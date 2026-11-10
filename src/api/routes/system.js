// System: overview, workers, queues, tasks, database, logs/audit, backups, analytics, reports, alerts, settings and AI providers.
import fs from 'node:fs';
import express from 'express';
import { z } from 'zod';
import { query, one, many } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { h, need, reauth, paging, pageMeta, idParam, csv } from '../middleware.js';
import { where, like, asDate } from '../sql.js';
import { sendControl } from '../../lib/bus.js';
import { getSetting, setSetting, publicSettings, REGISTRY } from '../../lib/settings.js';
import { setLogLevels, recentLogs, LEVELS } from '../../lib/logger.js';
import { overview, systemStatus, workerRows, workersOnline } from '../../services/status.js';
import { databaseStatus } from '../../services/dbmonitor.js';
import { runCleanup } from '../../services/cleanup.js';
import { backupPath } from '../../services/backup.js';
import { createTask, getTask, listTasks, cancelTask, retryTask, pauseTask, resumeTask, waitForTask } from '../../services/tasks.js';
import { queueCounts, failedJobs, pausePipeline, resumePipeline, drainPipeline, retryFailed, Q } from '../../lib/queue.js';
import { redisState, pingRedis } from '../../lib/redis.js';
import { sendExport, MAX_EXPORT_ROWS } from '../../services/export.js';
import { matchWhere } from './matches.js';
import { CARD_SELECT, toCard } from '../../services/cards.js';
import { BLOCK_FILTER_SQL } from '../../services/blocks.js';
import { createAlert, sendNotification } from '../../services/notifier.js';
import { providersSnapshot, updateProvider, testProvider, listModels, resetBreaker, PROVIDER_IDS, invalidateAi } from '../../ai/manager.js';
import { invalidateCompiled } from '../../services/config-cache.js';

const r = express.Router();
const WORKERS = ['telegram', 'processor', 'keyword', 'ai', 'notification', 'analytics', 'cleanup', 'scheduler'];
const bustCaches = async () => { invalidateCompiled(); invalidateAi(); await sendControl({ t: 'cache' }); };
const needWorker = async () => { if (!(await workersOnline())) throw new AppError('WORKER_OFFLINE', { status: 503 }); };

/* ---------- overview / status / workers ---------- */
r.get('/system/pause', need('viewer'), h(async (req, res) => res.json({ paused: await getSetting('system.paused') })));
r.post('/system/pause', need('admin'), reauth, h(async (req, res) => {
  const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
  await setSetting('system.paused', paused, req.user.id);
  await sendControl({ t: 'worker', action: paused ? 'pause' : 'resume' });
  await req.audit(paused ? 'SYSTEM_PAUSED' : 'SYSTEM_RESUMED');
  res.json({ ok: true, paused });
}));
r.get('/system/overview', need('viewer'), h(async (req, res) => res.json({ stats: await overview(), status: await systemStatus(true) })));
r.get('/system/status', need('viewer'), h(async (req, res) => res.json({ status: await systemStatus(true) })));
r.get('/system/workers', need('viewer'), h(async (req, res) => {
  const rows = await workerRows(); const by = new Map(rows.map((w) => [w.name, w]));
  res.json({ process_online: rows.some((w) => w.online), data: WORKERS.map((n) => { const w = by.get(n); return w ? { ...w, status: w.online ? w.status : 'offline' } : { name: n, status: 'offline', online: false, processed: 0, failed: 0 }; }) });
}));
r.post('/system/workers/:name/:action', need('admin'), h(async (req, res, next) => {
  const name = z.enum([...WORKERS, 'all']).parse(req.params.name); const action = z.enum(['start', 'stop', 'restart', 'pause', 'resume']).parse(req.params.action);
  if (action === 'stop' || name === 'all') { await new Promise((ok, no) => reauth(req, res, (e) => (e ? no(e) : ok()))); }
  await needWorker(); await sendControl({ t: 'worker', action, name });
  await req.audit('WORKER_CONTROL', { entity: 'worker', entityId: name, details: { action } });
  res.status(202).json({ ok: true });
}));

/* ---------- queues ---------- */
r.get('/system/queues', need('viewer'), h(async (req, res) => {
  const redis = await pingRedis(); const counts = redis.ok ? await queueCounts() : null;
  const failed = redis.ok ? await Promise.all([Q.process, Q.keyword, Q.ai, Q.notify].map(async (q) => [q, await failedJobs(q, 10).catch(() => [])])) : [];
  res.json({ redis: redis.ok, error: redis.ok ? null : redisState.lastError, paused: await getSetting('processing.paused'), counts, failed: Object.fromEntries(failed),
    messages: await one("SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending, count(*) FILTER (WHERE state = 'processing')::int AS processing, count(*) FILTER (WHERE state = 'failed')::int AS failed FROM messages WHERE created_at > now() - interval '7 days'") });
}));
r.post('/system/queues/pause', need('admin'), h(async (req, res) => { await setSetting('processing.paused', true, req.user.id); await pausePipeline().catch(() => {}); await req.audit('PROCESSING_PAUSED'); res.json({ ok: true }); }));
r.post('/system/queues/resume', need('admin'), h(async (req, res) => { await setSetting('processing.paused', false, req.user.id); await resumePipeline().catch(() => {}); await req.audit('PROCESSING_RESUMED'); res.json({ ok: true }); }));
r.post('/system/queues/clear', need('admin'), reauth, h(async (req, res) => {
  await drainPipeline().catch(() => {});
  const skipped = (await query("UPDATE messages SET state = 'skipped', skip_reason = 'queue_cleared' WHERE state IN ('pending','processing')")).rowCount;
  await req.audit('QUEUE_CLEARED', { details: { messages_skipped: skipped } }); res.json({ ok: true, messages_skipped: skipped });
}));
r.post('/system/queues/retry-failed', need('operator'), h(async (req, res) => {
  let jobs = 0; for (const q of [Q.process, Q.keyword, Q.ai, Q.notify]) jobs += await retryFailed(q).catch(() => 0);
  const msgs = (await query("UPDATE messages SET state = 'pending', attempts = 0, error = NULL WHERE state = 'failed' AND created_at > now() - interval '7 days'")).rowCount;
  await query("UPDATE notifications SET status = 'pending', attempts = 0 WHERE status = 'failed' AND channel IN ('telegram','email') AND created_at > now() - interval '2 days'");
  await req.audit('RETRY_FAILED', { details: { jobs, messages: msgs } }); res.json({ ok: true, jobs, messages: msgs });
}));

/* ---------- tasks ---------- */
r.get('/system/tasks', need('viewer'), h(async (req, res) => {
  const p = paging(req.query, { max: 100, def: 30 }); const { rows, total } = await listTasks({ state: req.query.state, queue: req.query.queue, limit: p.limit, offset: p.offset });
  const counts = await many('SELECT state, count(*)::int AS n FROM jobs GROUP BY state');
  res.json({ data: rows, meta: { ...pageMeta(total, p), counts: Object.fromEntries(counts.map((c) => [c.state, c.n])) } });
}));
r.get('/system/tasks/:id', need('viewer'), h(async (req, res) => { const t = await getTask(req.params.id); if (!t) throw new AppError('NOT_FOUND', { status: 404 }); res.json({ data: t }); }));
for (const [op, fn] of [['cancel', cancelTask], ['retry', retryTask], ['pause', pauseTask], ['resume', resumeTask]]) {
  r.post(`/system/tasks/:id/${op}`, need('operator'), h(async (req, res) => { const t = await fn(req.params.id); await req.audit(`TASK_${op.toUpperCase()}`, { entity: 'task', entityId: req.params.id }); res.json({ data: t }); }));
}

/* ---------- database ---------- */
r.get('/system/database', need('operator'), h(async (req, res) => res.json({ data: await databaseStatus() })));
r.post('/system/database/cleanup-preview', need('admin'), h(async (req, res) => res.json({ data: await runCleanup({ dryRun: true }) })));
r.post('/system/database/cleanup', need('admin'), reauth, h(async (req, res) => {
  await needWorker();
  const t = await createTask({ queue: 'maintenance', name: 'cleanup.run', title: 'Manual retention cleanup', payload: {}, dedupeKey: 'manual-cleanup', createdBy: req.user.id, maxAttempts: 1 });
  await req.audit('CLEANUP_REQUESTED', { entity: 'task', entityId: t.id }); res.status(202).json({ task: t });
}));
r.post('/system/database/emergency/clear', need('admin'), reauth, h(async (req, res) => { await setSetting('database.emergency_active', false, req.user.id); await req.audit('DB_EMERGENCY_MODE_CLEARED'); res.json({ ok: true }); }));

/* ---------- logs & audit ---------- */
r.get('/system/logs', need('operator'), h(async (req, res) => {
  const p = paging(req.query, { max: 200, def: 100 }); const w = where();
  const min = LEVELS[req.query.level] ?? 0; if (min) w.add('level = ANY($#::text[])', Object.entries(LEVELS).filter(([, n]) => n >= min).map(([k]) => k));
  if (req.query.q) w.add('(message ILIKE $# OR context::text ILIKE $#)', like(req.query.q)); if (req.query.source) w.add('source = $#', String(req.query.source));
  if (req.query.from && asDate(req.query.from)) w.add('created_at >= $#', asDate(req.query.from)); if (req.query.to && asDate(req.query.to)) w.add('created_at <= $#', asDate(req.query.to));
  const [rows, total] = await Promise.all([many(`SELECT id, created_at, level, source, message, context, request_id FROM system_logs WHERE ${w.sql} ORDER BY id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.v), one(`SELECT count(*)::int AS n FROM system_logs WHERE ${w.sql}`, w.v)]);
  res.json({ data: rows, meta: pageMeta(total.n, p), levels: Object.keys(LEVELS) });
}));
r.get('/system/logs/live', need('operator'), h(async (req, res) => res.json({ data: recentLogs(Math.min(300, Number(req.query.n) || 100)).reverse() })));
const auditWhere = (q) => { const w = where(); if (q.action) w.add('action ILIKE $#', like(q.action)); if (q.user) w.add('username ILIKE $#', like(q.user)); if (q.result) w.add('result = $#', String(q.result)); if (q.q) w.add('(action ILIKE $# OR details::text ILIKE $# OR entity_id ILIKE $#)', like(q.q)); if (q.from && asDate(q.from)) w.add('created_at >= $#', asDate(q.from)); if (q.to && asDate(q.to)) w.add('created_at <= $#', asDate(q.to)); return w; };
r.get('/system/audit', need('admin'), h(async (req, res) => {
  const p = paging(req.query, { max: 200, def: 50 }); const w = auditWhere(req.query);
  const [rows, total] = await Promise.all([many(`SELECT * FROM audit_logs WHERE ${w.sql} ORDER BY id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.v), one(`SELECT count(*)::int AS n FROM audit_logs WHERE ${w.sql}`, w.v)]);
  res.json({ data: rows, meta: pageMeta(total.n, p) });
}));
r.get('/export/audit', need('admin'), h(async (req, res) => {
  const w = auditWhere(req.query); const rows = await many(`SELECT * FROM audit_logs WHERE ${w.sql} ORDER BY id DESC LIMIT ${MAX_EXPORT_ROWS}`, w.v);
  sendExport(res, { format: req.query.format, name: 'nabd-audit', title: 'NABD AI — Audit log', lang: req.query.lang, rows, columns: ['id', 'created_at', 'username', 'action', 'entity', 'entity_id', 'result', 'ip', 'request_id', 'details'].map((key) => ({ key })) });
}));

/* ---------- backups ---------- */
r.get('/system/backups', need('admin'), h(async (req, res) => res.json({ data: await many('SELECT id, kind, file_name, size_bytes, sha256, encrypted, status, error, created_at FROM backups ORDER BY id DESC LIMIT 100'), enabled: await getSetting('backup.enabled') })));
r.post('/system/backups', need('admin'), h(async (req, res) => {
  const { kind } = z.object({ kind: z.enum(['database', 'config', 'rules']) }).parse(req.body); await needWorker();
  const t = await createTask({ queue: 'maintenance', name: 'backup.create', title: `Backup: ${kind}`, payload: { kind }, dedupeKey: `backup:${kind}`, createdBy: req.user.id, maxAttempts: 1 });
  await req.audit('BACKUP_REQUESTED', { entity: 'task', entityId: t.id, details: { kind } });
  const done = kind === 'database' ? t : await waitForTask(t.id, 15000);
  res.status(202).json({ task: done });
}));
r.get('/system/backups/:id/download', need('admin'), reauth, h(async (req, res) => {
  const b = await one("SELECT file_name FROM backups WHERE id = $1 AND status = 'ok'", [idParam(req)]); const p = b && backupPath(b.file_name);
  if (!p || !fs.existsSync(p)) throw new AppError('NOT_FOUND', { status: 404 });
  await req.audit('BACKUP_DOWNLOADED', { entity: 'backup', entityId: req.params.id }); res.download(p, b.file_name);
}));
r.delete('/system/backups/:id', need('admin'), reauth, h(async (req, res) => {
  const b = await one('DELETE FROM backups WHERE id = $1 RETURNING file_name', [idParam(req)]); if (!b) throw new AppError('NOT_FOUND', { status: 404 });
  const p = backupPath(b.file_name); if (p) fs.rmSync(p, { force: true }); await req.audit('BACKUP_DELETED', { entity: 'backup', entityId: req.params.id }); res.json({ ok: true });
}));

/* ---------- analytics & reports ---------- */
const RANGES = { '24h': { sql: '24 hours', trunc: 'hour' }, '7d': { sql: '7 days', trunc: 'hour' }, '30d': { sql: '30 days', trunc: 'day' }, '90d': { sql: '90 days', trunc: 'day' } };
const BLOCK_SRC = 'NOT EXISTS (SELECT 1 FROM blocked_sources bs WHERE bs.tg_chat_id = s.tg_chat_id)';
r.get('/analytics/overview', need('viewer'), h(async (req, res) => {
  const rg = RANGES[req.query.range] ?? RANGES['24h']; const since = `now() - interval '${rg.sql}'`;
  const [series, totals, keywords, groups, accounts, intents, ai, dist, prio, types, usage] = await Promise.all([
    many(`SELECT date_trunc('${rg.trunc}', bucket) AS t, sum(messages)::int AS messages, sum(matches)::int AS matches, sum(high)::int AS high, sum(duplicates)::int AS duplicates, sum(errors)::int AS errors FROM stats_hourly WHERE bucket >= ${since} GROUP BY 1 ORDER BY 1`),
    one(`SELECT COALESCE(sum(messages),0)::int AS messages, COALESCE(sum(matches),0)::int AS matches, COALESCE(sum(high),0)::int AS high, COALESCE(sum(duplicates),0)::int AS duplicates, COALESCE(sum(errors),0)::int AS errors FROM stats_hourly WHERE bucket >= ${since}`),
    many(`SELECT mm.keyword_text AS name, count(*)::int AS n FROM message_matches mm WHERE mm.created_at >= ${since} AND mm.keyword_text IS NOT NULL AND mm.deleted_at IS NULL AND ${BLOCK_FILTER_SQL} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
    many(`SELECT COALESCE(s.title, s.tg_chat_id::text) AS name, sum(h.messages)::int AS messages, sum(h.matches)::int AS matches FROM stats_hourly h JOIN telegram_sources s ON s.id = h.source_id WHERE h.bucket >= ${since} AND ${BLOCK_SRC} GROUP BY 1 ORDER BY 3 DESC, 2 DESC LIMIT 10`),
    many(`SELECT a.name, sum(h.messages)::int AS messages, sum(h.matches)::int AS matches, sum(h.errors)::int AS errors FROM stats_hourly h JOIN telegram_accounts a ON a.id = h.account_id WHERE h.bucket >= ${since} GROUP BY 1 ORDER BY 3 DESC, 2 DESC LIMIT 10`),
    many(`SELECT mm.intent AS name, count(*)::int AS n FROM message_matches mm WHERE mm.created_at >= ${since} AND mm.intent IS NOT NULL AND mm.deleted_at IS NULL AND ${BLOCK_FILTER_SQL} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
    many(`SELECT COALESCE(NULLIF(category, ''), '-') AS name, count(*)::int AS n FROM ai_results WHERE created_at >= ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
    many(`SELECT mm.bucket, count(*)::int AS n FROM message_matches mm WHERE mm.created_at >= ${since} AND mm.deleted_at IS NULL AND ${BLOCK_FILTER_SQL} GROUP BY 1 ORDER BY 1`),
    many(`SELECT mm.priority AS name, count(*)::int AS n FROM message_matches mm WHERE mm.created_at >= ${since} AND mm.deleted_at IS NULL AND ${BLOCK_FILTER_SQL} GROUP BY 1`),
    many(`SELECT mm.match_type AS name, count(*)::int AS n FROM message_matches mm WHERE mm.created_at >= ${since} AND mm.deleted_at IS NULL AND ${BLOCK_FILTER_SQL} GROUP BY 1 ORDER BY 2 DESC`),
    one(`SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors, COALESCE(avg(latency_ms) FILTER (WHERE status = 'ok'), 0)::int AS avg_ms FROM api_usage WHERE created_at >= ${since}`),
  ]);
  res.json({ range: req.query.range in RANGES ? req.query.range : '24h', series, totals: { ...totals, error_rate: totals.messages ? Math.round((totals.errors / totals.messages) * 1000) / 10 : 0 }, top: { keywords, groups, accounts, intents }, ai_classifications: ai, match_distribution: dist, priority: prio, match_types: types, ai_usage: usage });
}));

async function buildReport(q) {
  const w = matchWhere({ ...q, include_ignored: 'true' });
  const from = asDate(q.from) ?? new Date(Date.now() - 7 * 86400000); const to = asDate(q.to) ?? new Date();
  w.add('mm.created_at >= $#', from).add('mm.created_at <= $#', to);
  const base = `FROM message_matches mm JOIN messages m ON m.id = mm.message_id WHERE ${w.sql}`;
  const [totals, byDay, sources, keywords, intents, prio, conf, accounts, msgs, rows] = await Promise.all([
    one(`SELECT count(*)::int AS matches, COALESCE(avg(mm.score),0)::float AS avg_score, COALESCE(avg(mm.ai_confidence),0)::float AS avg_ai_confidence, COALESCE(sum(mm.occurrences),0)::int AS occurrences, count(DISTINCT mm.sender_id)::int AS users ${base}`, w.v),
    many(`SELECT date_trunc('day', mm.created_at) AS day, count(*)::int AS n ${base} GROUP BY 1 ORDER BY 1`, w.v),
    many(`SELECT COALESCE(s.title, '-') AS name, count(*)::int AS n FROM message_matches mm JOIN messages m ON m.id = mm.message_id LEFT JOIN telegram_sources s ON s.id = mm.source_id WHERE ${w.sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, w.v),
    many(`SELECT mm.keyword_text AS name, count(*)::int AS n ${base} AND mm.keyword_text IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, w.v),
    many(`SELECT mm.intent AS name, count(*)::int AS n ${base} AND mm.intent IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, w.v),
    many(`SELECT mm.priority AS name, count(*)::int AS n ${base} GROUP BY 1`, w.v),
    many(`SELECT mm.bucket AS name, count(*)::int AS n ${base} GROUP BY 1 ORDER BY 1`, w.v),
    many(`SELECT a.name, count(*)::int AS n FROM message_matches mm JOIN messages m ON m.id = mm.message_id JOIN match_occurrences mo ON mo.match_id = mm.id JOIN telegram_accounts a ON a.id = mo.account_id WHERE ${w.sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, w.v),
    one('SELECT COALESCE(sum(messages),0)::int AS n FROM stats_hourly WHERE bucket >= $1 AND bucket <= $2', [from, to]),
    many(`${CARD_SELECT} WHERE ${w.sql} ORDER BY mm.created_at DESC LIMIT ${MAX_EXPORT_ROWS}`, w.v),
  ]);
  return { period: { from, to }, totals: { ...totals, messages: msgs.n }, by_day: byDay, sources, keywords, intents, priority: prio, confidence_buckets: conf, accounts, cards: rows.map(toCard) };
}
r.get('/reports/run', need('viewer'), h(async (req, res) => { const rep = await buildReport(req.query); res.json({ data: { ...rep, cards: rep.cards.slice(0, 50) } }); }));
r.get('/export/report', need('viewer'), h(async (req, res) => {
  const rep = await buildReport(req.query); await req.audit('EXPORT_REPORT', { details: { format: req.query.format, rows: rep.cards.length } });
  const cols = ['id', 'created_at', 'score', 'match_type', 'priority', 'intent', 'keyword', 'source', 'account', 'sender_username', 'sender_id', 'text'].map((key) => ({ key }));
  sendExport(res, { format: req.query.format, name: 'nabd-report', title: 'NABD AI — Report', lang: req.query.lang, columns: cols,
    rows: rep.cards.map((c) => ({ id: c.id, created_at: c.created_at, score: c.score, match_type: c.match_type, priority: c.priority, intent: c.intent, keyword: c.keyword, source: c.source.title, account: c.account.name, sender_username: c.sender.username, sender_id: c.sender.id, text: c.text })) });
}));
r.get('/reports', need('viewer'), h(async (req, res) => res.json({ data: await many('SELECT * FROM reports ORDER BY id DESC LIMIT 100') })));
r.post('/reports', need('operator'), h(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(120), params: z.record(z.any()) }).parse(req.body);
  res.status(201).json({ data: await one('INSERT INTO reports (name, params, created_by) VALUES ($1,$2,$3) RETURNING *', [b.name, JSON.stringify(b.params), req.user.id]) });
}));
r.delete('/reports/:id', need('operator'), h(async (req, res) => { await query('DELETE FROM reports WHERE id = $1', [idParam(req)]); res.json({ ok: true }); }));

/* ---------- alerts (dashboard notifications) ---------- */
r.get('/alerts', need('viewer'), h(async (req, res) => {
  const p = paging(req.query, { max: 100, def: 30 }); const w = where("channel = 'dashboard'");
  if (req.query.unread === 'true') w.raw("status <> 'read'"); if (req.query.kind) w.add('kind = ANY($#::text[])', csv(req.query.kind)); if (req.query.severity) w.add('severity = ANY($#::text[])', csv(req.query.severity));
  const [rows, total, unread] = await Promise.all([many(`SELECT id, kind, severity, title, body, match_id, status, created_at FROM notifications WHERE ${w.sql} ORDER BY id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.v), one(`SELECT count(*)::int AS n FROM notifications WHERE ${w.sql}`, w.v), one("SELECT count(*)::int AS n FROM notifications WHERE channel = 'dashboard' AND status <> 'read'")]);
  res.json({ data: rows, meta: { ...pageMeta(total.n, p), unread: unread.n } });
}));
r.post('/alerts/read-all', need('viewer'), h(async (req, res) => { await query("UPDATE notifications SET status = 'read', read_at = now() WHERE channel = 'dashboard' AND status <> 'read'"); res.json({ ok: true }); }));
r.post('/alerts/:id/read', need('viewer'), h(async (req, res) => { await query("UPDATE notifications SET status = 'read', read_at = now() WHERE id = $1 AND channel = 'dashboard'", [idParam(req)]); res.json({ ok: true }); }));
r.delete('/alerts/:id', need('operator'), h(async (req, res) => { await query("DELETE FROM notifications WHERE id = $1 AND channel = 'dashboard'", [idParam(req)]); res.json({ ok: true }); }));
r.get('/alerts/deliveries', need('operator'), h(async (req, res) => res.json({ data: await many("SELECT id, channel, severity, title, status, attempts, error, created_at, sent_at FROM notifications WHERE channel IN ('telegram','email') ORDER BY id DESC LIMIT 50") })));

/* ---------- settings ---------- */
const SECURITY_GROUPS = new Set(['security', 'database', 'workers', 'queue', 'backup', 'logs']);
r.get('/settings', need('viewer'), h(async (req, res) => res.json({ data: await publicSettings() })));
r.put('/settings', need('admin'), h(async (req, res) => {
  const { values } = z.object({ values: z.record(z.any()) }).parse(req.body); const changed = [];
  for (const [k, v] of Object.entries(values)) {
    if (!REGISTRY[k]) throw new AppError('VALIDATION', { details: [{ path: [k], message: 'unknown setting' }] });
    if (REGISTRY[k].secret && (v === undefined || v === null || (typeof v === 'object'))) continue; // secrets: omit = keep, '' = clear
    if (SECURITY_GROUPS.has(REGISTRY[k].group) && k !== 'processing.paused') { /* admin only (already enforced) */ }
    await setSetting(k, v, req.user.id); changed.push(k);
  }
  if (changed.some((k) => k.startsWith('logs.'))) setLogLevels({ console: await getSetting('logs.level'), db: await getSetting('logs.db_level') });
  await bustCaches();
  const aiKeys = changed.filter((k) => k === 'ai.primary' || k === 'ai.fallback'); const others = changed.filter((k) => !aiKeys.includes(k));
  if (aiKeys.length) await req.audit('AI_PROVIDER_CHANGED', { details: { keys: aiKeys } });
  if (others.length) await req.audit('SETTINGS_CHANGED', { details: { keys: others } });
  res.json({ ok: true, changed });
}));
r.post('/settings/test/:channel', need('admin'), h(async (req, res) => {
  const channel = z.enum(['telegram', 'email']).parse(req.params.channel);
  const id = await createAlert({ title: 'NABD AI test notification', body: 'If you can read this, the channel works.', severity: 'info', kind: 'test', channels: [] });
  const row = await one("INSERT INTO notifications (kind, severity, channel, title, body, status) VALUES ('test','info',$1,'NABD AI test notification','If you can read this, the channel works.','pending') RETURNING id", [channel]);
  try { await sendNotification(row.id, { final: true }); res.json({ ok: true, dashboard_id: id }); } catch (e) { res.json({ ok: false, error: String(e.message).slice(0, 300) }); }
}));

/* ---------- AI providers ---------- */
r.get('/ai/providers', need('operator'), h(async (req, res) => res.json({ data: await providersSnapshot() })));
r.put('/ai/providers/:id', need('admin'), h(async (req, res) => {
  const id = z.enum(PROVIDER_IDS).parse(req.params.id);
  const b = z.object({
    enabled: z.boolean().optional(), api_key: z.string().max(600).optional(), model: z.string().trim().max(160).optional(), temperature: z.number().min(0).max(2).optional(), max_tokens: z.number().int().min(50).max(8000).optional(),
    timeout_ms: z.number().int().min(2000).max(120000).optional(), retry_count: z.number().int().min(0).max(5).optional(), headers: z.record(z.string().max(500)).optional(),
    base_url: z.string().trim().max(300).refine((u) => u === '' || /^https?:\/\//i.test(u), 'must start with http:// or https://').optional(),
  }).parse(req.body);
  await updateProvider(id, b); await sendControl({ t: 'cache' });
  await req.audit('AI_PROVIDER_CHANGED', { entity: 'ai_provider', entityId: id, details: { fields: Object.keys(b).map((k) => (k === 'api_key' || k === 'headers' ? `${k}(secret)` : k)) } });
  res.json({ ok: true });
}));
r.post('/ai/providers/:id/test', need('operator'), h(async (req, res) => { const id = z.enum(PROVIDER_IDS).parse(req.params.id); res.json(await testProvider(id)); }));
r.get('/ai/providers/:id/models', need('operator'), h(async (req, res) => res.json({ data: await listModels(z.enum(PROVIDER_IDS).parse(req.params.id)) })));
r.post('/ai/providers/:id/reset', need('admin'), h(async (req, res) => { resetBreaker(z.enum(PROVIDER_IDS).parse(req.params.id)); res.json({ ok: true }); }));
r.get('/ai/usage', need('operator'), h(async (req, res) => {
  const [series, byProvider, purposes] = await Promise.all([
    many("SELECT date_trunc('hour', created_at) AS t, count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors, COALESCE(avg(latency_ms),0)::int AS avg_ms FROM api_usage WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1"),
    many("SELECT provider, model, count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors, COALESCE(sum(tokens_in),0)::bigint AS tokens_in, COALESCE(sum(tokens_out),0)::bigint AS tokens_out FROM api_usage WHERE created_at > now() - interval '7 days' GROUP BY 1,2 ORDER BY 3 DESC"),
    many("SELECT purpose, count(*)::int AS calls FROM api_usage WHERE created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC"),
  ]);
  const recentErrors = await many("SELECT created_at, provider, http_status, error FROM api_usage WHERE status = 'error' ORDER BY id DESC LIMIT 10");
  res.json({ series, by_provider: byProvider, purposes, recent_errors: recentErrors });
}));

export default r;
