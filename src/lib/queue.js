// BullMQ wiring: producers fail fast when Redis is down (callers degrade), workers use blocking connections.
import { Queue, Worker } from 'bullmq';
import { redisOptions } from './redis.js';
import { getSetting } from './settings.js';
import { withTimeout } from './resilience.js';
import { logger } from './logger.js';

const log = logger('queue');
export const Q = { process: 'process', keyword: 'keyword', ai: 'ai', notify: 'notify', analytics: 'analytics' };
const PREFIX = 'nabd';
const queues = new Map();
export const queueState = { ok: true, lastError: null };

export function getQueue(name) {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { prefix: PREFIX, connection: redisOptions({ enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000 }) });
    q.on('error', (e) => { queueState.ok = false; queueState.lastError = e.message; });
    queues.set(name, q);
  }
  return q;
}

/** Returns true when queued, false when the queue is unavailable (callers must degrade, never lose data). */
export async function enqueue(name, jobName, data, { jobId, delay, priority } = {}) {
  try {
    const [attempts, backoffMs, keepC, keepF] = await Promise.all(['queue.attempts', 'queue.backoff_ms', 'queue.keep_completed', 'queue.keep_failed'].map(getSetting));
    await withTimeout(getQueue(name).add(jobName, data, {
      jobId, delay, priority, attempts, backoff: { type: 'exponential', delay: backoffMs },
      removeOnComplete: { count: keepC }, removeOnFail: { count: keepF },
    }), 2500, 'enqueue');
    queueState.ok = true;
    return true;
  } catch (e) {
    queueState.ok = false; queueState.lastError = e.message;
    return false;
  }
}

export function createWorker(name, processor, { concurrency = 4, limiter } = {}) {
  const w = new Worker(name, processor, {
    prefix: PREFIX, concurrency, limiter, lockDuration: 60000,
    connection: redisOptions({ maxRetriesPerRequest: null }),
  });
  w.on('error', (e) => { if (!/ECONNREFUSED|Connection is closed|ETIMEDOUT/.test(e.message)) log.warn(`worker ${name} error`, { err: e.message }); });
  return w;
}

export async function queueCounts() {
  const out = {};
  await Promise.all(Object.values(Q).map(async (n) => {
    try { out[n] = await withTimeout(getQueue(n).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused'), 1500, 'counts'); queueState.ok = true; }
    catch (e) { out[n] = null; queueState.ok = false; queueState.lastError = e.message; }
  }));
  return out;
}
const PIPE = [Q.process, Q.keyword, Q.ai];
export async function pausePipeline() { await Promise.all(PIPE.map((n) => getQueue(n).pause())); }
export async function resumePipeline() { await Promise.all(PIPE.map((n) => getQueue(n).resume())); }
export async function drainPipeline() { for (const n of [...PIPE, Q.notify]) await getQueue(n).drain(true); }
export async function retryFailed(name) { const q = getQueue(name); const n = (await q.getJobCounts('failed')).failed; if (n) await q.retryJobs({ state: 'failed', count: 1000 }); return n; }
export async function failedJobs(name, limit = 25) {
  const jobs = await getQueue(name).getJobs(['failed'], 0, limit - 1, false);
  return jobs.map((j) => ({ id: j.id, name: j.name, data: j.data, attempts: j.attemptsMade, failedReason: j.failedReason, finishedOn: j.finishedOn }));
}
export async function closeQueues() { await Promise.all([...queues.values()].map((q) => q.close().catch(() => {}))); queues.clear(); }
