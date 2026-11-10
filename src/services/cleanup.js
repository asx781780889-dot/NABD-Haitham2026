// Safe, reversible retention: unmatched messages are soft-deleted first and purged only after a grace period.
// Messages that back a card / occurrence are never touched. Always supports a dry run.
import { one, pool } from '../lib/db.js';
import { getSettings } from '../lib/settings.js';

const UNREFERENCED = `NOT EXISTS (SELECT 1 FROM message_matches mm WHERE mm.message_id = m.id) AND NOT EXISTS (SELECT 1 FROM match_occurrences mo WHERE mo.message_id = m.id)`;
const BATCH = 500; const MAX_BATCHES = 40;
async function batched(client, sql, params) {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) { const r = await client.query(sql, params); total += r.rowCount; if (r.rowCount < BATCH) break; }
  return total;
}

async function tryLock(client) {
  const { rows } = await client.query('SELECT pg_try_advisory_lock(727275) AS ok');
  return rows[0]?.ok === true;
}

export async function runCleanup({ dryRun = false, urgent = false } = {}) {
  const s = await getSettings('database.'); const l = await getSettings('logs.');
  const out = { dry_run: dryRun, urgent, lock_acquired: false, capped: false };
  const softWhere = `m.deleted_at IS NULL AND m.state IN ('done','skipped','failed') AND m.created_at < now() - make_interval(days => $1) AND ${UNREFERENCED}`;
  const purgeWhere = `m.deleted_at IS NOT NULL AND m.deleted_at < now() - make_interval(days => $1) AND ${UNREFERENCED}`;
  if (dryRun) {
    out.messages_to_soft_delete = (await one(`SELECT count(*)::int AS n FROM messages m WHERE ${softWhere}`, [s.retention_unmatched_days])).n;
    out.messages_to_purge = (await one(`SELECT count(*)::int AS n FROM messages m WHERE ${purgeWhere}`, [s.purge_grace_days])).n;
    out.logs_to_delete = (await one('SELECT count(*)::int AS n FROM system_logs WHERE created_at < now() - make_interval(days => $1)', [l.retention_days])).n;
    out.notifications_to_delete = (await one("SELECT count(*)::int AS n FROM notifications WHERE status IN ('sent','read','failed') AND created_at < now() - make_interval(days => $1)", [s.retention_notifications_days])).n;
    return out;
  }
  if (!s.cleanup_enabled && !process.env.NABD_FORCE_CLEANUP) return out;
  const client = await pool.connect();
  try {
    if (!(await tryLock(client))) { out.skipped = 'cleanup already running'; return out; }
    out.lock_acquired = true;
    out.messages_soft_deleted = await batched(client, `UPDATE messages SET deleted_at = now() WHERE id IN (SELECT m.id FROM messages m WHERE ${softWhere} LIMIT ${BATCH})`, [s.retention_unmatched_days]);
    out.messages_purged = await batched(client, `DELETE FROM messages WHERE id IN (SELECT m.id FROM messages m WHERE ${purgeWhere} LIMIT ${BATCH})`, [s.purge_grace_days]);
    out.logs_deleted = await batched(client, `DELETE FROM system_logs WHERE id IN (SELECT id FROM system_logs WHERE created_at < now() - make_interval(days => $1) ORDER BY id LIMIT ${BATCH})`, [l.retention_days]);
    out.notifications_deleted = await batched(client, `DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE status IN ('sent','read','failed') AND created_at < now() - make_interval(days => $1) ORDER BY id LIMIT ${BATCH})`, [s.retention_notifications_days]);
    out.sessions_deleted = await batched(client, `DELETE FROM user_sessions WHERE id IN (SELECT id FROM user_sessions WHERE expires_at < now() ORDER BY id LIMIT ${BATCH})`, []);
    out.jobs_deleted = await batched(client, `DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE state IN ('completed','failed','cancelled') AND finished_at < now() - interval '30 days' ORDER BY id LIMIT ${BATCH})`, []);
    out.usage_deleted = await batched(client, `DELETE FROM api_usage WHERE id IN (SELECT id FROM api_usage WHERE created_at < now() - interval '90 days' ORDER BY id LIMIT ${BATCH})`, []);
    out.automation_runs_deleted = await batched(client, `DELETE FROM automation_runs WHERE id IN (SELECT id FROM automation_runs WHERE started_at < now() - interval '60 days' ORDER BY id LIMIT ${BATCH})`, []);
    out.workers_deleted = await batched(client, `DELETE FROM workers WHERE (name, instance_id) IN (SELECT name, instance_id FROM workers WHERE last_heartbeat < now() - interval '7 days' LIMIT ${BATCH})`, []);
    out.capped = Object.values(out).some((v) => typeof v === 'number' && v >= BATCH * MAX_BATCHES);
    if (urgent) out.mode = 'eligible-data-only; primary records and matches preserved';
    return out;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(727275)'); } catch { /* ignore */ }
    client.release();
  }
}
