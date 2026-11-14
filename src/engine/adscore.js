import { normalizeText, hasLink } from './normalize.js';
import { quickMatch } from './keywords.js';

export const DEFAULT_WEIGHTS = Object.freeze({
  contact_phone: 30, contact_link: 20, contact_username: 10, cta: 20, offer: 20, price: 15,
  structure: 10, long_shape: 5, has_media: 5, seeker: -25, short_question: -10,
});
const PHONE_RE = /(?:^|\D)(?:05\d{8}|(?:\+?966|00966)5\d{8}|\d{9,13})(?:\D|$)/;
const LINK_RE = /(?:https?:\/\/|www\.)?(?:wa\.me|chat\.whatsapp\.com|t\.me|telegram\.me|instagram\.com|snapchat\.com|facebook\.com)\//i;
const USER_RE = /@[a-z\d_]{5,}/i;
const PRICE_RE = /(?:\d+(?:[.,]\d+)?)\s*(?:ريال|ر\.س|sar|\$)|(?:السعر|خصم|عرض)/i;
const EMOJI_RE = /[✅🔥📌📞⭐]/gu;
const contains = (analysis, phrase) => quickMatch(analysis, phrase, 'contains').ok;
export function scoreAd(analysis, rawText, { lexicon = [], hasMedia = false, weights = {} } = {}) {
  const text = String(rawText ?? ''); const norm = normalizeText(text); const w = { ...DEFAULT_WEIGHTS, ...weights }; const signals = [];
  const add = (id, ok) => { if (ok) signals.push({ id, weight: Number(w[id] ?? 0) }); };
  add('contact_phone', PHONE_RE.test(norm.replace(/[.\-\s]/g, '')));
  add('contact_link', LINK_RE.test(text) || hasLink(text)); add('contact_username', USER_RE.test(text));
  for (const kind of ['cta', 'offer', 'price']) {
    const hit = lexicon.some((x) => x.enabled !== false && x.kind === kind && contains(analysis, x.norm_phrase ?? x.phrase));
    add(kind, hit);
  }
  add('price', PRICE_RE.test(text) || signals.some((s) => s.id === 'price'));
  const lines = text.split(/\r?\n/).filter((x) => x.trim());
  add('structure', lines.length >= 4 && (lines.filter((x) => /(?:^|\s)[✅🔥📌📞⭐•*-]/u.test(x)).length >= 2 || (text.match(EMOJI_RE) ?? []).length / Math.max(1, text.length) > 0.08));
  add('long_shape', text.length > 250 && lines.length >= 3); add('has_media', !!hasMedia);
  const seekerLex = lexicon.some((x) => x.enabled !== false && x.kind === 'seeker' && contains(analysis, x.norm_phrase ?? x.phrase));
  const seekerKeys = new Set(['احتاج', 'محتاج', 'ابي', 'ابغي', 'ابغى', 'اريد', 'عايز', 'بدي']);
  add('seeker', seekerLex || (analysis?.keys ?? []).some((k) => seekerKeys.has(k)));
  add('short_question', text.length < 80 && !hasLink(text) && /[؟?]/.test(text));
  const score = Math.max(0, Math.min(100, signals.reduce((n, s) => n + s.weight, 0)));
  return { score, signals };
}
