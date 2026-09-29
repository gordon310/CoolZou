import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CostControl, chinaDay } from '../server/cost-control.mjs';
import { createApp } from '../server/app.mjs';
import { makeOutline } from '../server/outline.mjs';

test('reservations enforce paid, total, monthly and per-order limits; unknown charges remain held', () => {
  const db = new DatabaseSync(':memory:');
  let now = Date.parse('2026-09-14T15:59:59Z');
  const ledger = new CostControl(db, { dailyBudget: 500, paidDailyBudget: 400, monthlyBudget: 600, orderBudget: 300 }, () => now);
  try {
    ledger.reserve('paid1', 'paid', 300); ledger.commitReservation('paid1');
    assert.throws(() => ledger.reserve('paid2', 'paid', 101), /预算/);
    ledger.reserve('paid1', 'paid', 300);
    assert.equal(db.prepare('SELECT count(*) n FROM ai_budget').get().n, 1);
    ledger.reserve('free1', 'free', 200); ledger.commitReservation('free1');
    assert.throws(() => ledger.reserve('free2', 'free', 1), /预算/);
    ledger.settle('paid1', 100); ledger.settle('free1', undefined);
    now += 2000;
    assert.equal(chinaDay(now), '2026-09-15');
    // Yesterday's unknown charge still consumes today's available budget.
    assert.throws(() => ledger.reserve('big', 'free', 301), /单订单/);
    ledger.reserve('paid2', 'paid', 300); ledger.commitReservation('paid2'); ledger.settle('paid2', 300);
    assert.throws(() => ledger.reserve('month', 'free', 1), /预算/);
    assert.equal(db.prepare("SELECT status FROM ai_budget WHERE id='free1'").get().status, 'unknown');
  } finally { db.close(); }
});

test('unpaid reservation expires but committed delivery survives midnight and expiration', () => {
  const db = new DatabaseSync(':memory:'); let now = Date.now();
  const cost = new CostControl(db, {}, () => now);
  try {
    cost.reserve('unpaid'); cost.reserve('paid'); cost.commitReservation('paid');
    now += 24 * 3600_000;
    cost.expire();
    assert.throws(() => cost.commitReservation('unpaid'), /过期/);
    assert.equal(db.prepare("SELECT amount FROM ai_budget WHERE id='paid'").get().amount, 100_000);
    assert.equal(db.prepare("SELECT status FROM ai_budget WHERE id='paid'").get().status, 'committed');
  } finally { db.close(); }
});

test('real-model work is allowed only through the metered worker path', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const cost = new CostControl(db);
    assert.doesNotThrow(() => cost.assertAvailable('qwen'));
    await assert.rejects(makeOutline({}, [], { aiMode: 'qwen', aiKey: 'fake', aiBaseUrl: 'https://must-not-be-contacted.invalid' }), error => error.code === 'ai_not_configured');
    assert.throws(() => new CostControl(db, { monthlyBudget: NaN }), /Invalid/);
  } finally { db.close(); }
});

test('20 simultaneous jobs use two free and two paid slots, then drain without duplicate execution', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'coolzou-queue-'));
  const gates = []; const starts = []; let free = 0, paid = 0, freeMax = 0, paidMax = 0;
  const slides = Array.from({ length: 8 }, (_, i) => ({ title: `标题${i}`, body: '合成内容', notes: '', photoIds: [] }));
  const app = await createApp({ dataDir, aiMode: 'demo', phaseGenerator: async (input, photos, kind) => {
    starts.push(input.id);
    if (kind === 'outline') freeMax = Math.max(freeMax, ++free); else paidMax = Math.max(paidMax, ++paid);
    await new Promise(resolve => gates.push(resolve));
    if (kind === 'outline') free--; else paid--;
    return structuredClone(slides);
  } });
  try {
    for (let i = 0; i < 20; i++) {
      const user = app.store.createUser(); const id = `synthetic-${i}`;
      app.store.createDeck({ id, userId: user.id, input: { title: '压测', photoIds: [], reviewOutline: true } });
      if (i >= 10) {
        app.store.db.prepare("UPDATE jobs SET kind='complete' WHERE deck_id=?").run(id);
        app.store.updateDeck(id, { phase: 'full', directory_json: JSON.stringify(slides.map(s => ({ title: s.title }))), frozen_json: JSON.stringify(slides.slice(0, 5)) });
        const order = app.store.createOrder({ id: 'order-' + i, userId: user.id, deckId: id, revision: 0, channel: 'wechat' });
        app.store.db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(order.id);
      }
    }
    const first = Array.from({ length: 20 }, () => app.processNext());
    assert.equal(gates.length, 4);
    assert.equal(freeMax, 2); assert.equal(paidMax, 2);
    gates.splice(0).forEach(resolve => resolve()); await Promise.all(first);
    while (starts.length < 20) {
      const batch = Array.from({ length: 20 }, () => app.processNext());
      gates.splice(0).forEach(resolve => resolve()); await Promise.all(batch);
    }
    assert.equal(new Set(starts).size, 20);
    assert.equal(app.store.db.prepare("SELECT count(*) n FROM jobs WHERE status='done'").get().n, 20);
    assert.equal(freeMax, 2); assert.equal(paidMax, 2);
  } finally { gates.forEach(resolve => resolve()); await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('outline failure retries its original phase once and never exports absent slides', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'coolzou-retry-'));
  const kinds = [];
  const app = await createApp({ dataDir, aiMode: 'demo', phaseGenerator: async (_input, _photos, kind) => { kinds.push(kind); throw new Error('模拟失败'); } });
  try {
    const user = app.store.createUser();
    app.store.createDeck({ id: 'retry', userId: user.id, input: { photoIds: [], reviewOutline: false } });
    await app.processNext(); app.store.retry('retry'); await app.processNext();
    assert.deepEqual(kinds, ['outline', 'outline']);
    assert.throws(() => app.store.retry('retry'), /重试上限/);
    assert.equal(app.store.deckFile('retry', user.id, 'full'), null);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
