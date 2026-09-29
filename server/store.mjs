import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { transaction } from './cost-control.mjs';
import { HttpError } from './validation.mjs';

const iso = value => new Date(value ?? Date.now()).toISOString();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

export class Store {
  constructor(dataDir, options = {}) {
    this.aiMode = options.aiMode || process.env.AI_MODE || 'demo';
    this.dataDir = path.resolve(dataDir);
    this.filesDir = path.join(this.dataDir, 'files');
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, 'kidsppt.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS decks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, input_json TEXT NOT NULL, slides_json TEXT, status TEXT NOT NULL, stage TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, error TEXT, free_path TEXT, full_path TEXT, actual_pages INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, deck_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'queued\', created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, deck_id TEXT NOT NULL, revision INTEGER NOT NULL, amount_fen INTEGER NOT NULL, currency TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT); CREATE TABLE IF NOT EXISTS download_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, deck_id TEXT NOT NULL, variant TEXT NOT NULL, expires_at TEXT NOT NULL);');
  }
  async init() {
    await fs.mkdir(this.filesDir, { recursive: true });
    this.db.exec('CREATE TABLE IF NOT EXISTS wechat_accounts (app_id TEXT NOT NULL, open_id TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE, PRIMARY KEY(app_id, open_id))');
    if (!this.db.prepare('PRAGMA table_info(orders)').all().some(column => column.name === 'deck_title')) {
      this.db.exec('ALTER TABLE orders ADD COLUMN deck_title TEXT');
    }
    this.db.exec("UPDATE orders SET deck_title=(SELECT json_extract(input_json, '$.title') FROM decks WHERE decks.id=orders.deck_id AND decks.user_id=orders.user_id) WHERE deck_title IS NULL");
    for (const [table, columns] of Object.entries({ decks: { pipeline: 'INTEGER NOT NULL DEFAULT 1', phase: "TEXT NOT NULL DEFAULT 'full'", directory_json: 'TEXT', frozen_json: 'TEXT' }, jobs: { attempts: 'INTEGER NOT NULL DEFAULT 0' } })) {
      const names = this.db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
      for (const [name, type] of Object.entries(columns)) if (!names.includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS assets_user ON assets(user_id); CREATE INDEX IF NOT EXISTS jobs_status_kind ON jobs(status,kind); CREATE INDEX IF NOT EXISTS decks_user ON decks(user_id)');
  }
  assertQueueSpace(deckId) {
    if (deckId && this.db.prepare("SELECT 1 FROM jobs WHERE deck_id=? AND status IN ('queued','running')").get(deckId)) return;
    if (this.db.prepare("SELECT count(*) n FROM jobs WHERE status IN ('queued','running')").get().n >= 100) throw new HttpError(503, 'queue_full', '生成任务较多，请稍后重试');
  }
  assertUploadSpace(userId) {
    const unused = this.db.prepare("SELECT count(*) n FROM assets a WHERE a.user_id=? AND NOT EXISTS (SELECT 1 FROM decks d, json_each(d.input_json,'$.photoIds') p WHERE d.user_id=a.user_id AND p.value=a.id)").get(userId).n;
    if (unused >= 30) throw new HttpError(429, 'upload_limit', '未使用照片已达30张，请先生成作品或删除多余照片');
  }
  async cleanup() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(iso());
    this.db.prepare('DELETE FROM download_tokens WHERE expires_at<?').run(iso());
    const expired = this.db.prepare("SELECT a.id FROM assets a WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM decks d, json_each(d.input_json,'$.photoIds') p WHERE p.value=a.id) LIMIT 100").all(iso(Date.now() - 24 * 3600_000));
    for (const { id } of expired) {
      // Recheck immediately before deletion: a request may have linked the photo since the last await.
      const asset = this.db.prepare('SELECT user_id FROM assets WHERE id=?').get(id);
      if (!asset) continue;
      const removed = this.deleteAsset(id, asset.user_id);
      if (removed) await fs.rm(removed.path, { force: true });
    }
    return expired.length;
  }
  close() { this.db.close(); }
  makeToken(userId, ttlMs = 30 * 24 * 60 * 60 * 1000) {
    const value = token();
    this.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(value), userId, iso(Date.now() + ttlMs));
    return value;
  }
  createUser() {
    const id = 'demo_' + crypto.randomUUID();
    this.db.prepare('INSERT INTO users(id,created_at) VALUES(?,?)').run(id, iso());
    return { id };
  }
  wechatUser(appId, openId) {
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT user_id FROM wechat_accounts WHERE app_id=? AND open_id=?').get(appId, openId);
      if (existing) return { id: existing.user_id };
      const id = 'wx_' + crypto.randomUUID();
      this.db.prepare('INSERT INTO users(id,created_at) VALUES(?,?)').run(id, iso());
      this.db.prepare('INSERT INTO wechat_accounts(app_id,open_id,user_id) VALUES(?,?,?)').run(appId, openId, id);
      return { id };
    });
  }
  userForToken(value) {
    if (!value) return null;
    const row = this.db.prepare('SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(value), iso());
    return row ? { id: row.id } : null;
  }
  deleteSession(value) { if (value) this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(value)); }
  createAsset({ id, userId, name, filePath, mime, width, height }) {
    const createdAt = iso();
    this.db.prepare('INSERT INTO assets(id,user_id,name,path,mime,width,height,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, userId, name, filePath, mime, width, height, createdAt);
    return { id, name, mime, width, height, createdAt };
  }
  getAsset(id, userId) { return this.db.prepare('SELECT * FROM assets WHERE id=? AND user_id=?').get(id, userId) || null; }
  assetsForUser(ids, userId) {
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    return this.db.prepare('SELECT * FROM assets WHERE user_id=? AND id IN (' + marks + ')').all(userId, ...ids);
  }
  deleteAsset(id, userId) {
    const row = this.getAsset(id, userId);
    if (!row) return false;
    const linked = this.db.prepare('SELECT 1 FROM decks WHERE user_id=? AND input_json LIKE ? LIMIT 1').get(userId, '%' + id + '%');
    if (linked) return false;
    this.db.prepare('DELETE FROM assets WHERE id=? AND user_id=?').run(id, userId);
    return row;
  }
  findReusableDeck(userId, materialKey, template) {
    return this.db.prepare("SELECT d.* FROM task_admissions a JOIN decks d ON d.id=a.deck_id WHERE a.user_id=? AND a.material_key=? AND d.pipeline=2 AND d.status IN ('ready','outline_ready') AND json_extract(d.input_json,'$.template')<>? ORDER BY d.updated_at DESC LIMIT 1").get(userId, materialKey, template) || null;
  }
  createDeck({ id, userId, input, requestKey, materialKey }) {
    if (requestKey) {
      const admitted = this.cost.admit(userId, requestKey, id, materialKey, () => this.createDeck({ id, userId, input }));
      return this.getDeck(admitted, userId);
    }
    this.assertQueueSpace();
    const now = iso();
    this.db.prepare('INSERT INTO decks(id,user_id,input_json,status,stage,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, userId, JSON.stringify(input), 'outlining', '正在整理内容', 0, now, now);
    this.updateDeck(id, { pipeline: 2, phase: 'free' });
    this.db.prepare('INSERT INTO jobs(deck_id,kind,created_at) VALUES(?,?,?)').run(id, 'outline', now);
    return this.getDeck(id, userId);
  }
  createTemplateVariant({ id, userId, input, source, requestKey, materialKey }) {
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT deck_id FROM task_admissions WHERE user_id=? AND request_key=?').get(userId, requestKey);
      if (existing) return this.getDeck(existing.deck_id, userId);
      if (this.db.prepare("SELECT 1 FROM decks WHERE user_id=? AND status NOT IN ('ready','failed')").get(userId)) throw new HttpError(409, 'active_task', '请先完成当前作品');
      this.assertQueueSpace();
      const now = iso();
      const status = input.reviewOutline ? 'outline_ready' : 'queued';
      const stage = input.reviewOutline ? '内容待确认' : '等待排版';
      const oldPhotoIds = JSON.parse(source.input_json).photoIds || [];
      const newPhotoIds = input.photoIds || [];
      const photoMap = new Map(oldPhotoIds.map((photoId, index) => [photoId, newPhotoIds[index]]));
      const slides = JSON.parse(source.slides_json || '[]').map(slide => ({ ...slide, photoIds: (slide.photoIds || []).map(photoId => photoMap.get(photoId)).filter(Boolean) })).slice(0, 5);
      this.db.prepare('INSERT INTO decks(id,user_id,input_json,slides_json,status,stage,revision,actual_pages,directory_json,created_at,updated_at,pipeline,phase) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, userId, JSON.stringify(input), JSON.stringify(slides), status, stage, source.revision, source.actual_pages, source.directory_json, now, now, 2, 'free');
      // Render-only variants are tracked for idempotency but do not consume the AI daily quota.
      this.db.prepare('INSERT INTO task_admissions VALUES(?,?,?,?,?)').run(userId, requestKey, id, 'render-only', materialKey);
      if (!input.reviewOutline) this.db.prepare('INSERT INTO jobs(deck_id,kind,created_at) VALUES(?,?,?)').run(id, 'render', now);
      return this.getDeck(id, userId);
    });
  }
  getDeck(id, userId) {
    const row = this.db.prepare('SELECT * FROM decks WHERE id=? AND user_id=?').get(id, userId);
    return row ? this.#deck(row, userId) : null;
  }
  listDecks(userId) { return this.db.prepare('SELECT * FROM decks WHERE user_id=? ORDER BY created_at DESC').all(userId).map(row => this.#deck(row, userId)); }
  #deck(row, userId) {
    const input = JSON.parse(row.input_json);
    const photos = this.assetsForUser(input.photoIds, userId).map(asset => ({ id: asset.id, name: asset.name, url: '/api/assets/' + asset.id, width: asset.width, height: asset.height }));
    return { id: row.id, ...input, pipeline: row.pipeline, phase: row.phase, directory: row.directory_json ? JSON.parse(row.directory_json) : [], fullReady: Boolean(row.full_path), freeReady: Boolean(row.free_path), status: row.status, stage: row.stage, revision: row.revision, error: row.error, slides: row.slides_json ? JSON.parse(row.slides_json) : [], photos, paid: this.hasPaid(row.id, userId, row.revision), actualPages: row.actual_pages, aiMode: this.aiMode, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  nextJob() { return this.db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get() || null; }
  claimJob() {
    return transaction(this.db, () => {
      for (const [kind, limit] of [['complete', this.cost.policy.paidSlots], ['outline', this.cost.policy.freeSlots], ['render', this.cost.policy.renderSlots]]) {
        const running = this.db.prepare("SELECT count(*) n FROM jobs WHERE kind=? AND status='running'").get(kind).n;
        if (running >= limit) continue;
        const job = this.db.prepare("SELECT * FROM jobs WHERE kind=? AND status='queued' ORDER BY id LIMIT 1").get(kind);
        if (job) { this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=?").run(job.id); return job; }
      }
      return null;
    });
  }
  retry(id) {
    const job = this.db.prepare("SELECT * FROM jobs WHERE deck_id=? AND status='failed' ORDER BY id DESC LIMIT 1").get(id);
    if (!job || job.attempts >= 2) throw new HttpError(409, 'retry_exhausted', '已达到重试上限，请联系支持处理');
    this.assertQueueSpace();
    this.db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(job.id);
    this.updateDeck(id, { status: 'queued', stage: '等待重试', error: null });
  }
  markJob(id, status) { this.db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, id); }
  updateDeck(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const values = keys.map(key => fields[key]);
    this.db.prepare('UPDATE decks SET ' + keys.map(key => key + '=?').join(',') + ', updated_at=? WHERE id=?').run(...values, iso(), id);
  }
  setSlides(id, slides) { this.updateDeck(id, { slides_json: JSON.stringify(slides), status: 'outline_ready', stage: '内容待确认', error: null }); }
  queueRender(id) { this.assertQueueSpace(id); this.db.prepare('INSERT INTO jobs(deck_id,kind,created_at) VALUES(?,?,?)').run(id, 'render', iso()); this.updateDeck(id, { status: 'queued', stage: '等待导出', error: null }); }
  bumpRevision(id, slides) {
    const row = this.db.prepare('SELECT * FROM decks WHERE id=?').get(id);
    if (row.pipeline === 2 && row.phase === 'free' && slides.length !== JSON.parse(row.slides_json).length) throw new HttpError(400, 'preview_page_count', '请保留当前预览页数');
    if (row.frozen_json && JSON.stringify(slides.slice(0, 5)) !== row.frozen_json) throw new HttpError(409, 'frozen_preview', '前5页已确认，补全阶段只可编辑后续页面');
    if (row.frozen_json && slides.length !== row.actual_pages) throw new HttpError(400, 'full_page_count', '请保留已购买版本的页数');
    const revision = row.frozen_json ? row.revision : row.revision + 1;
    this.updateDeck(id, { slides_json: JSON.stringify(slides), revision, status: 'outline_ready', stage: '内容待确认' }); return revision;
  }
  setReady(id, files, pages) { this.updateDeck(id, { status: 'ready', stage: '可以下载', free_path: files.free, full_path: files.full, actual_pages: pages, error: null }); }
  setFailed(id, message) { this.updateDeck(id, { status: 'failed', stage: '生成失败', error: message }); }
  createOrder({ id, userId, deckId, revision, channel, mode = 'demo', amountFen = 5000, reserveBudget = false }) {
    return transaction(this.db, () => {
    const existing = this.db.prepare("SELECT * FROM orders WHERE user_id=? AND deck_id=? AND revision=? AND status IN ('pending','paid') ORDER BY created_at DESC LIMIT 1").get(userId, deckId, revision);
    if (reserveBudget && existing?.status !== 'paid') this.cost.reserve(existing?.id || id, 'paid', 100_000, true);
    if (existing) return existing;
    const deckTitle = this.getDeck(deckId, userId)?.title || '已删除的PPT';
    this.db.prepare('INSERT INTO orders(id,user_id,deck_id,revision,amount_fen,currency,channel,status,mode,created_at,deck_title) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, userId, deckId, revision, amountFen, 'CNY', channel, 'pending', mode, iso(), deckTitle);
    return this.order(id, userId);
    });
  }
  order(id, userId) { return this.db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(id, userId) || null; }
  orders(userId) { return this.db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(userId); }
  payOrder(id, userId) {
    return transaction(this.db, () => {
      const row = this.order(id, userId);
      if (!row || row.status === 'paid') return row;
      const deck = this.getDeck(row.deck_id, userId);
      if (!deck || deck.revision !== row.revision) throw new HttpError(409, 'stale_order', '作品不存在或版本已变化');
      if (deck.pipeline === 2 && !deck.fullReady) {
        this.assertQueueSpace();
        if (this.db.prepare("SELECT 1 FROM decks WHERE user_id=? AND id!=? AND status NOT IN ('ready','failed')").get(userId, deck.id)) throw new HttpError(409, 'active_task', '请先完成当前账号正在处理的作品');
        this.cost.commitReservation(id);
        this.updateDeck(deck.id, { frozen_json: JSON.stringify(deck.slides), phase: 'full', status: 'queued', stage: '已付款，等待补全' });
        this.db.prepare('INSERT INTO jobs(deck_id,kind,created_at) VALUES(?,?,?)').run(deck.id, 'complete', iso());
      }
      this.db.prepare("UPDATE orders SET status='paid',paid_at=? WHERE id=?").run(iso(), id);
      return this.order(id, userId);
    });
  }
  hasPaid(deckId, userId, revision) { return Boolean(this.db.prepare("SELECT 1 FROM orders WHERE deck_id=? AND user_id=? AND revision=? AND status='paid'").get(deckId, userId, revision)); }
  createDownloadToken({ userId, deckId, variant, ttlMs }) {
    const value = token();
    this.db.prepare('INSERT INTO download_tokens(token_hash,user_id,deck_id,variant,expires_at) VALUES(?,?,?,?,?)').run(hash(value), userId, deckId, variant, iso(Date.now() + ttlMs));
    return { value, expiresAt: Date.now() + ttlMs };
  }
  downloadToken(value) { return this.db.prepare('SELECT * FROM download_tokens WHERE token_hash=? AND expires_at>?').get(hash(value), iso()) || null; }
  deleteDeck(id, userId) {
    const row = this.db.prepare('SELECT * FROM decks WHERE id=? AND user_id=?').get(id, userId);
    if (!row) return null;
    const input = JSON.parse(row.input_json);
    this.db.prepare('DELETE FROM jobs WHERE deck_id=?').run(id);
    this.db.prepare('DELETE FROM download_tokens WHERE deck_id=?').run(id);
    this.db.prepare('DELETE FROM decks WHERE id=? AND user_id=?').run(id, userId);
    for (const assetId of input.photoIds) {
      const linked = this.db.prepare('SELECT 1 FROM decks WHERE input_json LIKE ? LIMIT 1').get('%' + assetId + '%');
      if (!linked) {
        const asset = this.db.prepare('SELECT * FROM assets WHERE id=? AND user_id=?').get(assetId, userId);
        this.db.prepare('DELETE FROM assets WHERE id=? AND user_id=?').run(assetId, userId);
        if (asset) fs.rm(asset.path, { force: true }).catch(() => {});
      }
    }
    for (const file of [row.free_path, row.full_path]) if (file) fs.rm(file, { force: true }).catch(() => {});
    return true;
  }
  deckFile(id, userId, variant) { const row = this.db.prepare('SELECT * FROM decks WHERE id=? AND user_id=?').get(id, userId); return row ? row[variant === 'free' ? 'free_path' : 'full_path'] : null; }
}
