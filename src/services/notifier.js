// Multi-channel notifications. Dashboard rows are written immediately; Telegram/email go through the queue (idempotent).
import { one, query } from '../lib/db.js';
import { getSetting } from '../lib/settings.js';
import { publish } from '../lib/bus.js';
import { enqueue, Q } from '../lib/queue.js';
import { priorityAtLeast } from '../engine/priority.js';
import { CHANNELS } from '../engine/conditions.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { getTelegramManager } from '../telegram/registry.js';

const log = logger('notifier');
const SEV = { low: 'low', medium: 'medium', high: 'high', critical: 'critical' };

export async function channelPlan(priority, forced = new Set()) {
  const plan = {};
  for (const ch of CHANNELS) {
    const [en, min] = await Promise.all([getSetting(`notify.${ch}.enabled`), getSetting(`notify.${ch}.min_priority`)]);
    plan[ch] = (en && priorityAtLeast(priority, min)) || forced.has(ch);
  }
  return plan;
}

export function formatCardText(card, lang = 'ar') {
  const ar = lang === 'ar';
  const who = card.sender.username ? `@${card.sender.username}` : card.sender.name || card.sender.id;
  const lines = [
    `[${card.priority.toUpperCase()}] ${Math.round(card.score)}%${card.intent ? ` • ${card.intent}` : ''}`,
    `${ar ? 'المصدر' : 'Source'}: ${card.source.title ?? '-'} (${card.account.name ?? '-'})`,
    `${ar ? 'المستخدم' : 'User'}: ${who} [${card.sender.id ?? '-'}]`,
    `"${String(card.text ?? '').replace(/\s+/g, ' ').slice(0, 400)}"`,
  ];
  if (card.ai_reason) lines.push(`${ar ? 'السبب' : 'Reason'}: ${card.ai_reason}`);
  if (card.links.message) lines.push(card.links.message);
  return lines.join('\n');
}

async function insertRow({ channel, kind, severity, title, body, matchId = null, payload = {}, dedupeKey = null, status = 'pending' }) {
  return one(
    `INSERT INTO notifications (kind, severity, channel, title, body, match_id, payload, dedupe_key, status, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9 = 'sent' THEN now() END)
     ON CONFLICT (dedupe_key, channel) DO NOTHING RETURNING id`,
    [kind, severity, channel, title, body, matchId, JSON.stringify(payload), dedupeKey, status],
  );
}

/** Creates the notification rows for a freshly created card. Returns the channel plan used. */
export async function notifyMatch(card, forced = new Set(), { onlyForced = false } = {}) {
  const lang = await getSetting('language.default');
  const plan = onlyForced ? Object.fromEntries(CHANNELS.map((c) => [c, forced.has(c)])) : await channelPlan(card.priority, forced);
  const title = `${card.priority.toUpperCase()} ${Math.round(card.score)}% — ${card.intent ?? card.keyword ?? 'match'}`;
  const body = formatCardText(card, lang);
  if (plan.dashboard) {
    const r = await insertRow({ channel: 'dashboard', kind: 'match', severity: SEV[card.priority], title, body, matchId: card.id, dedupeKey: `match:${card.id}`, status: 'sent', payload: { priority: card.priority } });
    if (r) await publish('alert.new', { id: r.id });
  }
  for (const ch of ['telegram', 'email']) {
    if (!plan[ch]) continue;
    const r = await insertRow({ channel: ch, kind: 'match', severity: SEV[card.priority], title, body, matchId: card.id, dedupeKey: `match:${card.id}`, payload: { priority: card.priority } });
    if (r) await enqueue(Q.notify, 'send', { id: r.id }, { jobId: `n-${r.id}` });
  }
  return plan;
}

/** System / automation alerts (dashboard row + optional external channels). */
export async function createAlert({ title, body = '', severity = 'info', kind = 'system', dedupeKey = null, payload = {}, channels = [] }) {
  const r = await insertRow({ channel: 'dashboard', kind, severity, title, body, dedupeKey, payload, status: 'sent' });
  if (r) await publish('alert.new', { id: r.id });
  for (const ch of channels.filter((c) => ['telegram', 'email'].includes(c))) {
    const x = await insertRow({ channel: ch, kind, severity, title, body, dedupeKey, payload });
    if (x) await enqueue(Q.notify, 'send', { id: x.id }, { jobId: `n-${x.id}` });
  }
  return r?.id ?? null;
}

async function sendTelegram(n) {
  const text = `${n.title}\n${n.body ?? ''}`.slice(0, 4000);
  const via = await getSetting('notify.telegram.via');
  if (via === 'account') {
    const mgr = getTelegramManager(); const accId = await getSetting('notify.telegram.account_id');
    if (!mgr || !accId) throw new AppError('TELEGRAM_UNAVAILABLE', { status: 503, message: 'account mode needs the telegram worker in the same process' });
    return mgr.sendToSelf(accId, text);
  }
  const [token, chat] = await Promise.all([getSetting('notify.telegram.bot_token'), getSetting('notify.telegram.chat_id')]);
  if (!token || !chat) throw new AppError('TELEGRAM_UNAVAILABLE', { status: 409, message: 'bot token / chat id not configured' });
  const base = process.env.TELEGRAM_BOT_API_BASE || 'https://api.telegram.org';
  const res = await fetch(`${base}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`telegram bot api ${res.status}: ${(await res.text()).slice(0, 160).replace(token, '***')}`);
}
async function sendEmail(n) {
  const [host, port, secure, user, pass, from, to] = await Promise.all(['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'from', 'to'].map((k) => getSetting(`notify.email.${k}`)));
  if (!host || !to) throw new AppError('VALIDATION', { status: 409, message: 'SMTP host / recipient not configured' });
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined, connectionTimeout: 15000 });
  await t.sendMail({ from: from || user || 'nabd-ai@localhost', to, subject: `[NABD AI] ${n.title}`, text: n.body ?? '' });
}

/** Queue handler. Throws on failure so BullMQ retries with backoff; marks failed only on the final attempt. */
export async function sendNotification(id, { final = false } = {}) {
  const n = await one('SELECT * FROM notifications WHERE id = $1', [id]);
  if (!n || n.status === 'sent' || n.status === 'read') return 'skipped';
  try {
    if (n.channel === 'telegram') await sendTelegram(n); else if (n.channel === 'email') await sendEmail(n); else return 'skipped';
    await query("UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, error = NULL WHERE id = $1", [id]);
    return 'sent';
  } catch (e) {
    await query('UPDATE notifications SET attempts = attempts + 1, error = $2, status = $3 WHERE id = $1', [id, String(e.message).slice(0, 300), final ? 'failed' : 'pending']);
    log.warn('notification send failed', { id, channel: n.channel, err: e.message });
    throw e;
  }
}
