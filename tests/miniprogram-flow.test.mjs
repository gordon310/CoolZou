import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import validation from '../miniprogram/utils/validation.js';

async function pageHarness(name, api, wxOverrides = {}) {
  let page;
  const navigation = [], timers = [];
  vm.runInNewContext(await readFile(`miniprogram/pages/${name}/${name}.js`, 'utf8'), {
    require: module => module.endsWith('validation') ? validation : api,
    Page(options) {
      page = { ...options, data: structuredClone(options.data), setData(patch) { Object.assign(this.data, patch); } };
    },
    wx: { navigateTo: options => navigation.push(options.url), redirectTo: options => navigation.push(options.url), ...wxOverrides },
    getApp: () => ({ globalData: { config: {} } }),
    setTimeout: callback => timers.push(callback), clearTimeout() {}
  });
  return { page, navigation, timers };
}

test('photo batch preserves completed uploads and ignores duplicate selection while uploading', async () => {
  let release;
  let calls = 0;
  let selections = 0;
  const { page } = await pageHarness('index', {
    async uploadImage() {
      if (++calls === 1) { await new Promise(resolve => { release = resolve; }); return { id: 'uploaded' }; }
      throw new Error('synthetic upload failure');
    }
  }, { chooseImage: options => { selections++; options.success({ tempFilePaths: ['one', 'two'] }); } });
  const first = page.chooseImages();
  await page.chooseImages();
  await Promise.resolve();
  release();
  await first;
  assert.equal(selections, 1);
  assert.equal(page.data.photos.length, 1);
  assert.equal(page.data.photos[0].id, 'uploaded');
  assert.equal(page.uploading, false);
  assert.match(page.data.error, /synthetic upload failure/);
});

test('mini program jumps to the first missing required item', async () => {
  const cases = [
    ['photos', '请上传至少一张活动照片', '#required-photos'],
    ['title', '请填写作品标题', '#required-title'],
    ['age', '请选择孩子年龄', '#required-age'],
    ['gender', '请选择孩子性别', '#required-gender'],
    ['content', '请填写演示稿描述', '#required-content'],
    ['consent', '请确认照片使用授权', '#required-consent']
  ];
  for (const [missing, message, selector] of cases) {
    const scrolls = [];
    const { page } = await pageHarness('index', {}, { pageScrollTo: options => scrolls.push(options) });
    page.data.form = { ...page.data.form, title: '植物观察', age: 7, gender: 'girl', content: '观察叶片的形状。', consent: true };
    page.data.photos = [{ id: 'photo' }];
    if (missing === 'photos') page.data.photos = [];
    else if (missing === 'consent') page.data.form.consent = false;
    else page.data.form[missing] = '';
    await page.submit();
    assert.equal(page.data.error, message);
    assert.equal(scrolls.length, 1);
    assert.equal(scrolls[0].selector, selector);
    assert.equal(scrolls[0].duration, 300);
  }
});

for (const reviewOutline of [false, true]) {
  test(`mini program creation routes to ${reviewOutline ? 'outline editing' : 'direct preview'}`, async () => {
    let submitted;
    const { page, navigation } = await pageHarness('index', {
      async createDeck(input) { submitted = input; return { deck: { id: 'sample-deck' } }; }
    });
    page.data.form = { ...page.data.form, title: '观察记录', age: 7, gender: 'girl', content: '叶片有不同形状。', consent: true, reviewOutline };
    page.data.photos = [{ id: 'photo' }];
    await page.submit();
    assert.equal(submitted.reviewOutline, reviewOutline);
    assert.equal(submitted.age, 7);
    assert.equal('grade' in submitted, false);
    assert.equal('type' in submitted, false);
    assert.equal(navigation[0], reviewOutline ? '../outline/outline?id=sample-deck' : '../preview/preview?id=sample-deck');
    assert.equal(page.data.loading, false);
  });
}

test('mini program submits a valid form only once while the request is in flight', async () => {
  let release;
  let calls = 0;
  const { page } = await pageHarness('index', {
    async createDeck() {
      calls++;
      await new Promise(resolve => { release = resolve; });
      return { deck: { id: 'sample-deck' } };
    }
  });
  page.data.form = { ...page.data.form, title: '观察记录', age: 7, gender: 'girl', content: '叶片有不同形状。', consent: true };
  page.data.photos = [{ id: 'photo' }];

  const first = page.submit();
  const second = page.submit();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
});

test('mini program direct preview polls queued work until the PPT is ready', async () => {
  let calls = 0;
  const { page, timers } = await pageHarness('preview', {
    async getDeck() { return { deck: { id: 'sample', status: ++calls === 1 ? 'queued' : 'ready', photos: [], slides: [] } }; }
  });
  page.deckId = 'sample';
  await page.load();
  assert.equal(page.data.deck.status, 'queued');
  assert.equal(timers.length, 1);
  await timers[0]();
  assert.equal(page.data.deck.status, 'ready');
  assert.equal(timers.length, 1);
});

test('mini program preview begins with a progress state, never a false ready state', async () => {
  const { page } = await pageHarness('preview', {});
  assert.equal(page.data.view.title, '正在生成你的 PPT');
  assert.equal(page.data.view.showProgress, true);
});

test('preview template binds the initial state to the progress card', async () => {
  const template = await readFile('miniprogram/pages/preview/preview.wxml', 'utf8');
  assert.match(template, /\{\{view\.title\}\}/);
  assert.match(template, /wx:if="\{\{view\.showProgress\}\}"/);
});

test('mini program preview maps active backend stages to visible progress percentages', async () => {
  const stages = [
    ['outlining', '正在整理内容', 25],
    ['queued', '等待导出', 60],
    ['rendering', '正在排版前5页', 85]
  ];
  for (const [status, stage, percent] of stages) {
    const { page } = await pageHarness('preview', {
      async getDeck() { return { deck: { id: 'sample', status, stage, photos: [], slides: [] } }; }
    });
    page.deckId = 'sample';
    await page.load();
    assert.equal(page.data.progress.percent, percent);
    assert.equal(page.data.progress.stage, stage);
  }
});

test('mini program direct preview stops polling and shows generation failures', async () => {
  const { page, timers } = await pageHarness('preview', {
    async getDeck() { return { deck: { status: 'failed', error: '请补充具体演示内容', photos: [], slides: [] } }; }
  });
  await page.load();
  assert.equal(page.data.error, '请补充具体演示内容');
  assert.equal(timers.length, 0);
});

test('mini program paid preview keeps polling and never downloads an unfinished full file', async () => {
  let downloads = 0;
  const { page, timers } = await pageHarness('preview', {
    async getDeck() { return { deck: { id: 'paid', status: 'queued', paid: true, fullReady: false, photos: [], slides: [], directory: [] } }; },
    async downloadPpt() { downloads++; }
  });
  await page.load();
  assert.equal(timers.length, 1);
  assert.equal(downloads, 0);
});
