import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { exchangeWechatCode } from '../server/wechat.mjs';

test('Wechat login reuses a persistent account and keeps provider secrets server-side', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'coolzou-wechat-'));
  let openId = 'synthetic-openid-a';
  const options = {
    dataDir, mode: 'live', aiMode: 'demo', paymentMode: 'disabled',
    wechatAppId: 'synthetic-app', wechatAppSecret: 'synthetic-secret',
    async wechatFetch(url, init) {
      assert.equal(url.origin, 'https://api.weixin.qq.com');
      assert.equal(url.searchParams.get('appid'), 'synthetic-app');
      assert.equal(url.searchParams.get('secret'), 'synthetic-secret');
      assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
      assert.equal(init.redirect, 'error');
      return Response.json({ openid: openId, session_key: 'synthetic-session-key' });
    }
  };
  let app;
  async function start() {
    app = await createApp(options);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  }
  const base = () => 'http://127.0.0.1:' + app.server.address().port;
  async function login(code = 'synthetic-code') {
    const response = await fetch(base() + '/api/session/wechat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, openid: 'client-forged-id' })
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.doesNotMatch(JSON.stringify(data), /synthetic-secret|synthetic-session-key|synthetic-openid|client-forged/);
    return data;
  }
  try {
    await start();
    const first = await login();
    const second = await login('synthetic-code-2');
    assert.equal(first.user.id, second.user.id);
    assert.notEqual(first.token, second.token);
    const me = await fetch(base() + '/api/me', { headers: { Authorization: 'Bearer ' + second.token } });
    assert.deepEqual((await me.json()).user, first.user);
    assert.equal((await fetch(base() + '/api/config').then(r => r.json())).dailyFreeTasks, 1);
    assert.equal((await fetch(base() + '/api/session/demo', { method: 'POST' })).status, 403);
    openId = 'synthetic-openid-b';
    assert.notEqual((await login()).user.id, first.user.id);
    await app.close(); app = null;
    await start(); openId = 'synthetic-openid-a';
    assert.equal((await login()).user.id, first.user.id);
    assert.equal(app.store.wechatUser('different-app', openId).id === first.user.id, false);
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Wechat login rejects invalid codes before any provider request', async () => {
  const config = { appId: 'app', appSecret: 'secret', fetchImpl() { assert.fail('must not request'); } };
  for (const code of [null, {}, '', ' ', 'a'.repeat(513)]) {
    await assert.rejects(exchangeWechatCode(code, config), error => error.status === 400);
  }
  await assert.rejects(exchangeWechatCode('code', { ...config, appSecret: '' }), error => error.status === 503);
});

test('Wechat failures cannot create a login or expose provider errors', async () => {
  const responses = [null, {}, { openid: 'forged' }, { errcode: 40029, errmsg: 'secret' }, { errcode: 40163 }, { errcode: 45011 }, { errcode: -1 }];
  for (const data of responses) {
    await assert.rejects(exchangeWechatCode('code', {
      appId: 'app', appSecret: 'secret', fetchImpl: async () => Response.json(data)
    }), error => error.status >= 400 && !error.message.includes('secret'));
  }
  for (const fetchImpl of [async () => { throw new Error('https://provider?secret=secret'); }, async () => new Response('secret', { status: 500 }), async () => new Response('invalid json')]) {
    await assert.rejects(exchangeWechatCode('code', { appId: 'app', appSecret: 'secret', fetchImpl }), error => error.code === 'wechat_unavailable' && !error.message.includes('secret'));
  }
});
