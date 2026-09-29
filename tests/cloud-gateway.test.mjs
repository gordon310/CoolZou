import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../cloud-gateway/server.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('gateway rejects oversized bodies before forwarding and cancels disconnected upstream requests', async () => {
  let forwarded = 0;
  let aborted = false;
  const upstream = http.createServer((req, res) => {
    forwarded++;
    res.on('close', () => { aborted = true; });
  });
  await listen(upstream);
  const gateway = createGateway({ upstreamOrigin: 'http://127.0.0.1:' + upstream.address().port, gatewaySecret: 'synthetic', allowInsecureUpstream: true });
  await listen(gateway);
  const base = 'http://127.0.0.1:' + gateway.address().port;
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(base + '/upload/assets', { method: 'POST', headers: { authorization: 'Bearer test', 'content-length': '2000001' } }, res => { res.resume(); resolve(res.statusCode); req.destroy(); });
      req.on('error', reject);
      req.flushHeaders();
    });
    assert.equal(status, 413);
    assert.equal(forwarded, 0);
    const invalidStatus = await new Promise((resolve, reject) => {
      const req = http.get(base, { path: '//[' }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(invalidStatus, 400);
    const req = http.get(base + '/api/hold');
    req.on('error', () => {});
    for (let i = 0; i < 100 && !forwarded; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(forwarded, 1);
    req.destroy();
    for (let i = 0; i < 100 && !aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(aborted, true);
  } finally { gateway.closeAllConnections(); upstream.closeAllConnections(); await close(gateway); await close(upstream); }
});

test('gateway streams approved routes and replaces untrusted forwarding headers', async () => {
  let received;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await listen(upstream);
  const gateway = createGateway({
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    gatewaySecret: 'server-only-secret',
    allowInsecureUpstream: true
  });
  await listen(gateway);

  try {
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/api/example?q=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://untrusted.example', 'x-coolzou-gateway': 'forged' },
      body: JSON.stringify({ value: 7 })
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-upstream'), 'yes');
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/api/example?q=1');
    assert.equal(received.body, '{"value":7}');
    assert.equal(received.headers.origin, undefined);
    assert.equal(received.headers['x-coolzou-gateway'], 'server-only-secret');

    assert.equal((await fetch(`http://127.0.0.1:${gateway.address().port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${gateway.address().port}/private`)).status, 404);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test('gateway refuses an insecure production upstream', () => {
  assert.throws(
    () => createGateway({ upstreamOrigin: 'http://43.142.125.248:4317', gatewaySecret: 'secret' }),
    /HTTPS/
  );
});

test('production gateway requires WeChat context for APIs and exposes only authenticated media paths', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await listen(upstream);
  const gateway = createGateway({
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    gatewaySecret: 'secret',
    allowInsecureUpstream: true,
    requireWechatContext: true
  });
  await listen(gateway);

  try {
    const base = `http://127.0.0.1:${gateway.address().port}`;
    assert.equal((await fetch(base + '/api/config')).status, 403);
    assert.equal((await fetch(base + '/api/config', { headers: { 'x-wx-openid': 'openid' } })).status, 200);
    assert.equal((await fetch(base + '/media/assets/asset-1', { headers: { authorization: 'Bearer token' } })).status, 200);
    assert.deepEqual(seen, ['/api/config', '/api/assets/asset-1']);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test('gateway logs upstream connection failures while keeping the client response generic', async () => {
  const unavailable = http.createServer();
  await listen(unavailable);
  const port = unavailable.address().port;
  await close(unavailable);

  const errors = [];
  const gateway = createGateway({
    upstreamOrigin: `http://127.0.0.1:${port}`,
    gatewaySecret: 'secret',
    allowInsecureUpstream: true,
    requireWechatContext: false,
    logger: { error: (...args) => errors.push(args) }
  });
  await listen(gateway);

  try {
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/api/config`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: { code: 'gateway_unavailable', message: '生成服务暂时不可用' } });
    assert.equal(errors.length, 1);
    assert.match(errors[0].join(' '), /ECONNREFUSED/);
  } finally {
    await close(gateway);
  }
});

test('gateway streams authenticated file uploads to the backend upload endpoint', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"id":"asset-1"}');
    });
  });
  await listen(upstream);
  const gateway = createGateway({
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    gatewaySecret: 'secret',
    allowInsecureUpstream: true,
    requireWechatContext: true
  });
  await listen(gateway);

  try {
    const base = `http://127.0.0.1:${gateway.address().port}`;
    assert.equal((await fetch(base + '/upload/assets', { method: 'POST', body: 'file-data' })).status, 401);
    const response = await fetch(base + '/upload/assets', {
      method: 'POST', headers: { authorization: 'Bearer session-token', 'content-type': 'multipart/form-data; boundary=test' }, body: 'file-data'
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { id: 'asset-1' });
    assert.deepEqual(seen, [{ url: '/api/assets/upload', authorization: 'Bearer session-token', body: 'file-data' }]);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});
