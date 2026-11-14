// Generic settings editor rendered from the server-side registry (types, ranges, options, secrets).
import { h } from './dom.js';
import { t, getLang } from './i18n.js';
import { put } from './api.js';
import { form, btn, toast, showError } from './ui.js';

const AR = {
  'general.app_name': 'اسم التطبيق', 'general.timezone': 'المنطقة الزمنية', 'language.default': 'اللغة الافتراضية', 'appearance.theme': 'السمة الافتراضية', 'appearance.density': 'كثافة العرض',
  'telegram.autostart_accounts': 'تشغيل الحسابات تلقائيًا', 'telegram.auto_monitor_new_sources': 'مراقبة كل أنواع المصادر الجديدة تلقائيًا (بما فيها الخاصة والمحفوظه)', 'telegram.reconnect_max_attempts': 'أقصى محاولات إعادة الاتصال', 'telegram.reconnect_base_ms': 'تأخير إعادة الاتصال الأساسي (مللي ثانية)', 'telegram.ping_interval_s': 'فاصل فحص الاتصال (ثانية)', 'telegram.catchup_per_source': 'رسائل التعويض لكل مصدر بعد الانقطاع', 'telegram.catchup_delay_ms': 'تأخير بين طلبات التعويض (مللي ثانية)',
  'ai.primary': 'المزود الأساسي', 'ai.fallback': 'المزود الاحتياطي', 'ai.failover_enabled': 'تحويل تلقائي عند الفشل', 'ai.semantic_enabled': 'تفعيل المطابقة الدلالية', 'ai.intent_enabled': 'تفعيل اكتشاف النية', 'ai.classification_enabled': 'تفعيل تصنيف الرسائل', 'ai.summarization_enabled': 'تفعيل التلخيص', 'ai.requests_per_minute': 'الحد الأقصى للطلبات في الدقيقة', 'ai.concurrency': 'عدد الطلبات المتزامنة', 'ai.min_chars': 'أقل طول رسالة للتحليل', 'ai.max_chars': 'أقصى طول يُرسل للنموذج', 'ai.breaker_threshold': 'أخطاء متتالية قبل فتح القاطع', 'ai.breaker_cooldown_s': 'مدة التبريد (ثانية)',
  'notify.dashboard.enabled': 'تنبيهات لوحة التحكم', 'notify.dashboard.min_priority': 'أدنى أولوية — اللوحة', 'notify.browser.enabled': 'إشعارات المتصفح', 'notify.browser.min_priority': 'أدنى أولوية — المتصفح', 'notify.sound.enabled': 'تنبيه صوتي', 'notify.sound.min_priority': 'أدنى أولوية — الصوت', 'notify.telegram.enabled': 'إشعارات Telegram', 'notify.telegram.min_priority': 'أدنى أولوية — Telegram', 'notify.telegram.via': 'الإرسال عبر', 'notify.telegram.bot_token': 'رمز بوت Telegram', 'notify.telegram.chat_id': 'معرّف المحادثة', 'notify.telegram.account_id': 'رقم الحساب (للإرسال إلى الرسائل المحفوظة)',
  'notify.email.enabled': 'إشعارات البريد', 'notify.email.min_priority': 'أدنى أولوية — البريد', 'notify.email.to': 'المستلم', 'notify.email.from': 'المرسل', 'notify.email.smtp_host': 'خادم SMTP', 'notify.email.smtp_port': 'منفذ SMTP', 'notify.email.smtp_secure': 'اتصال آمن (TLS)', 'notify.email.smtp_user': 'مستخدم SMTP', 'notify.email.smtp_pass': 'كلمة مرور SMTP',
  'security.session_ttl_hours': 'مدة الجلسة (ساعات)', 'security.max_failed_logins': 'محاولات الدخول الفاشلة قبل القفل', 'security.lockout_minutes': 'مدة القفل (دقائق)', 'security.password_min_length': 'أقل طول لكلمة المرور', 'security.rate_limit_per_min': 'حد الطلبات في الدقيقة', 'security.login_rate_limit_per_min': 'حد محاولات الدخول في الدقيقة',
  'database.size_limit_mb': 'حد حجم قاعدة البيانات (ميغابايت، 0 = تلقائي)', 'database.emergency_active': 'وضع الطوارئ مفعّل', 'database.emergency_pause_ingest': 'إيقاف الاستقبال في وضع الطوارئ', 'database.monitor_interval_s': 'فاصل فحص القاعدة (ثانية)', 'database.cleanup_enabled': 'تفعيل التنظيف الدوري الآمن', 'database.retention_unmatched_days': 'أيام الاحتفاظ بالرسائل غير المطابقة', 'database.purge_grace_days': 'أيام السماح قبل الإزالة النهائية', 'database.retention_logs_days': 'أيام الاحتفاظ بالسجلات', 'database.retention_notifications_days': 'أيام الاحتفاظ بالإشعارات',
  'workers.heartbeat_s': 'فاصل نبض العمّال (ثانية)', 'workers.concurrency_process': 'تزامن المعالج', 'workers.concurrency_keyword': 'تزامن الكلمات', 'workers.concurrency_notify': 'تزامن الإشعارات', 'queue.attempts': 'محاولات المهمة', 'queue.backoff_ms': 'تأخير المحاولة (مللي ثانية)', 'queue.keep_completed': 'عدد المهام المكتملة المحفوظة', 'queue.keep_failed': 'عدد المهام الفاشلة المحفوظة', 'processing.paused': 'إيقاف المعالجة',
  'radar.default_min_score': 'الحد الأدنى الافتراضي للتطابق', 'radar.few_shot_examples': 'عدد الأمثلة المرسلة للنموذج', 'radar.suggestions_min_hits': 'أقل تكرار لإظهار الاقتراح', 'radar.prefilter_threshold': 'عتبة الفلترة المحلية قبل الذكاء الاصطناعي (0–1)', 'dedupe.scope': 'نطاق منع التكرار', 'dedupe.window_hours': 'نافذة التكرار (ساعات)', 'dedupe.simhash_distance': 'مسافة التشابه (SimHash)', 'dedupe.similarity': 'نسبة التشابه النصي', 'priority.sensitive_words': 'كلمات حساسة (ترفع الأولوية)', 'priority.medium': 'عتبة المتوسطة', 'priority.high': 'عتبة العالية', 'priority.critical': 'عتبة الحرجة',
  'keywords.fuzzy_threshold': 'حد التقريب الافتراضي', 'keywords.context_penalty': 'خصم غياب السياق %', 'keywords.min_context_tokens': 'أقل عدد كلمات للسياق', 'keywords.custom_synonyms': 'مجموعات مرادفات (كلمات مفصولة بفواصل، الأولى هي الأساس)',
  'backup.enabled': 'نسخ احتياطي مجدول', 'backup.interval_hours': 'فاصل النسخ (ساعات)', 'backup.keep': 'عدد النسخ المحفوظة', 'logs.level': 'مستوى السجل (الطرفية)', 'logs.db_level': 'مستوى السجل (قاعدة البيانات)', 'logs.retention_days': 'أيام الاحتفاظ بالسجلات',
};
const human = (k) => k.split('.').slice(1).join(' ').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const labelFor = (k) => (getLang() === 'ar' ? AR[k] ?? human(k) : human(k));

export function settingsEditor(reg, keys, { readOnly = false, onSaved, extra } = {}) {
  const fields = []; const init = {};
  for (const k of keys) {
    const m = reg[k]; if (!m) continue; const label = labelFor(k);
    if (m.secret) { fields.push({ key: k, label, type: 'password', placeholder: m.value?.set ? t('saved — leave empty to keep') : '', dir: 'ltr' }); if (m.value?.set) fields.push({ key: `__clear.${k}`, label: `${t('Delete')}: ${label}`, type: 'toggle' }); init[k] = ''; continue; }
    const v = m.value; init[k] = v;
    if (m.type === 'boolean') fields.push({ key: k, label, type: 'toggle', value: v });
    else if (m.type === 'number') fields.push({ key: k, label, type: 'number', min: m.min, max: m.max, step: m.max <= 1 ? 0.05 : 1, value: v, dir: 'ltr' });
    else if (m.type === 'array') fields.push({ key: k, label, type: 'lines', rows: 3, value: v });
    else if (m.options) fields.push({ key: k, label, type: 'select', options: m.options.map((o) => ({ value: o, label: o || '—' })), value: v });
    else fields.push({ key: k, label, type: 'text', value: v });
  }
  const f = form(fields, init); f.el.classList.add('grid', 'g2'); f.el.style.display = 'grid';
  if (readOnly) f.el.querySelectorAll('input,select,textarea').forEach((e) => { e.disabled = true; });
  const save = btn(t('Save changes'), async () => {
    const v = f.get(); const values = {};
    for (const k of keys) { if (!reg[k]) continue; const m = reg[k];
      if (m.secret) { if (v[`__clear.${k}`]) values[k] = ''; else if (v[k]) values[k] = v[k]; continue; }
      const cur = v[k]; if (m.type === 'number' && (cur === undefined || Number.isNaN(cur))) continue; if (JSON.stringify(cur) !== JSON.stringify(init[k])) values[k] = cur; }
    if (!Object.keys(values).length) return toast(t('Saved.'));
    try { await put('/settings', { values }); toast(t('Saved.')); onSaved?.(values); } catch (e) { showError(e); }
  }, { kind: 'primary', ic: 'save' });
  return { el: h('div', { class: 'stack' }, f.el, extra, !readOnly && h('div', null, save)), form: f };
}
