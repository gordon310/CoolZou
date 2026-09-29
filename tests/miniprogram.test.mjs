import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import validation from '../miniprogram/utils/validation.js';

const { validateForm } = validation;

const root = path.resolve('miniprogram');
const read = file => readFile(path.join(root, file), 'utf8');

test('mini program registers the required pages and stays unbound to an app secret', async () => {
  const app = JSON.parse(await read('app.json'));
  assert.deepEqual(app.pages, ['pages/index/index', 'pages/outline/outline', 'pages/preview/preview', 'pages/works/works', 'pages/orders/orders']);
  const source = await read('utils/api.js');
  assert.doesNotMatch(source, /APP_SECRET|AppSecret|private_key/i);
  assert.match(source, /session\/wechat/);
});

test('mini program scripts use syntax accepted by the upload compiler', async () => {
  const files = ['utils/api.js', 'pages/index/index.js', 'pages/preview/preview.js'];
  for (const file of files) assert.doesNotMatch(await read(file), /\?\./);
});

test('mini program validates required creation fields before calling the API', () => {
  const base = { title: '活动', age: 7, gender: 'boy', content: '观察活动，介绍叶片颜色', photoIds: ['asset'], template: 'fresh', consent: true };
  assert.equal(validateForm(base), '');
  assert.match(validateForm({ ...base, photoIds: [] }), /照片/);
  assert.match(validateForm({ ...base, consent: false }), /授权/);
  assert.match(validateForm({ ...base, content: '' }), /演示稿描述/);
});

test('mini program obtains explicit consent before sending creation materials to the AI service', async () => {
  const indexWxml = await read('pages/index/index.wxml');
  assert.match(indexWxml, /同意将上传的照片和填写的信息发送至通义千问（DashScope）AI 服务/);
  assert.match(indexWxml, /仅用于本次 PPT 生成/);
});

test('mini program form controls keep stable native-component dimensions', async () => {
  const styles = await read('app.wxss');
  const indexWxml = await read('pages/index/index.wxml');
  assert.match(styles, /\.input\s*\{[^}]*height:\s*88rpx;[^}]*padding:\s*0 22rpx;/s);
  assert.match(styles, /\.picker\s*\{[^}]*min-height:\s*88rpx;/s);
  assert.match(styles, /\.textarea\s*\{[^}]*height:\s*220rpx;[^}]*line-height:\s*1\.55;/s);
  assert.match(styles, /\.control-placeholder\s*\{[^}]*color:/s);
  assert.equal((indexWxml.match(/placeholder-class="control-placeholder"/g) || []).length, 3);
});

test('photo uploader explains compression and twenty-photo size limits', async () => {
  const indexWxml = await read('pages/index/index.wxml');
  const indexJs = await read('pages/index/index.js');
  const webIndex = await readFile(path.resolve('web/index.html'), 'utf8');
  const webApp = await readFile(path.resolve('web/app.js'), 'utf8');
  assert.match(indexWxml, /系统自动压缩后上传/);
  assert.match(indexWxml, /最多 \{\{config\.maxPhotos\}\} 张/);
  assert.match(indexWxml, /单张不超过 1MB/);
  assert.match(indexWxml, /总上传不超过 20MB/);
  assert.match(indexJs, /config: \{ maxPhotos: 20 \}/);
  assert.match(webIndex, /系统自动压缩后上传/);
  assert.match(webIndex, /最多 20 张/);
  assert.match(webIndex, /单张不超过 1MB/);
  assert.match(webIndex, /总上传不超过 20MB/);
  assert.match(webApp, /function compressPhoto/);
  assert.match(webApp, /不能超过 20MB/);
});

test('photo uploader uses the image-only picker so its privacy declaration does not include video', async () => {
  const index = await read('pages/index/index.js');
  assert.match(index, /wx\.chooseImage\(/);
  assert.doesNotMatch(index, /wx\.chooseMedia\(/);
});

test('mini program template selector is one row of three checked radio-style buttons', async () => {
  const styles = await read('app.wxss');
  const index = await read('pages/index/index.js');
  const indexWxml = await read('pages/index/index.wxml');
  assert.match(styles, /\.template-list\s*\{[^}]*display:\s*flex;/s);
  assert.match(styles, /\.template-option\s*\{[^}]*flex:\s*1;[^}]*height:\s*88rpx;/s);
  assert.match(styles, /\.template-option\.selected\s*\{[^}]*border-color:\s*#26735b;[^}]*background:\s*#f1f7f3;/s);
  assert.match(indexWxml, /class="template-check"[^>]*>{{form\.template === item\.value \? '✓' : ''}}/);
  assert.doesNotMatch(indexWxml, /template-description|item\.description/);
  assert.doesNotMatch(index, /description:/);
});

test('mini program puts free and full downloads after the five-page preview', async () => {
  const index = await read('pages/index/index.js');
  const outline = await read('pages/outline/outline.js');
  const preview = await read('pages/preview/preview.js');
  const previewWxml = await read('pages/preview/preview.wxml');
  assert.match(index, /chooseImage/);
  assert.match(index, /createDeck/);
  assert.match(index, /content/);
  assert.match(index, /templates/);
  assert.match(index, /清新自然/);
  assert.match(index, /活力童趣/);
  assert.match(index, /简洁汇报/);
  assert.match(outline, /updateOutline/);
  assert.match(outline, /generate/);
  assert.match(preview, /downloadPpt\(this\.deckId, variant\)/);
  assert.match(preview, /showActionSheet/);
  assert.doesNotMatch(previewWxml, /收费|支付|付款|¥/);
  assert.equal((previewWxml.match(/bindtap="downloadFree"/g) || []).length, 1);
  assert.equal((previewWxml.match(/bindtap="downloadFull"/g) || []).length, 1);
  assert.match(previewWxml, /免费下载/);
  assert.match(previewWxml, /下载完整版（共{{deck.actualPages}}页）/);
  assert.match(preview, /downloadFree\(\)/);
  assert.match(preview, /50元/);
  const indexWxml = await read('pages/index/index.wxml');
  assert.match(indexWxml, /演示稿描述/);
  assert.match(indexWxml, /逐页编辑大纲/);
  assert.doesNotMatch(indexWxml, /免费|收费|支付|付款|¥/);
  assert.match(indexWxml, /data-field="age"/);
  assert.match(indexWxml, /年龄/);
  assert.doesNotMatch(indexWxml, /PPT 类型/);
  assert.match(index, /reviewOutline: false/);
  assert.match(indexWxml, /PPT 风格模板/);
});
