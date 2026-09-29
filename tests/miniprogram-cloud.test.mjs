import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('miniprogram/utils/api.js', 'utf8');

function loadApi({ cloud = true } = {}) {
  const calls = { container: [], request: [], upload: [], download: [], write: [], open: [], init: [] };
  const logs = [];
  const app = { globalData: {
    apiBaseUrl: 'http://127.0.0.1:4317', token: 'user-token', config: null,
    cloud: cloud ? {
      enabled: true,
      env: 'prod-d5gx1s4o899f5b776',
      service: 'express-5r3p',
      publicBaseUrl: 'https://express.example.tcloudbase.com'
    } : { enabled: false }
  } };
  const responses = [];
  const wx = {
    cloud: {
      init(options) { calls.init.push(options); },
      callContainer(options) {
        calls.container.push(options);
        const response = responses.shift() || { statusCode: 200, data: { ok: true } };
        options.success(response);
      }
    },
    request(options) { calls.request.push(options); options.success(responses.shift() || { statusCode: 200, data: { ok: true } }); },
    uploadFile(options) {
      calls.upload.push(options);
      options.success({ statusCode: 201, data: JSON.stringify({ id: 'asset-uploaded', url: '/api/assets/asset-uploaded' }) });
    },
    env: { USER_DATA_PATH: '/tmp/wx' },
    getFileSystemManager() { return { getFileInfo(options) { options.success({ size: 1000000 }); }, writeFile(options) { calls.write.push(options); options.success(); }, readFile() { throw new Error('base64 upload transport used'); } }; },
    downloadFile(options) { calls.download.push(options); options.success({ statusCode: 200, tempFilePath: '/tmp/result.bin' }); },
    openDocument(options) { calls.open.push(options); options.success(); }
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, getApp: () => app, wx, Promise, Map, Error, setTimeout: callback => callback(), console: { error(...args) { logs.push(args); } } });
  return { api: module.exports, app, wx, calls, responses, logs };
}

test('cloud transport sends JSON API through callContainer with service and token', async () => {
  const h = loadApi();
  const result = await h.api.request('/api/example?q=1', 'POST', { value: 7 });
  assert.equal(result.ok, true);
  assert.equal(h.calls.request.length, 0);
  assert.equal(h.calls.container.length, 1);
  assert.equal(h.calls.container[0].config.env, 'prod-d5gx1s4o899f5b776');
  assert.equal(h.calls.container[0].path, '/api/example?q=1');
  assert.equal(h.calls.container[0].header['X-WX-SERVICE'], 'express-5r3p');
  assert.equal(h.calls.container[0].header.Authorization, 'Bearer user-token');
});

test('cloud transport preserves API errors and local mode still uses wx.request', async () => {
  const cloud = loadApi();
  cloud.responses.push({ statusCode: 429, data: { error: { code: 'daily_quota', message: '明天再试' } } });
  await assert.rejects(cloud.api.request('/api/decks'), error => error.status === 429 && error.code === 'daily_quota' && error.message === '明天再试');

  const local = loadApi({ cloud: false });
  await local.api.request('/api/config');
  assert.equal(local.calls.container.length, 0);
  assert.equal(local.calls.request[0].url, 'http://127.0.0.1:4317/api/config');
});

test('cloud transport hides raw platform errors from the page', async () => {
  const h = loadApi();
  h.wx.cloud.callContainer = options => options.fail({ errCode: -501000, errMsg: 'cloud.callContainer:fail system error with internal trace' });
  await assert.rejects(h.api.request('/api/config'), error => {
    assert.equal(error.message, '生成服务暂时不可用，请稍后重试');
    assert.doesNotMatch(error.message, /callContainer|trace/i);
    return true;
  });
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0][0], '[KIDSPPT transport failure]');
  assert.equal(h.logs[0][1].code, -501000);
  assert.match(h.logs[0][1].message, /callContainer/);
});

test('protected photos use the CloudBase public URL while PPT downloads stay inside callContainer', async () => {
  const h = loadApi();
  h.responses.push({ statusCode: 200, data: { deck: { id: 'deck-1', photos: [{ id: 'asset-1', url: '/api/assets/asset-1' }], slides: [] } } });
  const deck = await h.api.getDeck('deck-1');
  assert.equal(deck.deck.photos[0].url, '/tmp/result.bin');
  assert.equal(h.calls.download[0].url, 'https://express.example.tcloudbase.com/media/assets/asset-1');
  assert.equal(h.calls.download[0].header.Authorization, 'Bearer user-token');

  h.responses.push({ statusCode: 200, data: { url: '/download/ticket', filename: '活动.pptx' } });
  h.responses.push({ statusCode: 200, data: new ArrayBuffer(3) });
  await h.api.downloadPpt('deck-1', 'free');
  assert.equal(h.calls.download.length, 1);
  assert.equal(h.calls.container[2].path, '/download/ticket');
  assert.equal(h.calls.container[2].header['X-WX-SERVICE'], 'express-5r3p');
  assert.equal(h.calls.container[2].responseType, 'arraybuffer');
  assert.equal(h.calls.write[0].filePath, '/tmp/wx/deck-1-free.pptx');
  assert.equal(h.calls.open[0].fileType, 'pptx');
});

test('photos use authenticated file upload instead of callContainer base64 payloads', async () => {
  const h = loadApi();
  const result = await h.api.uploadImage('/tmp/activity.jpg', '活动图片.jpg');
  assert.equal(result.id, 'asset-uploaded');
  assert.equal(result.url, '/tmp/activity.jpg');
  assert.equal(h.calls.upload.length, 1);
  assert.equal(h.calls.upload[0].url, 'https://express.example.tcloudbase.com/upload/assets');
  assert.equal(h.calls.upload[0].name, 'file');
  assert.equal(h.calls.upload[0].header.Authorization, 'Bearer user-token');
  assert.equal(h.calls.upload[0].formData.name, '活动图片.jpg');
  assert.equal(h.calls.container.length, 0);
});

test('mini program initializes the configured CloudBase environment once', async () => {
  const appSource = await readFile('miniprogram/app.js', 'utf8');
  let definition;
  const calls = [];
  vm.runInNewContext(appSource, { App(value) { definition = value; }, wx: { cloud: { init(options) { calls.push(options); } } } });
  definition.onLaunch();
  assert.equal(calls[0].env, 'prod-d5gx1s4o899f5b776');
  assert.equal(calls[0].traceUser, true);
});

test('oversized photos are compressed before upload and rejected if still too large', async () => {
  const h = loadApi();
  h.wx.getFileSystemManager = () => ({ getFileInfo: o => o.success({ size: o.filePath === '/tmp/small.jpg' ? 999999 : 1000001 }) });
  h.wx.compressImage = o => o.success({ tempFilePath: '/tmp/small.jpg' });
  await h.api.uploadImage('/tmp/large.jpg', 'photo');
  assert.equal(h.calls.upload[0].filePath, '/tmp/small.jpg');
  h.wx.compressImage = o => o.success({ tempFilePath: '/tmp/still-large.jpg' });
  await assert.rejects(h.api.uploadImage('/tmp/large.jpg', 'photo'), /1 MB/);
  assert.equal(h.calls.upload.length, 1);
});

test('upload backpressure retries are bounded and other upload errors are not retried', async () => {
  const h = loadApi();
  let calls = 0;
  h.wx.uploadFile = options => { calls++; options.success({ statusCode: 429, data: JSON.stringify({ error: { code: 'upload_busy', message: 'busy' } }) }); };
  await assert.rejects(h.api.uploadImage('/tmp/photo.jpg', 'photo'), /busy/);
  assert.equal(calls, 6);
  calls = 0;
  h.wx.uploadFile = options => { calls++; options.success({ statusCode: 503, data: JSON.stringify({ error: { code: 'disk_low', message: 'disk' } }) }); };
  await assert.rejects(h.api.uploadImage('/tmp/photo.jpg', 'photo'), /disk/);
  assert.equal(calls, 1);
});
