const app = getApp();
const assetFiles = new Map();

function authHeader(extra = {}) {
  return { ...extra, ...(app.globalData.token ? { Authorization: 'Bearer ' + app.globalData.token } : {}) };
}

function settle(res, resolve, reject) {
  if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
  const error = new Error(res.data && res.data.error && res.data.error.message || '请求失败');
  error.status = res.statusCode;
  error.code = res.data && res.data.error && res.data.error.code;
  reject(error);
}

function failWith(reject, message) {
  return raw => {
    console.error('[KIDSPPT transport failure]', { code: raw && raw.errCode, message: raw && raw.errMsg });
    const error = new Error(message);
    error.code = raw && raw.errCode;
    reject(error);
  };
}

function request(path, method = 'GET', data) {
  return new Promise((resolve, reject) => {
    const cloud = app.globalData.cloud;
    if (cloud && cloud.enabled) {
      return wx.cloud.callContainer({
        config: { env: cloud.env },
        path,
        method,
        data,
        header: authHeader({ 'X-WX-SERVICE': cloud.service }),
        success: res => settle(res, resolve, reject),
        fail: failWith(reject, '生成服务暂时不可用，请稍后重试')
      });
    }
    wx.request({
      url: app.globalData.apiBaseUrl + path,
      method,
      data,
      header: authHeader(),
      success: res => settle(res, resolve, reject),
      fail: failWith(reject, '网络连接失败，请稍后重试')
    });
  });
}

function publicUrl(relative) {
  if (/^https?:\/\//.test(relative)) return relative;
  const cloud = app.globalData.cloud;
  const path = cloud && cloud.enabled && relative.startsWith('/api/assets/') ? relative.replace(/^\/api/, '/media') : relative;
  return (cloud && cloud.enabled ? cloud.publicBaseUrl : app.globalData.apiBaseUrl) + path;
}

function downloadProtected(relative) {
  const url = publicUrl(relative);
  const key = app.globalData.token + ':' + url;
  if (assetFiles.has(key)) return assetFiles.get(key);
  const task = new Promise((resolve, reject) => wx.downloadFile({
    url,
    header: authHeader(),
    success(result) {
      if (result.statusCode === 200) return resolve(result.tempFilePath);
      reject(new Error('文件下载失败'));
    },
    fail: failWith(reject, '文件下载失败，请稍后重试')
  }));
  assetFiles.set(key, task);
  task.catch(() => assetFiles.delete(key));
  return task;
}

async function absoluteDeck(deck) {
  const photos = await Promise.all((deck.photos || []).map(async photo => ({ ...photo, url: await downloadProtected(photo.url) })));
  return { ...deck, photos };
}

async function bootstrap() {
  app.globalData.config = await request('/api/config');
  try { return (await request('/api/me')).user; } catch (error) {
    if (error.status !== 401) throw error;
    if (app.globalData.config.mode !== 'demo') {
      const login = await new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }));
      const result = await request('/api/session/wechat', 'POST', { code: login.code });
      app.globalData.token = result.token;
      return result.user;
    }
    const result = await request('/api/session/demo', 'POST', {});
    app.globalData.token = result.token;
    return result.user;
  }
}

async function uploadImage(filePath, name) {
  const sizeOf = path => new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath: path, success: info => resolve(info.size), fail: failWith(reject, '无法读取照片，请重新选择') }));
  const original = filePath;
  for (const quality of [80, 60, 40, 20]) {
    if (await sizeOf(filePath) <= 1000000) break;
    const result = await new Promise((resolve, reject) => wx.compressImage({ src: original, quality, compressedWidth: 1600, success: resolve, fail: failWith(reject, '照片压缩失败，请更换照片') }));
    filePath = result.tempFilePath;
  }
  if (await sizeOf(filePath) > 1000000) throw new Error('单张照片不能超过 1 MB，请压缩后重试');
  const upload = () => new Promise((resolve, reject) => {
    const cloud = app.globalData.cloud;
    const url = cloud && cloud.enabled ? cloud.publicBaseUrl + '/upload/assets' : app.globalData.apiBaseUrl + '/api/assets/upload';
    wx.uploadFile({
      url, filePath, name: 'file', formData: { name }, header: authHeader(),
      success(result) {
        let data = result.data;
        try { if (typeof data === 'string') data = JSON.parse(data); } catch { return reject(new Error('上传响应格式不正确')); }
        settle({ statusCode: result.statusCode, data }, asset => resolve({ ...asset, url: filePath }), reject);
      },
      fail: failWith(reject, '照片上传失败，请检查网络后重试')
    });
  });
  for (let attempt = 0; ; attempt++) {
    try { return await upload(); }
    catch (error) {
      if (attempt >= 5 || !['upload_busy', 'server_busy', 'gateway_busy'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
}

async function downloadPpt(deckId, variant) {
  const ticket = await request('/api/decks/' + deckId + '/download?variant=' + variant);
  const cloud = app.globalData.cloud;
  if (cloud && cloud.enabled) {
    const result = await new Promise((resolve, reject) => wx.cloud.callContainer({
      config: { env: cloud.env }, path: ticket.url, method: 'GET', dataType: 'text', responseType: 'arraybuffer',
      header: authHeader({ 'X-WX-SERVICE': cloud.service }),
      success(response) {
        if (response.statusCode === 200) return resolve(response.data);
        reject(new Error('文件下载失败，请稍后重试'));
      },
      fail: failWith(reject, '文件下载失败，请稍后重试')
    }));
    const filePath = wx.env.USER_DATA_PATH + '/' + deckId + '-' + variant + '.pptx';
    await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: result, success: resolve, fail: failWith(reject, '文件保存失败，请稍后重试') }));
    await new Promise((resolve, reject) => wx.openDocument({ filePath, fileType: 'pptx', showMenu: true, success: resolve, fail: reject }));
    return ticket;
  }
  const result = await new Promise((resolve, reject) => wx.downloadFile({
    url: publicUrl(ticket.url),
    header: authHeader(),
    success: resolve,
    fail: failWith(reject, '文件下载失败，请稍后重试')
  }));
  if (result.statusCode !== 200) throw new Error('下载失败');
  await new Promise((resolve, reject) => wx.openDocument({ filePath: result.tempFilePath, fileType: 'pptx', showMenu: true, success: resolve, fail: reject }));
  return ticket;
}

module.exports = {
  request,
  bootstrap,
  uploadImage,
  downloadPpt,
  createDeck: data => request('/api/decks', 'POST', data),
  getDeck: async id => { const result = await request('/api/decks/' + id); return { ...result, deck: await absoluteDeck(result.deck) }; },
  updateOutline: (id, data) => request('/api/decks/' + id + '/outline', 'PUT', data),
  generate: (id, data) => request('/api/decks/' + id + '/generate', 'POST', data),
  deleteAsset: id => request('/api/assets/' + id, 'DELETE'),
  deleteDeck: id => request('/api/decks/' + id, 'DELETE'),
  createOrder: (id, channel) => request('/api/decks/' + id + '/orders', 'POST', { channel }),
  demoPay: id => request('/api/orders/' + id + '/demo-pay', 'POST', { confirm: true }),
  listDecks: () => request('/api/decks'),
  listOrders: () => request('/api/orders')
};
