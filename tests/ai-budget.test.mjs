import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CostControl, aiCostMicros, costMicrosForTokens } from '../server/cost-control.mjs';
import { estimateAiCost } from '../server/ai.mjs';

test('AI token pricing uses ceiling integer arithmetic and rejects invalid usage', () => {
  assert.equal(costMicrosForTokens(0, 123), 0);
  assert.equal(costMicrosForTokens(1, 1), 1);
  assert.equal(costMicrosForTokens(1_000_001, 1), 2);
  assert.equal(aiCostMicros(
    { promptTokens: 1_000_001, completionTokens: 2_000_000, totalTokens: 3_000_001 },
    { inputPriceMicrosPerMillion: 1, outputPriceMicrosPerMillion: 3 }
  ), 8);
  assert.throws(() => costMicrosForTokens(-1, 1), /Invalid/);
  assert.throws(() => aiCostMicros({ promptTokens: -1, completionTokens: 1, totalTokens: 0 }, { inputPriceMicrosPerMillion: 1, outputPriceMicrosPerMillion: 1 }), /Invalid/);
});

test('AI estimate reserves the shorter card-output ceiling', () => {
  assert.equal(estimateAiCost({
    aiMaxInputTokens: 12_000, aiMaxCompletionTokens: 4_096,
    aiInputPriceMicrosPerMillion: 123, aiOutputPriceMicrosPerMillion: 456
  }, { content: '素材' }, [{ id: 'asset-1' }]), 3);
});

test('AI reservation settles valid usage and holds unknown or overrun usage', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new CostControl(db, { dailyBudget: 1_000, paidDailyBudget: 1_000, monthlyBudget: 2_000, orderBudget: 900 });
    const reserved = ledger.reserveAi('ai-free', 'free', 100);
    assert.equal(reserved.amount, 100);
    ledger.settleAi('ai-free', 50);
    assert.deepEqual({ ...db.prepare("SELECT amount,status,expires_at FROM ai_budget WHERE id='ai-free'").get() }, { amount: 50, status: 'settled', expires_at: null });

    ledger.reserveAi('ai-invalid', 'free', 100);
    ledger.settleAi('ai-invalid', -1);
    assert.deepEqual({ ...db.prepare("SELECT amount,status,expires_at FROM ai_budget WHERE id='ai-invalid'").get() }, { amount: 100, status: 'unknown', expires_at: null });

    ledger.reserveAi('ai-overrun', 'free', 100);
    ledger.settleAi('ai-overrun', 101);
    assert.deepEqual({ ...db.prepare("SELECT amount,status,expires_at FROM ai_budget WHERE id='ai-overrun'").get() }, { amount: 100, status: 'unknown', expires_at: null });
    assert.throws(() => ledger.reserveAi('too-large', 'free', 901), /单订单/);
  } finally {
    db.close();
  }
});

test('AI reservations do not expire or permit a second charge for the same job', () => {
  const db = new DatabaseSync(':memory:');
  let now = Date.UTC(2026, 8, 17);
  try {
    const ledger = new CostControl(db, { dailyBudget: 100, orderBudget: 100 }, () => now);
    ledger.reserveAi('ai-running', 'free', 100);
    now += 20 * 60_000;
    ledger.expire();
    assert.equal(db.prepare("SELECT amount FROM ai_budget WHERE id='ai-running'").get().amount, 100);
    assert.throws(() => ledger.reserveAi('ai-other', 'free', 1), error => error.code === 'budget_exhausted');
    assert.throws(() => ledger.reserveAi('ai-running', 'free', 100), error => error.code === 'ai_cost_unknown');
    ledger.settleAi('ai-running', undefined);
    assert.throws(() => ledger.reserveAi('ai-running', 'free', 100), error => error.code === 'ai_cost_unknown');
  } finally { db.close(); }
});
