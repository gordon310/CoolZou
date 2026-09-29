import { makeOutline } from './outline.mjs';
import { exportDeck } from './ppt.mjs';
import { HttpError, validateSlides } from './validation.mjs';
import { errorDetails } from './diagnostics.mjs';
import { estimateAiCost } from './ai.mjs';

export class Worker {
  constructor(store, config) { this.store = store; this.config = config; this.running = new Set(); this.started = new Map(); }
  isStalled() { return [...this.started.values()].some(start => Date.now() - start > this.config.jobTimeoutMs); }
  processNext() {
    if (this.closing) return Promise.resolve(false);
    const job = this.store.claimJob();
    if (!job) return Promise.resolve(false);
    const task = this.run(job);
    this.running.add(task);
    this.started.set(task, Date.now());
    task.finally(() => { this.running.delete(task); this.started.delete(task); }).catch(() => {});
    return task;
  }
  async drain() { await Promise.allSettled([...this.running]); }
  async run(job) {
    const started = Date.now();
    this.config.log('job_started', { jobId: job.id, deckId: job.deck_id, kind: job.kind });
    const row = this.store.db.prepare('SELECT * FROM decks WHERE id=?').get(job.deck_id);
    let aiReservationId;
    try {
      if (!row) throw new Error('作品不存在');
      const deck = this.store.getDeck(job.deck_id, row.user_id);
      const assets = this.store.assetsForUser(deck.photoIds, row.user_id);
      if (job.kind === 'outline' || job.kind === 'complete') {
        this.store.cost.assertAvailable(this.config.aiMode);
        if (job.kind === 'complete' && !deck.paid) throw new Error('付款尚未确认');
        const allowedIds = job.kind === 'outline' && deck.pipeline === 2 ? deck.photoIds.slice(0, 8) : deck.photoIds;
        const photos = assets.filter(asset => allowedIds.includes(asset.id)).map(asset => ({ id: asset.id, path: asset.path }));
        const input = { ...deck, photoIds: allowedIds };
        if (this.config.aiMode === 'qwen') {
          aiReservationId = `ai_job_${job.id}`;
          this.store.cost.reserveAi(aiReservationId, job.kind === 'complete' ? 'paid' : 'free', estimateAiCost(this.config, input, photos));
        }
        const generationStarted = Date.now();
        const generated = this.config.phaseGenerator
          ? await this.config.phaseGenerator(input, photos, job.kind)
          : await makeOutline(input, photos, this.config);
        this.config.log('generation_stage', { jobId: job.id, deckId: job.deck_id, kind: job.kind, stage: 'ai', durationMs: Date.now() - generationStarted });
        let slides = validateSlides(this.config.aiMode === 'qwen' ? generated?.slides : generated, allowedIds);
        if (this.config.aiMode === 'qwen') {
          const actual = generated?.usage?.costMicros;
          this.store.cost.settleAi(aiReservationId, actual);
          const budget = this.store.db.prepare('SELECT status FROM ai_budget WHERE id=?').get(aiReservationId);
          if (!budget || budget.status !== 'settled') throw new HttpError(503, 'ai_cost_unknown', 'AI 用量无法核对，作品未发布');
          this.config.log('ai_usage_settled', {
            jobId: job.id, deckId: job.deck_id, kind: job.kind, model: generated.usage.model,
            promptTokens: generated.usage.promptTokens, completionTokens: generated.usage.completionTokens,
            totalTokens: generated.usage.totalTokens, costMicros: actual
          });
        }
        if (deck.pipeline === 2 && job.kind === 'outline') {
          this.store.updateDeck(deck.id, { directory_json: JSON.stringify(slides.map(s => ({ title: s.title }))), actual_pages: slides.length });
          slides = slides.slice(0, 5);
        } else if (deck.pipeline === 2) {
          if (slides.length !== deck.directory.length) throw new Error('补全页数与目录不一致');
          const frozen = JSON.parse(row.frozen_json);
          slides = [...frozen, ...slides.slice(5).map((slide, i) => ({ ...slide, title: deck.directory[i + 5].title }))];
        }
        this.store.setSlides(deck.id, slides);
        if (deck.reviewOutline === false) this.store.queueRender(deck.id);
      } else if (job.kind === 'render') {
        const renderStarted = Date.now();
        await this.config.requireDisk();
        this.store.updateDeck(deck.id, { status: 'rendering', stage: deck.phase === 'full' ? '正在排版完整版' : '正在排版前5页' });
        const freeOnly = deck.pipeline === 2 && deck.phase === 'free' && deck.actualPages > 5;
        const files = await exportDeck(deck.slides, assets, this.store.filesDir, { ...deck, freeOnly, preserveFree: Boolean(row.frozen_json) });
        this.config.log('generation_stage', { jobId: job.id, deckId: job.deck_id, kind: job.kind, stage: 'ppt', durationMs: Date.now() - renderStarted });
        this.store.setReady(deck.id, files, deck.pipeline === 2 ? deck.actualPages : files.actualPages);
        this.store.updateDeck(deck.id, { stage: freeOnly ? '前5页已就绪' : '完整版已就绪' });
        if (deck.paid) {
          const order = this.store.db.prepare("SELECT id FROM orders WHERE deck_id=? AND revision=? AND status='paid'").get(deck.id, deck.revision);
          // Demo makes no external calls; live settlement needs verified provider usage.
          if (order) this.store.cost.settle(order.id, 0);
        }
      }
      this.store.markJob(job.id, 'done');
      this.config.log('job_done', { jobId: job.id, durationMs: Date.now() - started });
    } catch (error) {
      if (aiReservationId) this.store.cost.settleAi(aiReservationId, undefined);
      this.config.log('job_failed', { jobId: job.id, deckId: job.deck_id, kind: job.kind, ...errorDetails(error) });
      this.store.markJob(job.id, 'failed');
      this.store.setFailed(job.deck_id, error.message || '生成失败，请稍后重试');
    }
    return true;
  }
}
