import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';
import { createGateway } from '../cloud-gateway/server.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('photo travels through the authenticated gateway upload and protected download paths', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'coolzou-upload-e2e-'));
  const secret = 'local-e2e-gateway-secret';
  const app = await createApp({ dataDir, mode: 'demo', aiMode: 'demo', gatewaySecret: secret });
  await listen(app.server);
  const gateway = createGateway({
    upstreamOrigin: `http://127.0.0.1:${app.server.address().port}`,
    gatewaySecret: secret,
    allowInsecureUpstream: true,
    requireWechatContext: true
  });
  await listen(gateway);

  try {
    const backend = `http://127.0.0.1:${app.server.address().port}`;
    const gatewayBase = `http://127.0.0.1:${gateway.address().port}`;
    const session = await fetch(backend + '/api/session/demo', {
      method: 'POST', headers: { 'x-coolzou-gateway': secret, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(session.status, 201);
    const token = (await session.json()).token;

    const image = await sharp({ create: { width: 960, height: 540, channels: 3, background: '#df655f' } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('name', '本地联调照片.jpg');
    form.append('file', new Blob([image], { type: 'image/jpeg' }), 'activity.jpg');
    const uploaded = await fetch(gatewayBase + '/upload/assets', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
    });
    assert.equal(uploaded.status, 201);
    const asset = await uploaded.json();
    assert.match(asset.id, /^asset_/);

    const downloaded = await fetch(gatewayBase + asset.url.replace(/^\/api/, '/media'), {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('content-type'), 'image/jpeg');
    assert.ok((await downloaded.arrayBuffer()).byteLength > 100);
    assert.equal((await fetch(gatewayBase + '/api/config')).status, 403);
  } finally {
    await close(gateway);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
