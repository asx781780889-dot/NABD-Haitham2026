import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; process.env.DATABASE_URL ??= 'postgres://x'; process.env.MASTER_KEY ??= 'k'.repeat(40);
const { normalizeText, analyze, detectLang, buildCanon } = await import('../../src/engine/normalize.js');
const { compileKeyword, evaluateKeyword, evaluateKeywords, quickMatch, radarPrefilter, compileSignals } = await import('../../src/engine/keywords.js');
const { levenshtein, similarity, simhash, hamming, squash } = await import('../../src/engine/similarity.js');
const { computePriority } = await import('../../src/engine/priority.js');
const { evalNode, applyDecisionActions, newDecision } = await import('../../src/engine/conditions.js');
const { fingerprint } = await import('../../src/engine/dedupe.js');

const kw = (phrase, o = {}) => compileKeyword({ id: 1, phrase, match_modes: ['exact', 'partial', 'fuzzy'], fuzzy_threshold: 82, context_mode: 'none', min_score: 60, weight: 100, ...o }, o.variants ?? []);
const ev = (text, k, opts) => evaluateKeyword(analyze(text), k, opts);

test('normalization: diacritics, hamza, ta marbuta, elongation, digits, symbols', () => {
  assert.equal(normalizeText('أَحْتَاجُ مُسَاعَدَةً!!'), 'احتاج مساعده');
  assert.equal(normalizeText('مساااااعدة'), 'مساعده');
  assert.equal(normalizeText('رقم ٣٤٥ 😀 Hello,WORLD'), 'رقم 345 hello world');
});
test('spec examples: all dialect variants of "احتاج مساعدة" reach the same intent keyword', () => {
  const k = kw('احتاج مساعدة');
  for (const t of ['احتاج مساعدة', 'أحتاج مساعده', 'أبي مساعدة', 'أريد مساعدة', 'ابغى مساعدة', 'عايز مساعدة']) {
    const r = ev(t, k); assert.ok(r, t); assert.equal(r.score >= 95, true, `${t} -> ${r?.score}`);
  }
  assert.equal(ev('مرحبا بالجميع', k), null);
});
test('context matching: before/after/both and penalty vs strict', () => {
  const text = 'السلام عليكم احتاج مساعدة في مشروع التخرج';
  assert.equal(ev(text, kw('احتاج مساعدة', { context_mode: 'both' })).contextOk, true);
  const bare = ev('احتاج مساعدة', kw('احتاج مساعدة', { context_mode: 'both' }), { contextPenalty: 25 });
  assert.equal(bare.contextOk, false); assert.equal(bare.score, 75);
  assert.equal(ev('احتاج مساعدة', kw('احتاج مساعدة', { context_mode: 'both', context_strict: true })), null);
  assert.equal(ev('احتاج مساعدة', kw('احتاج مساعدة', { context_mode: 'after' })).contextOk, false);
  assert.equal(ev(text, kw('احتاج مساعدة', { context_mode: 'before' })).contextOk, true);
});
test('fuzzy: typos, spacing and repeated letters', () => {
  const k = kw('مشروع تخرج');
  assert.ok(ev('عندي مشروع تخرج', k).score === 100);
  assert.equal(ev('مشروعتخرج', k).type, 'fuzzy');
  assert.ok(ev('محتاج مشروع تخرجج', k).score >= 90);
  assert.ok(ev('مشروع تخرح', k).score >= 82);
  assert.equal(ev('كتاب طبخ', k), null);
});
test('Arabic article/prefix stemming: "مشروع التخرج" == "مشروع تخرج"', () => {
  assert.equal(ev('احتاج مساعدة في مشروع التخرج', kw('مشروع تخرج')).type, 'exact');
  assert.equal(ev('للمشروع', kw('مشروع')).type, 'exact');
});
test('partial (substring + token coverage) and synonyms via variants', () => {
  assert.equal(ev('مشروعي صعب', kw('مشروع', { match_modes: ['partial'] })).type, 'partial');
  const part = ev('تخرج مشروع', kw('احتاج مشروع تخرج', { match_modes: ['partial'] }));
  assert.ok(part && part.score >= 50 && part.score < 100);
  const k = compileKeyword({ id: 2, phrase: 'مشروع تخرج', match_modes: ['exact'], fuzzy_threshold: 82, context_mode: 'none', min_score: 60, weight: 100 }, [{ phrase: 'بحث التخرج', kind: 'synonym' }]);
  const r = evaluateKeyword(analyze('اريد بحث التخرج'), k); assert.equal(r.type, 'synonym');
});
test('weight, custom synonym groups, quickMatch and prefilter', () => {
  assert.equal(ev('احتاج مساعدة', kw('احتاج مساعدة', { weight: 50 })).score, 50);
  const canon = buildCanon([['سيارة', 'عربية', 'مركبة']]);
  const k = compileKeyword({ id: 3, phrase: 'سيارة', match_modes: ['exact'], fuzzy_threshold: 82, context_mode: 'none', min_score: 60, weight: 100 }, [], canon);
  assert.ok(evaluateKeyword(analyze('بيع عربية', canon), k));
  assert.equal(quickMatch(analyze('هذا اعلان مزعج'), 'اعلان', 'contains').ok, true);
  assert.equal(quickMatch(analyze('هذا شيء'), 'اعلان', 'contains').ok, false);
  const forms = compileSignals(['من يساعدني في مشروع التخرج', 'عندي مشروع تخرج']);
  assert.ok(radarPrefilter(analyze('مين يقدر يساعدني بمشروع التخرج'), forms) >= 40);
  assert.ok(radarPrefilter(analyze('صباح الخير جميعا'), forms) < 30);
  assert.equal(evaluateKeywords(analyze('x'), [kw('احتاج')]).length, 0);
});
test('similarity / simhash', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3); assert.equal(similarity('abc', 'abc'), 1);
  assert.equal(squash('مساااعدة هههه'), 'مساعدةه');
  const a = analyze('احتاج مساعدة في مشروع التخرج اليوم من فضلكم يا اخوان'); const b = analyze('احتاج مساعدة في مشروع التخرج اليوم من فضلكم يا اخوة');
  const c = analyze('بيع سيارة مستعملة بحالة ممتازة للتواصل على الخاص');
  assert.ok(hamming(simhash(a.tokens), simhash(b.tokens)) < hamming(simhash(a.tokens), simhash(c.tokens)));
  assert.equal(fingerprint(analyze('أحتاج   مساعدة!!')).norm, fingerprint(analyze('احتاج مساعده')).norm);
  assert.notEqual(fingerprint(analyze('أحتاج   مساعدة!!')).exact, fingerprint(analyze('احتاج مساعده')).exact);
  assert.equal(detectLang('مرحبا بكم'), 'ar'); assert.equal(detectLang('hello there'), 'en');
});
test('priority levels', () => {
  assert.equal(computePriority({ score: 55 }).priority, 'low');
  assert.equal(computePriority({ score: 80 }).priority, 'medium');
  assert.equal(computePriority({ score: 100 }).priority, 'high');
  assert.equal(computePriority({ score: 100, aiConfidence: 95, sensitiveHits: 1 }).priority, 'critical');
  assert.equal(computePriority({ score: 100, sourceWeight: -20 }).priority, 'medium');
});
test('conditions: spec rule example + decision actions', () => {
  const analysis = analyze('محتاج مساعدة في مشروع تخرج');
  const ctx = { analysis, message: { text: 'x', lang: 'ar' }, source: { id: 5, kind: 'group' }, ai: [{ isMatch: true, confidence: 91, intent: 'Graduation Help' }], candidates: [], best: { score: 91 } };
  const cond = { all: [{ type: 'text', mode: 'partial', value: 'مشروع تخرج' }, { type: 'intent', value: 'graduation help' }, { type: 'confidence', gte: 80 }, { type: 'source', ids: [9], negate: true }] };
  assert.deepEqual(evalNode(cond, ctx), { ok: true, score: 100 });
  assert.equal(evalNode({ all: [...cond.all, { type: 'confidence', gte: 95 }] }, ctx).ok, false);
  assert.equal(evalNode({ any: [{ type: 'lang', in: ['en'] }, { type: 'lang', in: ['ar'] }] }, ctx).ok, true);
  assert.equal(evalNode({ not: { type: 'source', ids: [5] } }, ctx).ok, false);
  const d = applyDecisionActions([{ type: 'create_card', priority: 'high' }, { type: 'notify', channels: ['telegram'] }, { type: 'tag', tags: ['vip'] }], newDecision());
  assert.equal(d.create && d.priority === 'high' && d.forceChannels.has('telegram') && d.tags.has('vip'), true);
});
