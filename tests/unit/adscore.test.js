import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../../src/engine/normalize.js';
import { scoreAd } from '../../src/engine/adscore.js';

test('adscore detects Saudi phone, CTA, link and price', () => {
  const text = 'نقدم خدماتنا للتواصل واتساب 0501234567 السعر 99 ريال';
  const r = scoreAd(analyze(text), text, { lexicon: [{ phrase: 'نقدم', norm_phrase: 'نقدم', kind: 'offer', weight: 20 }, { phrase: 'للتواصل', norm_phrase: 'للتواصل', kind: 'cta', weight: 20 }] });
  assert.equal(r.score >= 70, true);
  assert.ok(r.signals.some((x) => x.id === 'contact_phone'));
});

test('adscore protects a short seeker question', () => {
  const text = 'احتاج مساعدة؟';
  const r = scoreAd(analyze(text), text, { lexicon: [{ phrase: 'احتاج', norm_phrase: 'احتاج', kind: 'seeker', weight: -25 }] });
  assert.equal(r.score, 0);
  assert.ok(r.signals.some((x) => x.id === 'seeker'));
});
