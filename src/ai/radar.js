// Smart Radar helpers: natural-language -> draft definition (AI or offline heuristic) and feedback-driven suggestions.
import { z } from 'zod';
import { complete, aiAvailable } from './manager.js';
import { parseAiJson } from './analyzer.js';
import { DRAFT_SYSTEM, SUGGEST_SYSTEM } from './prompts.js';
import { many, query } from '../lib/db.js';
import { normalizeText, detectLang } from '../engine/normalize.js';
import { PRIORITIES } from '../engine/priority.js';

const phrases = (max) => z.array(z.string().trim().min(2).max(120)).transform((a) => [...new Set(a)].slice(0, max)).catch([]);
export const draftSchema = z.object({
  name: z.string().trim().min(1).max(120).catch('Radar'), intent: z.string().trim().min(1).max(160), intent_description: z.string().max(600).catch(''),
  language: z.enum(['ar', 'en', 'mixed']).catch('ar'), signals: phrases(30), negative_signals: phrases(15),
  min_score: z.coerce.number().min(30).max(100).catch(70), priority_hint: z.enum(PRIORITIES).nullable().catch(null), context_mode: z.enum(['none', 'before', 'after', 'both']).catch('none'),
});

const FILLER = new Set(['اريد', 'ابي', 'ابغي', 'ابغا', 'ودي', 'الاشخاص', 'الناس', 'الذين', 'اللذين', 'اللي', 'الي', 'يكتبون', 'يكتب', 'انهم', 'انه', 'يحتاجون', 'يحتاج', 'يطلبون', 'يبحثون', 'يبحث', 'عن', 'في', 'علي', 'من', 'مع', 'او', 'ان', 'كل', 'اي', 'احد', 'شخص', 'ناس', 'people', 'who', 'that', 'need', 'needs', 'want', 'looking', 'for', 'in', 'on', 'the', 'a', 'of', 'to', 'are', 'is', 'anyone', 'someone', 'somebody', 'help', 'مساعده', 'مساعدة']);

/** Offline fallback used when no AI provider is configured: builds editable signals from the description. */
export function heuristicDraft(description) {
  const norm = normalizeText(description);
  const core = norm.split(' ').filter((t) => t && !FILLER.has(t)).join(' ') || norm;
  const ar = detectLang(description) !== 'en';
  const signals = ar
    ? [`احتاج ${core}`, `ابي ${core}`, `اريد ${core}`, `محتاج ${core}`, `احتاج مساعدة في ${core}`, `ابغى مساعدة في ${core}`, `من يساعدني في ${core}`, `مين يساعدني في ${core}`, `عندي ${core}`, `ممكن مساعدة في ${core}`, core]
    : [`need help with ${core}`, `looking for ${core}`, `i need ${core}`, `anyone can help with ${core}`, `help with ${core}`, core];
  return { name: core.slice(0, 60) || 'Radar', intent: core.slice(0, 80) || 'Intent', intent_description: String(description).slice(0, 500), language: ar ? 'ar' : 'en', signals, negative_signals: [], min_score: 70, priority_hint: null, context_mode: 'none', source: 'heuristic' };
}

export async function draftRadar(description) {
  if (!(await aiAvailable())) return heuristicDraft(description);
  try {
    const res = await complete({ purpose: 'radar_draft', system: DRAFT_SYSTEM, user: `<description>\n${String(description).slice(0, 1500)}\n</description>`, json: true, maxTokens: 1500, temperature: 0.3 });
    return { ...draftSchema.parse(parseAiJson(res.text)), source: 'ai', provider: res.provider };
  } catch { return { ...heuristicDraft(description), source: 'heuristic', note: 'ai_failed' }; }
}

const sugSchema = z.object({ new_signals: phrases(10), negative_signals: phrases(6), min_score_suggestion: z.coerce.number().min(0).max(100).nullable().catch(null), notes: z.string().max(400).catch('') });

/** Proposals only: nothing is applied automatically. New signals become pending keyword suggestions for review. */
export async function suggestImprovements(radar) {
  const ex = await many('SELECT text, label FROM feedback_examples WHERE ai_rule_id = $1 ORDER BY created_at DESC LIMIT 30', [radar.id]);
  if (!ex.length) return { new_signals: [], negative_signals: [], min_score_suggestion: null, notes: 'no feedback yet' };
  const user = [`Intent: ${radar.intent}`, `Current signals:\n${radar.signals.map((s) => `- ${s}`).join('\n')}`,
    `Confirmed matches:\n${ex.filter((e) => e.label === 'positive').map((e) => `- ${e.text.slice(0, 200)}`).join('\n') || '(none)'}`,
    `Rejected matches:\n${ex.filter((e) => e.label === 'negative').map((e) => `- ${e.text.slice(0, 200)}`).join('\n') || '(none)'}`].join('\n\n');
  const res = await complete({ purpose: 'radar_suggest', system: SUGGEST_SYSTEM, user, json: true, maxTokens: 900, temperature: 0.3 });
  const out = sugSchema.parse(parseAiJson(res.text));
  for (const p of out.new_signals) {
    const norm = normalizeText(p);
    if (norm) await query("INSERT INTO keyword_suggestions (ai_rule_id, phrase, norm_phrase, example) VALUES ($1,$2,$3,'agent proposal') ON CONFLICT (ai_rule_id, norm_phrase) DO NOTHING", [radar.id, p, norm]);
  }
  return out;
}
