const API = window.KIDSPPT_API_BASE || '';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const templateNames = { fresh: '清新自然', playful: '活力童趣', report: '简洁汇报' };
const channelNames = { wechat: '微信支付', alipay: '支付宝' };
const state = { config: null, token: '', photos: [], deck: null, pollTimer: null, pendingPayment: null, downloadAfterReady: null };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const setNotice = message => { const el = $('#notice'); el.textContent = message || ''; el.hidden = !message; };
const fail = error => { setNotice(error.message || '请求失败，请稍后重试'); requestAnimationFrame(() => $('#notice')?.scrollIntoView({ behavior: 'smooth', block: 'center' })); };
async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}), ...(options.headers || {}) };
  const response = await fetch(API + path, { credentials: 'include', ...options, headers });
  const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) { const error = new Error(data?.error?.message || '请求失败'); error.status = response.status; error.code = data?.error?.code; throw error; }
  return data;
}
async function boot() {
  state.config = await api('/api/config');
  $('#generationMode').textContent = state.config.aiMode === 'demo' ? '本地文字整理模式 · AI 润色尚未接通' : 'AI 演示稿生成';
  $('#modeLabel').textContent = state.config.mode === 'demo' ? '本地演示模式' : '线上模式';
  $('#trialLimits').textContent = state.config.mode === 'demo' && state.config.aiMode === 'demo'
    ? '本地演示模式：可连续测试生成流程。'
    : '试运营：每个账号每天可新建' + state.config.dailyFreeTasks + '份作品。';
  try { await api('/api/me'); } catch (error) {
    if (error.status !== 401) throw error;
    const login = await api('/api/session/demo', { method: 'POST', body: JSON.stringify({}) }); state.token = login.token;
  }
}
function show(view) {
  $$('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + view));
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  const titles = { create:'制作一份孩子的活动 PPT', outline:'检查每一页内容', progress:'正在生成你的 PPT', preview:'你的 PPT 已准备好', works:'我的作品', orders:'订单记录' };
  $('#pageTitle').textContent = titles[view] || titles.create;
}
const radio = name => document.querySelector('input[name="' + name + '"]:checked')?.value || '';
function formInput() {
  return { title: $('#title').value.trim(), nickname: $('#nickname').value.trim(), grade: Number($('#grade').value), gender: $('#gender').value, content: $('#content').value.trim(), pageCount: 12, template: radio('template'), reviewOutline: $('#reviewOutline').checked, photoIds: state.photos.map(p => p.id), consent: $('#consent').checked };
}
function renderPhotos() {
  $('#photoList').innerHTML = state.photos.map((p, i) => '<div class="photo-item"><img src="' + esc(API + p.url) + '" alt="' + esc(p.name) + '"><button class="photo-remove" data-photo-action="remove" data-index="' + i + '" aria-label="移除第' + (i + 1) + '张照片">×</button><div class="photo-controls"><button data-photo-action="up" data-index="' + i + '" ' + (i === 0 ? 'disabled' : '') + ' aria-label="上移">↑</button><button data-photo-action="down" data-index="' + i + '" ' + (i === state.photos.length - 1 ? 'disabled' : '') + ' aria-label="下移">↓</button></div></div>').join('');
}
function readFile(file) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(file); }); }
function compressPhoto(file) {
  if (file.size <= 1000000) return Promise.resolve(file);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url);
      const qualities = [0.8, 0.6, 0.4, 0.2];
      const tryQuality = index => canvas.toBlob(blob => {
        if (!blob) return reject(new Error('照片压缩失败，请更换照片'));
        if (blob.size <= 1000000) return resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
        if (index === qualities.length - 1) return reject(new Error('图片压缩后仍超过 1MB，请更换照片'));
        tryQuality(index + 1);
      }, 'image/jpeg', qualities[index]);
      tryQuality(0);
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('照片压缩失败，请更换照片')); }; image.src = url;
  });
}
async function uploadPhotos(files) {
  if (state.photos.length + files.length > state.config.maxPhotos) throw new Error('照片最多上传' + state.config.maxPhotos + '张');
  const prepared = [];
  for (const file of files) { if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('请上传 JPG、PNG 或 WEBP 图片'); prepared.push(await compressPhoto(file)); }
  const currentBytes = state.photos.reduce((total, photo) => total + (photo.bytes || 0), 0);
  if (currentBytes + prepared.reduce((total, file) => total + file.size, 0) > 20000000) throw new Error('照片总上传大小不能超过 20MB');
  for (const file of prepared) { const photo = await api('/api/assets', { method:'POST', body: JSON.stringify({ name:file.name, data:await readFile(file) }) }); state.photos.push({ ...photo, bytes: file.size }); }
  renderPhotos();
}
function summary(deck) {
  const gender = deck.gender === 'boy' ? '男孩' : '女孩';
  $('#outlineSummary').innerHTML = '<dt>孩子</dt><dd>' + esc(deck.grade) + '年级 · ' + gender + '</dd><dt>模板</dt><dd>' + esc(templateNames[deck.template] || '清新自然') + '</dd><dt>页数</dt><dd>' + deck.slides.length + '页</dd><dt>图片</dt><dd>' + deck.photos.length + '张</dd>';
}
function renderOutline(deck) {
  $('#outlineTitle').textContent = deck.title; $('#outlineStage').textContent = deck.stage; summary(deck);
  $('#outlineEditor').innerHTML = deck.slides.map((s, i) => '<article class="slide-edit"><div class="slide-index">' + String(i + 1).padStart(2, '0') + '</div><div><label>页标题<textarea data-slide="' + i + '" data-field="title" maxlength="40" rows="1">' + esc(s.title) + '</textarea></label><label>页面正文<textarea data-slide="' + i + '" data-field="body" maxlength="180" rows="3">' + esc(s.body) + '</textarea></label><label>讲者备注<textarea class="slide-note" data-slide="' + i + '" data-field="notes" maxlength="8000" rows="2">' + esc(s.notes) + '</textarea></label></div></article>').join('');
  if (deck.pipeline === 2 && deck.phase === 'full') $$('#outlineEditor textarea').forEach(el => { if (Number(el.dataset.slide) < 5) el.readOnly = true; });
}
function readOutline() { return state.deck.slides.map((s, i) => ({ title:$('[data-slide="' + i + '"][data-field="title"]').value.trim(), body:$('[data-slide="' + i + '"][data-field="body"]').value.trim(), notes:$('[data-slide="' + i + '"][data-field="notes"]').value.trim(), photoIds:s.photoIds || [] })); }
async function saveOutline(message = true) {
  const result = await api('/api/decks/' + state.deck.id + '/outline', { method:'PUT', body:JSON.stringify({ revision:state.deck.revision, slides:readOutline() }) }); state.deck = result.deck; renderOutline(state.deck); if (message) setNotice('修改已保存'); return state.deck;
}
function progressPercent(status) { return ({ outlining: 25, queued: 60, rendering: 85, ready: 100 })[status] || 0; }
function progress(deck) {
  const failed = deck.status === 'failed'; const percent = progressPercent(deck.status);
  $('#progressTitle').textContent = '正在生成你的 PPT'; $('#progressMessage').textContent = '请稍后，精彩马上呈现';
  $('#progressPercent').textContent = percent + '%'; $('#progressStage').textContent = failed ? deck.error || '生成失败' : deck.stage || '请稍候';
  $('#progressValue').style.width = percent + '%'; $('#generationProgress').setAttribute('aria-valuenow', String(percent));
  $('#retryGeneration').hidden = !failed; $('#view-progress .loader').hidden = failed; $('#view-progress .progress-info').hidden = failed;
  $('#view-progress .progress-track').hidden = failed; $('#view-progress .progress-steps').hidden = failed;
}
function poll(deckId) {
  clearTimeout(state.pollTimer);
  const tick = async () => { try { const result = await api('/api/decks/' + deckId); state.deck = result.deck; progress(state.deck); if (state.deck.status === 'outline_ready') { renderOutline(state.deck); show('outline'); return; } if (state.deck.status === 'ready') { renderPreview(state.deck); show('preview'); if (state.downloadAfterReady === deckId && state.deck.fullReady) { state.downloadAfterReady = null; await downloadVariant('full'); } return; } if (state.deck.status === 'failed') { progress(state.deck); throw new Error(state.deck.error || '生成失败'); } state.pollTimer = setTimeout(tick, 900); } catch (error) { fail(error); } };
  show('progress'); tick();
}
function renderPreview(deck) {
  $('#previewTitle').textContent = deck.title + ' · ' + deck.actualPages + '页';
  $('#downloadFull').textContent = '下载完整版（共' + deck.actualPages + '页）';
  $('#downloadFree').textContent = '免费下载';
  const photos = new Map(deck.photos.map(p => [p.id, p]));
  const pages = deck.slides.slice(0, state.config.freePages);
  $('#slidePreview').innerHTML = pages.map(s => { const p = photos.get(s.photoIds?.[0]); return '<article class="slide-card template-' + esc(deck.template || 'fresh') + '"><div class="slide-card-text"><h3>' + esc(s.title) + '</h3><p>' + esc(s.body) + '</p></div>' + (p ? '<img src="' + esc(API + p.url) + '" alt="' + esc(p.name) + '">' : '<div></div>') + '</article>'; }).join('');
}
async function downloadVariant(variant) {
  try { const link = await api('/api/decks/' + state.deck.id + '/download?variant=' + variant); const res = await fetch(API + link.url, { credentials:'include', headers:state.token ? { Authorization:'Bearer ' + state.token } : {} }); if (!res.ok) throw new Error('下载失败'); const href = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = href; a.download = link.filename; a.click(); setTimeout(() => URL.revokeObjectURL(href), 1000); } catch (error) { fail(error); }
}
function openPayment() { if (state.config.paymentMode === 'disabled') return setNotice('微信支付和支付宝尚未配置'); state.pendingPayment = state.deck; $('#downloadDialogTitle').textContent = '完整 PPT（共' + state.deck.actualPages + '页）'; $('#paymentDialog').showModal(); }
async function confirmPayment() {
  $('#confirmPayment').disabled = true;
  try {
    const id = state.pendingPayment.id;
    const order = await api('/api/decks/' + id + '/orders', { method:'POST', body:JSON.stringify({ channel:radio('payChannel') }) });
    if (state.config.paymentMode !== 'demo') throw new Error('真实支付尚未配置');
    await api('/api/orders/' + order.order.id + '/demo-pay', { method:'POST', body:JSON.stringify({ confirm:true }) });
    $('#paymentDialog').close(); state.downloadAfterReady = id; poll(id);
  } catch (error) { fail(error); } finally { $('#confirmPayment').disabled = false; }
}
async function openDeck(id) { state.deck = (await api('/api/decks/' + id)).deck; if (state.deck.status === 'outline_ready') { renderOutline(state.deck); show('outline'); } else if (state.deck.status === 'ready') { renderPreview(state.deck); show('preview'); } else poll(id); }
async function loadWorks() {
  const list = (await api('/api/decks')).decks;
  $('#worksList').innerHTML = list.length ? list.map(d => '<article class="work-item"><div class="work-main"><h3>' + esc(d.title) + '</h3><div class="work-meta"><span>' + (d.actualPages || d.pageCount) + '页</span><span>' + esc(new Date(d.createdAt).toLocaleDateString('zh-CN')) + '</span><span>' + esc(d.stage) + '</span></div></div><div class="work-side"><button class="button secondary" data-work-action="open" data-id="' + d.id + '">查看</button><button class="button secondary" data-work-action="delete" data-id="' + d.id + '" aria-label="删除作品">×</button></div></article>').join('') : '<div class="empty-state"><h3>还没有作品</h3><p>完成第一份活动资料后，作品会出现在这里。</p></div>';
}
async function loadOrders() {
  const list = (await api('/api/orders')).orders;
  $('#ordersList').innerHTML = list.length ? list.map(o => '<article class="order-row"><div class="order-main"><strong>' + esc(o.title) + '</strong><small>' + esc(channelNames[o.channel] || o.channel) + ' · ' + (o.mode === 'demo' ? '本地演示' : '线上') + '</small><small>订单号：' + esc(o.id) + '</small><small>' + esc(o.delivery) + '</small></div><span class="order-status">' + (o.status === 'paid' ? '已支付' : '待支付') + '</span><span class="order-price">¥' + (o.amountFen / 100).toFixed(2) + '</span></article>').join('') : '<div class="empty-state"><h3>暂无订单</h3><p>购买完整 PPT 后，订单会出现在这里。</p></div>';
}
$('#photoInput').addEventListener('change', async e => { try { await uploadPhotos([...e.target.files]); } catch (error) { fail(error); } e.target.value = ''; });
$('#photoList').addEventListener('click', async e => { const b = e.target.closest('button[data-photo-action]'); if (!b) return; const i = Number(b.dataset.index); if (b.dataset.photoAction === 'remove') { try { await api('/api/assets/' + state.photos[i].id, { method:'DELETE' }); state.photos.splice(i, 1); renderPhotos(); } catch (error) { fail(error); } } else { const j = i + (b.dataset.photoAction === 'up' ? -1 : 1); if (state.photos[j]) [state.photos[i], state.photos[j]] = [state.photos[j], state.photos[i]]; renderPhotos(); } });
$('#reviewOutline').addEventListener('change', () => { $('#submitDeck span').textContent = $('#reviewOutline').checked ? '生成内容大纲' : '生成 PPT'; });
$('#createForm').addEventListener('submit', async e => { e.preventDefault(); const input = formInput(); if (!input.title || !input.grade || !input.gender || !input.content || !input.photoIds.length || !input.consent) return setNotice('请补齐标题、年级、性别、演示稿描述、照片及授权确认'); const button = $('#submitDeck'); button.disabled = true; setNotice(''); try { const result = await api('/api/decks', { method:'POST', body:JSON.stringify(input) }); state.deck = result.deck; poll(state.deck.id); } catch (error) { fail(error); } finally { button.disabled = false; } });
$('#backToCreate').addEventListener('click', () => show('create'));
$('#saveOutline').addEventListener('click', async () => { try { await saveOutline(); } catch (error) { fail(error); } });
$('#generatePpt').addEventListener('click', async () => { try { await saveOutline(false); const result = await api('/api/decks/' + state.deck.id + '/generate', { method:'POST', body:JSON.stringify({ revision:state.deck.revision }) }); state.deck = result.deck; poll(state.deck.id); } catch (error) { fail(error); } });
$('#retryGeneration').addEventListener('click', async () => {
  try { await api('/api/decks/' + state.deck.id + '/retry', { method: 'POST', body: '{}' }); setNotice(''); poll(state.deck.id); } catch (error) { fail(error); }
});
$('#downloadFree').addEventListener('click', () => downloadVariant('free'));
$('#downloadFull').addEventListener('click', () => state.deck?.paid || state.deck?.actualPages <= state.config.freePages ? downloadVariant('full') : openPayment());
$('#confirmPayment').addEventListener('click', confirmPayment);
$('#cancelPayment').addEventListener('click', () => $('#paymentDialog').close());
$('#closeDialog').addEventListener('click', () => $('#paymentDialog').close());
$('#newWork').addEventListener('click', () => { state.deck = null; state.photos = []; renderPhotos(); $('#createForm').reset(); $('#submitDeck span').textContent = '生成 PPT'; show('create'); });
$('#worksList').addEventListener('click', async e => { const b = e.target.closest('button[data-work-action]'); if (!b) return; try { if (b.dataset.workAction === 'open') await openDeck(b.dataset.id); else if (confirm('确定删除这份作品吗？删除后无法恢复。')) { await api('/api/decks/' + b.dataset.id, { method:'DELETE' }); await loadWorks(); } } catch (error) { fail(error); } });
$$('.nav-item').forEach(b => b.addEventListener('click', async () => { try { if (b.dataset.view === 'works') { show('works'); await loadWorks(); } else if (b.dataset.view === 'orders') { show('orders'); await loadOrders(); } else show('create'); } catch (error) { fail(error); } }));
$('#accountButton').addEventListener('click', () => setNotice('当前为' + (state.config?.mode === 'demo' ? '本地演示' : '线上') + '账号，素材仅在当前账号下可见。'));
boot().catch(fail);
