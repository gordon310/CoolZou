import { readFile as defaultReadFile } from 'node:fs/promises';
import { makePrompt } from './outline.mjs';
import { HttpError, validateSlides } from './validation.mjs';
import { aiCostMicros, costMicrosForTokens } from './cost-control.mjs';

const responseFormat = Object.freeze({ type: 'json_object' });
const maxImagePixels = 262_144;
const imageTokenCeiling = Math.ceil(maxImagePixels / (32 * 32)) + 2;
const outputTokenLimit = config => Math.min(config.aiMaxCompletionTokens, 1200);

const providerError = (code, message) => new HttpError(503, code, message);
const invalidOutput = () => providerError('ai_invalid_output', 'AI 返回内容不符合演示稿格式');

function assertConfigured(config) {
  if (!config.aiKey || !config.aiBaseUrl || !config.aiModel ||
      [config.aiMaxInputTokens, config.aiMaxCompletionTokens, config.aiTimeoutMs,
        config.aiInputPriceMicrosPerMillion, config.aiOutputPriceMicrosPerMillion]
        .some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw providerError('ai_not_configured', '正式 AI 配置不完整');
  }
}

function usageFrom(payload, config) {
  const usage = payload?.usage;
  const fields = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  if (!usage || fields.some(field => !Number.isSafeInteger(usage[field]) || usage[field] < 0) ||
      usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) throw invalidOutput();
  const model = typeof payload.model === 'string' && payload.model ? payload.model : config.aiModel;
  const costMicros = Number.isSafeInteger(config.aiInputPriceMicrosPerMillion) && Number.isSafeInteger(config.aiOutputPriceMicrosPerMillion)
    ? aiCostMicros({ promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens }, {
      inputPriceMicrosPerMillion: config.aiInputPriceMicrosPerMillion,
      outputPriceMicrosPerMillion: config.aiOutputPriceMicrosPerMillion
    })
    : null;
  return {
    model,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    costMicros
  };
}

export function estimateAiCost(config, _input, _photos) {
  return costMicrosForTokens(config.aiMaxInputTokens, config.aiInputPriceMicrosPerMillion) +
    costMicrosForTokens(outputTokenLimit(config), config.aiOutputPriceMicrosPerMillion);
}

function validateProviderSlides(value, photos) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.slides)) throw invalidOutput();
  for (const slide of value.slides) {
    if (!slide || typeof slide !== 'object' || Array.isArray(slide)) throw invalidOutput();
  }
  try { return validateSlides(value.slides, photos.map(photo => photo.id)); }
  catch { throw invalidOutput(); }
}

const photoLabel = id => `图片 ID：${id}。若使用此图片，photoIds 只能填写 "${id}"。`;

function assertInputBound(config, prompt, photos) {
  const labelBytes = photos.reduce((total, photo) => total + Buffer.byteLength(photoLabel(photo.id), 'utf8'), 0);
  const upperBound = Buffer.byteLength(prompt, 'utf8') + labelBytes + photos.length * imageTokenCeiling;
  if (upperBound > config.aiMaxInputTokens) {
    throw new HttpError(400, 'ai_input_limit', '本次文字或图片超出 AI 输入上限，请减少素材后重试');
  }
}

async function requestJsonWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response?.ok) throw providerError('ai_unavailable', 'AI 服务暂时不可用，请稍后重试');
    try { return await response.json(); }
    catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') throw providerError('ai_timeout', 'AI 请求超时，请稍后重试');
      throw invalidOutput();
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') throw providerError('ai_timeout', 'AI 请求超时，请稍后重试');
    throw providerError('ai_unavailable', 'AI 服务暂时不可用，请稍后重试');
  } finally {
    clearTimeout(timer);
  }
}

export function createDashScopeGenerator(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const readFile = dependencies.readFile || defaultReadFile;
  return async function generatePhase(input, photos = [], _kind = 'outline') {
    assertConfigured(config);
    if (typeof fetchImpl !== 'function') throw providerError('ai_unavailable', 'AI 服务暂时不可用，请稍后重试');
    const prompt = makePrompt(input);
    assertInputBound(config, prompt, photos);
    const images = [];
    try {
      for (const photo of photos) {
        const bytes = await readFile(photo.path);
        images.push(
          { type: 'text', text: photoLabel(photo.id) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}` }, max_pixels: maxImagePixels }
        );
      }
    } catch {
      throw providerError('ai_unavailable', 'AI 输入素材暂时不可用，请稍后重试');
    }
    const body = {
      model: config.aiModel,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images] }],
      stream: false,
      enable_thinking: false,
      vl_high_resolution_images: false,
      max_tokens: outputTokenLimit(config),
      response_format: responseFormat
    };
    const url = `${String(config.aiBaseUrl).replace(/\/$/, '')}/chat/completions`;
    const payload = await requestJsonWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.aiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, config.aiTimeoutMs || 60_000);
    const choice = payload?.choices?.[0];
    if (!choice) throw invalidOutput();
    if (choice.finish_reason === 'length') throw providerError('ai_output_limit', 'AI 输出超过长度限制，请稍后重试');
    if (choice.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw invalidOutput();
    let parsed;
    try { parsed = JSON.parse(choice.message.content); } catch { throw invalidOutput(); }
    return { slides: validateProviderSlides(parsed, photos), usage: usageFrom(payload, config) };
  };
}
