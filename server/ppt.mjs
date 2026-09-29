import fs from 'node:fs/promises';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { validateSlides } from './validation.mjs';
import { templates } from './templates.mjs';

const colors = { ink: '202523' };
const photoFrame = { x: 7.35, y: 1.78, w: 5.15, h: 3.35 };

function fitPhoto(photo) {
  const scale = Math.min(photoFrame.w / photo.width, photoFrame.h / photo.height);
  const w = photo.width * scale;
  const h = photo.height * scale;
  return { x: photoFrame.x + (photoFrame.w - w) / 2, y: photoFrame.y + (photoFrame.h - h) / 2, w, h };
}

function addPage(pptx, data, photos, index, total, metadata) {
  const slide = pptx.addSlide();
  const style = templates[metadata.template] || templates.fresh;
  slide.background = { color: style.page };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.1, fill: { color: style.accent }, line: { color: style.accent } });
  const accent = style.accent;
  slide.addText(metadata.title || '我的活动记录', { x: 0.58, y: 0.28, w: 8.8, h: 0.22, fontFace: 'Microsoft YaHei', fontSize: 10, bold: true, color: accent, margin: 0, breakLine: false });
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.58, y: 1.35, w: 6.1, h: 4.25, rectRadius: 0.08, fill: { color: style.soft }, line: { color: style.divider, width: 1 } });
  slide.addText(data.title, { x: 0.92, y: 1.78, w: 5.4, h: 0.62, fontFace: 'Microsoft YaHei', fontSize: index === 0 ? 28 : 25, bold: true, color: colors.ink, margin: 0.02, fit: 'shrink' });
  slide.addText(data.body || '', { x: 0.96, y: 2.85, w: 5.28, h: 1.45, fontFace: 'Microsoft YaHei', fontSize: 17, color: colors.ink, breakLine: false, margin: 0.06, valign: 'mid', fit: 'shrink' });
  if (photos.length) {
    const photo = photos[0];
    slide.addShape(pptx.ShapeType.roundRect, { x: 7.05, y: 1.35, w: 5.75, h: 4.25, rectRadius: 0.08, fill: { color: 'FFFFFF' }, line: { color: style.divider, width: 1 } });
    slide.addImage({ data: photo.data, ...fitPhoto(photo) });
  }
  slide.addShape(pptx.ShapeType.line, { x: 0.62, y: 6.78, w: 12.1, h: 0, line: { color: style.divider, width: 1 } });
  const child = metadata.age ? `${metadata.age}岁` : `${metadata.grade}年级`;
  slide.addText(`${metadata.nickname || '小朋友'}  ·  ${child}`, { x: 0.62, y: 6.94, w: 4.5, h: 0.2, fontFace: 'Microsoft YaHei', fontSize: 9, color: style.muted, margin: 0 });
  slide.addText(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, { x: 11.55, y: 6.94, w: 1.15, h: 0.2, fontFace: 'Microsoft YaHei', fontSize: 9, color: style.muted, align: 'right', margin: 0 });
  if (data.notes && typeof slide.addNotes === 'function') slide.addNotes(data.notes);
}

async function writePresentation(slides, photos, output, metadata) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'KIDSPPT';
  pptx.subject = '小学生活动PPT';
  pptx.title = metadata.title || '我的活动记录';
  const byId = new Map(photos.map(photo => [photo.id, photo]));
  const budget = Math.floor(4000000 / slides.length);
  const prepared = new Map();
  for (const [index, data] of slides.entries()) {
    const photo = data.photoIds.map(id => byId.get(id)).find(Boolean);
    if (photo && !prepared.has(photo.id)) {
      let image;
      let info;
      for (const [width, quality] of [[1920, 85], [1600, 70], [1280, 55], [960, 40], [640, 30], [320, 20]]) {
        const output = await sharp(photo.path, { limitInputPixels: 24_000_000 }).timeout({ seconds: 15 }).rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer({ resolveWithObject: true });
        image = output.data;
        info = output.info;
        if (image.length <= budget) break;
      }
      if (image.length > budget) throw new Error('图片压缩失败，请减少照片后重试');
      prepared.set(photo.id, { data: 'image/jpeg;base64,' + image.toString('base64'), width: info.width, height: info.height });
    }
    addPage(pptx, data, photo ? [prepared.get(photo.id)] : [], index, metadata.actualPages || slides.length, metadata);
  }
  const bytes = await pptx.write({ outputType: 'nodebuffer', compression: true });
  if (bytes.length > 5000000) throw new Error('PPT 超过 5 MB，请减少内容后重试');
  const temporary = output + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, output); }
  finally { await fs.rm(temporary, { force: true }); }
  return output;
}

export async function exportDeck(slides, photos, outputDir, metadata = {}) {
  const normalized = validateSlides(slides, photos.map(photo => photo.id));
  await fs.mkdir(outputDir, { recursive: true });
  const stem = `${metadata.id || 'deck'}-${metadata.revision ?? 0}`;
  const full = path.resolve(outputDir, `${stem}-full.pptx`);
  const free = path.resolve(outputDir, `${stem}-free.pptx`);
  if (!metadata.preserveFree) await writePresentation(normalized.slice(0, 5), photos, free, metadata);
  if (!metadata.freeOnly) await writePresentation(normalized, photos, full, metadata);
  return { free, full: metadata.freeOnly ? null : full, actualPages: normalized.length };
}
