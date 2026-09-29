import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';

async function fixture(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'coolzou-reliability-'));
  const events = [];
  const app = await createApp({ dataDir, mode: 'demo', aiMode: 'demo', logger: (event, fields) => events.push({ event, ...fields }), ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const token = () => app.store.makeToken(app.store.createUser().id);
  return { app, base, dataDir, events, token, close: async () => { await app.close(); await rm(dataDir, { force: true, recursive: true }); } };
}

function hold(base, route, token) {
  const req = http.request(base + route, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
  req.on('error', () => {});
  req.write('{');
  return req;
}

async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('condition not reached');
}

test('20 simultaneous uploads are bounded and disconnected requests release slots', async () => {
  const h = await fixture();
  const held = [hold(h.base, '/api/assets', h.token()), hold(h.base, '/api/assets', h.token())];
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    const tokens = Array.from({ length: 20 }, h.token);
    const results = await Promise.all(tokens.map(token => fetch(h.base + '/api/assets', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}' })));
    assert.ok(results.every(r => r.status === 429));
    assert.equal((await fetch(h.base + '/health')).status, 200);
    held.forEach(req => req.destroy());
    await until(async () => (await fetch(h.base + '/api/assets', { method: 'POST', headers: { authorization: 'Bearer ' + h.token(), 'content-type': 'application/json' }, body: '{}' })).status === 400);
  } finally { held.forEach(req => req.destroy()); await h.close(); }
});

test('request overload leaves health responsive and returns a retryable error', async () => {
  const h = await fixture();
  const invalidStatus = await new Promise((resolve, reject) => {
    const req = http.get(h.base, { path: '//[' }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(invalidStatus, 400);
  const token = h.token();
  const held = Array.from({ length: 32 }, () => hold(h.base, '/api/decks', token));
  try {
    await until(async () => (await fetch(h.base + '/api/config')).status === 503);
    assert.equal((await fetch(h.base + '/health')).status, 200);
  } finally { held.forEach(req => req.destroy()); await h.close(); }
});

test('small compressed image cannot expand beyond the pixel limit', async () => {
  const h = await fixture();
  try {
    const image = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#ffffff' } }).png().toBuffer();
    assert.ok(image.length < 1000000);
    const response = await fetch(h.base + '/api/assets', { method: 'POST', headers: { authorization: 'Bearer ' + h.token(), 'content-type': 'application/json' }, body: JSON.stringify({ data: image.toString('base64') }) });
    assert.equal(response.status, 400);
    assert.equal(h.app.store.db.prepare('SELECT count(*) n FROM assets').get().n, 0);
  } finally { await h.close(); }
});

test('low disk space blocks writes while health and reads remain available', async () => {
  const h = await fixture({ minDiskBytes: Number.MAX_SAFE_INTEGER });
  try {
    const response = await fetch(h.base + '/api/assets', { method: 'POST', headers: { authorization: 'Bearer ' + h.token() }, body: '{}' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'disk_low');
    assert.equal((await fetch(h.base + '/health')).status, 200);
    assert.ok(h.events.some(e => e.event === 'disk_low'));
  } finally { await h.close(); }
});

test('pending uploads and generation queues have hard limits; cleanup preserves linked photos', async () => {
  const h = await fixture();
  try {
    const user = h.app.store.createUser();
    for (let i = 0; i < 30; i++) {
      const file = path.join(h.app.store.filesDir, i + '.jpg');
      await writeFile(file, 'synthetic');
      h.app.store.createAsset({ id: 'asset-' + i, userId: user.id, filePath: file, name: 'synthetic', mime: 'image/jpeg', width: 1, height: 1 });
    }
    assert.throws(() => h.app.store.assertUploadSpace(user.id), /30/);
    h.app.store.createDeck({ id: 'keep', userId: user.id, input: { photoIds: ['asset-0'] } });
    h.app.store.db.prepare("UPDATE assets SET created_at='2020-01-01T00:00:00.000Z'").run();
    await h.app.maintenance();
    assert.equal(h.app.store.db.prepare('SELECT count(*) n FROM assets').get().n, 1);
    assert.equal(await readFile(path.join(h.app.store.filesDir, '0.jpg'), 'utf8'), 'synthetic');
    for (let i = 1; i < 100; i++) h.app.store.createDeck({ id: 'deck-' + i, userId: user.id, input: { photoIds: [] } });
    assert.throws(() => h.app.store.createDeck({ id: 'overflow', userId: user.id, input: { photoIds: [] } }), /较多/);
    assert.equal(h.app.store.getDeck('overflow', user.id), null);
  } finally { await h.close(); }
});

test('a stalled job fails health without releasing its concurrency slot', async () => {
  let release;
  const h = await fixture({ jobTimeoutMs: 10, phaseGenerator: () => new Promise(resolve => { release = resolve; }) });
  const user = h.app.store.createUser();
  h.app.store.createDeck({ id: 'stalled', userId: user.id, input: { photoIds: [], reviewOutline: true } });
  const task = h.app.processNext();
  try {
    await until(() => h.app.worker.isStalled());
    assert.equal((await fetch(h.base + '/health')).status, 503);
    assert.equal(h.app.worker.running.size, 1);
  } finally { release([{ title: '合成', body: '', notes: '', photoIds: [] }]); await task; await h.close(); }
});

test('restart records interrupted work without blindly repeating model calls', async () => {
  const h = await fixture();
  const user = h.app.store.createUser();
  h.app.store.createDeck({ id: 'interrupted', userId: user.id, input: { photoIds: [] } });
  h.app.store.claimJob();
  await h.app.close();
  const app = await createApp({ dataDir: h.dataDir, mode: 'demo', aiMode: 'demo', logger: (event, fields) => h.events.push({ event, ...fields }) });
  try {
    assert.equal(app.store.getDeck('interrupted', user.id).status, 'failed');
    assert.equal(app.store.nextJob(), null);
    assert.ok(h.events.some(e => e.event === 'job_interrupted' && e.deckId === 'interrupted'));
  } finally { await app.close(); await rm(h.dataDir, { recursive: true, force: true }); }
});

test('uncaught exceptions leave a durable crash record and a nonzero exit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coolzou-fatal-'));
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', "await import('./server/main.mjs'); setTimeout(() => { throw new Error('synthetic-private-payload'); }, 50);"], { env: { ...process.env, DATA_DIR: dir, APP_MODE: 'demo', AI_MODE: 'demo', PORT: '0', GATEWAY_SECRET: '' }, stdio: 'ignore' });
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    assert.equal(code, 1);
    const log = await readFile(path.join(dir, 'logs/events.jsonl'), 'utf8');
    assert.match(log, /fatal_exception/);
    assert.doesNotMatch(log, /synthetic-private-payload/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
