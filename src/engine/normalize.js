// Arabic/Latin text normalisation, light stemming and dialect canonicalisation used by every matcher.
const DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g; // tashkeel, quranic marks, tatweel
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g;
const CHAR_MAP = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي', 'ک': 'ك', 'ی': 'ي', 'ې': 'ي', 'ھ': 'ه', 'ڤ': 'ف', 'پ': 'ب', 'چ': 'ج', 'گ': 'ك', 'ژ': 'ز' };
const CHAR_RE = /[أإآٱىةؤئکیېھڤپچگژ]/g;
const AR = /[\u0600-\u06FF]/;
export const URL_RE = /(https?:\/\/|www\.|t\.me\/|@[a-z0-9_]{4,})\S*/i;

export function normalizeText(input) {
  let s = String(input ?? '').normalize('NFKC').replace(INVISIBLE, '').toLowerCase();
  s = s.replace(DIACRITICS, '').replace(/\p{M}+/gu, '');
  s = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
  s = s.replace(CHAR_RE, (c) => CHAR_MAP[c]);
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/(\p{L})\1{2,}/gu, '$1'); // elongation (3+ repeats never occur in real words): "مساااعدة" -> "مساعدة"
  return s.replace(/\s+/g, ' ').trim();
}

export function stem(tok) {
  if (tok.length > 3 && AR.test(tok)) {
    const m = /^(وال|فال|بال|كال|لل|ال)/.exec(tok);
    if (m && tok.length - m[0].length >= 2) return tok.slice(m[0].length);
  }
  return tok;
}

// Built-in dialect equivalence groups (first item is the canonical form). Extend through settings.
export const DEFAULT_SYNONYM_GROUPS = [
  ['احتاج', 'محتاج', 'محتاجه', 'ابي', 'ابغي', 'ابغا', 'ابا', 'ودي', 'بدي', 'عايز', 'عايزه', 'عاوز', 'عاوزه', 'اريد', 'حابب', 'نفسي'],
  ['مشروع', 'بروجكت', 'project', 'بروجيكت'],
  ['واجب', 'واجبات', 'هومورك', 'homework', 'assignment'],
  ['مساعده', 'مساعدتي', 'help', 'عون'],
];
export function buildCanon(groups = DEFAULT_SYNONYM_GROUPS) {
  const m = new Map();
  for (const g of groups) {
    const list = (Array.isArray(g) ? g : String(g).split(/[,،]/)).map((x) => normalizeText(x)).filter(Boolean);
    for (const w of list) if (list[0] && !m.has(w)) m.set(w, list[0]);
  }
  return m;
}
export const DEFAULT_CANON = buildCanon();

export const toKeys = (tokens, canon = DEFAULT_CANON) => tokens.map((t) => canon.get(t) ?? ((s) => canon.get(s) ?? s)(stem(t)));
export const tokenize = (norm) => (norm ? norm.split(' ') : []);

export function analyze(text, canon = DEFAULT_CANON, maxTokens = 600) {
  const raw = String(text ?? '');
  const norm = normalizeText(raw);
  const tokens = tokenize(norm).slice(0, maxTokens);
  const starts = []; let pos = 0;
  for (const t of tokens) { starts.push(pos); pos += t.length + 1; }
  return { raw, norm: tokens.length === tokenize(norm).length ? norm : tokens.join(' '), tokens, keys: toKeys(tokens, canon), starts };
}
export function tokenAt(starts, charIdx) {
  let lo = 0; let hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= charIdx) lo = mid; else hi = mid - 1; }
  return lo;
}
export function detectLang(text) {
  let ar = 0; let la = 0;
  for (const ch of String(text ?? '')) { if (AR.test(ch)) ar++; else if (/[a-z]/i.test(ch)) la++; }
  if (ar + la < 3) return 'other';
  if (ar > la * 2) return 'ar';
  if (la > ar * 2) return 'en';
  return 'mixed';
}
export const hasLink = (text) => URL_RE.test(String(text ?? ''));
