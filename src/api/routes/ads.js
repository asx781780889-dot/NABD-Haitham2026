import express from 'express';
import { z } from 'zod';
import { one, many, query } from '../../lib/db.js';
import { h, need, paging, pageMeta, idParam } from '../middleware.js';
import { analyze } from '../../engine/normalize.js';
import { scoreAd } from '../../engine/adscore.js';
import { getCompiled, invalidateCompiled } from '../../services/config-cache.js';
import { classifyAd } from '../../ai/analyzer.js';
import { aiAvailable } from '../../ai/manager.js';
const r = express.Router();
const textBody = z.object({ text: z.string().trim().min(1).max(8000), has_media: z.boolean().optional() });
r.get('/advertisers', need('viewer'), h(async (req, res) => {
  const p = paging(req.query, { max: 100, def: 30 });
  const where = req.query.status ? 'WHERE status = $1' : '';
  const values = req.query.status ? [String(req.query.status)] : [];
  const [rows, total] = await Promise.all([many(`SELECT * FROM sender_profiles ${where} ORDER BY ad_score DESC, last_ad_at DESC NULLS LAST LIMIT ${p.limit} OFFSET ${p.offset}`, values), one(`SELECT count(*)::int AS n FROM sender_profiles ${where}`, values)]);
  res.json({ data: rows, meta: pageMeta(total.n, p) });
}));
r.post('/ads/test', need('viewer'), h(async (req, res) => {
  const b = textBody.parse(req.body); const cfg = await getCompiled();
  const result = scoreAd(analyze(b.text, cfg.canon), b.text, { lexicon: cfg.adLexicon, hasMedia: b.has_media });
  let ai = null;
  if (await aiAvailable()) { try { ai = await classifyAd({ text: b.text, normHash: null, sourceTitle: 'calibration', examples: await many('SELECT text,label FROM ad_examples ORDER BY created_at DESC LIMIT 12') }); } catch { /* local result remains available */ } }
  res.json({ ...result, ai });
}));
r.post('/ads/feedback', need('operator'), h(async (req, res) => {
  const b = z.object({ text: z.string().trim().min(1).max(1000), label: z.enum(['ad', 'not_ad']), match_id: z.coerce.number().int().positive().nullable().optional(), tg_user_id: z.coerce.number().int().nullable().optional() }).parse(req.body);
  await query('INSERT INTO ad_examples (text,label,match_id,tg_user_id,created_by) VALUES ($1,$2,$3,$4,$5)', [b.text, b.label, b.match_id ?? null, b.tg_user_id ?? null, req.user.id]);
  if (b.match_id) await query('UPDATE message_matches SET ad_label=$2, ad_score=CASE WHEN $2=\'ad\' THEN GREATEST(COALESCE(ad_score,0),70) ELSE LEAST(COALESCE(ad_score,0),30) END WHERE id=$1', [b.match_id, b.label === 'ad' ? 'ad' : 'clean']);
  await req.audit('AD_FEEDBACK', { entity: 'ad_example', details: { label: b.label, matchId: b.match_id ?? null } });
  res.status(201).json({ ok: true });
}));
r.patch('/advertisers/:id', need('operator'), h(async (req, res) => {
  const id = Number(req.params.id); if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid sender id' });
  const b = z.object({ status: z.enum(['unknown', 'suspect', 'advertiser', 'trusted']) }).parse(req.body);
  const row = await one("UPDATE sender_profiles SET status=$2,status_source='operator',updated_at=now() WHERE tg_user_id=$1 RETURNING *", [id, b.status]);
  if (!row) return res.status(404).json({ error: 'not found' });
  await req.audit('ADVERTISER_STATUS', { entity: 'sender_profile', entityId: id, details: { status: b.status } });
  res.json({ data: row });
}));
r.post('/ads/lexicon', need('operator'), h(async (req, res) => {
  const b = z.object({ phrase: z.string().trim().min(2).max(120), kind: z.enum(['offer','cta','price','seeker']), weight: z.coerce.number().int().min(-50).max(50) }).parse(req.body);
  const norm = b.phrase.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const row = await one('INSERT INTO ad_lexicon (phrase,norm_phrase,kind,weight) VALUES ($1,$2,$3,$4) ON CONFLICT (norm_phrase) DO UPDATE SET kind=EXCLUDED.kind,weight=EXCLUDED.weight,enabled=true RETURNING *', [b.phrase, norm, b.kind, b.weight]);
  invalidateCompiled(); await req.audit('AD_LEXICON_UPDATED', { entity: 'ad_lexicon', entityId: row.id }); res.status(201).json({ data: row });
}));
export default r;
