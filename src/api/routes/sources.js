// /api/sources: groups / channels / private chats / saved. Enable monitoring, per-source rules, bulk actions, history scans.
import express from 'express';
import { z } from 'zod';
import { query, one, many } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { sendControl } from '../../lib/bus.js';
import { h, need, paging, pageMeta, idParam, csv, buildUpdate } from '../middleware.js';
import { createTask } from '../../services/tasks.js';
import { workersOnline } from '../../services/status.js';
import { invalidateCompiled } from '../../services/config-cache.js';
import { telegramLinks } from '../../telegram/links.js';

const r = express.Router();
const KINDS = ['group', 'supergroup', 'channel', 'private', 'saved'];
const refresh = (accountId) => sendControl({ t: 'account', action: 'refresh_sources', id: accountId });
const COLS = 's.id, s.account_id, a.name AS account_name, s.tg_chat_id, s.kind, s.title, s.username, s.members_count, s.monitoring_enabled, s.priority_weight, s.ai_rule_ids, s.keyword_ids, s.settings, s.last_message_at, s.messages_count, s.matches_count, s.created_at';

r.get('/', need('viewer'), h(async (req, res) => {
  const p = paging(req.query); const w = ['s.deleted_at IS NULL', 'a.deleted_at IS NULL']; const v = [];
  const add = (sql, val) => { v.push(val); w.push(sql.split('$#').join(`$${v.length}`)); };
  if (req.query.account_id) add('s.account_id = $#', Number(req.query.account_id));
  if (req.query.kind) add('s.kind = ANY($#::text[])', csv(req.query.kind));
  if (req.query.monitored === 'true' || req.query.monitored === 'false') add('s.monitoring_enabled = $#', req.query.monitored === 'true');
  if (req.query.q) add("(nabd_norm(s.title) ILIKE '%' || nabd_norm($#) || '%' OR nabd_norm(s.username) ILIKE '%' || nabd_norm($#) || '%')", String(req.query.q).slice(0, 80).replace(/[\\%_]/g, (c) => `\\${c}`));
  const where = w.join(' AND ');
  const [rows, total] = await Promise.all([
    many(`SELECT ${COLS} FROM telegram_sources s JOIN telegram_accounts a ON a.id = s.account_id WHERE ${where} ORDER BY s.monitoring_enabled DESC, s.last_message_at DESC NULLS LAST, s.id LIMIT ${p.limit} OFFSET ${p.offset}`, v),
    one(`SELECT count(*)::int AS n FROM telegram_sources s JOIN telegram_accounts a ON a.id = s.account_id WHERE ${where}`, v),
  ]);
  res.json({ data: rows.map((s) => ({ ...s, link: telegramLinks({ chatId: s.tg_chat_id, kind: s.kind, username: s.username, messageId: 1 }).chat })), meta: pageMeta(total.n, p) });
}));

r.post('/', need('operator'), h(async (req, res) => {
  const b = z.object({ account_id: z.coerce.number().int().positive(), tg_chat_id: z.coerce.number().int(), kind: z.enum(KINDS), title: z.string().trim().max(200).optional(), username: z.string().trim().max(64).optional() }).parse(req.body);
  if (!(await one('SELECT 1 AS x FROM telegram_accounts WHERE id = $1 AND deleted_at IS NULL', [b.account_id]))) throw new AppError('NOT_FOUND', { status: 404 });
  const s = await one(`INSERT INTO telegram_sources (account_id, tg_chat_id, kind, title, username, monitoring_enabled) VALUES ($1,$2,$3,$4,$5,true)
    ON CONFLICT (account_id, tg_chat_id) DO UPDATE SET deleted_at = NULL, monitoring_enabled = true, title = COALESCE(EXCLUDED.title, telegram_sources.title) RETURNING id`, [b.account_id, b.tg_chat_id, b.kind, b.title ?? null, b.username ?? null]);
  await refresh(b.account_id); await req.audit('SOURCE_ADDED', { entity: 'source', entityId: s.id });
  res.status(201).json({ data: s });
}));

const patchSchema = z.object({
  monitoring_enabled: z.boolean().optional(), priority_weight: z.number().int().min(-30).max(30).optional(),
  ai_rule_ids: z.array(z.number().int().positive()).max(100).optional(), keyword_ids: z.array(z.number().int().positive()).max(500).optional(), settings: z.record(z.any()).optional(),
});
r.patch('/:id', need('operator'), h(async (req, res) => {
  const id = idParam(req); const b = patchSchema.parse(req.body);
  const { sets, vals } = buildUpdate(b, { monitoring_enabled: undefined, priority_weight: undefined, ai_rule_ids: undefined, keyword_ids: undefined, settings: 'jsonb' });
  if (!sets.length) throw new AppError('VALIDATION', { message: 'nothing to update' });
  const s = await one(`UPDATE telegram_sources SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id, account_id, monitoring_enabled`, [id, ...vals]);
  if (!s) throw new AppError('NOT_FOUND', { status: 404 });
  await refresh(s.account_id); invalidateCompiled();
  await req.audit(b.monitoring_enabled === undefined ? 'SOURCE_UPDATED' : (b.monitoring_enabled ? 'SOURCE_MONITORING_ENABLED' : 'SOURCE_MONITORING_DISABLED'), { entity: 'source', entityId: id, details: b });
  res.json({ data: s });
}));
r.delete('/:id', need('operator'), h(async (req, res) => {
  const id = idParam(req);
  const s = await one('UPDATE telegram_sources SET deleted_at = now(), monitoring_enabled = false WHERE id = $1 AND deleted_at IS NULL RETURNING account_id', [id]);
  if (!s) throw new AppError('NOT_FOUND', { status: 404 });
  await refresh(s.account_id); await req.audit('SOURCE_REMOVED', { entity: 'source', entityId: id });
  res.json({ ok: true });
}));
r.post('/bulk', need('operator'), h(async (req, res) => {
  const b = z.object({ ids: z.array(z.number().int().positive()).min(1).max(1000), action: z.enum(['enable', 'disable', 'remove']) }).parse(req.body);
  const sql = b.action === 'remove' ? 'UPDATE telegram_sources SET deleted_at = now(), monitoring_enabled = false WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL RETURNING account_id'
    : `UPDATE telegram_sources SET monitoring_enabled = ${b.action === 'enable'} WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL RETURNING account_id`;
  const rows = await many(sql, [b.ids]);
  for (const a of new Set(rows.map((x) => x.account_id))) await refresh(a);
  await req.audit('SOURCES_BULK', { details: { action: b.action, count: rows.length } });
  res.json({ updated: rows.length });
}));
r.post('/:id/scan', need('operator'), h(async (req, res) => {
  const id = idParam(req); const { limit } = z.object({ limit: z.coerce.number().int().min(10).max(2000).default(200) }).parse(req.body ?? {});
  const s = await one('SELECT id, title FROM telegram_sources WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!s) throw new AppError('NOT_FOUND', { status: 404 });
  if (!(await workersOnline())) throw new AppError('WORKER_OFFLINE', { status: 503 });
  const t = await createTask({ queue: 'telegram', name: 'scan_history', title: `Scan history: ${s.title ?? id}`, payload: { sourceId: id, limit }, dedupeKey: `scan:${id}`, createdBy: req.user.id, maxAttempts: 3 });
  await req.audit('SOURCE_SCAN_STARTED', { entity: 'source', entityId: id, details: { limit } });
  res.status(202).json({ task: t });
}));

export default r;
