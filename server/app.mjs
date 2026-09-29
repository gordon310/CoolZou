import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Store } from './store.mjs';
import { Worker } from './worker.mjs';
import { validateChannel } from './payments.mjs';
import { templates } from './templates.mjs';
import { HttpError, validateInput, validateSlides } from './validation.mjs';
import { CostControl } from './cost-control.mjs';
import { createDashScopeGenerator } from './ai.mjs';
import { exchangeWechatCode } from './wechat.mjs';
import { createLogger, errorDetails } from './diagnostics.mjs';

sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 32 });

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const setting = (options, key, envKey, fallback = '') => String(options[key] ?? process.env[envKey] ?? fallback).trim();
const positiveInteger = value => {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

export async function createApp(options = {}) {
  const aiMode = setting(options, 'aiMode', 'AI_MODE', 'demo') || 'demo';
  const config = {
    dataDir: options.dataDir || path.join(root, 'var'),
    mode: options.mode || process.env.APP_MODE || 'demo',
    aiMode,
    wechatAppId: options.wechatAppId ?? process.env.WECHAT_APP_ID ?? '',
    wechatAppSecret: options.wechatAppSecret ?? process.env.WECHAT_APP_SECRET ?? '',
    gatewaySecret: options.gatewaySecret ?? process.env.GATEWAY_SECRET ?? '',
    aiKey: setting(options, 'aiKey', 'DASHSCOPE_API_KEY'),
    aiBaseUrl: setting(options, 'aiBaseUrl', 'DASHSCOPE_BASE_URL'),
    aiModel: setting(options, 'aiModel', 'DASHSCOPE_MODEL', aiMode === 'demo' ? 'qwen3-vl-plus' : ''),
    aiMaxInputTokens: positiveInteger(options.aiMaxInputTokens ?? process.env.DASHSCOPE_MAX_INPUT_TOKENS),
    aiMaxCompletionTokens: positiveInteger(options.aiMaxCompletionTokens ?? process.env.DASHSCOPE_MAX_COMPLETION_TOKENS),
    aiTimeoutMs: positiveInteger(options.aiTimeoutMs ?? process.env.DASHSCOPE_TIMEOUT_MS),
    aiInputPriceMicrosPerMillion: positiveInteger(options.aiInputPriceMicrosPerMillion ?? process.env.DASHSCOPE_INPUT_PRICE_MICROS_PER_MILLION),
    aiOutputPriceMicrosPerMillion: positiveInteger(options.aiOutputPriceMicrosPerMillion ?? process.env.DASHSCOPE_OUTPUT_PRICE_MICROS_PER_MILLION),
    paymentMode: options.paymentMode || process.env.PAYMENT_MODE || ((options.mode || process.env.APP_MODE) === 'live' ? 'disabled' : 'demo'),
    priceFen: 5000, freePages: 5, maxPhotos: 20, maxPhotoBytes: 1000000,
    downloadTtlMs: options.downloadTtlMs || 5 * 60 * 1000,
    maxRequests: 32, maxUploads: 2, minDiskBytes: options.minDiskBytes ?? 1_000_000_000,
    jobTimeoutMs: options.jobTimeoutMs ?? 180_000
  };
  if (config.aiMode === 'qwen' && (!config.aiKey || !config.aiBaseUrl || !config.aiModel ||
      [config.aiMaxInputTokens, config.aiMaxCompletionTokens, config.aiTimeoutMs,
        config.aiInputPriceMicrosPerMillion, config.aiOutputPriceMicrosPerMillion].some(value => value === null))) {
    throw new HttpError(503, 'ai_not_configured', '正式 AI 配置不完整');
  }
  const store = new Store(config.dataDir, { aiMode: config.aiMode });
  await store.init();
  const log = options.logger || createLogger(config.dataDir);
  const requireDisk = async () => {
    const disk = await fs.statfs(store.filesDir);
    if (disk.bavail * disk.bsize < config.minDiskBytes) throw new HttpError(503, 'disk_low', '存储空间暂时不足，请稍后再试；已有作品仍可下载');
  };
  config.log = log;
  config.requireDisk = requireDisk;
  const demoCostPolicy = config.mode === 'demo' && config.aiMode === 'demo' ? { dailyFreeTasks: 20 } : {};
  store.cost = new CostControl(store.db, { ...demoCostPolicy, ...(options.costPolicy || {}) }, options.now);
  config.phaseGenerator = options.phaseGenerator || (config.aiMode === 'qwen' ? createDashScopeGenerator(config) : undefined);
  const worker = new Worker(store, config);
  for (const job of store.db.prepare("SELECT * FROM jobs WHERE status='running'").all()) {
    log('job_interrupted', { jobId: job.id, deckId: job.deck_id, kind: job.kind });
    store.markJob(job.id, 'failed');
    store.setFailed(job.deck_id, '上次生成被中断，请重试；正式模型需先核对用量');
  }
  const send = (res, status, payload, headers = {}) => {
    const binary = Buffer.isBuffer(payload);
    const body = binary ? payload : Buffer.from(JSON.stringify(payload));
    res.writeHead(status, { 'Content-Type': binary ? 'application/octet-stream' : 'application/json; charset=utf-8', 'Content-Length': body.length, ...headers });
    res.end(body);
  };
  const fail = (res, error) => {
    if (!(error instanceof HttpError)) log('request_failed', errorDetails(error));
    const e = error instanceof HttpError ? error : new HttpError(500, 'server_error', '服务暂时不可用');
    if (!res.headersSent) send(res, e.status, { error: { code: e.code, message: e.message } });
    else res.end();
  };
  const readBytes = (req, limit) => new Promise((resolve, reject) => {
    if (req.aborted) return reject(new HttpError(400, 'request_aborted', '上传已中断'));
    let size = 0; let oversized = false; const chunks = [];
    req.on('data', chunk => {
      if (oversized) return;
      size += chunk.length;
      if (size > limit) { oversized = true; reject(new HttpError(413, 'body_too_large', '上传内容过大')); }
      else chunks.push(chunk);
    });
    req.on('end', () => { if (!oversized) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, 'request_aborted', '上传已中断')));
  });
  const readBody = async req => {
    try { const bytes = await readBytes(req, 1_500_000); return bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json', '请求内容不是有效JSON'); }
  };
  const getCookie = req => (req.headers.cookie || '').split(';').map(v => v.trim().split('=')).find(pair => pair[0] === 'kidsppt_session')?.[1];
  const authValue = req => (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : getCookie(req);
  const currentUser = req => store.userForToken(authValue(req));
  const requireUser = req => currentUser(req) || (() => { throw new HttpError(401, 'unauthorized', '请先登录'); })();
  const trustedGateway = req => {
    if (!config.gatewaySecret) return true;
    const expected = Buffer.from(config.gatewaySecret); const actual = Buffer.from(String(req.headers['x-coolzou-gateway'] || ''));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
  const csrf = req => { const origin = req.headers.origin; if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new HttpError(403, 'csrf_origin', '请求来源不受信任'); };
  const publicConfig = () => ({ mode: config.mode, aiMode: config.aiMode, aiAvailable: ['demo', 'qwen'].includes(config.aiMode), dailyFreeTasks: store.cost.policy.dailyFreeTasks, freePhotoLimit: 8, paymentMode: config.paymentMode, paymentChannels: config.paymentMode === 'disabled' ? [] : ['wechat', 'alipay'], priceFen: config.priceFen, currency: 'CNY', freePages: config.freePages, maxPhotos: config.maxPhotos, maxPhotoBytes: config.maxPhotoBytes, templates: Object.entries(templates).map(([id, value]) => ({ id, name: value.name, description: value.description })) });
  const json = req => readBody(req);
  const saveAsset = async (user, name, buffer) => {
    if (buffer.length > config.maxPhotoBytes) throw new HttpError(413, 'image_too_large', '单张照片不能超过 1 MB，请压缩后重试');
    let meta;
    try { meta = await sharp(buffer, { limitInputPixels: 24_000_000 }).metadata(); if (!['jpeg', 'png', 'webp'].includes(meta.format) || !meta.width || !meta.height || (meta.pages || 1) > 1) throw new Error(); }
    catch { throw new HttpError(400, 'invalid_image', '请上传不超过2400万像素的静态 JPG、PNG 或 WEBP 图片'); }
    const id = 'asset_' + crypto.randomUUID(); const filePath = path.join(store.filesDir, id + '.jpg');
    let converted = await sharp(buffer, { limitInputPixels: 24_000_000 }).timeout({ seconds: 15 }).rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    if (converted.length > config.maxPhotoBytes) converted = await sharp(converted).resize({ width: 1280, height: 1280, fit: 'inside' }).jpeg({ quality: 60 }).toBuffer();
    if (converted.length > config.maxPhotoBytes) throw new HttpError(413, 'image_too_large', '图片压缩后仍过大，请更换照片');
    await fs.writeFile(filePath, converted);
    meta = await sharp(converted).metadata();
    let asset;
    try { asset = store.createAsset({ id, userId: user.id, name: String(name || '活动图片').slice(0, 80), filePath, mime: 'image/jpeg', width: meta.width, height: meta.height }); }
    catch (error) { await fs.rm(filePath, { force: true }); throw error; }
    return { ...asset, url: '/api/assets/' + id };
  };
  const present = order => presentOrder(order, store.getDeck(order.deck_id, order.user_id));
  const sendFile = async (res, file, headers) => {
    const stat = await fs.stat(file);
    res.writeHead(200, { 'Content-Length': stat.size, ...headers });
    await pipeline(createReadStream(file), res);
  };
  const route = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = req.method || 'GET';
    if (method === 'GET' && url.pathname === '/health') {
      store.db.prepare('SELECT 1').get();
      const ok = !worker.isStalled();
      return send(res, ok ? 200 : 503, { ok });
    }
    if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/download/')) && !trustedGateway(req)) throw new HttpError(403, 'gateway_required', '请求入口不受信任');
    if (method !== 'GET') csrf(req);
    if (method === 'GET' && url.pathname === '/api/config') return send(res, 200, publicConfig());
    if (method === 'POST' && url.pathname === '/api/session/demo') {
      if (config.mode !== 'demo') throw new HttpError(403, 'demo_disabled', '线上模式不允许使用演示登录');
      const user = store.createUser(); const value = store.makeToken(user.id);
      return send(res, 201, { token: value, user }, { 'Set-Cookie': 'kidsppt_session=' + value + '; HttpOnly; SameSite=Lax; Path=/' });
    }
    if (method === 'POST' && url.pathname === '/api/session/wechat') {
      if (config.mode !== 'live') throw new HttpError(503, 'wechat_not_configured', '微信登录尚未配置');
      const body = await json(req);
      const openId = await exchangeWechatCode(body?.code, { appId: config.wechatAppId, appSecret: config.wechatAppSecret, fetchImpl: options.wechatFetch });
      const user = store.wechatUser(config.wechatAppId, openId);
      return send(res, 200, { token: store.makeToken(user.id), user });
    }
    if (method === 'GET' && url.pathname === '/api/me') return send(res, 200, { user: requireUser(req) });
    if (method === 'POST' && url.pathname === '/api/logout') { store.deleteSession(authValue(req)); return send(res, 200, { ok: true }); }

    if (method === 'POST' && url.pathname === '/api/assets/upload') {
      const user = requireUser(req); const contentType = String(req.headers['content-type'] || '');
      if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(400, 'invalid_upload', '上传格式不正确');
      let form;
      try {
        const bytes = await readBytes(req, config.maxPhotoBytes + 1024 * 1024);
        form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'invalid_upload', '上传格式不正确');
      }
      const file = form.get('file');
      if (!file || typeof file.arrayBuffer !== 'function') throw new HttpError(400, 'invalid_upload', '请选择要上传的图片');
      return send(res, 201, await saveAsset(user, form.get('name') || file.name, Buffer.from(await file.arrayBuffer())));
    }

    const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (assetMatch) {
      const user = requireUser(req); const asset = store.getAsset(assetMatch[1], user.id); if (!asset) throw new HttpError(404, 'not_found', '图片不存在');
      if (method === 'GET') return sendFile(res, asset.path, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=60' });
      if (method === 'DELETE') { const removed = store.deleteAsset(asset.id, user.id); if (!removed) throw new HttpError(409, 'asset_in_use', '图片已关联作品'); await fs.rm(asset.path, { force: true }); return send(res, 200, { ok: true }); }
    }
    if (method === 'POST' && url.pathname === '/api/assets') {
      const user = requireUser(req); const body = await json(req);
      if (typeof body.data !== 'string' || body.data.length > config.maxPhotoBytes * 2) throw new HttpError(400, 'invalid_image', '图片过大或格式不正确');
      return send(res, 201, await saveAsset(user, body.name, Buffer.from(body.data, 'base64')));
    }

    if (method === 'POST' && url.pathname === '/api/decks') {
      const user = requireUser(req); const input = validateInput(await json(req)); const assets = store.assetsForUser(input.photoIds, user.id);
      if (assets.length !== input.photoIds.length) throw new HttpError(404, 'asset_not_found', '有图片不属于当前账号');
      const byId = new Map(assets.map(asset => [asset.id, asset]));
      const photoHashes = [];
      for (const id of input.photoIds) photoHashes.push(crypto.createHash('sha256').update(await fs.readFile(byId.get(id).path)).digest('hex'));
      const requestKey = crypto.createHash('sha256').update(JSON.stringify({ version: 2, aiMode: config.aiMode, ...input, photoIds: photoHashes })).digest('hex');
      const materialKey = crypto.createHash('sha256').update(JSON.stringify({ version: 1, ...input, template: undefined, theme: undefined, reviewOutline: undefined, photoIds: photoHashes })).digest('hex');
      const reusable = store.findReusableDeck(user.id, materialKey, input.template);
      if (reusable) {
        const deck = store.createTemplateVariant({ id: 'deck_' + crypto.randomUUID(), userId: user.id, input, source: reusable, requestKey, materialKey });
        return send(res, 202, { deck });
      }
      store.cost.assertAvailable(config.aiMode);
      const deck = store.createDeck({ id: 'deck_' + crypto.randomUUID(), userId: user.id, input, requestKey, materialKey }); return send(res, 202, { deck });
    }
    if (url.pathname === '/api/decks') { const user = requireUser(req); return send(res, 200, { decks: store.listDecks(user.id) }); }

    const deckMatch = url.pathname.match(/^\/api\/decks\/([^/]+)(?:\/(.*))?$/);
    if (deckMatch) {
      const user = requireUser(req); const deck = store.getDeck(deckMatch[1], user.id); if (!deck) throw new HttpError(404, 'not_found', '作品不存在');
      const action = deckMatch[2] || '';
      if (!action && method === 'GET') return send(res, 200, { deck });
      if (!action && method === 'DELETE') {
        if (store.db.prepare("SELECT 1 FROM jobs WHERE deck_id=? AND status='running'").get(deck.id) || (deck.paid && !deck.fullReady)) throw new HttpError(409, 'generation_active', '生成处理中，暂不能删除；付费异常请联系支持处理');
        store.deleteDeck(deck.id, user.id); return send(res, 200, { ok: true });
      }
      if (action === 'outline' && method === 'PUT') {
        const body = await json(req); const current = store.getDeck(deck.id, user.id);
        if (current?.status !== 'outline_ready') throw new HttpError(409, 'deck_not_editable', '当前阶段不能修改内容');
        if (body.revision !== current.revision) throw new HttpError(409, 'revision_conflict', '内容版本已变化，请重新打开');
        const slides = validateSlides(body.slides, deck.photoIds); store.bumpRevision(deck.id, slides); return send(res, 200, { deck: store.getDeck(deck.id, user.id) });
      }
      if (action === 'generate' && method === 'POST') {
        const body = await json(req); const current = store.getDeck(deck.id, user.id);
        if (current?.status !== 'outline_ready' || body.revision !== current.revision) throw new HttpError(409, 'revision_conflict', '请先确认当前内容');
        store.queueRender(deck.id); return send(res, 202, { deck: store.getDeck(deck.id, user.id) });
      }
      if (action === 'retry' && method === 'POST') { if (deck.status !== 'failed') throw new HttpError(409, 'cannot_retry', '当前作品不需要重试'); store.cost.assertAvailable(config.aiMode); store.retry(deck.id); return send(res, 202, { deck: store.getDeck(deck.id, user.id) }); }
      const preview = action.match(/^preview\/(\d+)$/); if (preview && method === 'GET') throw new HttpError(503, 'preview_not_ready', '页面预览暂未生成，请使用排版预览');
      if (action === 'download' && method === 'GET') {
        const variant = url.searchParams.get('variant') || 'free'; if (!['free', 'full'].includes(variant)) throw new HttpError(400, 'invalid_variant', '下载类型不正确');
        if (variant === 'full' && deck.actualPages > config.freePages && !deck.paid) throw new HttpError(402, 'payment_required', '完整PPT需要支付50元');
        if (!store.deckFile(deck.id, user.id, variant)) throw new HttpError(409, 'deck_not_ready', 'PPT还在生成中，完成后即可下载');
        const ticket = store.createDownloadToken({ userId: user.id, deckId: deck.id, variant, ttlMs: config.downloadTtlMs });
        return send(res, 200, { url: '/download/' + ticket.value, filename: deck.title + '-' + (variant === 'free' ? '前5页' : '完整版') + '.pptx', expiresAt: ticket.expiresAt });
      }
      if (action === 'orders' && method === 'POST') {
        if (deck.status !== 'ready') throw new HttpError(409, 'deck_not_ready', 'PPT生成完成后才能购买');
        if (deck.actualPages <= config.freePages) throw new HttpError(409, 'payment_not_needed', '当前作品不超过5页，无需购买');
        const body = await json(req); const channel = validateChannel(body.channel);
        const current = store.getDeck(deck.id, user.id);
        if (current?.status !== 'ready' || current.revision !== deck.revision) throw new HttpError(409, 'deck_changed', '作品状态已变化，请重新打开');
        if (config.paymentMode !== 'demo') throw new HttpError(503, 'payment_not_configured', '微信支付和支付宝尚未配置');
        store.cost.assertAvailable(config.aiMode);
        const order = store.createOrder({ id: 'order_' + crypto.randomUUID(), userId: user.id, deckId: deck.id, revision: deck.revision, channel, amountFen: config.priceFen, mode: config.paymentMode, reserveBudget: deck.pipeline === 2 && !deck.fullReady });
        return send(res, 201, { order: present(order) });
      }
    }
    if (method === 'GET' && url.pathname === '/api/orders') { const user = requireUser(req); return send(res, 200, { orders: store.orders(user.id).map(present) }); }
    const orderPay = url.pathname.match(/^\/api\/orders\/([^/]+)\/demo-pay$/);
    if (orderPay && method === 'POST') {
      const user = requireUser(req); const order = store.order(orderPay[1], user.id); if (!order) throw new HttpError(404, 'not_found', '订单不存在');
      if (config.paymentMode !== 'demo') throw new HttpError(403, 'demo_payment_disabled', '线上模式不允许模拟支付');
      const body = await json(req); if (body.confirm !== true) throw new HttpError(400, 'payment_not_confirmed', '请确认模拟支付');
      store.cost.assertAvailable(config.aiMode);
      return send(res, 200, { order: present(store.payOrder(order.id, user.id)) });
    }
    const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && method === 'GET') { const user = requireUser(req); const order = store.order(orderMatch[1], user.id); if (!order) throw new HttpError(404, 'not_found', '订单不存在'); return send(res, 200, { order: present(order) }); }

    const fileMatch = url.pathname.match(/^\/download\/([^/]+)$/);
    if (fileMatch && method === 'GET') {
      const user = requireUser(req); const ticket = store.downloadToken(fileMatch[1]);
      if (!ticket || ticket.user_id !== user.id) throw new HttpError(ticket ? 403 : 404, 'download_denied', ticket ? '下载链接已失效' : '下载链接不存在');
      const file = store.deckFile(ticket.deck_id, user.id, ticket.variant); if (!file) throw new HttpError(404, 'not_found', '文件不存在');
      return sendFile(res, file, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Content-Disposition': 'attachment' });
    }
    if (method === 'GET') {
      const relative = url.pathname === '/' ? '/index.html' : url.pathname;
      if (relative.includes('..') || relative.startsWith('/api/') || relative.startsWith('/download/')) throw new HttpError(404, 'not_found', '页面不存在');
      const filePath = path.join(root, 'web', relative);
      try { const stat = await fs.stat(filePath); if (!stat.isFile()) throw new Error(); return send(res, 200, await fs.readFile(filePath), { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' }); } catch { throw new HttpError(404, 'not_found', '页面不存在'); }
    }
    throw new HttpError(404, 'not_found', '接口不存在');
  };
  let requests = 0;
  const uploads = new Set();
  const server = http.createServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { return send(res, 400, { error: { code: 'invalid_url', message: '请求地址不正确' } }); }
    const health = pathname === '/health';
    let uploadUser;
    let admitted = false;
    try {
      if (!health) {
        if (requests >= config.maxRequests) throw new HttpError(503, 'server_busy', '当前访问较多，请稍后重试');
        requests++; admitted = true;
        if (req.method === 'POST' && ['/api/assets', '/api/assets/upload'].includes(pathname)) {
          if (!trustedGateway(req)) throw new HttpError(403, 'gateway_required', '请求入口不受信任');
          const user = requireUser(req);
          if (uploads.size >= config.maxUploads || uploads.has(user.id)) throw new HttpError(429, 'upload_busy', '照片正在处理，请稍后重试');
          uploads.add(user.id); uploadUser = user.id;
          store.assertUploadSpace(user.id);
          await requireDisk();
        }
      }
      await route(req, res);
    } catch (error) {
      if (!res.headersSent && (error.status === 429 || error.status === 503)) res.setHeader('Retry-After', '3');
      if (error.code === 'disk_low') log('disk_low');
      // Rejected request bodies must not occupy a keep-alive connection indefinitely.
      if (!req.complete && !res.headersSent) { res.setHeader('Connection', 'close'); req.resume(); }
      fail(res, error);
    } finally { if (admitted) requests--; if (uploadUser) uploads.delete(uploadUser); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.setTimeout(60_000, socket => socket.destroy());
  server.maxConnections = 64;
  return { server, store, worker, config, log, processNext: () => worker.processNext(), maintenance: () => store.cleanup(), close: async () => { worker.closing = true; await new Promise(resolve => server.close(resolve)); await worker.drain(); store.close(); } };
}

function presentOrder(order, deck) {
  const deckTitle = order.deck_title || '已删除的PPT';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(order.created_at)).map(part => [part.type, part.value]));
  const title = `${deckTitle} · ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  const delivery = order.status !== 'paid' ? '待支付' : !deck ? '作品已删除' : deck.fullReady ? '可下载' : deck.status === 'failed' ? '交付异常，待处理' : deck.status === 'outline_ready' ? '待确认大纲' : '生成中';
  return { id: order.id, title, deckTitle, deckId: order.deck_id, revision: order.revision, amountFen: order.amount_fen, currency: order.currency, channel: order.channel, status: order.status, delivery, mode: order.mode, createdAt: order.created_at, paidAt: order.paid_at };
}
