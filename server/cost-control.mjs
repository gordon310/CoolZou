import { HttpError } from './validation.mjs';

// Amounts are integer millionths of a yuan, including outstanding reservations.
export const costDefaults = Object.freeze({ dailyFreeTasks: 1, freeSlots: 2, paidSlots: 2, renderSlots: 2, dailyBudget: 5_000_000, paidDailyBudget: 4_000_000, monthlyBudget: 150_000_000, orderBudget: 500_000 });
export const chinaDay = time => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);

export function costMicrosForTokens(tokens, priceMicrosPerMillion) {
  if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(priceMicrosPerMillion) || priceMicrosPerMillion < 0) throw new Error('Invalid token cost');
  const value = (BigInt(tokens) * BigInt(priceMicrosPerMillion) + 999_999n) / 1_000_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid token cost');
  return Number(value);
}

export function aiCostMicros(usage, pricing) {
  const fields = ['promptTokens', 'completionTokens', 'totalTokens'];
  if (!usage || fields.some(field => !Number.isSafeInteger(usage[field]) || usage[field] < 0)) throw new Error('Invalid AI usage');
  return costMicrosForTokens(usage.promptTokens, pricing?.inputPriceMicrosPerMillion) +
    costMicrosForTokens(usage.completionTokens, pricing?.outputPriceMicrosPerMillion);
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export class CostControl {
  constructor(db, policy = {}, now = Date.now) {
    this.db = db; this.policy = { ...costDefaults, ...policy }; this.now = now;
    for (const value of Object.values(this.policy)) if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid cost policy');
    db.exec(`CREATE TABLE IF NOT EXISTS task_admissions (user_id TEXT NOT NULL, request_key TEXT NOT NULL, deck_id TEXT NOT NULL, day TEXT NOT NULL, material_key TEXT, UNIQUE(user_id, request_key));
      CREATE TABLE IF NOT EXISTS ai_budget (id TEXT PRIMARY KEY, lane TEXT NOT NULL, day TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, expires_at INTEGER);
      CREATE INDEX IF NOT EXISTS task_admissions_day ON task_admissions(user_id, day);`);
    if (!db.prepare('PRAGMA table_info(task_admissions)').all().some(column => column.name === 'material_key')) db.exec('ALTER TABLE task_admissions ADD COLUMN material_key TEXT');
  }
  assertAvailable(aiMode) {
    if (!['demo', 'qwen'].includes(aiMode)) throw new HttpError(503, 'ai_paused', 'AI 模式未配置');
  }
  admit(userId, key, deckId, materialKey, create) {
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT d.id,d.status FROM task_admissions a JOIN decks d ON d.id=a.deck_id WHERE a.user_id=? AND a.request_key=?').get(userId, key);
      if (existing && existing.status !== 'failed') return existing.id;
      if (this.db.prepare("SELECT 1 FROM decks WHERE user_id=? AND status NOT IN ('ready','failed')").get(userId)) throw new HttpError(409, 'active_task', '已有一份作品待生成或确认，请先完成当前作品');
      const day = chinaDay(this.now());
      const count = this.db.prepare("SELECT count(*) n FROM task_admissions a LEFT JOIN decks d ON d.id=a.deck_id WHERE a.user_id=? AND a.day=? AND (d.id IS NULL OR d.status!='failed')").get(userId, day).n;
      if (count >= this.policy.dailyFreeTasks) throw new HttpError(429, 'daily_quota', '试运营期间每个账号每天可新建1份作品，请明天再试；已有作品仍可下载');
      // Keep daily counts after deletion, but let a failed request be submitted again.
      this.db.prepare('UPDATE task_admissions SET request_key=request_key || deck_id WHERE user_id=? AND request_key=?').run(userId, key);
      this.db.prepare('INSERT INTO task_admissions VALUES(?,?,?,?,?)').run(userId, key, deckId, day, materialKey || null);
      create(); return deckId;
    });
  }
  expire() {
    this.db.prepare("UPDATE ai_budget SET status='released',amount=0 WHERE status='reserved' AND expires_at IS NOT NULL AND expires_at<=?").run(this.now());
  }
  reserve(id, lane = 'paid', amount = 100_000, inTransaction = false, expiresAt = this.now() + 15 * 60_000) {
    const reserve = () => {
      this.expire();
      const existing = this.db.prepare('SELECT * FROM ai_budget WHERE id=?').get(id);
      if (existing && existing.status !== 'released') return existing;
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.policy.orderBudget) throw new HttpError(503, 'order_budget', '本次生成超过单订单预算');
      const day = chinaDay(this.now());
      const rows = this.db.prepare("SELECT * FROM ai_budget WHERE status!='released'").all();
      const sum = predicate => rows.filter(predicate).reduce((total, row) => total + row.amount, 0);
      const outstanding = row => row.status !== 'settled';
      if (sum(row => row.day === day || outstanding(row)) + amount > this.policy.dailyBudget ||
          sum(row => row.day.slice(0, 7) === day.slice(0, 7) || outstanding(row)) + amount > this.policy.monthlyBudget ||
          (lane === 'paid' && sum(row => row.lane === 'paid' && (row.day === day || outstanding(row))) + amount > this.policy.paidDailyBudget)) {
        throw new HttpError(503, 'budget_exhausted', '今日生成预算已用完，暂不接受新订单；已有付费任务继续处理');
      }
      this.db.prepare('INSERT INTO ai_budget VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,amount=excluded.amount,status=excluded.status,expires_at=excluded.expires_at').run(id, lane, day, amount, 'reserved', expiresAt);
      return this.db.prepare('SELECT * FROM ai_budget WHERE id=?').get(id);
    };
    return inTransaction ? reserve() : transaction(this.db, reserve);
  }
  reserveAi(id, lane, estimateMicros) {
    return transaction(this.db, () => {
      this.expire();
      if (this.db.prepare('SELECT 1 FROM ai_budget WHERE id=?').get(id)) {
        throw new HttpError(503, 'ai_cost_unknown', '该 AI 任务已有费用记录，不能重复调用');
      }
      return this.reserve(id, lane, estimateMicros, true, null);
    });
  }
  commitReservation(id) {
    const row = this.db.prepare('SELECT * FROM ai_budget WHERE id=?').get(id);
    if (!row || row.status === 'released' || (row.status === 'reserved' && row.expires_at <= this.now())) throw new HttpError(409, 'order_expired', '订单已过期，请重新下单');
    this.db.prepare("UPDATE ai_budget SET status='committed',expires_at=NULL WHERE id=? AND status='reserved'").run(id);
  }
  settleAi(id, actual) {
    const row = this.db.prepare('SELECT * FROM ai_budget WHERE id=?').get(id);
    if (!row || row.status === 'settled' || row.status === 'released') return;
    if (!Number.isSafeInteger(actual) || actual < 0 || actual > row.amount) {
      this.db.prepare("UPDATE ai_budget SET status='unknown',expires_at=NULL WHERE id=?").run(id);
      return;
    }
    this.db.prepare("UPDATE ai_budget SET status='settled',amount=?,expires_at=NULL WHERE id=?").run(actual, id);
  }
  settle(id, actual) {
    return this.settleAi(id, actual);
  }
}
