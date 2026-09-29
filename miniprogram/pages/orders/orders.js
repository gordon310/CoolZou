const api = require('../../utils/api');

Page({
  data: { orders: [], error: '' },
  async onShow() { try { await api.bootstrap(); await this.load(); } catch (error) { this.setData({ error: error.message }); } },
  async load() { try { const result = await api.listOrders(); this.setData({ orders: result.orders, error: '' }); } catch (error) { this.setData({ error: error.message }); } }
});
