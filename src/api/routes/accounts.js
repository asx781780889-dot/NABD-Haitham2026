// /api/accounts: add (secure login flow), manage, operate and inspect Telegram accounts. Secrets never leave the server.
import express from 'express';
import { z } from 'zod';
import { query, one, many } from '../../lib/db.js';
import { encrypt, maskPhone, keyedHash } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { sendControl, publish } from '../../lib/bus.js';
import { h, need, reauth, idParam } from '../middleware.js';
import { SAFE_ACCOUNT_COLUMNS } from '../../services/accounts.js';
import { startLogin, submitCode, submitPassword, importSession, closeFlow, hasFlow } from '../../telegram/login.js';
import { createTask, waitForTask } from '../../services/tasks.js';
import { workersOnline } from '../../services/status.js';

const r = express.Router();
const normPhone = (p) => { const d = String(p).replace(/[\s\-().]/g, ''); return d.startsWith('+') ? d : `+${d}`; };
const createSchema = z.object({
  name: z.string().trim().max(80).optional(), description: z.string().trim().max(500).optional(), tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  phone: z.string().transform(normPhone).pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'invalid phone number')),
  api_id: z.coerce.number().int().positive().max(2147483647), api_hash: z.string().trim().regex(/^[a-fA-F0-9]{32}$/, 'API hash must be 32 hex characters'),
  session: z.string().trim().min(20).max(4000).optional(),
});
const get = async (id) => { const a = await one(`SELECT ${SAFE_ACCOUNT_COLUMNS}, (SELECT count(*)::int FROM telegram_sources s WHERE s.account_id = a.id AND s.deleted_at IS NULL AND s.monitoring_enabled) AS sources_monitored FROM telegram_accounts a WHERE a.id = $1 AND a.deleted_at IS NULL`, [id]); if (!a) throw new AppError('NOT_FOUND', { status: 404 }); return a; };
async function requireWorker() { if (!(await workersOnline())) throw new AppError('WORKER_OFFLINE', { status: 503 }); }

r.get('/', need('viewer'), h(async (req, res) => {
  res.json({ data: await many(`SELECT ${SAFE_ACCOUNT_COLUMNS}, (SELECT count(*)::int FROM telegram_sources s WHERE s.account_id = a.id AND s.deleted_at IS NULL AND s.monitoring_enabled) AS sources_monitored FROM telegram_accounts a WHERE a.deleted_at IS NULL ORDER BY a.id`) });
}));
r.get('/:id', need('viewer'), h(async (req, res) => res.json({ data: await get(idParam(req)), login_pending: hasFlow(idParam(req)) })));

r.post('/', need('admin'), h(async (req, res) => {
  const b = createSchema.parse(req.body);
  const phoneHash = keyedHash(b.phone);
  if (await one('SELECT 1 AS x FROM telegram_accounts WHERE phone_hash = $1 AND deleted_at IS NULL', [phoneHash])) throw new AppError('CONFLICT', { status: 409, message: 'this phone number is already added' });
  const acc = await one(
    `INSERT INTO telegram_accounts (name, description, tags, phone_enc, phone_masked, phone_hash, api_id_enc, api_hash_enc, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [b.name || maskPhone(b.phone), b.description ?? null, b.tags ?? [], encrypt(b.phone), maskPhone(b.phone), phoneHash, encrypt(String(b.api_id)), encrypt(b.api_hash), req.user.id]);
  try {
    const login = b.session ? await importSession(acc.id, b.session) : await startLogin(acc.id);
    await req.audit('ACCOUNT_ADDED', { entity: 'account', entityId: acc.id, details: { via: b.session ? 'session' : 'code' } });
    res.status(201).json({ data: await get(acc.id), login });
  } catch (e) { await query('DELETE FROM telegram_accounts WHERE id = $1 AND status = $2', [acc.id, 'pending']); throw e; }
}));

r.post('/:id/login/start', need('admin'), h(async (req, res) => { const id = idParam(req); await get(id); res.json({ login: await startLogin(id) }); }));
r.post('/:id/login/code', need('admin'), h(async (req, res) => {
  const id = idParam(req); const { code } = z.object({ code: z.string().trim().regex(/^\d{4,8}$/, 'digits only') }).parse(req.body);
  const login = await submitCode(id, code);
  if (login.step === 'done') await req.audit('ACCOUNT_CONNECTED', { entity: 'account', entityId: id });
  res.json({ login });
}));
r.post('/:id/login/password', need('admin'), h(async (req, res) => {
  const id = idParam(req); const { password } = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
  const login = await submitPassword(id, password);
  await req.audit('ACCOUNT_CONNECTED', { entity: 'account', entityId: id, details: { two_step: true } });
  res.json({ login });
}));
r.post('/:id/login/cancel', need('admin'), h(async (req, res) => {
  const id = idParam(req); await closeFlow(id);
  await query("DELETE FROM telegram_accounts a WHERE a.id = $1 AND a.status = 'pending' AND NOT EXISTS (SELECT 1 FROM telegram_sessions s WHERE s.account_id = a.id)", [id]); // abandoned onboarding leaves no orphan row
  res.json({ ok: true });
}));

r.patch('/:id', need('admin'), h(async (req, res) => {
  const id = idParam(req); await get(id);
  const b = z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(500).nullable().optional(), tags: z.array(z.string().trim().min(1).max(30)).max(10).optional() }).parse(req.body);
  await query('UPDATE telegram_accounts SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END, tags = COALESCE($5, tags) WHERE id = $1', [id, b.name ?? null, b.description !== undefined, b.description ?? null, b.tags ?? null]);
  await req.audit('ACCOUNT_UPDATED', { entity: 'account', entityId: id, details: b });
  res.json({ data: await get(id) });
}));
r.delete('/:id', need('admin'), reauth, h(async (req, res) => {
  const id = idParam(req); await get(id); await closeFlow(id);
  await query("UPDATE telegram_accounts SET deleted_at = now(), enabled = false, status = 'disabled' WHERE id = $1", [id]);
  await query('UPDATE telegram_sessions SET is_active = false, revoked_at = now() WHERE account_id = $1 AND is_active', [id]);
  await query('UPDATE telegram_sources SET monitoring_enabled = false WHERE account_id = $1', [id]);
  await sendControl({ t: 'account', action: 'remove', id });
  await req.audit('ACCOUNT_DELETED', { entity: 'account', entityId: id });
  res.json({ ok: true });
}));

r.post('/:id/enable', need('operator'), h(async (req, res) => { const id = idParam(req); await get(id); await query("UPDATE telegram_accounts SET enabled = true, status = CASE WHEN status = 'disabled' THEN 'disconnected' ELSE status END, reconnect_attempts = 0 WHERE id = $1", [id]); await sendControl({ t: 'account', action: 'connect', id }); await req.audit('ACCOUNT_ENABLED', { entity: 'account', entityId: id }); res.json({ data: await get(id) }); }));
r.post('/:id/disable', need('operator'), h(async (req, res) => { const id = idParam(req); await get(id); await query("UPDATE telegram_accounts SET enabled = false WHERE id = $1", [id]); await sendControl({ t: 'account', action: 'remove', id }); await req.audit('ACCOUNT_DISABLED', { entity: 'account', entityId: id }); res.json({ data: await get(id) }); }));
for (const [op, status] of [['connect', 'connecting'], ['disconnect', 'disconnected'], ['reconnect', 'connecting']]) {
  r.post(`/:id/${op}`, need('operator'), h(async (req, res) => {
    const id = idParam(req); await get(id); await requireWorker();
    if (op !== 'disconnect') await query("UPDATE telegram_accounts SET enabled = true, reconnect_attempts = 0 WHERE id = $1 AND status <> 'auth_required'", [id]);
    await sendControl({ t: 'account', action: op, id });
    await req.audit(op === 'disconnect' ? 'ACCOUNT_DISCONNECTED' : 'ACCOUNT_RECONNECT_REQUESTED', { entity: 'account', entityId: id });
    await publish('account.status', { id, status });
    res.status(202).json({ ok: true });
  }));
}
for (const op of ['sync', 'test']) {
  r.post(`/:id/${op}`, need('operator'), h(async (req, res) => {
    const id = idParam(req); const acc = await get(id); await requireWorker();
    const t = await createTask({ queue: 'telegram', name: `account.${op}`, title: `${op === 'sync' ? 'Sync' : 'Test'}: ${acc.name}`, payload: { id }, dedupeKey: `acc:${id}:${op}`, createdBy: req.user.id, maxAttempts: 1 });
    const done = await waitForTask(t.id, op === 'test' ? 25000 : 45000);
    await req.audit(op === 'sync' ? 'ACCOUNT_SYNCED' : 'ACCOUNT_TESTED', { entity: 'account', entityId: id, result: done?.state === 'completed' ? 'success' : 'failure' });
    res.status(done?.state === 'completed' || done?.state === 'failed' ? 200 : 202).json({ task: done, result: done?.result ?? null, error: done?.error ?? null });
  }));
}
r.get('/:id/logs', need('operator'), h(async (req, res) => {
  const id = idParam(req);
  res.json({ data: await many(`(SELECT created_at, level, source, message, context::text AS details FROM system_logs WHERE context->>'accountId' = $1::text)
    UNION ALL (SELECT created_at, 'info', 'audit', action, details::text FROM audit_logs WHERE entity = 'account' AND entity_id = $1::text) ORDER BY created_at DESC LIMIT 100`, [String(id)]) });
}));

export default r;
