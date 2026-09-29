const api = require('../../utils/api');

Page({
  data: { decks: [], error: '' },
  async onShow() { try { await api.bootstrap(); await this.load(); } catch (error) { this.setData({ error: error.message }); } },
  async load() { try { const result = await api.listDecks(); this.setData({ decks: result.decks, error: '' }); } catch (error) { this.setData({ error: error.message }); } },
  open(event) { wx.navigateTo({ url: '../preview/preview?id=' + event.currentTarget.dataset.id }); },
  remove(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: '删除作品', content: '删除后无法恢复，确定继续吗？', success: async result => {
      if (!result.confirm) return;
      try { await api.deleteDeck(id); await this.load(); } catch (error) { this.setData({ error: error.message }); }
    } });
  }
});
