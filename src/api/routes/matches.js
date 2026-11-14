// Live cards, messages, global search, saved results, block lists, feedback and exports.
import express from 'express';
import { z } from 'zod';
import { query, one, many } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { h, need, paging, pageMeta, idParam, csv } from '../middleware.js';
import { where, like, nlike, asDate } from '../sql.js';
import { CARD_SELECT, toCard } from '../../services/cards.js';
import { saveMatch } from '../../services/saved.js';
import { BLOCK_FILTER_SQL, blockUser, blockSource, blockKeyword, invalidateBlocks } from '../../services/blocks.js';
import { publish } from '../../lib/bus.js';
import { sendExport, MAX_EXPORT_ROWS } from '../../services/export.js';
import { normalizeText } from '../../engine/normalize.js';

const r = express.Router();
const PRIS = ['low', 'medium', 'high', 'critical'];

export function matchWhere(q, { includeIgnored = false } = {}) {
  const w = where('mm.deleted_at IS NULL', BLOCK_FILTER_SQL);
  if (q.priority) w.add('mm.priority = ANY($#::text[])', csv(q.priority).filter((p) => PRIS.includes(p)));
  if (q.min_score) w.add('mm.score >= $#', Math.max(0, Math.min(100, Number(q.min_score) || 0)));
  if (q.buckets && q.buckets !== 'all') { const b = csv(q.buckets).map(Number).filter((n) => Number.isInteger(n) && n >= 10 && n <= 100); if (b.length) w.add('mm.bucket = ANY($#::int[])', b); }
  if (q.account_id) w.add('mm.id IN (SELECT mo.match_id FROM match_occurrences mo WHERE mo.account_id = $#)', Number(q.account_id));
  if (q.source_id) w.add('mm.source_id = $#', Number(q.source_id));
  if (q.source) nlike(w, ['(SELECT title FROM telegram_sources s0 WHERE s0.id = mm.source_id)', '(SELECT username FROM telegram_sources s1 WHERE s1.id = mm.source_id)'], q.source);
  if (q.intent) nlike(w, 'mm.intent', q.intent);
  if (q.rule_id) w.add('mm.ai_rule_id = $#', Number(q.rule_id));
  if (q.keyword) nlike(w, 'mm.keyword_text', q.keyword);
  if (q.user) nlike(w, ['m.sender_username', 'm.sender_name'], q.user);
  if (q.user_id) w.add('mm.sender_id = $#', Number(q.user_id));
  if (q.q) nlike(w, ['m.text', 'mm.keyword_text', 'mm.intent', 'm.sender_username'], q.q);
  if (q.from && asDate(q.from)) w.add('mm.created_at >= $#', asDate(q.from));
  if (q.to && asDate(q.to)) w.add('mm.created_at <= $#', asDate(q.to));
  if (q.status) w.add('mm.status = ANY($#::text[])', csv(q.status)); else if (!includeIgnored && q.include_ignored !== 'true') w.raw("mm.status <> 'ignored'");
  if (q.pinned === 'true') w.raw('mm.pinned');
  if (q.saved === 'true') w.raw('EXISTS (SELECT 1 FROM saved_results sr WHERE sr.match_id = mm.id AND sr.deleted_at IS NULL)');
  if (q.feedback) w.add('mm.feedback = $#', String(q.feedback));
  if (q.after_id) w.add('mm.id > $#', Number(q.after_id));
  return w;
}
const ORDER = {
  created: 'mm.created_at DESC, mm.id DESC', score: 'mm.score DESC, mm.created_at DESC',
  priority: "CASE mm.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, mm.created_at DESC",
};
const FROM_COUNT = 'FROM message_matches mm JOIN messages m ON m.id = mm.message_id';

async function listMatches(q, p) {
  const w = matchWhere(q); const order = `${q.pinned_first === 'true' ? 'mm.pinned DESC, ' : ''}${ORDER[q.sort] ?? ORDER.created}`;
  const [rows, total] = await Promise.all([
    many(`${CARD_SELECT} WHERE ${w.sql} ORDER BY ${order} LIMIT ${p.limit} OFFSET ${p.offset}`, w.v),
    one(`SELECT count(*)::int AS n ${FROM_COUNT} WHERE ${w.sql}`, w.v),
  ]);
  return { cards: rows.map(toCard), total: total.n };
}
const loadCard = async (id) => { const row = await one(`${CARD_SELECT} WHERE mm.id = $1 AND mm.deleted_at IS NULL`, [id]); if (!row) throw new AppError('NOT_FOUND', { status: 404 }); return toCard(row); };

r.get('/matches', need('viewer'), h(async (req, res) => {
  const p = paging(req.query, { max: 100, def: 30 }); const { cards, total } = await listMatches(req.query, p);
  res.json({ data: cards, meta: pageMeta(total, p) });
}));
r.get('/matches/stats', need('viewer'), h(async (req, res) => {
  const w = matchWhere(req.query);
  res.json({ data: await one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE mm.priority = 'critical')::int AS critical, count(*) FILTER (WHERE mm.priority = 'high')::int AS high,
    count(*) FILTER (WHERE mm.priority = 'medium')::int AS medium, count(*) FILTER (WHERE mm.priority = 'low')::int AS low, COALESCE(avg(mm.score), 0)::float AS avg_score ${FROM_COUNT} WHERE ${w.sql}`, w.v) });
}));
r.get('/matches/:id', need('viewer'), h(async (req, res) => res.json({ data: await loadCard(idParam(req)) })));

const act = (name, fn, auditAction) => r.post(`/matches/:id/${name}`, need('operator'), h(async (req, res) => {
  const id = idParam(req); const card = await loadCard(id); const out = await fn(id, card, req);
  if (auditAction) await req.audit(auditAction, { entity: 'match', entityId: id });
  await publish('match.update', { id });
  res.json({ ok: true, ...(out ?? {}) });
}));
act('seen', (id) => query("UPDATE message_matches SET status = 'seen' WHERE id = $1 AND status = 'new'", [id]));
act('ignore', (id) => query("UPDATE message_matches SET status = 'ignored' WHERE id = $1", [id]), 'MATCH_IGNORED');
act('restore', (id) => query("UPDATE message_matches SET status = 'seen' WHERE id = $1", [id]));
act('pin', (id) => query('UPDATE message_matches SET pinned = true WHERE id = $1', [id]), 'MATCH_PINNED');
act('unpin', (id) => query('UPDATE message_matches SET pinned = false WHERE id = $1', [id]));
act('save', async (id, c, req) => ({ saved_id: (await saveMatch(id, { userId: req.user.id }))?.id }), 'MATCH_SAVED');
act('unsave', (id) => query('UPDATE saved_results SET deleted_at = now() WHERE match_id = $1 AND deleted_at IS NULL', [id]));
act('block-user', async (id, c, req) => {
  if (c.sender.id == null) throw new AppError('BAD_STATE', { status: 409, message: 'no user id on this message' });
  await blockUser({ tgUserId: c.sender.id, username: c.sender.username, reason: 'blocked from card', userId: req.user.id });
}, 'USER_BLOCKED');
act('block-source', async (id, c, req) => { await blockSource({ tgChatId: c.source.tg_chat_id, kind: c.source.kind ?? 'group', title: c.source.title, reason: 'blocked from card', userId: req.user.id }); }, 'SOURCE_BLOCKED');
r.delete('/matches/:id', need('operator'), h(async (req, res) => { const id = idParam(req); await loadCard(id); await query('UPDATE message_matches SET deleted_at = now() WHERE id = $1', [id]); await req.audit('MATCH_DELETED', { entity: 'match', entityId: id }); res.json({ ok: true }); }));

/** Feedback loop: reviewed examples are fed back into future AI prompts (no automatic model training). */
r.post('/matches/:id/feedback', need('operator'), h(async (req, res) => {
  const id = idParam(req); const { value } = z.object({ value: z.enum(['correct', 'incorrect', 'ignore', 'block']) }).parse(req.body);
  const c = await loadCard(id);
  if (value === 'correct' || value === 'incorrect') {
    await query('UPDATE message_matches SET feedback = $2 WHERE id = $1', [id, value]);
    if (c.rule?.id) {
      await query('INSERT INTO feedback_examples (ai_rule_id, match_id, text, label, created_by) VALUES ($1,$2,$3,$4,$5)', [c.rule.id, id, String(c.text).slice(0, 500), value === 'correct' ? 'positive' : 'negative', req.user.id]);
      await query('DELETE FROM feedback_examples WHERE ai_rule_id = $1 AND id NOT IN (SELECT id FROM feedback_examples WHERE ai_rule_id = $1 ORDER BY created_at DESC LIMIT 200)', [c.rule.id]);
    }
  } else if (value === 'ignore') await query("UPDATE message_matches SET status = 'ignored' WHERE id = $1", [id]);
  else if (c.sender.id != null) { await blockUser({ tgUserId: c.sender.id, username: c.sender.username, reason: 'feedback: block', userId: req.user.id }); await query("UPDATE message_matches SET status = 'ignored' WHERE id = $1", [id]); }
  await req.audit('MATCH_FEEDBACK', { entity: 'match', entityId: id, details: { value } }); await publish('match.update', { id });
  res.json({ ok: true });
}));

const messagesHandler = h(async (req, res) => {
  const p = paging(req.query, { max: 100, def: 30 }); const q = req.query;
  const w = where('m.deleted_at IS NULL', 'NOT EXISTS (SELECT 1 FROM blocked_users bu WHERE bu.tg_user_id = m.sender_id)', 'NOT EXISTS (SELECT 1 FROM blocked_sources bs WHERE bs.tg_chat_id = m.tg_chat_id)');
  if (q.q) nlike(w, 'm.text', q.q); if (q.account_id) w.add('m.account_id = $#', Number(q.account_id)); if (q.source_id) w.add('m.source_id = $#', Number(q.source_id));
  if (q.user_id) w.add('m.sender_id = $#', Number(q.user_id)); if (q.user) nlike(w, ['m.sender_username', 'm.sender_name'], q.user); if (q.state) w.add('m.state = ANY($#::text[])', csv(q.state));
  if (q.from && asDate(q.from)) w.add('m.sent_at >= $#', asDate(q.from)); if (q.to && asDate(q.to)) w.add('m.sent_at <= $#', asDate(q.to));
  const [rows, total] = await Promise.all([
    many(`SELECT m.id, m.account_id, m.source_id, m.tg_message_id, m.sender_id, m.sender_username, m.sender_name, left(m.text, 600) AS text, m.lang, m.state, m.skip_reason, m.sent_at, s.title AS source_title, a.name AS account_name,
            (SELECT mm.id FROM message_matches mm WHERE mm.message_id = m.id) AS match_id FROM messages m JOIN telegram_sources s ON s.id = m.source_id JOIN telegram_accounts a ON a.id = m.account_id
          WHERE ${w.sql} ORDER BY m.sent_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.v),
    one(`SELECT count(*)::int AS n FROM messages m WHERE ${w.sql}`, w.v),
  ]);
  res.json({ data: rows, meta: pageMeta(total.n, p) });
});
r.get('/messages', need('viewer'), messagesHandler);
r.get('/search', need('viewer'), h(async (req, res, next) => {
  if (req.query.scope === 'messages') return messagesHandler(req, res, next);
  const p = paging(req.query, { max: 100, def: 30 }); const { cards, total } = await listMatches(req.query, p);
  res.json({ data: cards, meta: pageMeta(total, p) });
}));

const SAVED_COLS = 'id, match_id, source_title, account_name, sender_id, sender_username, message_text, message_link, message_at, rule_name, intent, score, priority, ai_classification, notes, tags, created_at';
function savedWhere(q) {
  const w = where('deleted_at IS NULL');
  if (q.q) nlike(w, ['message_text', 'notes', 'sender_username', 'source_title'], q.q);
  if (q.tag) w.add('$# = ANY(tags)', String(q.tag)); if (q.priority) w.add('priority = ANY($#::text[])', csv(q.priority)); if (q.rule) nlike(w, 'rule_name', q.rule);
  if (q.from && asDate(q.from)) w.add('created_at >= $#', asDate(q.from)); if (q.to && asDate(q.to)) w.add('created_at <= $#', asDate(q.to));
  return w;
}
r.get('/saved', need('viewer'), h(async (req, res) => {
  const p = paging(req.query); const w = savedWhere(req.query);
  const [rows, total] = await Promise.all([many(`SELECT ${SAVED_COLS} FROM saved_results WHERE ${w.sql} ORDER BY created_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.v), one(`SELECT count(*)::int AS n FROM saved_results WHERE ${w.sql}`, w.v)]);
  res.json({ data: rows, meta: pageMeta(total.n, p) });
}));
r.patch('/saved/:id', need('operator'), h(async (req, res) => {
  const id = idParam(req); const b = z.object({ notes: z.string().max(4000).nullable().optional(), tags: z.array(z.string().trim().min(1).max(30)).max(20).optional() }).parse(req.body);
  const row = await one('UPDATE saved_results SET notes = CASE WHEN $2::boolean THEN $3 ELSE notes END, tags = COALESCE($4, tags) WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id, b.notes !== undefined, b.notes ?? null, b.tags ?? null]);
  if (!row) throw new AppError('NOT_FOUND', { status: 404 }); res.json({ ok: true });
}));
r.delete('/saved/:id', need('operator'), h(async (req, res) => { const id = idParam(req); await query('UPDATE saved_results SET deleted_at = now() WHERE id = $1', [id]); await req.audit('SAVED_DELETED', { entity: 'saved', entityId: id }); res.json({ ok: true }); }));

r.get('/blocks', need('viewer'), h(async (req, res) => {
  const [users, sources, keywords, userCount, sourceCount, keywordCount] = await Promise.all([
    many('SELECT * FROM blocked_users ORDER BY created_at DESC LIMIT 1000'),
    many('SELECT * FROM blocked_sources ORDER BY created_at DESC LIMIT 1000'),
    many('SELECT id, phrase, reason, created_at FROM blocked_keywords ORDER BY created_at DESC LIMIT 1000'),
    one('SELECT count(*)::int AS n FROM blocked_users'),
    one('SELECT count(*)::int AS n FROM blocked_sources'),
    one('SELECT count(*)::int AS n FROM blocked_keywords'),
  ]);
  res.json({ users, sources, keywords, counts: { users: userCount.n, sources: sourceCount.n, keywords: keywordCount.n } });
}));
r.post('/blocks/users', need('operator'), h(async (req, res) => {
  const b = z.object({ tg_user_id: z.coerce.number().int(), username: z.string().trim().max(64).nullable().optional(), reason: z.string().trim().max(300).optional() }).parse(req.body);
  await blockUser({ tgUserId: b.tg_user_id, username: b.username ?? null, reason: b.reason ?? null, userId: req.user.id }); await req.audit('USER_BLOCKED', { entity: 'tg_user', entityId: b.tg_user_id }); res.status(201).json({ ok: true });
}));
r.post('/blocks/sources', need('operator'), h(async (req, res) => {
  const b = z.object({ tg_chat_id: z.coerce.number().int(), kind: z.enum(['group', 'supergroup', 'channel', 'private', 'saved']).default('group'), title: z.string().trim().max(200).nullable().optional(), reason: z.string().trim().max(300).optional() }).parse(req.body);
  await blockSource({ tgChatId: b.tg_chat_id, kind: b.kind, title: b.title ?? null, reason: b.reason ?? null, userId: req.user.id }); await req.audit('SOURCE_BLOCKED', { entity: 'tg_chat', entityId: b.tg_chat_id }); res.status(201).json({ ok: true });
}));
r.post('/blocks/keywords', need('operator'), h(async (req, res) => {
  const b = z.object({ phrase: z.string().trim().min(2).max(120), reason: z.string().trim().max(300).optional() }).parse(req.body);
  if (!normalizeText(b.phrase)) throw new AppError('VALIDATION', { message: 'phrase has no letters or digits' });
  await blockKeyword({ phrase: b.phrase, reason: b.reason ?? null, userId: req.user.id }); await req.audit('KEYWORD_BLOCKED', { details: { phrase: b.phrase } }); res.status(201).json({ ok: true });
}));
for (const [path, table] of [['users', 'blocked_users'], ['sources', 'blocked_sources'], ['keywords', 'blocked_keywords']]) {
  r.delete(`/blocks/${path}/:id`, need('operator'), h(async (req, res) => { const id = idParam(req); await query(`DELETE FROM ${table} WHERE id = $1`, [id]); invalidateBlocks(); await req.audit('BLOCK_REMOVED', { entity: table, entityId: id }); res.json({ ok: true }); }));
}

const MATCH_COLS = [['id', 'ID'], ['created_at', 'Created'], ['sent_at', 'Message time'], ['score', 'Match %'], ['match_type', 'Type'], ['priority', 'Priority'], ['intent', 'Intent'], ['keyword', 'Keyword'], ['ai_reason', 'AI reason'], ['source', 'Source'], ['account', 'Account'], ['detected_by', 'Detected by'], ['sender_username', 'Username'], ['sender_id', 'User ID'], ['text', 'Message'], ['link', 'Link']].map(([key, label]) => ({ key, label }));
const flat = (c) => ({ id: c.id, created_at: c.created_at, sent_at: c.sent_at, score: c.score, match_type: c.match_type, priority: c.priority, intent: c.intent, keyword: c.keyword, ai_reason: c.ai_reason, source: c.source.title, account: c.account.name, detected_by: c.detected_by.map((a) => a.name), sender_username: c.sender.username, sender_id: c.sender.id, text: c.text, link: c.links.message });
r.get('/export/matches', need('viewer'), h(async (req, res) => {
  const { cards } = await listMatches(req.query, { limit: MAX_EXPORT_ROWS, offset: 0 });
  await req.audit('EXPORT_MATCHES', { details: { format: req.query.format, rows: cards.length } });
  sendExport(res, { format: req.query.format, name: 'nabd-matches', title: 'NABD AI — Matches', columns: MATCH_COLS, rows: cards.map(flat), lang: req.query.lang });
}));
r.get('/export/saved', need('viewer'), h(async (req, res) => {
  const w = savedWhere(req.query); const rows = await many(`SELECT ${SAVED_COLS} FROM saved_results WHERE ${w.sql} ORDER BY created_at DESC LIMIT ${MAX_EXPORT_ROWS}`, w.v);
  await req.audit('EXPORT_SAVED', { details: { format: req.query.format, rows: rows.length } });
  sendExport(res, { format: req.query.format, name: 'nabd-saved', title: 'NABD AI — Saved results', lang: req.query.lang, rows,
    columns: ['id', 'created_at', 'source_title', 'sender_username', 'sender_id', 'message_text', 'message_at', 'rule_name', 'intent', 'score', 'priority', 'notes', 'tags'].map((key) => ({ key })) });
}));

export default r;
