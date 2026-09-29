const api = require('../../utils/api');

Page({
  data: { deck: null, loading: false, error: '' },
  timer: null,
  async onLoad(options) { this.deckId = options.id; try { await api.bootstrap(); await this.load(); } catch (error) { this.setData({ error: error.message }); } },
  onUnload() { if (this.timer) clearTimeout(this.timer); },
  async load() {
    try {
      const deck = (await api.getDeck(this.deckId)).deck;
      this.setData({ deck, error: '' });
      if (deck.status === 'outlining' || deck.status === 'queued' || deck.status === 'rendering') this.timer = setTimeout(() => this.load(), 900);
      else if (deck.status === 'ready') wx.redirectTo({ url: '../preview/preview?id=' + deck.id });
    } catch (error) { this.setData({ error: error.message }); }
  },
  edit(event) {
    const index = Number(event.currentTarget.dataset.index); const field = event.currentTarget.dataset.field;
    if (this.data.deck.pipeline === 2 && this.data.deck.phase === 'full' && index < 5) return;
    this.setData({ ['deck.slides[' + index + '].' + field]: event.detail.value });
  },
  async save() {
    this.setData({ loading: true, error: '' });
    try { const result = await api.updateOutline(this.deckId, { revision: this.data.deck.revision, slides: this.data.deck.slides }); this.setData({ deck: result.deck }); wx.showToast({ title: '已保存', icon: 'success' }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  async generate() {
    this.setData({ loading: true, error: '' });
    try {
      const saved = await api.updateOutline(this.deckId, { revision: this.data.deck.revision, slides: this.data.deck.slides });
      const result = await api.generate(this.deckId, { revision: saved.deck.revision });
      this.setData({ deck: result.deck }); this.load();
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  }
});
