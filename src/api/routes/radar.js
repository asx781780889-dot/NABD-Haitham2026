// Smart Radar, Keyword engine, Rules engine and Automations (all changes invalidate the compiled caches in every process).
import express from 'express';
import { z } from 'zod';
import { query, one, many, tx } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { h, need, idParam, paging, pageMeta, buildUpdate } from '../middleware.js';
import { where, nlike } from '../sql.js';
import { normalizeText, analyze } from '../../engine/normalize.js';
import { evaluateKeywords, compileKeyword } from '../../engine/keywords.js';
import { conditionSchema, actionSchema, evalNode, newDecision, applyDecisionActions } from '../../engine/conditions.js';
import { PRIORITIES } from '../../engine/priority.js';
import { getCompiled, invalidateCompiled } from '../../services/config-cache.js';
import { invalidateAutomations, TRIGGERS } from '../../services/automation.js';
import { sendControl } from '../../lib/bus.js';
import { draftRadar, suggestImprovements } from '../../ai/radar.js';
import { analyzeForRadar } from '../../ai/analyzer.js';
import { aiAvailable } from '../../ai/manager.js';
import { fingerprint } from '../../engine/dedupe.js';

const r = express.Router();
const bust = async () => { invalidateCompiled(); invalidateAutomations(); await sendControl({ t: 'cache' }); };
const phraseList = (max) => z.array(z.string().trim().min(2).max(160)).max(max).transform((a) => [...new Set(a)]);
const CTX = z.enum(['none', 'before', 'after', 'both']);

/* ---------- Smart Radar ---------- */
const radarBody = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).default(''), intent: z.string().trim().min(1).max(160), intent_description: z.string().trim().max(800).nullable().optional(),
  signals: phraseList(60), negative_signals: phraseList(30).default([]), min_score: z.number().int().min(0).max(100).default(70),
  ai_mode: z.enum(['off', 'uncertain', 'always']).default('uncertain'), context_mode: CTX.default('none'), priority_hint: z.enum(PRIORITIES).nullable().optional(),
});
r.get('/radar', need('viewer'), h(async (req, res) => {
  res.json({ data: await many(`SELECT r.id, r.name, r.description, r.intent, r.intent_description, r.signals, r.negative_signals, r.status, r.min_score, r.ai_mode, r.context_mode, r.priority_hint, r.hits, r.confirmed, r.rejected, r.created_at, r.updated_at,
    (SELECT count(*)::int FROM keyword_suggestions k WHERE k.ai_rule_id = r.id AND k.status = 'pending') AS suggestions, (SELECT count(*)::int FROM feedback_examples f WHERE f.ai_rule_id = r.id) AS examples
    FROM ai_rules r WHERE r.deleted_at IS NULL ORDER BY r.id DESC`) });
}));
r.post('/radar/draft', need('operator'), h(async (req, res) => {
  const { description } = z.object({ description: z.string().trim().min(5).max(1500) }).parse(req.body);
  const draft = await draftRadar(description);
  await req.audit('RADAR_DRAFTED', { details: { source: draft.source } });
  res.json({ data: { ...draft, description, status: 'draft', requires_confirmation: true } });
}));
r.post('/radar', need('operator'), h(async (req, res) => {
  const { confirm, ...b } = radarBody.extend({ confirm: z.boolean().default(false) }).parse(req.body);
  if (!b.signals.length) throw new AppError('VALIDATION', { details: [{ path: ['signals'], message: 'at least one signal phrase is required' }] });
  const row = await one(`INSERT INTO ai_rules (name, description, intent, intent_description, signals, negative_signals, min_score, ai_mode, context_mode, priority_hint, status, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [b.name, b.description, b.intent, b.intent_description ?? null, b.signals, b.negative_signals, b.min_score, b.ai_mode, b.context_mode, b.priority_hint ?? null, confirm ? 'active' : 'draft', req.user.id]);
  await bust(); await req.audit('RULE_CREATED', { entity: 'radar', entityId: row.id, details: { status: confirm ? 'active' : 'draft' } });
  res.status(201).json({ data: row });
}));
r.get('/radar/:id', need('viewer'), h(async (req, res) => {
  const row = await one('SELECT * FROM ai_rules WHERE id = $1 AND deleted_at IS NULL', [idParam(req)]);
  if (!row) throw new AppError('NOT_FOUND', { status: 404 }); res.json({ data: row });
}));
r.patch('/radar/:id', need('operator'), h(async (req, res) => {
  const id = idParam(req); const b = radarBody.partial().parse(req.body);
  const { sets, vals } = buildUpdate(b, { name: undefined, description: undefined, intent: undefined, intent_description: undefined, signals: undefined, negative_signals: undefined, min_score: undefined, ai_mode: undefined, context_mode: undefined, priority_hint: undefined });
  if (!sets.length) throw new AppError('VALIDATION', { message: 'nothing to update' });
  if (!(await one(`UPDATE ai_rules SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, ...vals]))) throw new AppError('NOT_FOUND', { status: 404 });
  await bust(); await req.audit('RULE_UPDATED', { entity: 'radar', entityId: id, details: { fields: Object.keys(b) } });
  res.json({ ok: true });
}));
for (const [op, status] of [['activate', 'active'], ['pause', 'paused']]) {
  r.post(`/radar/:id/${op}`, need('operator'), h(async (req, res) => {
    const id = idParam(req);
    if (op === 'activate') { const { confirm } = z.object({ confirm: z.literal(true) }).parse(req.body ?? {}); void confirm; }
    if (!(await one("UPDATE ai_rules SET status = $2 WHERE id = $1 AND deleted_at IS NULL AND array_length(signals, 1) > 0 RETURNING id", [id, status]))) throw new AppError('NOT_FOUND', { status: 404 });
    await bust(); await req.audit(op === 'activate' ? 'RULE_ACTIVATED' : 'RULE_PAUSED', { entity: 'radar', entityId: id }); res.json({ ok: true });
  }));
}
r.delete('/radar/:id', need('operator'), h(async (req, res) => {
  const id = idParam(req); await query("UPDATE ai_rules SET deleted_at = now(), status = 'archived' WHERE id = $1", [id]); await bust(); await req.audit('RULE_DELETED', { entity: 'radar', entityId: id }); res.json({ ok: true });
}));
/** Dry run: shows what the engine (and optionally the AI) would decide for a sample message. Nothing is stored. */
r.post('/radar/:id/test', need('operator'), h(async (req, res) => {
  const id = idParam(req); const { text, use_ai } = z.object({ text: z.string().trim().min(1).max(2000), use_ai: z.boolean().default(false) }).parse(req.body);
  const radar = await one('SELECT * FROM ai_rules WHERE id = $1 AND deleted_at IS NULL', [id]); if (!radar) throw new AppError('NOT_FOUND', { status: 404 });
  const cfg = await getCompiled(); const an = analyze(text, cfg.canon);
  const kw = compileKeyword({ id: null, ai_rule_id: id, phrase: '', match_modes: ['exact', 'partial', 'fuzzy'], fuzzy_threshold: 82, context_mode: radar.context_mode, context_strict: false, min_score: radar.min_score, weight: 100, is_sensitive: false }, radar.signals.map((p) => ({ phrase: p, kind: 'signal' })), cfg.canon);
  const hits = evaluateKeywords(an, [kw]);
  let ai = null; let ai_error = null;
  if (use_ai) { if (!(await aiAvailable())) ai_error = 'AI_NOT_CONFIGURED'; else try { ai = await analyzeForRadar({ radar, text, normHash: fingerprint(an).norm, sourceTitle: 'test', examples: [] }); } catch (e) { ai_error = e.code ?? e.message; } }
  res.json({ data: { normalized: an.norm, keyword: hits[0] ?? null, ai, ai_error, min_score: radar.min_score } });
}));
r.get('/radar/:id/suggestions', need('viewer'), h(async (req, res) => {
  res.json({ data: await many("SELECT id, phrase, hits, example, status, created_at FROM keyword_suggestions WHERE ai_rule_id = $1 AND status = 'pending' ORDER BY hits DESC, created_at DESC LIMIT 100", [idParam(req)]) });
}));
r.post('/radar/suggestions/:id/:action', need('operator'), h(async (req, res) => {
  const id = idParam(req); const action = z.enum(['accept', 'ignore']).parse(req.params.action);
  await tx(async (c) => {
    const s = (await c.query("UPDATE keyword_suggestions SET status = $2 WHERE id = $1 AND status = 'pending' RETURNING ai_rule_id, phrase", [id, action === 'accept' ? 'added' : 'ignored'])).rows[0];
    if (!s) throw new AppError('NOT_FOUND', { status: 404 });
    if (action === 'accept') await c.query('UPDATE ai_rules SET signals = array_append(signals, $2) WHERE id = $1 AND NOT ($2 = ANY(signals))', [s.ai_rule_id, s.phrase]);
  });
  await bust(); await req.audit(action === 'accept' ? 'SUGGESTION_ACCEPTED' : 'SUGGESTION_IGNORED', { entity: 'suggestion', entityId: id }); res.json({ ok: true });
}));
r.post('/radar/:id/suggest', need('operator'), h(async (req, res) => {
  const radar = await one('SELECT * FROM ai_rules WHERE id = $1 AND deleted_at IS NULL', [idParam(req)]); if (!radar) throw new AppError('NOT_FOUND', { status: 404 });
  res.json({ data: await suggestImprovements(radar), note: 'Proposals only: nothing was changed. Review pending suggestions to apply them.' });
}));
r.get('/radar/:id/examples', need('viewer'), h(async (req, res) => res.json({ data: await many('SELECT id, text, label, created_at FROM feedback_examples WHERE ai_rule_id = $1 ORDER BY created_at DESC LIMIT 100', [idParam(req)]) })));
r.delete('/radar/examples/:id', need('operator'), h(async (req, res) => { await query('DELETE FROM feedback_examples WHERE id = $1', [idParam(req)]); res.json({ ok: true }); }));

/* ---------- Keywords ---------- */
const kwBody = z.object({
  phrase: z.string().trim().min(2).max(160), match_modes: z.array(z.enum(['exact', 'partial', 'fuzzy', 'semantic'])).min(1).default(['exact', 'partial', 'fuzzy']),
  fuzzy_threshold: z.number().int().min(50).max(100).default(82), context_mode: CTX.default('none'), context_strict: z.boolean().default(false), min_score: z.number().int().min(0).max(100).default(60),
  weight: z.number().int().min(1).max(100).default(100), is_sensitive: z.boolean().default(false), enabled: z.boolean().default(true), notes: z.string().max(500).nullable().optional(),
  ai_rule_id: z.number().int().positive().nullable().optional(),
  variants: z.array(z.object({ phrase: z.string().trim().min(2).max(160), kind: z.enum(['synonym', 'dialect', 'typo', 'abbr', 'ai', 'manual']).default('synonym') })).max(100).optional(),
});
const KW_COLS = { phrase: undefined, norm_phrase: undefined, match_modes: undefined, fuzzy_threshold: undefined, context_mode: undefined, context_strict: undefined, min_score: undefined, weight: undefined, is_sensitive: undefined, enabled: undefined, notes: undefined, ai_rule_id: undefined };
const needNorm = (p) => { const n = normalizeText(p); if (!n) throw new AppError('VALIDATION', { details: [{ path: ['phrase'], message: 'must contain letters or digits' }] }); return n; };
r.get('/keywords', need('viewer'), h(async (req, res) => {
  const p = paging(req.query); const w = where('k.deleted_at IS NULL');
  if (req.query.q) nlike(w, 'k.phrase', req.query.q); if (req.query.rule_id) w.add('k.ai_rule_id = $#', Number(req.query.rule_id)); if (req.query.enabled) w.add('k.enabled = $#', req.query.enabled === 'true');
  const [rows, total] = await Promise.all([
    many(`SELECT k.*, r.name AS rule_name, COALESCE((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'phrase', v.phrase, 'kind', v.kind) ORDER BY v.id) FROM keyword_variants v WHERE v.keyword_id = k.id), '[]') AS variants
          FROM keywords k LEFT JOIN ai_rules r ON r.id = k.ai_rule_id WHERE ${w.sql} ORDER BY k.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.v),
    one(`SELECT count(*)::int AS n FROM keywords k WHERE ${w.sql}`, w.v)]);
  res.json({ data: rows, meta: pageMeta(total.n, p) });
}));
r.post('/keywords/test', need('operator'), h(async (req, res) => {
  const { text } = z.object({ text: z.string().min(1).max(2000) }).parse(req.body);
  const cfg = await getCompiled(); const an = analyze(text, cfg.canon);
  res.json({ data: { normalized: an.norm, hits: evaluateKeywords(an, cfg.keywords) } });
}));
r.post('/keywords', need('operator'), h(async (req, res) => {
  const b = kwBody.parse(req.body); const norm = needNorm(b.phrase);
  const id = await tx(async (c) => {
    const k = (await c.query(`INSERT INTO keywords (phrase, norm_phrase, match_modes, fuzzy_threshold, context_mode, context_strict, min_score, weight, is_sensitive, enabled, notes, ai_rule_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [b.phrase, norm, b.match_modes, b.fuzzy_threshold, b.context_mode, b.context_strict, b.min_score, b.weight, b.is_sensitive, b.enabled, b.notes ?? null, b.ai_rule_id ?? null, req.user.id])).rows[0].id;
    for (const v of b.variants ?? []) { const n = normalizeText(v.phrase); if (n) await c.query('INSERT INTO keyword_variants (keyword_id, phrase, norm_phrase, kind) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [k, v.phrase, n, v.kind]); }
    return k;
  });
  await bust(); await req.audit('KEYWORD_CREATED', { entity: 'keyword', entityId: id }); res.status(201).json({ data: { id } });
}));
r.patch('/keywords/:id', need('operator'), h(async (req, res) => {
  const id = idParam(req); const b = kwBody.omit({ variants: true }).partial().parse(req.body);
  if (b.phrase) b.norm_phrase = needNorm(b.phrase);
  const { sets, vals } = buildUpdate(b, KW_COLS);
  if (!sets.length) throw new AppError('VALIDATION', { message: 'nothing to update' });
  if (!(await one(`UPDATE keywords SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, ...vals]))) throw new AppError('NOT_FOUND', { status: 404 });
  await bust(); await req.audit('KEYWORD_UPDATED', { entity: 'keyword', entityId: id }); res.json({ ok: true });
}));
r.delete('/keywords/:id', need('operator'), h(async (req, res) => { const id = idParam(req); await query('UPDATE keywords SET deleted_at = now(), enabled = false WHERE id = $1', [id]); await bust(); await req.audit('KEYWORD_DELETED', { entity: 'keyword', entityId: id }); res.json({ ok: true }); }));
r.post('/keywords/:id/variants', need('operator'), h(async (req, res) => {
  const id = idParam(req); const v = z.object({ phrase: z.string().trim().min(2).max(160), kind: z.enum(['synonym', 'dialect', 'typo', 'abbr', 'ai', 'manual']).default('synonym') }).parse(req.body);
  const n = needNorm(v.phrase);
  const row = await one('INSERT INTO keyword_variants (keyword_id, phrase, norm_phrase, kind) SELECT id, $2, $3, $4 FROM keywords WHERE id = $1 AND deleted_at IS NULL ON CONFLICT DO NOTHING RETURNING id', [id, v.phrase, n, v.kind]);
  await bust(); res.status(201).json({ data: row });
}));
r.delete('/keywords/variants/:id', need('operator'), h(async (req, res) => { await query('DELETE FROM keyword_variants WHERE id = $1', [idParam(req)]); await bust(); res.json({ ok: true }); }));

/* ---------- Rules engine ---------- */
const ruleBody = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).nullable().optional(), enabled: z.boolean().default(true), sort_order: z.number().int().min(0).max(100000).default(100),
  stop_on_match: z.boolean().default(false), conditions: conditionSchema, actions: z.array(actionSchema).min(1).max(20),
});
const RULE_COLS = { name: undefined, description: undefined, enabled: undefined, sort_order: undefined, stop_on_match: undefined, conditions: 'jsonb', actions: 'jsonb' };
r.get('/rules', need('viewer'), h(async (req, res) => res.json({ data: await many('SELECT * FROM rules WHERE deleted_at IS NULL ORDER BY sort_order, id') })));
r.post('/rules', need('operator'), h(async (req, res) => {
  const b = ruleBody.parse(req.body);
  const row = await one('INSERT INTO rules (name, description, enabled, sort_order, stop_on_match, conditions, actions, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [b.name, b.description ?? null, b.enabled, b.sort_order, b.stop_on_match, JSON.stringify(b.conditions), JSON.stringify(b.actions), req.user.id]);
  await bust(); await req.audit('RULE_CREATED', { entity: 'rule', entityId: row.id }); res.status(201).json({ data: row });
}));
r.patch('/rules/:id', need('operator'), h(async (req, res) => {
  const id = idParam(req); const b = ruleBody.partial().parse(req.body); const { sets, vals } = buildUpdate(b, RULE_COLS);
  if (!sets.length) throw new AppError('VALIDATION', { message: 'nothing to update' });
  if (!(await one(`UPDATE rules SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, ...vals]))) throw new AppError('NOT_FOUND', { status: 404 });
  await bust(); await req.audit('RULE_UPDATED', { entity: 'rule', entityId: id }); res.json({ ok: true });
}));
r.delete('/rules/:id', need('operator'), h(async (req, res) => { const id = idParam(req); await query('UPDATE rules SET deleted_at = now(), enabled = false WHERE id = $1', [id]); await bust(); await req.audit('RULE_DELETED', { entity: 'rule', entityId: id }); res.json({ ok: true }); }));
r.post('/rules/test', need('operator'), h(async (req, res) => {
  const b = z.object({ text: z.string().min(1).max(2000), conditions: conditionSchema, actions: z.array(actionSchema).default([]), ai: z.object({ intent: z.string().max(200), confidence: z.number().min(0).max(100), is_match: z.boolean().default(true) }).optional() }).parse(req.body);
  const cfg = await getCompiled(); const an = analyze(b.text, cfg.canon); const hits = evaluateKeywords(an, cfg.keywords);
  const ctx = { analysis: an, message: { text: b.text, lang: null, hasLink: /https?:\/\//.test(b.text) }, source: {}, account: {}, candidates: hits.map((x) => ({ ...x, intent: null })), best: hits[0] ?? null, ai: b.ai ? [{ isMatch: b.ai.is_match, confidence: b.ai.confidence, intent: b.ai.intent }] : [], priority: 'low' };
  const result = evalNode(b.conditions, ctx); const d = newDecision(); if (result.ok) applyDecisionActions(b.actions, d);
  res.json({ data: { matched: result.ok, score: result.score, decision: { create: d.create, suppress: d.suppress, priority: d.priority, notify: [...d.forceChannels], tags: [...d.tags], save: d.save } } });
}));

/* ---------- Automations ---------- */
const autoBody = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).nullable().optional(), enabled: z.boolean().default(true), trigger: z.enum(TRIGGERS), conditions: conditionSchema.default({}), actions: z.array(actionSchema).min(1).max(20) });
const AUTO_COLS = { name: undefined, description: undefined, enabled: undefined, trigger: undefined, conditions: 'jsonb', actions: 'jsonb' };
r.get('/automations/triggers', need('viewer'), h(async (req, res) => res.json({ data: TRIGGERS })));
r.get('/automations', need('viewer'), h(async (req, res) => res.json({ data: await many('SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY id DESC') })));
r.post('/automations', need('operator'), h(async (req, res) => {
  const b = autoBody.parse(req.body);
  const row = await one('INSERT INTO automations (name, description, enabled, trigger, conditions, actions, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [b.name, b.description ?? null, b.enabled, b.trigger, JSON.stringify(b.conditions), JSON.stringify(b.actions), req.user.id]);
  await bust(); await req.audit('AUTOMATION_CREATED', { entity: 'automation', entityId: row.id }); res.status(201).json({ data: row });
}));
r.patch('/automations/:id', need('operator'), h(async (req, res) => {
  const id = idParam(req); const b = autoBody.partial().parse(req.body); const { sets, vals } = buildUpdate(b, AUTO_COLS);
  if (!sets.length) throw new AppError('VALIDATION', { message: 'nothing to update' });
  if (!(await one(`UPDATE automations SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, ...vals]))) throw new AppError('NOT_FOUND', { status: 404 });
  await bust(); await req.audit('AUTOMATION_UPDATED', { entity: 'automation', entityId: id }); res.json({ ok: true });
}));
r.delete('/automations/:id', need('operator'), h(async (req, res) => { const id = idParam(req); await query('UPDATE automations SET deleted_at = now(), enabled = false WHERE id = $1', [id]); await bust(); await req.audit('AUTOMATION_DELETED', { entity: 'automation', entityId: id }); res.json({ ok: true }); }));
r.get('/automations/:id/runs', need('viewer'), h(async (req, res) => res.json({ data: await many('SELECT id, dedupe_key, status, result, error, started_at, finished_at FROM automation_runs WHERE automation_id = $1 ORDER BY id DESC LIMIT 50', [idParam(req)]) })));

export default r;
