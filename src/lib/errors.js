// Typed application errors + bilingual, human-readable messages (never a bare "Error 500").
import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(code, { status = 400, details, cause, message } = {}) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.cause = cause;
  }
}
export const newErrorId = () => 'E-' + crypto.randomBytes(4).toString('hex').toUpperCase();

const M = (en, ar) => ({ en, ar });
export const MESSAGES = {
  VALIDATION: M('Some fields are invalid.', 'بعض الحقول غير صالحة.'),
  UNAUTHENTICATED: M('Please sign in to continue.', 'يرجى تسجيل الدخول للمتابعة.'),
  FORBIDDEN: M('You do not have permission for this action.', 'ليست لديك صلاحية لتنفيذ هذا الإجراء.'),
  NOT_FOUND: M('The requested item was not found.', 'العنصر المطلوب غير موجود.'),
  CONFLICT: M('This item already exists or conflicts with another.', 'هذا العنصر موجود مسبقًا أو يتعارض مع عنصر آخر.'),
  BAD_STATE: M('This action is not allowed in the current state.', 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية.'),
  RATE_LIMITED: M('Too many requests. Please wait a moment and retry.', 'عدد الطلبات كبير. انتظر قليلًا ثم أعد المحاولة.'),
  CSRF: M('Security token missing or expired. Reload the page.', 'رمز الأمان مفقود أو منتهي. أعد تحميل الصفحة.'),
  REAUTH_REQUIRED: M('Confirm your password to continue.', 'أكّد كلمة المرور للمتابعة.'),
  INVALID_CREDENTIALS: M('Wrong username or password.', 'اسم المستخدم أو كلمة المرور غير صحيحة.'),
  ACCOUNT_LOCKED: M('Too many failed attempts. Try again later.', 'محاولات فاشلة كثيرة. حاول لاحقًا.'),
  SETUP_DONE: M('Initial setup is already complete.', 'اكتمل الإعداد الأولي مسبقًا.'),
  TELEGRAM_UNAVAILABLE: M('An error occurred while connecting to Telegram.', 'حدث خطأ أثناء الاتصال بخدمة Telegram.'),
  TELEGRAM_AUTH: M('Telegram rejected the account session. Sign in again.', 'رفض Telegram جلسة الحساب. سجّل الدخول من جديد.'),
  TELEGRAM_CODE_INVALID: M('The Telegram login code is wrong.', 'كود تسجيل الدخول من Telegram غير صحيح.'),
  TELEGRAM_CODE_EXPIRED: M('The Telegram login code expired. Request a new one.', 'انتهت صلاحية الكود. اطلب كودًا جديدًا.'),
  TELEGRAM_PASSWORD_INVALID: M('The two-step verification password is wrong.', 'كلمة مرور التحقق بخطوتين غير صحيحة.'),
  TELEGRAM_FLOOD: M('Telegram asked us to slow down. Retrying automatically later.', 'طلب Telegram تخفيف الطلبات. ستتم إعادة المحاولة تلقائيًا لاحقًا.'),
  TELEGRAM_LOGIN_EXPIRED: M('The login session expired. Start again.', 'انتهت جلسة تسجيل الدخول. ابدأ من جديد.'),
  SESSION_INVALID: M('The provided Telegram session is invalid.', 'جلسة Telegram المُدخلة غير صالحة.'),
  AI_UNAVAILABLE: M('The AI service is unavailable right now.', 'خدمة الذكاء الاصطناعي غير متاحة حاليًا.'),
  AI_NOT_CONFIGURED: M('No AI provider is configured. Add one in AI Settings.', 'لم يتم إعداد مزود ذكاء اصطناعي. أضفه من إعدادات الذكاء الاصطناعي.'),
  DB_UNAVAILABLE: M('The database is unavailable.', 'قاعدة البيانات غير متاحة.'),
  QUEUE_UNAVAILABLE: M('The queue (Redis) is unavailable. Work continues in degraded mode.', 'الطابور (Redis) غير متاح. يعمل النظام بوضع محدود.'),
  WORKER_OFFLINE: M('No worker process is online. Start it with scripts/start.sh.', 'لا توجد عملية Worker تعمل. شغّلها عبر scripts/start.sh.'),
  SYSTEM_PAUSED: M('The system is paused. Resume it to continue.', 'النظام متوقف مؤقتًا. شغّله مرة أخرى للمتابعة.'),
  INTERNAL: M('Something went wrong on our side. Use the error ID when reporting it.', 'حدث خطأ غير متوقع. استخدم رقم الخطأ عند الإبلاغ عنه.'),
};

export function errorBody(err, id) {
  const code = err?.code && MESSAGES[err.code] ? err.code : 'INTERNAL';
  const m = MESSAGES[code];
  const expose = ['VALIDATION', 'CONFLICT', 'BAD_STATE', 'NOT_FOUND', 'TELEGRAM_FLOOD'].includes(code) || err?.expose;
  return {
    error: {
      code, id, message: m.en, message_ar: m.ar, message_en: m.en,
      ...(err?.details !== undefined ? { details: err.details } : {}),
      ...(expose && err?.message && err.message !== err.code ? { detail: String(err.message).slice(0, 300) } : {}),
    },
  };
}
