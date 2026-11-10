// PostgreSQL-backed task runner (SKIP LOCKED): durable, resumable (checkpoints), cancellable, works without Redis.
import { one, query } from '../lib/db.js';
import { publish } from '../lib/bus.js';
import { backoff } from '../lib/resilience.js';
import { fireTrigger } from '../services/automation.js';
import { createAlert } from '../services/notifier.js';
import { logger } from '../lib/logger.js';

const log = logger('tasks');
export class TaskInterrupt extends Error { constructor(kind) { super(kind); this.kind = kind; } }

export class TaskRunner {
  constructor({ instanceId, handlers, max = 3 }) { Object.assign(this, { instanceId, handlers, max, running: 0, stopped: true, timer: null, busy: false }); }
  start() { this.stopped = false; this.timer = setInterval(() => void this.tick(), 3000); void this.tick(); }
  async stop() { this.stopped = true; clearInterval(this.timer); const end = Date.now() + 10000; while (this.running && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); }
  poke() { setImmediate(() => void this.tick()); }

  async tick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      while (!this.stopped && this.running < this.max) {
        const names = [...this.handlers().keys()];
        if (!names.length) break;
        const job = await one(
          `UPDATE jobs SET state = 'running', locked_by = $1, started_at = COALESCE(started_at, now()), heartbeat_at = now(), attempts = attempts + 1, error = NULL
            WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND run_after <= now() AND name = ANY($2::text[]) ORDER BY run_after, created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
          [this.instanceId, names]);
        if (!job) break;
        this.running++;
        void this.execute(job).finally(() => { this.running--; this.poke(); });
      }
    } catch (e) { log.warn('task tick failed', { err: e.message }); } finally { this.busy = false; }
  }

  async execute(job) {
    const handler = this.handlers().get(job.name);
    await publish('job.update', { id: job.id });
    const hb = setInterval(() => query('UPDATE jobs SET heartbeat_at = now() WHERE id = $1', [job.id]).catch(() => {}), 20000);
    const helpers = {
      async checkpoint(progress, cp) {
        const r = await one('UPDATE jobs SET progress = $2, checkpoint = COALESCE($3::jsonb, checkpoint), heartbeat_at = now() WHERE id = $1 RETURNING cancel_requested, pause_requested', [job.id, progress, cp ? JSON.stringify(cp) : null]);
        if (r?.cancel_requested) throw new TaskInterrupt('cancelled');
        if (r?.pause_requested) throw new TaskInterrupt('paused');
        await publish('job.update', { id: job.id });
      },
    };
    const done = (state, extra = {}) => query(
      `UPDATE jobs SET state = $2, finished_at = CASE WHEN $2 IN ('completed','failed','cancelled') THEN now() ELSE NULL END,
         duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int, locked_by = NULL, progress = COALESCE($3, progress), result = COALESCE($4::jsonb, result),
         error = $5, run_after = COALESCE($6, run_after), cancel_requested = false, pause_requested = false WHERE id = $1`,
      [job.id, state, extra.progress ?? null, extra.result ? JSON.stringify(extra.result) : null, extra.error ?? null, extra.runAfter ?? null]);
    try {
      const result = await handler(job, helpers);
      await done('completed', { progress: 100, result: result ?? {} });
    } catch (e) {
      if (e instanceof TaskInterrupt) await done(e.kind === 'paused' ? 'paused' : 'cancelled');
      else if (job.attempts < job.max_attempts) {
        await done('queued', { error: String(e.message).slice(0, 300), runAfter: new Date(Date.now() + backoff(job.attempts, 3000, 120000)) });
        log.warn('task failed, will retry', { id: job.id, name: job.name, attempt: job.attempts, err: e.message });
      } else {
        await done('failed', { error: String(e.message).slice(0, 300) });
        log.error('task failed permanently', { id: job.id, name: job.name, err: e.message });
        await createAlert({ title: `Task failed: ${job.title ?? job.name}`, body: String(e.message).slice(0, 300), severity: 'medium', kind: 'job', dedupeKey: `job:${job.id}` });
        void fireTrigger('job_failed', { id: job.id, name: job.name, error: e.message }, { ref: job.id });
      }
    } finally { clearInterval(hb); await publish('job.update', { id: job.id }); }
  }
}
