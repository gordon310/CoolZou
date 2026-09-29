import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDashScopeGenerator } from '../server/ai.mjs';

const config = {
  aiMode: 'qwen',
  aiKey: 'provider-secret',
  aiBaseUrl: 'https://dashscope.example/compatible-mode/v1/',
  aiModel: 'qwen3-vl-plus',
  aiMaxInputTokens: 12000,
  aiMaxCompletionTokens: 4096,
  aiTimeoutMs: 1000,
  aiInputPriceMicrosPerMillion: 1,
  aiOutputPriceMicrosPerMillion: 1
};

const input = {
  title: '校园观察', nickname: '小同学', age: 7, gender: 'boy',
  content: '观察叶片并记录颜色', pageCount: 5, template: 'fresh', photoIds: ['asset-1']
};

const validSlide = { title: '观察叶片', body: '记录叶片颜色', notes: '说明观察方法', photoIds: ['asset-1'] };

function response(payload, status = 200) {
  return Response.json(payload, { status });
}

async function assertCode(code, fetchImpl, patch = {}) {
  let calls = 0;
  const generate = createDashScopeGenerator({ ...config, ...patch }, {
    fetchImpl: async (...args) => { calls++; return fetchImpl(...args); },
    readFile: async () => Buffer.from('jpeg-bytes')
  });
  await assert.rejects(
    generate(input, [{ id: 'asset-1', path: '/private/activity.jpg' }], 'outline'),
    error => error.code === code && !error.message.includes('provider-secret') && !error.message.includes('provider response')
  );
  return calls;
}

test('sends prompt and private JPEGs as a bounded structured request', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coolzou-ai-'));
  const jpegPath = path.join(dir, 'activity.jpg');
  await writeFile(jpegPath, Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AYf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AYf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQMBAT8Qof/EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQIBAT8Qof/EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAT8Qof/Z', 'base64'));
  try {
    const calls = [];
    const generate = createDashScopeGenerator(config, {
      fetchImpl: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return Response.json({
          model: 'qwen3-vl-plus',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ slides: [validSlide] }) } }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
        });
      }
    });
    const result = await generate(input, [{ id: 'asset-1', path: jpegPath }], 'outline');
    assert.deepEqual(result.slides, [validSlide]);
    assert.equal(calls[0].url, config.aiBaseUrl.replace(/\/$/, '') + '/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer provider-secret');
    assert.equal(calls[0].body.model, config.aiModel);
    assert.equal(calls[0].body.stream, false);
    assert.equal(calls[0].body.response_format.type, 'json_object');
    assert.equal(calls[0].body.enable_thinking, false);
    assert.equal(calls[0].body.max_tokens, 1200);
    const content = calls[0].body.messages[0].content;
    const photoIndex = content.findIndex(item => item.type === 'image_url');
    assert.match(content[photoIndex - 1].text, /asset-1/);
    assert.equal(content[photoIndex].max_pixels, 262144);
    assert.equal(calls[0].body.vl_high_resolution_images, false);
    assert.match(content[0].text, /每页.*一句/);
    assert.match(JSON.stringify(calls[0].body), /data:image\/jpeg;base64,/);
    assert.deepEqual(result.usage, { model: 'qwen3-vl-plus', promptTokens: 12, completionTokens: 8, totalTokens: 20, costMicros: 2 });
    assert.doesNotMatch(JSON.stringify(result), /provider-secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fails closed when the provider key is missing', async () => {
  let calls = 0;
  const generate = createDashScopeGenerator({ ...config, aiKey: '' }, { fetchImpl: async () => { calls++; } });
  await assert.rejects(generate(input, [], 'outline'), error => error.code === 'ai_not_configured');
  assert.equal(calls, 0);
});

test('maps provider failures without exposing the response body', async () => {
  assert.equal(await assertCode('ai_unavailable', async () => new Response('provider response secret', { status: 503 })), 1);
});

test('maps aborted provider calls to a timeout', async () => {
  const error = Object.assign(new Error('provider secret'), { name: 'AbortError' });
  assert.equal(await assertCode('ai_timeout', async () => { throw error; }), 1);
});

test('rejects empty choices, truncated output, invalid JSON and missing usage', async t => {
  await t.test('empty choices', async () => {
    assert.equal(await assertCode('ai_invalid_output', async () => response({ choices: [] })), 1);
  });
  await t.test('finish reason length', async () => {
    assert.equal(await assertCode('ai_output_limit', async () => response({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })), 1);
  });
  await t.test('invalid JSON', async () => {
    assert.equal(await assertCode('ai_invalid_output', async () => response({ choices: [{ finish_reason: 'stop', message: { content: '{' } }] })), 1);
  });
  await t.test('missing usage', async () => {
    assert.equal(await assertCode('ai_invalid_output', async () => response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ slides: [validSlide] }) } }] })), 1);
  });
});

test('rejects output that references an unknown private photo', async () => {
  const invalid = { ...validSlide, photoIds: ['not-this-user-photo'] };
  assert.equal(await assertCode('ai_invalid_output', async () => response({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ slides: [invalid] }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  })), 1);
});

test('rejects over-budget input before reading images or calling the provider', async () => {
  let calls = 0;
  let reads = 0;
  const generate = createDashScopeGenerator({ ...config, aiMaxInputTokens: 2000 }, {
    fetchImpl: async () => { calls++; return response({}); },
    readFile: async () => { reads++; return Buffer.from('jpeg'); }
  });
  await assert.rejects(generate({ ...input, content: '观'.repeat(3000) }, [{ id: 'asset-1', path: '/private/photo.jpg' }]), error => error.code === 'ai_input_limit');
  assert.equal(calls, 0);
  assert.equal(reads, 0);
});

test('counts every image in the input budget before calling the provider', async () => {
  let calls = 0;
  const generate = createDashScopeGenerator({ ...config, aiMaxInputTokens: 2000 }, {
    fetchImpl: async () => { calls++; return response({}); },
    readFile: async () => Buffer.from('jpeg')
  });
  await assert.rejects(generate(input, Array.from({ length: 8 }, (_, i) => ({ id: `asset-${i}`, path: '/private/photo.jpg' }))), error => error.code === 'ai_input_limit');
  assert.equal(calls, 0);
});

test('keeps the timeout active while reading the response body', async () => {
  assert.equal(await assertCode('ai_timeout', async (_url, init) => ({
    ok: true,
    json: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({}), 100);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    })
  }), { aiTimeoutMs: 10 }), 1);
});

test('validates JSON object fields and rejects inconsistent usage', async t => {
  const valid = { model: 'qwen3-vl-plus', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ slides: [validSlide] }) } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
  for (const slide of [{ ...validSlide, body: 123 }, { ...validSlide, title: '字'.repeat(41) }]) {
    await t.test('invalid slide fields', async () => {
      await assertCode('ai_invalid_output', async () => response({ ...valid, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ slides: [slide] }) } }] }));
    });
  }
  await t.test('usage totals', async () => {
    await assertCode('ai_invalid_output', async () => response({ ...valid, usage: { ...valid.usage, total_tokens: 99 } }));
  });
});

test('keeps the slide protocol when the provider adds an auxiliary field', async () => {
  const result = await createDashScopeGenerator(config, {
    fetchImpl: async () => response({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        slides: [{ ...validSlide, rationale: '图片与内容匹配' }]
      }) } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
    }),
    readFile: async () => Buffer.from('jpeg-bytes')
  })(input, [{ id: 'asset-1', path: '/private/activity.jpg' }]);

  assert.deepEqual(result.slides, [validSlide]);
});
