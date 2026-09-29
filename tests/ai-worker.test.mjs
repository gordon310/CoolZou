import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

const providerConfig = {
  mode: 'live', aiMode: 'qwen', paymentMode: 'disabled',
  aiKey: 'provider-secret', aiBaseUrl: 'https://dashscope.example/v1', aiModel: 'qwen3-vl-plus',
  aiMaxInputTokens: 10, aiMaxCompletionTokens: 10, aiTimeoutMs: 1000,
  aiInputPriceMicrosPerMillion: 1_000_000, aiOutputPriceMicrosPerMillion: 1_000_000,
  costPolicy: { dailyBudget: 100, paidDailyBudget: 100, monthlyBudget: 100, orderBudget: 100 }
};

const slides = Array.from({ length: 5 }, (_, i) => ({ title: `第${i + 1}页`, body: '活动记录', notes: '', photoIds: [] }));
const usage = { model: 'qwen3-vl-plus', promptTokens: 1, completionTokens: 2, totalTokens: 3, costMicros: 3 };

async function appWith(options) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'coolzou-ai-worker-'));
  const app = await createApp({ ...providerConfig, ...options, dataDir });
  return { app, dataDir };
}

function deck(app, id) {
  const user = app.store.createUser();
  app.store.createDeck({ id, userId: user.id, input: { title: '真实 AI 测试', grade: 3, gender: 'boy', content: '观察活动', photoIds: [], reviewOutline: true } });
  return { user, id };
}

test('qwen outline reserves before generation and settles returned usage', async () => {
  let calls = 0;
  const events = [];
  const { app, dataDir } = await appWith({ logger: (event, fields) => events.push({ event, ...fields }), phaseGenerator: async () => { calls++; return { slides, usage }; } });
  try {
    const item = deck(app, 'ai-free');
    await app.processNext();
    assert.equal(calls, 1);
    assert.equal(app.store.getDeck(item.id, item.user.id).status, 'outline_ready');
    assert.deepEqual({ ...app.store.db.prepare("SELECT lane,amount,status FROM ai_budget WHERE id='ai_job_1'").get() }, { lane: 'free', amount: 3, status: 'settled' });
    assert.deepEqual(events.find(event => event.event === 'ai_usage_settled'), {
      event: 'ai_usage_settled', jobId: 1, deckId: item.id, kind: 'outline',
      model: 'qwen3-vl-plus', promptTokens: 1, completionTokens: 2, totalTokens: 3, costMicros: 3
    });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('qwen budget refusal does not call the provider generator', async () => {
  let calls = 0;
  const { app, dataDir } = await appWith({ costPolicy: { dailyBudget: 2 }, phaseGenerator: async () => { calls++; return { slides, usage }; } });
  try {
    const item = deck(app, 'ai-budget-refused');
    await app.processNext();
    assert.equal(calls, 0);
    assert.equal(app.store.getDeck(item.id, item.user.id).status, 'failed');
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM ai_budget').get().n, 0);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('invalid qwen slides fail the job and are never published', async () => {
  const invalid = [{ ...slides[0], photoIds: ['not-owned'] }];
  const { app, dataDir } = await appWith({ phaseGenerator: async () => ({ slides: invalid, usage }) });
  try {
    const item = deck(app, 'ai-invalid');
    await app.processNext();
    const stored = app.store.getDeck(item.id, item.user.id);
    assert.equal(stored.status, 'failed');
    assert.deepEqual(stored.slides, []);
    assert.equal(app.store.db.prepare("SELECT status FROM ai_budget WHERE id='ai_job_1'").get().status, 'unknown');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('demo mode keeps array generators and needs no AI pricing', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'coolzou-ai-worker-demo-'));
  const app = await createApp({ dataDir, mode: 'demo', aiMode: 'demo', phaseGenerator: async () => slides });
  try {
    const item = deck(app, 'demo-array');
    await app.processNext();
    assert.equal(app.store.getDeck(item.id, item.user.id).status, 'outline_ready');
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM ai_budget').get().n, 0);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('retry after an unknown provider charge cannot call the provider twice', async () => {
  let calls = 0;
  const { app, dataDir } = await appWith({ phaseGenerator: async () => { calls++; throw new Error('synthetic provider timeout'); }, logger: () => {} });
  try {
    const item = deck(app, 'ai-unknown-retry');
    await app.processNext();
    app.store.retry(item.id);
    await app.processNext();
    assert.equal(calls, 1);
    assert.equal(app.store.db.prepare("SELECT status FROM ai_budget WHERE id='ai_job_1'").get().status, 'unknown');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
