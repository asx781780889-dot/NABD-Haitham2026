// Keyword engine: exact / partial / fuzzy / synonym matching with context rules and a radar pre-filter.
import { analyze, normalizeText, tokenize, toKeys, tokenAt, DEFAULT_CANON } from './normalize.js';
import { similarity, squash } from './similarity.js';

const STOP = new Set(['في', 'من', 'الي', 'علي', 'عن', 'مع', 'او', 'ان', 'ما', 'هل', 'لا', 'the', 'a', 'an', 'of', 'in', 'to', 'and', 'for', 'is', 'on', 'with', 'at', 'by', 'i', 'me', 'my']);
export { analyze };

function makeForm(phrase, kind, canon) {
  const norm = normalizeText(phrase);
  if (!norm) return null;
  const stems = toKeys(tokenize(norm), canon);
  return { norm, stems, kind, content: stems.filter((s) => !STOP.has(s)) };
}

/** Compile a DB keyword row (+ variant rows) into an immutable matcher. */
export function compileKeyword(k, variants = [], canon = DEFAULT_CANON) {
  const forms = []; const seen = new Set();
  for (const f of [{ phrase: k.phrase, kind: 'primary' }, ...variants.map((v) => ({ phrase: v.phrase, kind: v.kind || 'manual' }))]) {
    const form = makeForm(f.phrase, f.kind, canon);
    if (form && !seen.has(form.norm)) { seen.add(form.norm); forms.push(form); }
  }
  return {
    id: k.id, aiRuleId: k.ai_rule_id ?? null, phrase: k.phrase,
    modes: new Set(k.match_modes?.length ? k.match_modes : ['exact', 'partial', 'fuzzy']),
    fuzzy: (k.fuzzy_threshold ?? 82) / 100,
    contextMode: k.context_mode ?? 'none', contextStrict: !!k.context_strict,
    minScore: k.min_score ?? 60, weight: k.weight ?? 100, sensitive: !!k.is_sensitive, forms,
  };
}
export const compileSignals = (signals, canon = DEFAULT_CANON) => signals.map((s) => makeForm(s, 'signal', canon)).filter(Boolean);

function matchForm(an, form, modes, fuzzy, minCoverage = 0.6) {
  const P = form.stems; const n = P.length; const T = an.keys; const m = T.length;
  if (!n || !m) return null;
  let best = null;
  const take = (score, type, start, end) => { if (!best || score > best.score) best = { score, type, start, end }; };

  if (modes.has('exact')) {
    outer: for (let i = 0; i + n <= m; i++) {
      for (let j = 0; j < n; j++) if (T[i + j] !== P[j]) continue outer;
      take(100, 'exact', i, i + n);
      break;
    }
    if (best) return best;
  }
  if (modes.has('partial')) {
    if (form.norm.length >= 3) {
      const idx = an.norm.indexOf(form.norm);
      if (idx >= 0) take(88, 'partial', tokenAt(an.starts, idx), tokenAt(an.starts, idx + form.norm.length - 1) + 1);
    }
    const C = form.content.length ? form.content : P;
    if (C.length >= 2) {
      const idxs = [];
      for (const p of C) {
        let i = T.indexOf(p);
        if (i < 0 && p.length >= 4) i = T.findIndex((t) => t.length >= 4 && (t.includes(p) || p.includes(t)));
        if (i >= 0) idxs.push(i);
      }
      if (idxs.length >= 2 && idxs.length / C.length >= minCoverage) {
        const s = Math.min(...idxs); const e = Math.max(...idxs) + 1;
        if (e - s <= n + 4) take(Math.round((85 * idxs.length) / C.length), 'partial', s, e);
      }
    }
  }
  if (modes.has('fuzzy')) {
    const target = squash(P.join(''));
    if (target.length >= 4) {
      const maxDiff = Math.max(2, Math.ceil(target.length * 0.35));
      for (let w = Math.max(1, n - 1); w <= n + 1; w++) {
        for (let i = 0; i + w <= m; i++) {
          const cand = squash(T.slice(i, i + w).join(''));
          if (Math.abs(cand.length - target.length) > maxDiff) continue;
          const sim = similarity(target, cand);
          if (sim >= fuzzy) take(Math.min(98, Math.round(sim * 100)), 'fuzzy', i, i + w);
        }
      }
    }
  }
  return best;
}

export function evaluateKeyword(an, kw, opts = {}) {
  const penalty = opts.contextPenalty ?? 25; const minCtx = opts.minContextTokens ?? 1;
  let best = null;
  for (const form of kw.forms) {
    const r = matchForm(an, form, kw.modes, kw.fuzzy, opts.minCoverage);
    if (r && (!best || r.score > best.score)) best = { ...r, form };
  }
  if (!best) return null;
  const before = best.start; const after = an.keys.length - best.end;
  let contextOk = true;
  if (kw.contextMode === 'before') contextOk = before >= minCtx;
  else if (kw.contextMode === 'after') contextOk = after >= minCtx;
  else if (kw.contextMode === 'both') contextOk = before >= minCtx && after >= minCtx;
  let score = best.score;
  if (!contextOk) { if (kw.contextStrict) return null; score *= 1 - penalty / 100; }
  score = Math.round(Math.min(100, (score * kw.weight) / 100));
  return {
    keywordId: kw.id, aiRuleId: kw.aiRuleId, phrase: kw.phrase, matchedForm: best.form.norm,
    type: best.form.kind === 'primary' || best.form.kind === 'signal' ? best.type : 'synonym', rawType: best.type,
    score, contextOk, before, after, sensitive: kw.sensitive, minScore: kw.minScore,
  };
}
export const evaluateKeywords = (an, kws, opts) => kws.map((k) => evaluateKeyword(an, k, opts)).filter(Boolean).sort((a, b) => b.score - a.score);

/** Single-phrase matcher used by rule conditions and blocked keywords. mode: exact|partial|fuzzy|contains */
export function quickMatch(an, phrase, mode = 'partial', canon = DEFAULT_CANON) {
  const norm = normalizeText(phrase);
  if (!norm) return { ok: false, score: 0 };
  if (mode === 'contains') {
    const i = an.norm.indexOf(norm);
    return i < 0 ? { ok: false, score: 0 } : { ok: true, score: 100, start: tokenAt(an.starts, i), end: tokenAt(an.starts, i + norm.length - 1) + 1 };
  }
  const form = makeForm(phrase, 'quick', canon);
  const modes = new Set(mode === 'exact' ? ['exact'] : mode === 'fuzzy' ? ['exact', 'fuzzy'] : ['exact', 'partial']);
  const r = matchForm(an, form, modes, 0.85);
  return r ? { ok: true, score: r.score, start: r.start, end: r.end } : { ok: false, score: 0 };
}

/** Cheap local relevance (0-100) of a message against a radar's example signals; gates paid AI calls. */
export function radarPrefilter(an, signalForms) {
  const modes = new Set(['exact', 'partial', 'fuzzy']);
  let best = 0;
  for (const f of signalForms) { const r = matchForm(an, f, modes, 0.62, 0.5); if (r && r.score > best) best = r.score; if (best === 100) break; }
  return best;
}
