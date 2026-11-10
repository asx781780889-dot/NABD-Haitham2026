// Worker modules (start/stop/pause independently): telegram, processor, keyword, ai, notification, analytics, cleanup, scheduler.
import os from 'node:os';
import { createWorker, enqueue, Q, getQueue } from '../lib/queue.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { many, one, pool, query } from '../lib/db.js';
import { Ingestor } from '../services/ingest.js';
import { TelegramManager } from '../telegram/manager.js';
import { setTelegramManager } from '../telegram/registry.js';
import { stageProcess, stageKeyword, stageAi, markFailed } from './pipeline.js';
import { sendNotification, createAlert } from '../services/notifier.js';
import { flushStats } from '../services/stats.js';
import { runCleanup } from '../services/cleanup.js';
import { createBackup } from '../services/backup.js';
import { databaseStatus } from '../services/dbmonitor.js';
import { createTask } from '../services/tasks.js';
import { fireTrigger } from '../services/automation.js';
import { publish } from '../lib/bus.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';

const log = logger('modules');
const SWEEP_MS = Number(process.env.NABD_SWEEP_MS || 15000);
const SWEEP_AGE_S = Number(process.env.NABD_SWEEP_AGE_S || 20);
const isFinal = (job) => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

function bullModule(name, queue, handler, optsFn = async () => ({}), { onFinalFail } = {}) {
  let worker = null; const st = { processed: 0, failed: 0, lastError: null };
  return {
    name, queue,
    async start() {
      worker = createWorker(queue, (job) => handler(job), await optsFn());
      worker.on('completed', () => { st.processed++; });
      worker.on('failed', (job, err) => { st.failed++; st.lastError = err?.message ?? String(err); if (job && onFinalFail && job.attemptsMade >= (job.opts.attempts ?? 1)) onFinalFail(job, err).catch(() => {}); });
    },
    async stop() { const w = worker; worker = null; if (w) await w.close(); },
    async pause() { await worker?.pause(true); }, async resume() { await worker?.resume(); },
    stats: () => ({ ...st }),
  };
}

export const processorModule = () => bullModule('processor', Q.process, (j) => stageProcess(j.data.messageId), async () => ({ concurrency: await getSetting('workers.concurrency_process') }),
  { onFinalFail: (j, e) => markFailed(j.data.messageId, e) });
export const keywordModule = () => bullModule('keyword', Q.keyword, (j) => stageKeyword(j.data.messageId), async () => ({ concurrency: await getSetting('workers.concurrency_keyword') }),
  { onFinalFail: (j, e) => markFailed(j.data.messageId, e) });
export const aiModule = () => bullModule('ai', Q.ai, (j) => stageAi(j.data.messageId, j.data.radarIds, { final: isFinal(j) }),
  async () => ({ concurrency: await getSetting('ai.concurrency'), limiter: { max: await getSetting('ai.requests_per_minute'), duration: 60000 } }),
  { onFinalFail: (j, e) => markFailed(j.data.messageId, e) });
export const notificationModule = () => bullModule('notification', Q.notify, (j) => sendNotification(j.data.id, { final: isFinal(j) }), async () => ({ concurrency: await getSetting('workers.concurrency_notify') }));

export function analyticsModule() {
  const inner = bullModule('analytics', Q.analytics, async () => {
    await query(`UPDATE ai_rules r SET confirmed = x.c, rejected = x.i FROM (SELECT ai_rule_id, count(*) FILTER (WHERE feedback = 'correct')::int AS c, count(*) FILTER (WHERE feedback = 'incorrect')::int AS i
                   FROM message_matches WHERE ai_rule_id IS NOT NULL GROUP BY ai_rule_id) x WHERE r.id = x.ai_rule_id`);
    await query("DELETE FROM stats_hourly WHERE bucket < now() - interval '400 days'");
    await flushStats();
  });
  const stop = inner.stop;
  return { ...inner, async stop() { await flushStats(); await stop(); } };
}

export function telegramModule() {
  const ingestor = new Ingestor(); let mgr = null;
  return {
    name: 'telegram',
    async start() { mgr = new TelegramManager({ ingestor }); setTelegramManager(mgr); await mgr.start(); },
    async stop() { if (mgr) await mgr.stop(); setTelegramManager(null); mgr = null; },
    stats: () => ({ processed: ingestor.stats().inserted, failed: ingestor.stats().failures, meta: { ...(mgr?.snapshot() ?? {}), ingest: ingestor.stats() } }),
    onCommand: (cmd) => mgr?.command(cmd),
    tasks: {
      'account.connect': async (j) => { await mgr.connect(j.payload.id); return { ok: true }; },
      'account.reconnect': async (j) => { await mgr.reconnect(j.payload.id); return { ok: true }; },
      'account.disconnect': async (j) => { await mgr.disconnect(j.payload.id); return { ok: true }; },
      'account.sync': (j) => mgr.syncDialogs(j.payload.id),
      'account.test': (j) => mgr.test(j.payload.id),
      scan_history: (j, h) => mgr.scanHistory(j, h),
    },
  };
}

export function cleanupModule() {
  return {
    name: 'cleanup', stats: () => ({ processed: 0, failed: 0 }), async start() {}, async stop() {},
    tasks: {
      'cleanup.run': async (j) => { const r = await runCleanup({ dryRun: !!j.payload.dryRun, urgent: !!j.payload.urgent }); if (!j.payload.dryRun) await audit({ username: 'system' }, 'CLEANUP_RUN', { details: r }); return r; },
      'backup.create': async (j) => { const b = await createBackup({ kind: j.payload.kind ?? 'database', createdBy: j.created_by }); await audit({ username: 'system', user: j.created_by ? { id: j.created_by } : undefined }, 'BACKUP_CREATED', { entity: 'backup', entityId: b.id, details: { kind: b.kind, size: b.size_bytes } }); return { id: b.id, file: b.file_name, size: b.size_bytes }; },
    },
  };
}

const LEVEL_SEV = { warning: 'low', high_risk: 'medium', critical: 'high', emergency_prep: 'critical', emergency: 'critical' };
async function leader(name, fn) {
  const c = await pool.connect();
  try {
    const { rows } = await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`nabd:${name}`]);
    if (rows[0]?.ok) await fn();
  } catch (e) { log.warn(`scheduler job ${name} failed`, { err: e.message }); }
  finally { try { await c.query('SELECT pg_advisory_unlock(hashtext($1))', [`nabd:${name}`]); } catch { /* ignore */ } c.release(); }
}

export function schedulerModule() {
  const timers = []; let lastLevel = 'normal'; const st = { processed: 0, failed: 0 };
  const every = (ms, name, fn) => timers.push(setInterval(() => void leader(name, async () => { try { await fn(); st.processed++; } catch (e) { st.failed++; throw e; } }), ms));
  async function sweep() {
    await query("UPDATE messages SET state = 'failed', error = 'max attempts exceeded' WHERE state IN ('pending','processing') AND attempts >= 8");
    await query("UPDATE messages SET state = 'pending' WHERE state = 'processing' AND claimed_at < now() - interval '3 minutes'");
    const pending = await many("SELECT id, attempts FROM messages WHERE state = 'pending' AND created_at < now() - make_interval(secs => $1) ORDER BY id LIMIT 200", [SWEEP_AGE_S]);
    let inline = 0;
    for (const m of pending) if (!(await enqueue(Q.process, 'process', { messageId: m.id }, { jobId: `m-${m.id}-${m.attempts}` })) && inline++ < 25) await stageProcess(m.id).catch(() => {});
    const notes = await many("SELECT id, attempts FROM notifications WHERE status = 'pending' AND channel IN ('telegram','email') AND created_at < now() - interval '30 seconds' AND attempts < 5 ORDER BY id LIMIT 20");
    for (const n of notes) if (!(await enqueue(Q.notify, 'send', { id: n.id }, { jobId: `n-${n.id}-${n.attempts}` }))) await sendNotification(n.id).catch(() => {});
    await query("UPDATE jobs SET state = 'failed', error = 'worker lost and attempts exhausted', finished_at = now(), locked_by = NULL WHERE state = 'running' AND heartbeat_at < now() - interval '90 seconds' AND attempts >= max_attempts");
    await query("UPDATE jobs SET state = 'queued', locked_by = NULL WHERE state = 'running' AND heartbeat_at < now() - interval '90 seconds'");
  }
  async function dbCheck() {
    const s = await databaseStatus();
    if (s.level !== lastLevel) {
      const prev = lastLevel; lastLevel = s.level;
      if (s.level !== 'normal') {
        await createAlert({ title: `Database at ${s.percent}% (${s.level})`, body: `Size ${(s.size_bytes / 1048576).toFixed(1)} MB of ${(s.limit_bytes / 1048576).toFixed(0)} MB. Review Cleanup in System > Database.`, severity: LEVEL_SEV[s.level], kind: 'db', dedupeKey: `db:${s.level}:${new Date().toISOString().slice(0, 13)}`, channels: s.percent >= 90 ? ['telegram', 'email'] : [] });
        await fireTrigger('db_threshold', { id: s.level, level: s.level, percent: s.percent }, { ref: `${s.level}:${new Date().toISOString().slice(0, 13)}` });
      }
      if (s.percent >= 90 && s.level !== 'emergency') {
        await createTask({ queue: 'maintenance', name: 'cleanup.run', title: 'Urgent storage cleanup', payload: { urgent: true }, dedupeKey: `urgent-cleanup:${new Date().toISOString().slice(0, 13)}`, maxAttempts: 2 });
      }
      if (s.level === 'emergency' && (await getSetting('database.emergency_pause_ingest')) && !s.emergency_active) { await setSetting('database.emergency_active', true); await audit({ username: 'system' }, 'DB_EMERGENCY_MODE_ON', { details: { percent: s.percent } }); }
      if (['normal', 'warning', 'high_risk', 'critical'].includes(s.level) && s.emergency_active && prev !== s.level) { await setSetting('database.emergency_active', false); await audit({ username: 'system' }, 'DB_EMERGENCY_MODE_OFF', { details: { percent: s.percent } }); }
    }
    await publish('system.status', { db: s.level });
  }
  async function workerLiveness() {
    const dead = await many("SELECT DISTINCT name FROM workers WHERE status = 'running' AND last_heartbeat < now() - interval '60 seconds' AND last_heartbeat > now() - interval '1 day'");
    for (const d of dead) {
      await createAlert({ title: `Worker "${d.name}" stopped responding`, severity: 'high', kind: 'worker', dedupeKey: `worker:${d.name}:${new Date().toISOString().slice(0, 13)}` });
      await fireTrigger('worker_down', { id: d.name, name: d.name }, { ref: `${d.name}:${new Date().toISOString().slice(0, 13)}` });
    }
  }
  async function scheduleHeavy() {
    if (await getSetting('backup.enabled')) {
      const h = await getSetting('backup.interval_hours');
      const last = await one("SELECT 1 AS x FROM backups WHERE kind = 'database' AND status = 'ok' AND created_at > now() - make_interval(hours => $1)", [h]);
      if (!last) await createTask({ queue: 'maintenance', name: 'backup.create', title: 'Scheduled database backup', payload: { kind: 'database' }, dedupeKey: 'auto-backup', maxAttempts: 2 });
    }
    if (await getSetting('database.cleanup_enabled')) await createTask({ queue: 'maintenance', name: 'cleanup.run', title: 'Scheduled retention cleanup', payload: {}, dedupeKey: 'auto-cleanup', maxAttempts: 2 });
    await enqueue(Q.analytics, 'rollup', {}, { jobId: `rollup-${Math.floor(Date.now() / 3600000)}` });
  }
  return {
    name: 'scheduler',
    async start() {
      every(SWEEP_MS, 'sweep', sweep); every(30000, 'liveness', workerLiveness);
      every((Number(process.env.NABD_DBCHECK_S) || Math.max(10, await getSetting('database.monitor_interval_s'))) * 1000, 'dbcheck', dbCheck);
      every(10 * 60 * 1000, 'heavy', scheduleHeavy);
      setTimeout(() => void leader('dbcheck', dbCheck), 3000).unref();
    },
    async stop() { timers.splice(0).forEach(clearInterval); },
    stats: () => ({ ...st, meta: { db_level: lastLevel } }),
  };
}
export const hostInfo = () => ({ host: os.hostname(), pid: process.pid });
export { getQueue };
