import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; process.env.DATABASE_URL ??= 'postgres://x'; process.env.MASTER_KEY ??= 'k'.repeat(40);
const { classifyMessageIntent, matchPreviousAdvertisement } = await import('../../src/engine/message-intent.js');
const { analyze } = await import('../../src/engine/normalize.js');
const { fingerprint } = await import('../../src/engine/dedupe.js');

test('classifies direct Arabic and dialect help requests as NEED_HELP', () => {
  for (const text of [
    'أحتاج مساعدة في مشروع التخرج',
    'ابي احد يساعدني في الواجب',
    'مين يشرح لي هذا الدرس؟',
    'ابحث عن مدرس يساعدني',
    'مطلوب تلخيص محاضرة الاقتصاد',
    'Can anyone help me with this project?',
  ]) assert.equal(classifyMessageIntent(text).label, 'NEED_HELP', text);
});

test('classifies explicit education-service promotion as ADVERTISEMENT', () => {
  for (const text of [
    'نقدم خدمات حل الواجبات ومشاريع التخرج، للتواصل واتساب',
    'نوفر لكم حل الاختبارات والبحوث الجامعية بأسعار مناسبة',
    'مكتبنا يقدم خدمات مشاريع التخرج والبحوث الجامعية، تواصل معنا',
    'مركزنا يقدم خدمات الواجبات والمشاريع للتواصل https://t.me/example أو 0501234567',
    'We offer homework and project completion services. Contact us for prices.',
  ]) assert.equal(classifyMessageIntent(text).label, 'ADVERTISEMENT', text);
});

test('keeps mixed, unrelated and weak evidence in UNCERTAIN', () => {
  for (const text of [
    'أحتاج مساعدة في مشروعي ونقدم خدمات للطلاب',
    'صباح الخير يا جماعة',
    'كان اختبار الاحصاء هذا الاسبوع صعبا',
    'هذا رابط المشروع https://example.test',
    'رقمي +966500000000',
    'السعر 50 ريال',
  ]) assert.equal(classifyMessageIntent(text).label, 'UNCERTAIN', text);
});

test('does not infer an ad from a contact detail attached to a help request', () => {
  assert.equal(classifyMessageIntent('احتاج مدرس يساعدني في مشروع، هذا رقمي 0501234567').label, 'NEED_HELP');
  assert.equal(classifyMessageIntent('محتاج مساعدة، راسلوني على https://t.me/example').label, 'NEED_HELP');
});

test('empty content remains reviewable', () => {
  assert.equal(classifyMessageIntent('').label, 'UNCERTAIN');
});

test('matches a cross-account ad repost after emoji, spacing and small wording changes', () => {
  const original = 'نقدم لكم خدمات حل واجبات الاحصاء ومشاريع التخرج باسعار ممتازة للتواصل واتساب 0501234567 مع ضمان التسليم في الوقت';
  const repost = 'نقدم لكم خدمة حل واجبات الاحصاء ومشاريع التخرج باسعار خاصة للتواصل عبر واتساب 0501234567 مع ضمان التسليم في الموعد 📲';
  const fp = fingerprint(analyze(original));
  const previous = [{ text: original, norm_hash: fp.norm, sh0: fp.bands[0], sh1: fp.bands[1], sh2: fp.bands[2], sh3: fp.bands[3] }];
  const result = matchPreviousAdvertisement(repost, previous);
  assert.ok(result); assert.ok(result.confidence >= 80); assert.match(result.reason, /إعلان سابق/);
});
