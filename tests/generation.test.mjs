import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { randomBytes } from 'node:crypto';
import { validateInput, validateSlides } from '../server/validation.mjs';
import { makeDemoOutline, makePrompt } from '../server/outline.mjs';
import { exportDeck } from '../server/ppt.mjs';

const input = {
  title: '校园科学活动', nickname: '小同学', grade: 3, gender: 'boy',
  requirements: '用简短的句子记录活动', template: 'fresh',
  flow: '进入植物园\n观察叶片\n记录颜色\n比较形状\n整理观察记录\n交流发现',
  pageCount: 12, theme: 'green', photoIds: ['photo1', 'photo2'], consent: true
};

test('photo-heavy exports stay below five MB without losing slides or editable text', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kidsppt-size-'));
  try {
    const photo = path.join(dir, 'noise.jpg');
    await sharp(randomBytes(1920 * 1080 * 3), { raw: { width: 1920, height: 1080, channels: 3 } }).jpeg({ quality: 95 }).toFile(photo);
    const slides = Array.from({ length: 20 }, (_, i) => ({ title: '页面' + i, body: '保留可编辑文字', notes: '保留讲稿', photoIds: ['photo1'] }));
    const files = await exportDeck(slides, [{ id: 'photo1', path: photo }], dir, input);
    for (const [file, count] of [[files.free, 5], [files.full, 20]]) {
      const bytes = await readFile(file);
      assert.ok(bytes.length <= 5000000, String(bytes.length));
      const zip = await JSZip.loadAsync(bytes);
      assert.equal(Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, count);
      assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /保留可编辑文字/);
      assert.equal(Object.keys(zip.files).filter(n => /^ppt\/media\/.+\.jpeg$/.test(n)).length, count);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validates the simplified form without requiring age or type', () => {
  for (const patch of [{ grade: 7 }, { gender: 'x' }, { requirements: ' ' }, { flow: '' }, { photoIds: [] }, { photoIds: ['p', 'p'] }, { consent: false }, { pageCount: 21 }]) {
    assert.throws(() => validateInput({ ...input, ...patch }), /./);
  }
  assert.equal(validateInput(input).grade, 3);
  assert.equal(validateInput(input).reviewOutline, false);
  assert.equal(validateInput({ ...input, reviewOutline: true }).reviewOutline, true);
});

test('accepts only ages five through eighteen and uses age in the deck copy', () => {
  const ageInput = { ...input, grade: undefined, age: 7 };
  const normalized = validateInput(ageInput);
  assert.equal(normalized.age, 7);
  assert.equal('grade' in normalized, false);
  assert.match(makePrompt(normalized), /7岁/);
  assert.throws(() => validateInput({ ...ageInput, age: 4 }), /年龄不符合要求/);
  assert.throws(() => validateInput({ ...ageInput, age: 19 }), /年龄不符合要求/);
});

test('rejects slide photos outside the current work and oversized copy', () => {
  const good = Array.from({ length: 5 }, () => ({ title: '观察', body: '叶片颜色', notes: '', photoIds: ['photo1'] }));
  assert.equal(validateSlides(good, ['photo1']).length, 5);
  assert.throws(() => validateSlides([{ ...good[0], photoIds: ['other-user-photo'] }, ...good.slice(1)], ['photo1']));
  assert.throws(() => validateSlides([{ ...good[0], body: '超'.repeat(181) }, ...good.slice(1)], ['photo1']));
});

test('demo outline preserves supplied flow and prompt includes child parameters', () => {
  const normalized = validateInput(input);
  const outline = makeDemoOutline(normalized);
  assert.ok(outline.length >= 5 && outline.length <= 12);
  assert.ok(outline.some(s => s.body.includes('观察叶片')));
  const prompt = makePrompt(normalized);
  assert.match(prompt, /3/);
  assert.match(prompt, /不.*编造/);
  assert.notEqual(prompt, makePrompt(validateInput({ ...input, grade: 1, gender: 'girl' })));
});

test('AI prompt requests the structured slides object contract', () => {
  const prompt = makePrompt(validateInput(input));
  assert.match(prompt, /JSON对象/);
  assert.match(prompt, /slides/);
});

test('local copy preserves concrete topics without fabricated first-person filler', () => {
  const outline = makeDemoOutline(validateInput(input));
  const step = outline.find(slide => slide.title === '观察叶片');
  assert.equal(step.body, '观察叶片');
  assert.doesNotMatch(JSON.stringify(outline), /我先完成|我认真听|更清楚的认识|活动过程 \d/);
  assert.match(makePrompt(validateInput(input)), /清新自然/);
});

test('numbered scripts preserve all twelve topics as one-sentence cards', () => {
  const topics = ['开场', '膳食宝塔', '餐盘搭配', '科普栏', '阅读区', '快检实验', '清洗提醒', '同学分享一', '同学分享二', '行动', '活动小记', '结束'];
  const content = '主持稿\n共12页。建议总时长9分钟。\n' + topics.map((topic, i) => `第${i + 1}页｜${topic}\n${topic}的具体内容。\n【主持准备，不朗读】下一页切换提示。\n--------------------`).join('\n');
  const slides = makeDemoOutline(validateInput({ ...input, content }));
  assert.deepEqual(slides.map(s => s.title), topics);
  assert.doesNotMatch(slides.map(s => s.body).join(''), /共12页|总时长|主持准备|切换提示|我先完成/);
  assert.ok(slides.every(slide => slide.body.length <= 60 && slide.notes === ''));
  assert.equal(validateSlides(slides, input.photoIds).length, 12);
});

test('long descriptions become short cards without speaker notes', () => {
  const content = Array.from({ length: 101 }, (_, i) => `第${i + 1}个观察发现。`).join('\n');
  const slides = makeDemoOutline(validateInput({ ...input, content }));
  assert.ok(slides.every(s => s.notes === ''));
  assert.ok(slides.every(s => s.body.length <= 60));
  assert.equal(validateSlides(slides, input.photoIds).length, 12);
});

test('template selection is normalized before the deck is stored', () => {
  assert.equal(validateInput({ ...input, template: 'playful' }).template, 'playful');
  assert.equal(validateInput({ ...input, template: 'missing-template' }).template, 'fresh');
});

test('merged activity content and writing requirements are accepted as one field', () => {
  const content = '参观食品安全展览\n记录洗手步骤\n希望用三年级孩子口吻，扩写观察和收获';
  const normalized = validateInput({ ...input, content, flow: undefined, requirements: undefined });
  assert.equal(normalized.content, content);
  assert.equal(normalized.flow, content);
  assert.equal(normalized.requirements, content);
  assert.match(makePrompt(normalized), /参观食品安全展览/);
  assert.ok(makeDemoOutline(normalized).some(slide => slide.body.includes('记录洗手步骤')));
  assert.equal(makeDemoOutline(normalized).length, 4);
});

test('free export contains only five pages and free media', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kidsppt-export-'));
  try {
    const first = path.join(dir, 'first.png');
    const paid = path.join(dir, 'paid.png');
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#147b68' } }).png().toFile(first);
    await sharp({ create: { width: 300, height: 600, channels: 3, background: '#df5d66' } }).png().toFile(paid);
    const slides = Array.from({ length: 8 }, (_, i) => ({ title: i < 5 ? '观察 ' + (i + 1) : 'ONLY_PAID_PAGE', body: i < 5 ? '认真记录叶片的形状。' : 'PRIVATE_PAID_BODY', notes: i < 5 ? '我的观察记录' : 'PRIVATE_PAID_NOTES', photoIds: [i < 5 ? 'photo1' : 'photo2'] }));
    const files = await exportDeck(slides, [{ id: 'photo1', path: first }, { id: 'photo2', path: paid }], path.join(dir, 'output'), input);
    const free = await JSZip.loadAsync(await readFile(files.free));
    const full = await JSZip.loadAsync(await readFile(files.full));
    const pages = zip => Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    assert.equal(pages(free).length, 5);
    assert.equal(pages(full).length, 8);
    const xml = (await Promise.all(Object.keys(free.files).filter(name => name.endsWith('.xml')).map(name => free.file(name).async('string')))).join('');
    assert.doesNotMatch(xml, /ONLY_PAID_PAGE|PRIVATE_PAID_BODY|PRIVATE_PAID_NOTES/);
    assert.equal(Object.keys(free.files).filter(name => /^ppt\/media\//.test(name) && !free.files[name].dir).length, 5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('portrait photos remain proportional and fit inside the smaller photo area', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kidsppt-portrait-'));
  try {
    const portrait = path.join(dir, 'portrait.jpg');
    await sharp({ create: { width: 1280, height: 1707, channels: 3, background: '#147b68' } }).jpeg().toFile(portrait);
    const slides = Array.from({ length: 5 }, () => ({ title: '竖图测试', body: '照片应完整等比例显示。', notes: '', photoIds: ['photo1'] }));
    const files = await exportDeck(slides, [{ id: 'photo1', path: portrait }], dir, { ...input, grade: undefined, age: 5 });
    const zip = await JSZip.loadAsync(await readFile(files.free));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const [, width, height] = xml.match(/<p:pic>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>[\s\S]*?<\/p:pic>/);
    assert.ok(Math.abs(Number(width) / Number(height) - 1280 / 1707) < 0.01);
    assert.ok(Number(width) / 914400 <= 4.5);
    assert.ok(Number(height) / 914400 <= 4.1);
    assert.match(xml, /5岁/);
    assert.ok((xml.match(/prst="roundRect"/g) || []).length >= 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
