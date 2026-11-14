// Typed settings registry. Secrets are AES-GCM encrypted at rest and never leave the server.
import { query } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { AppError } from './errors.js';

const S = (group, def, o = {}) => ({ group, def, type: o.type ?? (Array.isArray(def) ? 'array' : typeof def), secret: !!o.secret, options: o.options, min: o.min, max: o.max });
const PRI = ['low', 'medium', 'high', 'critical'];

export const REGISTRY = {
  'general.app_name': S('general', 'NABD AI'),
  'general.setup_complete': S('general', false),
  'general.timezone': S('general', 'UTC'),
  'language.default': S('language', 'ar', { options: ['ar', 'en'] }),
  'appearance.theme': S('appearance', 'dark', { options: ['dark', 'light'] }),
  'appearance.density': S('appearance', 'comfortable', { options: ['comfortable', 'compact'] }),
  'telegram.autostart_accounts': S('telegram', true),
  // New sources on every account inherit the automatic monitoring policy by default.
  'telegram.auto_monitor_new_sources': S('telegram', true),
  'telegram.reconnect_max_attempts': S('telegram', 8, { min: 1, max: 50 }),
  'telegram.reconnect_base_ms': S('telegram', 5000, { min: 500, max: 600000 }),
  'telegram.ping_interval_s': S('telegram', 60, { min: 10, max: 600 }),
  'telegram.catchup_per_source': S('telegram', 50, { min: 0, max: 500 }),
  'telegram.catchup_delay_ms': S('telegram', 1500, { min: 100, max: 30000 }),
  'ai.primary': S('ai', '', { options: ['', 'gemini', 'openai', 'anthropic', 'local', 'custom', 'grok'] }),
  'ai.fallback': S('ai', '', { options: ['', 'gemini', 'openai', 'anthropic', 'local', 'custom', 'grok'] }),
  'ai.failover_enabled': S('ai', true),
  'ai.semantic_enabled': S('ai', true),
  'ai.intent_enabled': S('ai', true),
  'ai.classification_enabled': S('ai', true),
  'ai.summarization_enabled': S('ai', false),
  'ai.requests_per_minute': S('ai', 30, { min: 1, max: 6000 }),
  'ai.concurrency': S('ai', 2, { min: 1, max: 16 }),
  'ai.min_chars': S('ai', 6, { min: 1, max: 200 }),
  'ai.max_chars': S('ai', 1500, { min: 100, max: 8000 }),
  'ai.breaker_threshold': S('ai', 5, { min: 1, max: 50 }),
  'ai.breaker_cooldown_s': S('ai', 60, { min: 5, max: 3600 }),
  'notify.dashboard.enabled': S('notifications', true),
  'notify.dashboard.min_priority': S('notifications', 'low', { options: PRI }),
  'notify.browser.enabled': S('notifications', true),
  'notify.browser.min_priority': S('notifications', 'high', { options: PRI }),
  'notify.sound.enabled': S('notifications', true),
  'notify.sound.min_priority': S('notifications', 'high', { options: PRI }),
  'notify.telegram.enabled': S('notifications', false),
  'notify.telegram.min_priority': S('notifications', 'high', { options: PRI }),
  'notify.telegram.via': S('notifications', 'bot', { options: ['bot', 'account'] }),
  'notify.telegram.bot_token': S('notifications', '', { secret: true }),
  'notify.telegram.chat_id': S('notifications', ''),
  'notify.telegram.account_id': S('notifications', 0, { min: 0 }),
  'notify.email.enabled': S('notifications', false),
  'notify.email.min_priority': S('notifications', 'critical', { options: PRI }),
  'notify.email.to': S('notifications', ''),
  'notify.email.from': S('notifications', ''),
  'notify.email.smtp_host': S('notifications', ''),
  'notify.email.smtp_port': S('notifications', 587, { min: 1, max: 65535 }),
  'notify.email.smtp_secure': S('notifications', false),
  'notify.email.smtp_user': S('notifications', ''),
  'notify.email.smtp_pass': S('notifications', '', { secret: true }),
  'security.session_ttl_hours': S('security', 168, { min: 1, max: 24 * 90 }),
  'security.max_failed_logins': S('security', 5, { min: 3, max: 50 }),
  'security.lockout_minutes': S('security', 15, { min: 1, max: 1440 }),
  'security.password_min_length': S('security', 10, { min: 8, max: 128 }),
  'security.rate_limit_per_min': S('security', 600, { min: 30, max: 100000 }),
  'security.login_rate_limit_per_min': S('security', 10, { min: 3, max: 1000 }),
  'database.size_limit_mb': S('database', 0, { min: 0 }),
  'database.emergency_active': S('database', false),
  'database.emergency_pause_ingest': S('database', true),
  'database.monitor_interval_s': S('database', 60, { min: 10, max: 3600 }),
  'database.cleanup_enabled': S('database', true),
  // Retain unmatched messages for 24 hours before the existing soft-delete flow.
  'database.retention_unmatched_days': S('database', 1, { min: 1, max: 3650 }),
  'database.purge_grace_days': S('database', 7, { min: 1, max: 365 }),
  'database.retention_logs_days': S('database', 30, { min: 1, max: 3650 }),
  'database.retention_notifications_days': S('database', 60, { min: 1, max: 3650 }),
  'workers.heartbeat_s': S('workers', 5, { min: 2, max: 60 }),
  'system.paused': S('workers', false),
  'workers.concurrency_process': S('workers', 4, { min: 1, max: 64 }),
  'workers.concurrency_keyword': S('workers', 4, { min: 1, max: 64 }),
  'workers.concurrency_notify': S('workers', 4, { min: 1, max: 64 }),
  'queue.attempts': S('queue', 5, { min: 1, max: 20 }),
  'queue.backoff_ms': S('queue', 3000, { min: 100, max: 600000 }),
  'queue.keep_completed': S('queue', 500, { min: 0, max: 100000 }),
  'queue.keep_failed': S('queue', 2000, { min: 0, max: 100000 }),
  'processing.paused': S('queue', false),
  'radar.default_min_score': S('radar', 70, { min: 0, max: 100 }),
  'radar.few_shot_examples': S('radar', 6, { min: 0, max: 20 }),
  'radar.suggestions_min_hits': S('radar', 2, { min: 1, max: 100 }),
  'radar.prefilter_threshold': S('radar', 0.3, { min: 0, max: 1 }),
  'dedupe.scope': S('radar', 'normal', { options: ['strict', 'normal', 'aggressive'] }),
  'dedupe.window_hours': S('radar', 24, { min: 1, max: 720 }),
  'dedupe.simhash_distance': S('radar', 3, { min: 0, max: 8 }),
  'dedupe.similarity': S('radar', 0.9, { min: 0.5, max: 1 }),
  'priority.sensitive_words': S('radar', []),
  'priority.medium': S('radar', 60, { min: 1, max: 100 }),
  'priority.high': S('radar', 80, { min: 1, max: 120 }),
  'priority.critical': S('radar', 95, { min: 1, max: 140 }),
  'keywords.fuzzy_threshold': S('keywords', 0.82, { min: 0.5, max: 1 }),
  'keywords.context_penalty': S('keywords', 25, { min: 0, max: 100 }),
  'keywords.min_context_tokens': S('keywords', 1, { min: 1, max: 10 }),
  'keywords.custom_synonyms': S('keywords', []),
  'backup.enabled': S('backup', true),
  'backup.interval_hours': S('backup', 24, { min: 1, max: 720 }),
  'backup.keep': S('backup', 7, { min: 1, max: 100 }),
  'logs.level': S('logs', 'info', { options: ['debug', 'info', 'warning', 'error', 'critical'] }),
  'logs.db_level': S('logs', 'warning', { options: ['debug', 'info', 'warning', 'error', 'critical'] }),
  'logs.retention_days': S('logs', 30, { min: 1, max: 3650 }),
};

let cache = null; let cacheAt = 0;
async function load() {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  try {
    const rows = (await query('SELECT key, value FROM settings')).rows;
    cache = new Map(rows.map((r) => [r.key, r.value])); cacheAt = Date.now();
  } catch { cache ??= new Map(); }
  return cache;
}
export const invalidateSettings = () => { cache = null; };

function coerce(key, reg, value) {
  const bad = (m) => new AppError('VALIDATION', { details: [{ path: [key], message: m }] });
  if (reg.type === 'boolean') { if (typeof value !== 'boolean') throw bad('must be boolean'); return value; }
  if (reg.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw bad('must be a number');
    if (reg.min !== undefined && n < reg.min) throw bad(`min ${reg.min}`);
    if (reg.max !== undefined && n > reg.max) throw bad(`max ${reg.max}`);
    return n;
  }
  if (reg.type === 'array') { if (!Array.isArray(value)) throw bad('must be a list'); return value.slice(0, 500); }
  const s = String(value ?? '');
  if (reg.options && !reg.options.includes(s)) throw bad(`one of: ${reg.options.join(', ')}`);
  if (s.length > 2000) throw bad('too long');
  return s;
}

export async function getSetting(key) {
  const reg = REGISTRY[key];
  if (!reg) throw new Error(`unknown setting ${key}`);
  const v = (await load()).get(key);
  if (v === undefined) return reg.def;
  if (reg.secret) { try { return v ? decrypt(v) : ''; } catch { return ''; } }
  return v;
}
export async function getSettings(prefix) {
  const out = {};
  for (const key of Object.keys(REGISTRY)) if (key.startsWith(prefix)) out[key.slice(prefix.length)] = await getSetting(key);
  return out;
}
export async function setSetting(key, value, userId = null) {
  const reg = REGISTRY[key];
  if (!reg) throw new AppError('VALIDATION', { details: [{ path: [key], message: 'unknown setting' }] });
  let v = coerce(key, reg, value);
  if (reg.secret) v = v ? encrypt(v) : '';
  await query(
    `INSERT INTO settings (key, value, is_secret, updated_by) VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(v), reg.secret, userId],
  );
  invalidateSettings();
}
/** UI-safe view: secrets are reported as {set: boolean}, never as values. */
export async function publicSettings() {
  const c = await load(); const out = {};
  for (const [key, reg] of Object.entries(REGISTRY)) {
    const raw = c.get(key);
    out[key] = { group: reg.group, type: reg.type, options: reg.options, min: reg.min, max: reg.max, secret: reg.secret, value: reg.secret ? { set: !!raw } : (raw === undefined ? reg.def : raw), default: reg.secret ? undefined : reg.def };
  }
  return out;
}
