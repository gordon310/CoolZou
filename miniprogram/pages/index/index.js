const api = require('../../utils/api');
const { firstMissingField } = require('../../utils/validation');

Page({
  data: {
    config: { maxPhotos: 20 }, photos: [], loading: false,
    ages: Array.from({ length: 14 }, (_, index) => index + 5), genders: ['男孩', '女孩'], templates: [{ value: 'fresh', label: '清新自然' }, { value: 'playful', label: '活力童趣' }, { value: 'report', label: '简洁汇报' }],
    form: { title: '', nickname: '', age: '', gender: '', content: '', template: 'fresh', reviewOutline: false, consent: false }
  },
  async onLoad() {
    try { await api.bootstrap(); this.setData({ config: getApp().globalData.config }); } catch (error) { this.setData({ error: error.message }); }
  },
  setField(event) {
    const field = event.currentTarget.dataset.field;
    const pickerValues = { age: this.data.ages, gender: ['boy', 'girl'] };
    const value = pickerValues[field] ? pickerValues[field][Number(event.detail.value)] : event.detail.value;
    this.setData({ ['form.' + field]: value });
  },
  setReviewOutline(event) { this.setData({ 'form.reviewOutline': event.detail.value.includes('yes') }); },
  setTemplate(event) { this.setData({ 'form.template': event.currentTarget.dataset.template }); },
  setConsent(event) { this.setData({ 'form.consent': event.detail.value.includes('yes') }); },
  async chooseImages() {
    if (this.uploading) return;
    const remain = (this.data.config.maxPhotos || 20) - this.data.photos.length;
    if (remain <= 0) return wx.showToast({ title: '照片已达上限', icon: 'none' });
    this.uploading = true;
    try {
      const result = await new Promise((resolve, reject) => wx.chooseImage({ count: Math.min(remain, 9), sourceType: ['album', 'camera'], success: resolve, fail: reject }));
      const next = [...this.data.photos];
      for (const filePath of result.tempFilePaths) {
        next.push(await api.uploadImage(filePath, '活动图片'));
        this.setData({ photos: [...next], error: '' });
      }
    } catch (error) { if (error.errMsg && error.errMsg.includes('cancel')) return; this.setData({ error: error.message || '上传失败' }); }
    finally { this.uploading = false; }
  },
  async removeImage(event) { if (this.uploading) return; const index = Number(event.currentTarget.dataset.index); try { await api.deleteAsset(this.data.photos[index].id); const photos = this.data.photos.filter((_, i) => i !== index); this.setData({ photos }); } catch (error) { this.setData({ error: error.message }); } },
  moveImage(event) {
    if (this.uploading) return;
    const index = Number(event.currentTarget.dataset.index); const direction = Number(event.currentTarget.dataset.direction); const target = index + direction;
    if (target < 0 || target >= this.data.photos.length) return;
    const photos = [...this.data.photos]; [photos[index], photos[target]] = [photos[target], photos[index]]; this.setData({ photos });
  },
  async submit() {
    if (this.submitting) return;
    if (this.uploading) return wx.showToast({ title: '请等待照片上传完成', icon: 'none' });
    const form = { ...this.data.form, age: Number(this.data.form.age), photoIds: this.data.photos.map(photo => photo.id), pageCount: 5 };
    const missing = firstMissingField(form);
    if (missing) {
      this.setData({ error: missing.message });
      wx.pageScrollTo({ selector: '#required-' + missing.field, duration: 300 });
      return;
    }
    this.submitting = true;
    this.setData({ loading: true, error: '' });
    try { const result = await api.createDeck(form); wx.navigateTo({ url: (form.reviewOutline ? '../outline/outline?id=' : '../preview/preview?id=') + result.deck.id }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.submitting = false; this.setData({ loading: false }); }
  }
});
