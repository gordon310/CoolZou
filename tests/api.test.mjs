import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createApp } from '../server/app.mjs';

async function harness(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'coolzou-test-'));
  const app = await createApp({ ...options, dataDir, mode: options.mode || 'demo', aiMode: options.aiMode || 'demo', costPolicy: { dailyFreeTasks: 1, ...(options.costPolicy || {}) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, { token, body, method, ...rest } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method: method || (body !== undefined ? 'POST' : 'GET'),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...rest
    });
    const json = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    return { response, status: response.status, json };
  };
  return { app, dataDir, call, base, close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

async function account(h) { return (await h.call('/api/session/demo', { body: {} })).json.token; }

test('both upload routes enforce the one MB boundary', async () => {
  const h = await harness();
  try {
    const token = await account(h);
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    for (const size of [1000000, 1000001]) {
      const image = Buffer.concat([jpeg, Buffer.alloc(size - jpeg.length)]);
      const json = await h.call('/api/assets', { token, body: { data: image.toString('base64') } });
      assert.equal(json.status, size === 1000000 ? 201 : 413);
      const form = new FormData();
      form.append('file', new Blob([image], { type: 'image/jpeg' }), 'photo.jpg');
      const response = await fetch(h.base + '/api/assets/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
      assert.equal(response.status, size === 1000000 ? 201 : 413);
    }
  } finally { await h.close(); }
});

test('photo creation exposes and enforces a twenty-photo limit', async () => {
  const h = await harness();
  try {
    assert.equal((await h.call('/api/config')).json.maxPhotos, 20);
    const token = await account(h);
    const result = await h.call('/api/decks', { token, body: {
      title: '活动记录', grade: 3, gender: 'boy', content: '观察活动',
      photoIds: Array.from({ length: 21 }, (_, index) => 'asset-' + index), consent: true
    } });
    assert.equal(result.status, 400);
    assert.match(result.json.error.message, /1至20张/);
  } finally { await h.close(); }
});
async function asset(h, token) {
  const image = await sharp({ create: { width: 480, height: 320, channels: 3, background: '#287b69' } }).jpeg().toBuffer();
  const result = await h.call('/api/assets', { token, body: { name: 'activity.jpg', data: image.toString('base64') } });
  assert.equal(result.status, 201);
  return result.json;
}
async function deck(h, token, photoId, options = {}) {
  const result = await h.call('/api/decks', { token, body: {
    title: '叶片观察活动', nickname: '小同学', grade: 3, gender: 'boy',
    content: '进入植物园\n观察叶片\n记录颜色\n比较形状\n整理观察记录\n交流发现\n请用简短自然的三年级口吻扩写观察和收获',
    pageCount: 12, template: 'playful', photoIds: [photoId], consent: true, reviewOutline: true, ...options
  } });
  assert.equal(result.status, 202);
  assert.equal(result.json.deck.template, 'playful');
  return result.json.deck;
}
async function ready(h, token, id) {
  await h.app.processNext();
  let result = await h.call(`/api/decks/${id}`, { token });
  assert.equal(result.json.deck.status, 'outline_ready');
  const generated = await h.call(`/api/decks/${id}/generate`, { token, body: { revision: result.json.deck.revision } });
  assert.equal(generated.status, 202);
  await h.app.processNext();
  result = await h.call(`/api/decks/${id}`, { token });
  assert.equal(result.json.deck.status, 'ready');
  return result.json.deck;
}

test('default creation skips outline editing and queues a downloadable PPT', async () => {
  const h = await harness();
  try {
    const token = await account(h);
    const d = await deck(h, token, (await asset(h, token)).id, { reviewOutline: undefined });
    assert.equal(d.reviewOutline, false);
    assert.equal('age' in d, false);
    assert.equal('type' in d, false);
    await h.app.processNext();
    assert.equal((await h.call(`/api/decks/${d.id}`, { token })).json.deck.status, 'queued');
    await h.app.processNext();
    assert.equal((await h.call(`/api/decks/${d.id}`, { token })).json.deck.status, 'ready');
    assert.equal((await h.call(`/api/decks/${d.id}/download?variant=free`, { token })).status, 200);
  } finally { await h.close(); }
});

test('two real sessions cannot access each other assets, decks or download rights', async () => {
  const h = await harness();
  try {
    const a = await account(h), b = await account(h);
    assert.notEqual(a, b);
    const photo = await asset(h, a);
    assert.equal((await h.call(photo.url, { token: b })).status, 404);
    assert.equal((await h.call(photo.url)).status, 401);
    const d = await deck(h, a, photo.id);
    assert.equal((await h.call(`/api/decks/${d.id}`, { token: b })).status, 404);
    assert.equal((await h.call(`/api/decks/${d.id}`, { token: b, method: 'DELETE' })).status, 404);
    assert.equal((await h.call('/api/decks', { token: b })).json.decks.length, 0);
    await ready(h, a, d.id);
    assert.equal((await h.call(`/api/decks/${d.id}/download?variant=full`, { token: a })).status, 402);
    const free = await h.call(`/api/decks/${d.id}/download?variant=free`, { token: a });
    assert.equal(free.status, 200);
    const file = await h.call(free.json.url, { token: a });
    const zip = await JSZip.loadAsync(Buffer.from(await file.response.arrayBuffer()));
    assert.equal(Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 5);
    assert.equal((await h.call(free.json.url, { token: b })).status, 403);
  } finally { await h.close(); }
});

test('orders use fixed price; only confirmed demo payment unlocks once; frozen revisions and deletion enforced', async () => {
  const h = await harness();
  try {
    const token = await account(h);
    const d = await deck(h, token, (await asset(h, token)).id);
    assert.equal((await h.call(`/api/decks/${d.id}/orders`, { token, body: { channel: 'wechat' } })).status, 409);
    await h.app.processNext();
    const editable = (await h.call(`/api/decks/${d.id}`, { token })).json.deck;
    assert.equal((await h.call(`/api/decks/${d.id}/outline`, { token, method: 'PUT', body: { revision: -1, slides: editable.slides } })).status, 409);
    await h.call(`/api/decks/${d.id}/generate`, { token, body: { revision: editable.revision } });
    await h.app.processNext();
    const first = await h.call(`/api/decks/${d.id}/orders`, { token, body: { channel: 'wechat', amountFen: 1 } });
    assert.equal(first.json.order.amountFen, 5000);
    assert.equal(first.json.order.currency, 'CNY');
    assert.equal(first.json.order.deckTitle, d.title);
    assert.match(first.json.order.title, /^叶片观察活动 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Exercise upgrading an existing order and Beijing time across a UTC date boundary.
    h.app.store.db.exec('ALTER TABLE orders DROP COLUMN deck_title');
    await h.app.store.init();
    h.app.store.db.prepare('UPDATE orders SET created_at=? WHERE id=?').run('2026-09-14T16:04:07.000Z', first.json.order.id);
    const expectedTitle = '叶片观察活动 · 2026-09-15 00:04:07';
    assert.equal((await h.call(`/api/orders/${first.json.order.id}`, { token })).json.order.title, expectedTitle);
    const again = await h.call(`/api/decks/${d.id}/orders`, { token, body: { channel: 'wechat' } });
    assert.equal(first.json.order.id, again.json.order.id);
    assert.equal((await h.call(`/api/orders/${first.json.order.id}/demo-pay`, { token, body: {} })).status, 400);
    assert.equal((await h.call(`/api/decks/${d.id}/download?variant=full`, { token })).status, 402);
    for (let i = 0; i < 2; i++) {
      assert.equal((await h.call(`/api/orders/${first.json.order.id}/demo-pay`, { token, body: { confirm: true } })).json.order.status, 'paid');
    }
    assert.equal((await h.call('/api/orders', { token })).json.orders.length, 1);
    await h.app.processNext();
    const completion = (await h.call(`/api/decks/${d.id}`, { token })).json.deck;
    await h.call(`/api/decks/${d.id}/generate`, { token, body: { revision: completion.revision } });
    await h.app.processNext();
    const full = await h.call(`/api/decks/${d.id}/download?variant=full`, { token });
    assert.equal(full.status, 200);
    assert.equal((await h.call(`/api/decks/${d.id}/outline`, { token, method: 'PUT', body: { revision: 1, slides: editable.slides } })).status, 409);
    await h.call(`/api/decks/${d.id}`, { token, method: 'DELETE' });
    assert.equal((await h.call('/api/orders', { token })).json.orders[0].title, expectedTitle);
    assert.equal((await h.call(full.json.url, { token })).status, 404);
    assert.equal((await h.call(`/api/assets/${d.photos[0].id}`, { token })).status, 404);
  } finally { await h.close(); }
});

test('live mode cannot create demo accounts or serve local private files', async () => {
  const h = await harness({ mode: 'live' });
  try {
    assert.equal((await h.call('/api/session/demo', { body: {} })).status, 403);
    assert.equal((await h.call('/api/session/wechat', { body: { code: 'not-real' } })).status, 503);
    assert.equal((await h.call('/.env')).status, 404);
    assert.equal((await h.call('/docs/spec.md')).status, 404);
    assert.equal((await h.call('/examples/private/example.jpg')).status, 404);
    assert.equal((await h.call('/api/config')).json.paymentMode, 'disabled');
  } finally { await h.close(); }
});

test('configured gateway secret protects API routes with constant external behavior', async () => {
  const h = await harness({ gatewaySecret: 'trusted-gateway-secret' });
  try {
    const call = headers => fetch(`${h.base}/api/config`, { headers });
    assert.equal((await call()).status, 403);
    assert.equal((await call({ 'x-coolzou-gateway': 'wrong' })).status, 403);
    const accepted = await call({ 'x-coolzou-gateway': 'trusted-gateway-secret' });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).freePages, 5);
  } finally { await h.close(); }
});

test('health endpoint reports readiness without gateway authentication', async () => {
  const h = await harness({ mode: 'live', gatewaySecret: 'trusted-gateway-secret' });
  try {
    const result = await h.call('/health');
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true });
  } finally { await h.close(); }
});

test('invalid upload bytes, unsupported format and CSRF origin are rejected', async () => {
  const h = await harness();
  try {
    const token = await account(h);
    assert.equal((await h.call('/api/assets', { token, body: { name: 'fake.jpg', data: Buffer.from('not an image').toString('base64') } })).status, 400);
    const attack = await h.call('/api/session/demo', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: {} });
    assert.equal(attack.status, 403);
    assert.equal((await h.call('/api/decks', { token, body: {} })).status, 400);
  } finally { await h.close(); }
});

test('authenticated multipart upload stores a validated image without base64 JSON', async () => {
  const h = await harness();
  try {
    const token = await account(h);
    const image = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#26735b' } }).png().toBuffer();
    const form = new FormData();
    form.append('name', '校园活动.png');
    form.append('file', new Blob([image], { type: 'image/png' }), 'activity.png');
    const response = await fetch(`${h.base}/api/assets/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
    });
    assert.equal(response.status, 201);
    const saved = await response.json();
    assert.equal(saved.name, '校园活动.png');
    assert.equal(saved.mime, 'image/jpeg');
    assert.equal((await h.call(saved.url, { token })).status, 200);

    const invalid = new FormData();
    invalid.append('file', new Blob([Buffer.from('not an image')]), 'fake.jpg');
    assert.equal((await fetch(`${h.base}/api/assets/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: invalid
    })).status, 400);
  } finally { await h.close(); }
});

test('download links expire even when original session is still valid', async () => {
  const h = await harness({ downloadTtlMs: 1 });
  try {
    const token = await account(h);
    const d = await deck(h, token, (await asset(h, token)).id);
    await ready(h, token, d.id);
    const link = await h.call(`/api/decks/${d.id}/download?variant=free`, { token });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await h.call(link.json.url, { token })).status, 404);
  } finally { await h.close(); }
});

test('new projects expose only five pages; payment queues one completion and preserves edited preview', async () => {
  const h = await harness();
  try {
    const token = await account(h);
    const d = await deck(h, token, (await asset(h, token)).id);
    await h.app.processNext();
    const editable = (await h.call(`/api/decks/${d.id}`, { token })).json.deck;
    assert.equal(editable.slides.length, 5);
    assert.equal(editable.directory.length, 8);
    editable.slides[0].body = '家长确认的开场';
    const saved = await h.call(`/api/decks/${d.id}/outline`, { token, method: 'PUT', body: { revision: editable.revision, slides: editable.slides } });
    await h.call(`/api/decks/${d.id}/generate`, { token, body: { revision: saved.json.deck.revision } });
    await h.app.processNext();
    assert.equal(h.app.store.deckFile(d.id, h.app.store.userForToken(token).id, 'full'), null);
    const frozen = (await h.call(`/api/decks/${d.id}`, { token })).json.deck.slides;
    const freePath = h.app.store.deckFile(d.id, h.app.store.userForToken(token).id, 'free');
    const freeBytes = await readFile(freePath);
    const order = (await h.call(`/api/decks/${d.id}/orders`, { token, body: { channel: 'wechat' } })).json.order;
    for (let i = 0; i < 3; i++) await h.call(`/api/orders/${order.id}/demo-pay`, { token, body: { confirm: true } });
    assert.equal((await h.call(`/api/decks/${d.id}/download?variant=full`, { token })).status, 409);
    assert.equal((await h.call(`/api/decks/${d.id}/download?variant=free`, { token })).status, 200);
    assert.equal(h.app.store.db.prepare("SELECT count(*) n FROM jobs WHERE deck_id=? AND kind='complete'").get(d.id).n, 1);
    await h.app.processNext();
    const fullEditor = (await h.call(`/api/decks/${d.id}`, { token })).json.deck;
    assert.equal(fullEditor.status, 'outline_ready');
    const revision = fullEditor.revision;
    const changed = structuredClone(fullEditor.slides); changed[0].body = '意外覆盖';
    assert.equal((await h.call(`/api/decks/${d.id}/outline`, { token, method: 'PUT', body: { revision, slides: changed } })).status, 409);
    await h.call(`/api/decks/${d.id}/generate`, { token, body: { revision } });
    await h.app.processNext();
    const full = (await h.call(`/api/decks/${d.id}`, { token })).json.deck;
    assert.equal(full.fullReady, true);
    assert.equal(full.paid, true);
    assert.equal(full.slides.length, 8);
    assert.deepEqual(full.slides.slice(0, 5), frozen);
    assert.deepEqual(await readFile(freePath), freeBytes);
  } finally { await h.close(); }
});

test('same-content photo reupload dedupes; daily quota persists after deletion', async () => {
  const h = await harness();
  try {
    const token = await account(h);
    const d = await deck(h, token, (await asset(h, token)).id);
    const same = await deck(h, token, (await asset(h, token)).id);
    assert.equal(same.id, d.id);
    await ready(h, token, d.id);
    await h.call(`/api/decks/${d.id}`, { token, method: 'DELETE' });
    const photo = await asset(h, token);
    const blocked = await h.call('/api/decks', { token, body: { title: '另一份', grade: 3, gender: 'boy', content: '观察叶片', photoIds: [photo.id], consent: true } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, 'daily_quota');
  } finally { await h.close(); }
});

test('a failed work does not consume the daily new-work slot', async () => {
  const h = await harness({ phaseGenerator: async () => { throw new Error('synthetic generation failure'); } });
  try {
    const token = await account(h);
    const photo = await asset(h, token);
    const failed = await deck(h, token, photo.id);
    await h.app.processNext();
    assert.equal((await h.call(`/api/decks/${failed.id}`, { token })).json.deck.status, 'failed');

    const replacement = await deck(h, token, photo.id);
    assert.notEqual(replacement.id, failed.id);
  } finally { await h.close(); }
});

test('budget refusal creates no order; paid completion with default flow needs no editor', async () => {
  const h = await harness({ costPolicy: { paidDailyBudget: 100_000 } });
  try {
    const token = await account(h);
    const d = await deck(h, token, (await asset(h, token)).id, { reviewOutline: false });
    await h.app.processNext(); await h.app.processNext();
    const budget = h.app.store.cost;
    budget.reserve('other-delivery'); budget.commitReservation('other-delivery');
    assert.equal((await h.call(`/api/decks/${d.id}/orders`, { token, body: { channel: 'wechat' } })).status, 503);
    assert.equal((await h.call('/api/orders', { token })).json.orders.length, 0);
    budget.settle('other-delivery', 0);
    const order = (await h.call(`/api/decks/${d.id}/orders`, { token, body: { channel: 'wechat' } })).json.order;
    await h.call(`/api/orders/${order.id}/demo-pay`, { token, body: { confirm: true } });
    assert.equal((await h.call(`/api/orders/${order.id}`, { token })).json.order.delivery, '生成中');
    await h.app.processNext(); await h.app.processNext();
    const full = (await h.call(`/api/decks/${d.id}`, { token })).json.deck;
    assert.equal(full.status, 'ready'); assert.equal(full.fullReady, true);
    assert.equal((await h.call(`/api/orders/${order.id}`, { token })).json.order.delivery, '可下载');
    assert.equal(budget.db.prepare('SELECT amount FROM ai_budget WHERE id=?').get(order.id).amount, 0);
  } finally { await h.close(); }
});

test('20 repeated HTTP submissions and render requests create only one task of each kind', async () => {
  const h = await harness();
  try {
    const token = await account(h); const photo = await asset(h, token);
    const submissions = await Promise.all(Array.from({ length: 20 }, () => deck(h, token, photo.id)));
    assert.equal(new Set(submissions.map(d => d.id)).size, 1);
    const d = submissions[0]; await h.app.processNext();
    const responses = await Promise.all(Array.from({ length: 20 }, () => h.call(`/api/decks/${d.id}/generate`, { token, body: { revision: 0 } })));
    assert.equal(responses.filter(r => r.status === 202).length, 1);
    assert.equal(h.app.store.db.prepare("SELECT count(*) n FROM jobs WHERE deck_id=? AND kind='render'").get(d.id).n, 1);
  } finally { await h.close(); }
});

test('changing only the template reuses the prepared content without spending another daily AI task', async () => {
  const h = await harness();
  try {
    const token = await account(h);
    const photo = await asset(h, token);
    const first = await deck(h, token, photo.id, { template: 'playful', reviewOutline: true });
    await ready(h, token, first.id);
    const prepared = (await h.call(`/api/decks/${first.id}`, { token })).json.deck;
    const fullSlides = [...prepared.slides, ...Array.from({ length: 3 }, (_, i) => ({ title: `后续${i}`, body: '仅在完整版出现', notes: '', photoIds: [] }))];
    h.app.store.updateDeck(first.id, { slides_json: JSON.stringify(fullSlides), full_path: '/tmp/existing-full.pptx', phase: 'full' });
    const variant = await h.call('/api/decks', { token, body: {
      title: first.title, nickname: first.nickname, grade: first.grade, gender: first.gender,
      content: first.content, pageCount: first.pageCount, template: 'report', photoIds: [photo.id], consent: true, reviewOutline: false
    } });
    assert.equal(variant.status, 202);
    assert.notEqual(variant.json.deck.id, first.id);
    assert.equal(variant.json.deck.template, 'report');
    assert.equal(variant.json.deck.status, 'queued');
    assert.equal(h.app.store.db.prepare("SELECT count(*) n FROM jobs WHERE deck_id=? AND kind='outline'").get(variant.json.deck.id).n, 0);
    await h.app.processNext();
    const result = (await h.call(`/api/decks/${variant.json.deck.id}`, { token })).json.deck;
    assert.equal(result.status, 'ready');
    assert.equal(result.template, 'report');
    assert.equal(result.slides.length, 5);
    assert.equal(result.freeReady, true);
    assert.equal(result.fullReady, false);
  } finally { await h.close(); }
});

test('qwen configuration fails closed without token limits and prices', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'coolzou-qwen-config-'));
  let app;
  try {
    await assert.rejects(
      async () => { app = await createApp({ dataDir, mode: 'live', aiMode: 'qwen', aiKey: 'provider-secret', aiBaseUrl: 'https://dashscope.example/v1', aiModel: 'qwen3-vl-plus' }); },
      error => error.code === 'ai_not_configured'
    );
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('qwen configuration exposes bounded provider settings without opening payment', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'coolzou-qwen-config-'));
  const app = await createApp({
    dataDir, mode: 'live', aiMode: 'qwen', paymentMode: 'disabled',
    aiKey: 'provider-secret', aiBaseUrl: ' https://dashscope.example/v1/ ', aiModel: ' qwen3-vl-plus ',
    aiMaxInputTokens: 12000, aiMaxCompletionTokens: 4096, aiTimeoutMs: 60000,
    aiInputPriceMicrosPerMillion: 123, aiOutputPriceMicrosPerMillion: 456
  });
  try {
    assert.equal(app.config.aiKey, 'provider-secret');
    assert.equal(app.config.aiBaseUrl, 'https://dashscope.example/v1/');
    assert.equal(app.config.aiModel, 'qwen3-vl-plus');
    assert.equal(app.config.aiMaxInputTokens, 12000);
    assert.equal(app.config.aiMaxCompletionTokens, 4096);
    assert.equal(app.config.aiTimeoutMs, 60000);
    assert.equal(app.config.aiInputPriceMicrosPerMillion, 123);
    assert.equal(app.config.aiOutputPriceMicrosPerMillion, 456);
    assert.equal(app.config.paymentMode, 'disabled');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
