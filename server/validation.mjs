import { normalizeTemplate } from './templates.mjs';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const text = (value, name, max, required = true) => {
  if (typeof value !== 'string' || (required && value.trim().length === 0) || value.length > max) {
    throw new HttpError(400, 'invalid_input', `${name}不符合要求`);
  }
  return value.trim();
};

const integer = (value, name, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'invalid_input', `${name}不符合要求`);
  }
  return value;
};

export function validateInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'invalid_input', '请求内容不正确');
  }
  if (input.consent !== true) throw new HttpError(400, 'consent_required', '请先确认图片和文字仅用于本次生成');
  const photoIds = Array.isArray(input.photoIds) ? input.photoIds : [];
  if (photoIds.length < 1 || photoIds.length > 20 || photoIds.some(id => typeof id !== 'string') || new Set(photoIds).size !== photoIds.length) {
    throw new HttpError(400, 'invalid_input', '请上传1至20张不同的活动图片');
  }
  const title = text(input.title, '作品标题', 40);
  const nickname = text(input.nickname ?? '', '孩子称呼', 20, false);
  const content = input.content !== undefined ? text(input.content, '演示稿描述', 8000) : null;
  const requirements = content || text(input.requirements, 'PPT要求描述', 2000);
  const flow = content || text(input.flow, '活动流程或内容', 8000);
  const template = normalizeTemplate(input.template || (input.theme === 'coral' ? 'playful' : 'fresh'));
  const theme = ['green', 'coral'].includes(input.theme) ? input.theme : template === 'playful' ? 'coral' : 'green';
  const child = input.age === undefined
    ? { grade: integer(input.grade, '年级', 1, 6) }
    : { age: integer(input.age, '年龄', 5, 18) };
  return {
    title, nickname, ...child,
    gender: ['boy', 'girl'].includes(input.gender) ? input.gender : (() => { throw new HttpError(400, 'invalid_input', '性别不正确'); })(),
    content: content || `${flow}\n\n${requirements}`, requirements, flow, pageCount: integer(input.pageCount ?? 12, '页数', 5, 20), template, theme,
    reviewOutline: input.reviewOutline === true,
    photoIds: [...photoIds], consent: true
  };
}

export function validateSlides(slides, allowedPhotoIds) {
  if (!Array.isArray(slides) || slides.length < 1 || slides.length > 20) {
    throw new HttpError(400, 'invalid_slides', 'PPT页数不符合要求');
  }
  const allowed = new Set(allowedPhotoIds || []);
  return slides.map((slide, index) => {
    if (!slide || typeof slide !== 'object') throw new HttpError(400, 'invalid_slides', `第${index + 1}页内容不正确`);
    const photoIds = Array.isArray(slide.photoIds) ? slide.photoIds : [];
    if (photoIds.length > 1 || photoIds.some(id => !allowed.has(id))) {
      throw new HttpError(400, 'invalid_slides', `第${index + 1}页的图片不属于当前作品`);
    }
    return {
      title: text(slide.title, `第${index + 1}页标题`, 40),
      body: text(slide.body ?? '', `第${index + 1}页正文`, 180, false),
      notes: text(slide.notes ?? '', `第${index + 1}页备注`, 8000, false),
      photoIds: [...photoIds]
    };
  });
}
