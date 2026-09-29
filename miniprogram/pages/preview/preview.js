const api = require('../../utils/api');

function progressFor(deck) {
  const percent = ({ outlining: 25, queued: 60, rendering: 85, ready: 100 })[deck.status] || 0;
  return { percent, stage: deck.stage || '请稍候' };
}

function viewFor(deck) {
  const ready = deck && deck.status === 'ready';
  const failed = deck && deck.status === 'failed';
  return { title: ready ? deck.title : '正在生成你的 PPT', generating: !ready, showProgress: !ready && !failed };
}

Page({
  data: { deck: null, config: {}, error: '', loading: false, progress: { percent: 0, stage: '正在连接生成服务' }, view: viewFor(null) },
  async onLoad(options) { this.deckId = options.id; try { await api.bootstrap(); await this.load(); } catch (error) { this.setData({ error: error.message }); } },
  onUnload() { this.unloaded = true; clearTimeout(this.timer); },
  async load() {
    clearTimeout(this.timer);
    try {
      const result = await api.getDeck(this.deckId); const photos = new Map(result.deck.photos.map(photo => [photo.id, photo]));
      if (this.unloaded) return;
      const deck = { ...result.deck, slides: result.deck.slides.map(slide => {
        const photoId = slide.photoIds && slide.photoIds[0];
        const photo = photoId ? photos.get(photoId) : null;
        return { ...slide, photoUrl: photo && photo.url || '' };
      }) };
      const config = getApp().globalData.config || {};
      this.setData({ deck: { ...deck, slides: deck.slides.slice(0, config.freePages || 5) }, config, progress: progressFor(deck), view: viewFor(deck) });
      if (deck.status === 'failed') this.setData({ error: deck.error || '生成失败' });
      else if (deck.status === 'outline_ready') wx.redirectTo({ url: '../outline/outline?id=' + deck.id });
      else if (deck.status !== 'ready') this.timer = setTimeout(() => this.load(), 900);
    }
    catch (error) { this.setData({ error: error.message }); }
  },
  async retry() { try { await api.request('/api/decks/' + this.deckId + '/retry', 'POST', {}); this.setData({ error: '' }); await this.load(); } catch (error) { this.setData({ error: error.message }); } },
  downloadFull() {
    if (this.data.deck.paid || this.data.deck.actualPages <= (this.data.config.freePages || 5)) return this.download('full');
    if (this.data.config.paymentMode === 'disabled') return this.setData({ error: '真实支付尚未开通' });
    wx.showActionSheet({ itemList: ['微信支付', '支付宝'], success: result => this.pay(result.tapIndex === 0 ? 'wechat' : 'alipay') });
  },
  downloadFree() { this.download('free'); },
  async pay(channel) {
    this.setData({ loading: true, error: '' });
    try {
      const order = await api.createOrder(this.deckId, channel);
      if (this.data.config.paymentMode !== 'demo') throw new Error('真实支付尚未配置，请稍后再试');
      const confirm = await new Promise(resolve => wx.showModal({ title: '确认下载完整版', content: '完整 PPT（共' + this.data.deck.actualPages + '页）50元，确认后补全其余页面。本地演示不会实际扣款。', confirmText: '确认', success: resolve }));
      if (!confirm.confirm) return;
      await api.demoPay(order.order.id); await this.load();
      if (this.data.deck.fullReady) await this.download('full');
    } catch (error) { this.setData({ error: error.message }); } finally { this.setData({ loading: false }); }
  },
  async download(variant) { this.setData({ loading: true }); try { await api.downloadPpt(this.deckId, variant); } catch (error) { this.setData({ error: error.message }); } finally { this.setData({ loading: false }); } }
});
