function firstMissingField(form) {
  const fields = [
    ['photos', !form.photoIds.length, '请上传至少一张活动照片'],
    ['title', !form.title, '请填写作品标题'],
    ['age', !form.age, '请选择孩子年龄'],
    ['gender', !form.gender, '请选择孩子性别'],
    ['content', !form.content, '请填写演示稿描述'],
    ['template', !form.template, '请选择 PPT 风格模板'],
    ['consent', !form.consent, '请确认照片使用授权']
  ];
  const missing = fields.find(field => field[1]);
  return missing && { field: missing[0], message: missing[2] };
}

function validateForm(form) {
  const missing = firstMissingField(form);
  return missing ? missing.message : '';
}

module.exports = { validateForm, firstMissingField };
