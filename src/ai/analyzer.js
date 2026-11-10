// Per-message analysis against a radar intent + defensive JSON parsing and result caching.
import { z } from 'zod';
import { complete } from './manager.js';
import { ANALYZER_SYSTEM, analyzerUserPrompt } from './prompts.js';
import { getSetting } from '../lib/settings.js';
import { safeRedis } from '../lib/redis.js';
import { AppError } from '../lib/errors.js';
import { PRIORITIES } from '../engine/priority.js';

const bool = z.preprocess((v) => v === true || v === 'true' || v === 1 || v === '1', z.boolean());
export const analysisSchema = z.object({
  match: bool,
  confidence: z.preprocess((v) => { const n = Number(v); return Number.isFinite(n) ? (n > 0 && n <= 1 ? n * 100 : n) : 0; }, z.number().transform((n) => Math.max(0, Math.min(100, n)))),
  intent: z.string().max(200).catch(''), category: z.string().max(80).catch(''),
  priority: z.enum(PRIORITIES).catch('medium'),
  entities: z.array(z.object({ type: z.string().max(40), value: z.string().max(200) })).max(10).catch([]),
  reason: z.string().max(400).catch(''), suggested_keywords: z.array(z.string().max(80)).max(5).catch([]), summary: z.string().max(240).catch(''),
});

export function parseAiJson(text) {
  let s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in AI response');
  s = s.slice(a, b + 1);
  return JSON.parse(s);
}

export async function analyzeForRadar({ radar, text, normHash, sourceTitle, examples = [] }) {
  const [maxChars, wantSummary, useIntent, useClass] = await Promise.all([getSetting('ai.max_chars'), getSetting('ai.summarization_enabled'), getSetting('ai.intent_enabled'), getSetting('ai.classification_enabled')]);
  const key = `ai:v1:${radar.id}:${+new Date(radar.updated_at)}:${normHash}`;
  const cached = normHash ? await safeRedis((r) => r.get(key)) : null;
  if (cached) { try { return { ...JSON.parse(cached), cached: true }; } catch { /* recompute */ } }
  const user = analyzerUserPrompt({ radar, text: String(text).slice(0, maxChars), examples, sourceTitle, wantSummary });
  let parsed = null; let res = null; let lastErr = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    res = await complete({ purpose: 'analyze', system: ANALYZER_SYSTEM, user, json: true, maxTokens: 400, temperature: 0 });
    try { parsed = analysisSchema.parse(parseAiJson(res.text)); } catch (e) { lastErr = e; }
  }
  if (!parsed) throw new AppError('AI_UNAVAILABLE', { status: 502, message: `unparseable AI response: ${lastErr?.message}` });
  const entities = useClass ? [...parsed.entities] : [];
  if (wantSummary && parsed.summary) entities.push({ type: 'summary', value: parsed.summary });
  const out = {
    isMatch: parsed.match, confidence: parsed.confidence, intent: useIntent && parsed.intent ? parsed.intent : radar.intent,
    category: useClass ? parsed.category : '', priority: useClass ? parsed.priority : null, entities, reason: parsed.reason,
    suggested: parsed.suggested_keywords, provider: res.provider, model: res.model, latencyMs: res.latencyMs, tokensIn: res.tokensIn ?? null, tokensOut: res.tokensOut ?? null,
  };
  if (normHash) await safeRedis((r) => r.set(key, JSON.stringify(out), 'EX', 86400));
  return out;
}
