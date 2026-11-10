// Compiled, cached view of keywords / radars / rules used by the processing pipeline (10 s TTL + explicit invalidation).
import { many } from '../lib/db.js';
import { getSetting } from '../lib/settings.js';
import { compileKeyword, compileSignals } from '../engine/keywords.js';
import { buildCanon, DEFAULT_SYNONYM_GROUPS } from '../engine/normalize.js';

let cache = null; let at = 0;
export const invalidateCompiled = () => { cache = null; };

export async function getCompiled() {
  if (cache && Date.now() - at < 10000) return cache;
  const [kwRows, varRows, radarRows, ruleRows, custom, sensitive, thresholds] = await Promise.all([
    many('SELECT * FROM keywords WHERE enabled AND deleted_at IS NULL'),
    many('SELECT v.* FROM keyword_variants v JOIN keywords k ON k.id = v.keyword_id WHERE k.enabled AND k.deleted_at IS NULL'),
    many("SELECT * FROM ai_rules WHERE status = 'active' AND deleted_at IS NULL ORDER BY id"),
    many('SELECT * FROM rules WHERE enabled AND deleted_at IS NULL ORDER BY sort_order, id'),
    getSetting('keywords.custom_synonyms'),
    getSetting('priority.sensitive_words'),
    Promise.all(['medium', 'high', 'critical'].map((k) => getSetting(`priority.${k}`))),
  ]);
  const canon = buildCanon([...DEFAULT_SYNONYM_GROUPS, ...custom]);
  const byKw = new Map();
  for (const v of varRows) { if (!byKw.has(v.keyword_id)) byKw.set(v.keyword_id, []); byKw.get(v.keyword_id).push(v); }
  const keywords = kwRows.map((k) => compileKeyword(k, byKw.get(k.id) ?? [], canon));
  const radars = radarRows.map((r) => ({
    ...r,
    kw: compileKeyword({ id: null, ai_rule_id: r.id, phrase: '', match_modes: ['exact', 'partial', 'fuzzy'], fuzzy_threshold: 82, context_mode: r.context_mode, context_strict: false, min_score: r.min_score, weight: 100, is_sensitive: false }, r.signals.map((p) => ({ phrase: p, kind: 'signal' })), canon),
    forms: compileSignals(r.signals, canon), negForms: compileSignals(r.negative_signals, canon),
  }));
  const [medium, high, critical] = thresholds;
  const rulesNeedAi = ruleRows.some((r) => /"type":"(confidence|intent)"/.test(JSON.stringify(r.conditions)));
  cache = { canon, keywords, radars, rules: ruleRows, rulesNeedAi, sensitiveWords: sensitive.map(String).filter(Boolean), thresholds: { medium, high, critical } };
  at = Date.now();
  return cache;
}
