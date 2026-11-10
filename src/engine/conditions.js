// Condition tree evaluator shared by the Rules Engine and the Automation Engine (no duplicated logic).
import { z } from 'zod';
import { quickMatch } from './keywords.js';
import { normalizeText } from './normalize.js';
import { priorityAtLeast, PRIORITIES } from './priority.js';

export const LEAF_TYPES = ['text', 'intent', 'confidence', 'score', 'radar', 'keyword', 'source', 'account', 'sender', 'lang', 'priority', 'has_link', 'length', 'hour', 'field'];
export const conditionSchema = z.lazy(() => z.union([
  z.object({ all: z.array(conditionSchema).max(30) }).strict(),
  z.object({ any: z.array(conditionSchema).max(30) }).strict(),
  z.object({ not: conditionSchema }).strict(),
  z.object({ type: z.enum(LEAF_TYPES), negate: z.boolean().optional() }).passthrough(),
  z.object({}).strict(), // empty = always true
]));

const YES = { ok: true, score: null }; const NO = { ok: false, score: null };
const ok = (v) => (v ? YES : NO);
const nums = (a) => (Array.isArray(a) ? a.map(Number) : []);

function leaf(c, ctx) {
  const m = ctx.message ?? {}; const ai = ctx.ai ?? []; const cands = ctx.candidates ?? [];
  switch (c.type) {
    case 'text': {
      const r = quickMatch(ctx.analysis, String(c.value ?? ''), c.mode ?? 'partial');
      if (!r.ok) return NO;
      const total = ctx.analysis.keys.length; const mode = c.context ?? 'none';
      if (mode === 'before' && r.start < 1) return NO;
      if (mode === 'after' && total - r.end < 1) return NO;
      if (mode === 'both' && (r.start < 1 || total - r.end < 1)) return NO;
      return { ok: true, score: r.score };
    }
    case 'intent': {
      const want = normalizeText(c.value ?? '');
      return ok(want && (ai.some((a) => a.isMatch && normalizeText(a.intent ?? '') === want) || cands.some((k) => normalizeText(k.intent ?? '') === want)));
    }
    case 'confidence': return ok(ai.some((a) => a.isMatch && a.confidence >= (c.gte ?? 0)));
    case 'score': { const s = ctx.best?.score ?? 0; return ok((c.gte == null || s >= c.gte) && (c.lte == null || s <= c.lte)); }
    case 'radar': return ok(cands.some((k) => k.aiRuleId != null && nums(c.ids).includes(k.aiRuleId)));
    case 'keyword': return ok(cands.some((k) => k.keywordId != null && nums(c.ids).includes(k.keywordId)));
    case 'source': return ok(nums(c.ids).includes(ctx.source?.id) || (c.kinds ?? []).includes(ctx.source?.kind) || nums(c.chat_ids).includes(ctx.source?.tgChatId));
    case 'account': return ok(nums(c.ids).includes(ctx.account?.id));
    case 'sender': {
      const names = (c.usernames ?? []).map((u) => String(u).toLowerCase().replace(/^@/, ''));
      return ok(nums(c.ids).includes(m.senderId) || (m.senderUsername && names.includes(String(m.senderUsername).toLowerCase())));
    }
    case 'lang': return ok((c.in ?? []).includes(m.lang));
    case 'priority': return ok(PRIORITIES.includes(c.gte) && priorityAtLeast(ctx.priority ?? 'low', c.gte));
    case 'has_link': return ok(!!m.hasLink === (c.value ?? true));
    case 'length': { const L = (m.text ?? '').length; return ok((c.gte == null || L >= c.gte) && (c.lte == null || L <= c.lte)); }
    case 'hour': {
      const h = ctx.hour ?? new Date().getUTCHours(); const f = c.from ?? 0; const t = c.to ?? 24;
      return ok(f <= t ? h >= f && h < t : h >= f || h < t);
    }
    case 'field': {
      if (!/^[a-zA-Z0-9_.]{1,60}$/.test(c.path ?? '')) return NO;
      const v = c.path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx); const w = c.value;
      switch (c.op ?? 'eq') {
        case 'eq': return ok(String(v) === String(w));
        case 'ne': return ok(String(v) !== String(w));
        case 'gt': return ok(Number(v) > Number(w));
        case 'gte': return ok(Number(v) >= Number(w));
        case 'lt': return ok(Number(v) < Number(w));
        case 'lte': return ok(Number(v) <= Number(w));
        case 'in': return ok(Array.isArray(w) && w.map(String).includes(String(v)));
        case 'contains': return ok(String(v ?? '').toLowerCase().includes(String(w ?? '').toLowerCase()));
        default: return NO;
      }
    }
    default: return NO;
  }
}

/** Returns {ok, score}; score is the minimum text-match score across AND-ed text leaves (or max across OR). */
export function evalNode(node, ctx, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return YES;
  if (Array.isArray(node.all)) {
    let score = null;
    for (const n of node.all) {
      const r = evalNode(n, ctx, depth + 1);
      if (!r.ok) return NO;
      if (r.score != null) score = score == null ? r.score : Math.min(score, r.score);
    }
    return { ok: true, score };
  }
  if (Array.isArray(node.any)) {
    let best = null;
    for (const n of node.any) { const r = evalNode(n, ctx, depth + 1); if (r.ok && (!best || (r.score ?? -1) > (best.score ?? -1))) best = r; }
    return best ?? NO;
  }
  if (node.not) return ok(!evalNode(node.not, ctx, depth + 1).ok);
  if (!node.type) return YES;
  const r = leaf(node, ctx);
  return node.negate ? ok(!r.ok) : r;
}

export const DECISION_ACTIONS = ['create_card', 'set_priority', 'suppress', 'notify', 'tag', 'save'];
export const AUTOMATION_ACTIONS = [...DECISION_ACTIONS, 'create_alert', 'block_user', 'pause_source'];
export const CHANNELS = ['dashboard', 'browser', 'sound', 'telegram', 'email'];
export const actionSchema = z.object({
  type: z.enum(AUTOMATION_ACTIONS),
  priority: z.enum(PRIORITIES).optional(), value: z.enum(PRIORITIES).optional(),
  channels: z.array(z.enum(CHANNELS)).optional(), tags: z.array(z.string().max(40)).max(10).optional(),
  title: z.string().max(200).optional(), body: z.string().max(1000).optional(),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
}).strict();

/** Pure: mutate the in-memory decision from rule actions. */
export function applyDecisionActions(actions, d) {
  for (const a of actions ?? []) {
    switch (a.type) {
      case 'create_card': d.create = true; if (a.priority) { d.priority = a.priority; d.priorityLocked = true; } break;
      case 'set_priority': d.priority = a.value ?? d.priority; d.priorityLocked = true; break;
      case 'suppress': d.suppress = true; break;
      case 'notify': for (const c of (a.channels?.length ? a.channels : CHANNELS)) d.forceChannels.add(c); break;
      case 'tag': for (const t of a.tags ?? []) d.tags.add(t); break;
      case 'save': d.save = true; break;
      default: break;
    }
  }
  return d;
}
export const newDecision = () => ({ create: false, suppress: false, priority: null, priorityLocked: false, forceChannels: new Set(), tags: new Set(), save: false, ruleIds: [] });
