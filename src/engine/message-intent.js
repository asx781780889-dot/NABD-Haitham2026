import { analyze, normalizeText } from './normalize.js';
import { bandDistance, fingerprint, textSimilarity } from './dedupe.js';

export const MESSAGE_INTENTS = Object.freeze(['NEED_HELP', 'ADVERTISEMENT', 'UNCERTAIN']);

/** Match against previously confirmed/classified ads across senders; only strong text similarity is decisive. */
export function matchPreviousAdvertisement(text, previousAds, { threshold = 0.82 } = {}) {
  const current = analyze(text); if (current.norm.length < 24 || current.tokens.length < 4) return null;
  const fp = fingerprint(current);
  for (const ad of previousAds) {
    const prior = normalizeText(ad.text ?? ''); if (prior.length < 24) continue;
    if (ad.norm_hash === fp.norm || prior === current.norm) return { confidence: 99, reason: 'تطابق مع إعلان سابق مصنف.' };
    if (Math.min(prior.length, current.norm.length) < 60) continue;
    const distance = ad.sh0 == null ? null : bandDistance([ad.sh0, ad.sh1, ad.sh2, ad.sh3], fp.h);
    const similarity = Number.isFinite(Number(ad.sim_score)) ? Number(ad.sim_score) : textSimilarity(current.norm, prior);
    if ((distance != null && distance <= 3 && similarity >= threshold * 0.9) || similarity >= Math.min(0.97, threshold + 0.02)) {
      return { confidence: Math.min(99, Math.round(similarity * 100)), reason: 'تشابه قوي مع إعلان سابق مصنف؛ أُستبعد التكرار عبر الحسابات.' };
    }
  }
  return null;
}

const HELP_PHRASES = [
  'احتاج مساعدة', 'محتاج مساعدة', 'محتاجه مساعدة', 'ابي مساعدة', 'ابغى مساعدة', 'اريد مساعدة',
  'ابحث عن مساعدة', 'ادور على مساعدة', 'ابحث عن مدرس', 'ابحث عن معلم', 'ابحث عن متخصص', 'ابحث عن شخص', 'من يساعدني', 'احد يساعدني', 'احد يقدر يساعدني',
  'مين يساعدني', 'مين يشرح', 'ممكن تساعدوني', 'مطلوب مساعدة', 'مطلوب شرح', 'مطلوب تلخيص', 'ساعدوني', 'ساعدني', 'هل يوجد من يساعد',
  'looking for help', 'need help', 'can anyone help', 'please help', 'looking for someone', 'need someone',
];
const WANTS_SERVICE = ['احتاج', 'محتاج', 'محتاجه', 'ابي', 'ابغى', 'ابغا', 'اريد', 'ابحث عن', 'ادور على'];
const OFFER_PHRASES = [
  'نقدم', 'نوفر', 'يقدم', 'يقدم لكم', 'تقدم', 'تقدم لكم', 'مكتبنا يقدم', 'مركزنا يقدم', 'خدماتنا', 'خدمتنا', 'اقدم', 'اقدم لكم', 'نقدم لكم', 'نوفر لكم',
  'ننجز', 'نحل', 'حل الواجبات', 'حل الاختبارات', 'حل مشاريع', 'حل البحوث', 'نساعدكم',
  'عندنا فريق', 'متوفر لدينا', 'متاح لدينا', 'we offer', 'we provide', 'our services',
  'we can do', 'we solve', 'professional service',
];
const ACADEMIC_SERVICE_PHRASES = [
  'واجب', 'واجبات', 'هومورك', 'homework', 'assignment', 'اختبار', 'اختبارات', 'امتحان',
  'مشروع', 'مشاريع', 'تخرج', 'بحث', 'بحوث', 'رساله', 'رسائل', 'تقرير', 'تقارير',
  'حل', 'حلول', 'شرح', 'تلخيص', 'ملخص', 'ملفات', 'محاضرات', 'محاضره', 'مادة', 'مواد', 'ماجستير', 'دكتوراه',
  'مدرس', 'معلم', 'متخصص', 'خدمة', 'خدمات', 'تقنية', 'تقني', 'برمجة', 'ترجمة', 'تصميم', 'عرض تقديمي', 'عروض تقديمية',
  'power bi', 'excel', 'thesis', 'project', 'report', 'exam', 'coursework', 'academic', 'technical', 'presentation',
];
const hasAnyPhrase = (text, phrases) => phrases.some((phrase) => {
  const normalized = normalizeText(phrase); const padded = ` ${text} `;
  return padded.includes(` ${normalized} `) || (!normalized.includes(' ') && padded.includes(` و${normalized} `));
});
const result = (label, confidence, reason, method = 'rules') => ({ label, confidence, reason, method });

/** Conservative local pre-classifier. Mixed intent and weak evidence stay reviewable. */
export function classifyMessageIntent(text) {
  const norm = normalizeText(text);
  if (!norm) return result('UNCERTAIN', 0, 'لا يوجد نص كافٍ للتصنيف.');

  const serviceContext = hasAnyPhrase(norm, ACADEMIC_SERVICE_PHRASES);
  const asksForHelp = hasAnyPhrase(norm, HELP_PHRASES) || (serviceContext && hasAnyPhrase(norm, WANTS_SERVICE));
  const offersService = hasAnyPhrase(norm, OFFER_PHRASES);

  // A link, phone number, or price without an explicit service offer is not an ad.
  if (asksForHelp && offersService) {
    return result('UNCERTAIN', 52, 'تتضمن الرسالة طلبًا وعرضًا معًا؛ يلزم التحقق من السياق.');
  }
  if (offersService && serviceContext) {
    return result('ADVERTISEMENT', 91, 'صياغة عرض خدمة واضحة في سياق تعليمي.');
  }
  if (asksForHelp) {
    return result('NEED_HELP', 89, 'صياغة مباشرة لطلب المساعدة أو البحث عن شخص يقدّمها.');
  }
  if (/(?:https?:\/\/|www\.|t\.me\/|\b\+?\d[\d ()-]{6,}\d\b)/iu.test(String(text ?? '')) && !offersService) {
    return result('UNCERTAIN', 45, 'وجود رابط أو رقم اتصال وحده لا يثبت وجود إعلان أو طلب مساعدة.');
  }
  return result('UNCERTAIN', 35, 'لا توجد إشارة سياقية كافية لطلب مساعدة أو عرض خدمة.');
}
