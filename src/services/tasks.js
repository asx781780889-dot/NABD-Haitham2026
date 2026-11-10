// Durable admin tasks stored in PostgreSQL (work without Redis): account ops, history scans, backups, cleanup, exports.
import { one, many, query } from '../lib/db.js';
import { notify } from '../lib/db.js';
import { publish, CONTROL } from '../lib/bus.js';
import { AppError } from '../lib/errors.js';
import { sleep } from '../lib/resilience.js';

export const TERMINAL = ['completed', 'failed', 'cancelled'];

export async function createTask({ queue, name, title = null, payload = {}, dedupeKey = null, createdBy = null, maxAttempts = 3, runAfter = null }) {
  try {
    const row = await one(
      `INSERT INTO jobs (queue, name, title, payload, dedupe_key, created_by, max_attempts, run_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now())) RETURNING *`,
      [queue, name, title ?? name, JSON.stringify(payload), dedupeKey, createdBy, maxAttempts, runAfter],
    );
    await notify(CONTROL, { t: 'task', id: row.id });
    await publish('job.update', { id: row.id });
    return row;
  } catch (e) {
    if (e.code === '23505' && dedupeKey) return { ...(await one('SELECT * FROM jobs WHERE dedupe_key = $1 AND state IN (\'queued\',\'running\',\'paused\')', [dedupeKey])), deduped: true };
    throw e;
  }
}
export const getTask = (id) => one('SELECT * FROM jobs WHERE id = $1', [id]);
export async function listTasks({ state, queue, limit = 50, offset = 0 } = {}) {
  const w = []; const p = [];
  if (state) { p.push(state.split(',')); w.push(`state = ANY($${p.length}::text[])`); }
  if (queue) { p.push(queue); w.push(`queue = $${p.length}`); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [rows, total] = await Promise.all([
    many(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, p),
    one(`SELECT count(*)::int AS n FROM jobs ${where}`, p),
  ]);
  return { rows, total: total.n };
}
async function mustGet(id) { const t = await getTask(id); if (!t) throw new AppError('NOT_FOUND', { status: 404 }); return t; }
export async function cancelTask(id) {
  const t = await mustGet(id);
  if (TERMINAL.includes(t.state)) throw new AppError('BAD_STATE', { status: 409 });
  if (t.state === 'running') await query('UPDATE jobs SET cancel_requested = true WHERE id = $1', [id]);
  else await query("UPDATE jobs SET state = 'cancelled', finished_at = now(), cancel_requested = true WHERE id = $1", [id]);
  await publish('job.update', { id }); return getTask(id);
}
export async function retryTask(id) {
  const t = await mustGet(id);
  if (!['failed', 'cancelled'].includes(t.state)) throw new AppError('BAD_STATE', { status: 409 });
  await query("UPDATE jobs SET state = 'queued', attempts = 0, error = NULL, cancel_requested = false, pause_requested = false, finished_at = NULL, run_after = now() WHERE id = $1", [id]);
  await notify(CONTROL, { t: 'task', id }); await publish('job.update', { id }); return getTask(id);
}
export async function pauseTask(id) {
  const t = await mustGet(id);
  if (t.state === 'queued') await query("UPDATE jobs SET state = 'paused' WHERE id = $1", [id]);
  else if (t.state === 'running') await query('UPDATE jobs SET pause_requested = true WHERE id = $1', [id]);
  else throw new AppError('BAD_STATE', { status: 409 });
  await publish('job.update', { id }); return getTask(id);
}
export async function resumeTask(id) {
  const t = await mustGet(id);
  if (t.state !== 'paused') throw new AppError('BAD_STATE', { status: 409 });
  await query("UPDATE jobs SET state = 'queued', pause_requested = false, run_after = now() WHERE id = $1", [id]);
  await notify(CONTROL, { t: 'task', id }); await publish('job.update', { id }); return getTask(id);
}
export async function waitForTask(id, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const t = await getTask(id);
    if (!t || TERMINAL.includes(t.state) || t.state === 'paused') return t;
    if (Date.now() > end) return t;
    await sleep(300);
  }
}
