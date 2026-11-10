// Interactive Telegram login (code -> optional 2FA password). Temporary clients live only in memory and expire after 10 minutes.
import { createTelegramClient, mapTelegramError } from './adapter.js';
import { loadAccountSecrets, storeSession } from '../services/accounts.js';
import { query } from '../lib/db.js';
import { sendControl, publish } from '../lib/bus.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const log = logger('tg-login');
const TTL_MS = 10 * 60 * 1000;
const flows = new Map();
setInterval(() => { for (const [id, f] of flows) if (Date.now() - f.createdAt > TTL_MS) closeFlow(id); }, 30000).unref();

export async function closeFlow(accountId) {
  const f = flows.get(accountId); flows.delete(accountId);
  if (f) { try { await f.adapter.disconnect(); } catch { /* ignore */ } }
}
export const hasFlow = (id) => flows.has(id);

export async function startLogin(accountId) {
  const acc = await loadAccountSecrets(accountId);
  if (!acc) throw new AppError('NOT_FOUND', { status: 404 });
  await closeFlow(accountId);
  const adapter = createTelegramClient({ apiId: acc.apiId, apiHash: acc.apiHash, sessionString: '' });
  try {
    await adapter.connect();
    const { phoneCodeHash, isCodeViaApp } = await adapter.sendCode(acc.phone);
    flows.set(accountId, { adapter, phone: acc.phone, hash: phoneCodeHash, step: 'code', createdAt: Date.now() });
    return { step: 'code', via: isCodeViaApp ? 'app' : 'sms', expires_in: TTL_MS / 1000 };
  } catch (e) { try { await adapter.disconnect(); } catch { /* ignore */ } throw mapTelegramError(e); }
}

async function finish(accountId, adapter) {
  const session = adapter.saveSession(); const me = await adapter.getMe();
  await storeSession(accountId, session);
  await query("UPDATE telegram_accounts SET tg_user_id = $2, tg_username = $3, tg_first_name = $4, status = 'disconnected', last_error = NULL, reconnect_attempts = 0 WHERE id = $1", [accountId, me.id, me.username, me.firstName]);
  await closeFlow(accountId); // the long-lived connection is owned by the worker (single owner per session)
  await sendControl({ t: 'account', action: 'connect', id: accountId });
  await publish('account.status', { id: accountId });
  log.info('telegram account authorised', { accountId });
  return { step: 'done', me: { id: me.id, username: me.username, name: me.name } };
}

export async function submitCode(accountId, code) {
  const f = flows.get(accountId);
  if (!f) throw new AppError('TELEGRAM_LOGIN_EXPIRED', { status: 410 });
  try {
    const r = await f.adapter.signIn({ phone: f.phone, code: String(code).trim(), phoneCodeHash: f.hash });
    if (r.needsPassword) { f.step = 'password'; return { step: 'password' }; }
    return await finish(accountId, f.adapter);
  } catch (e) { const m = mapTelegramError(e); if (m.code === 'TELEGRAM_CODE_EXPIRED') await closeFlow(accountId); throw m; }
}
export async function submitPassword(accountId, password) {
  const f = flows.get(accountId);
  if (!f || f.step !== 'password') throw new AppError('TELEGRAM_LOGIN_EXPIRED', { status: 410 });
  try { await f.adapter.signInPassword(password); return await finish(accountId, f.adapter); } catch (e) { throw mapTelegramError(e); }
}
/** Import an existing GramJS/Telethon StringSession instead of an interactive login. */
export async function importSession(accountId, sessionString) {
  const acc = await loadAccountSecrets(accountId);
  if (!acc) throw new AppError('NOT_FOUND', { status: 404 });
  const adapter = createTelegramClient({ apiId: acc.apiId, apiHash: acc.apiHash, sessionString });
  try {
    await adapter.connect();
    if (!(await adapter.isAuthorized())) throw new AppError('SESSION_INVALID', { status: 400 });
    return await finish(accountId, adapter);
  } catch (e) { try { await adapter.disconnect(); } catch { /* ignore */ } throw e instanceof AppError ? e : (e?.message && /session|auth|key/i.test(e.message) ? new AppError('SESSION_INVALID', { status: 400, cause: e }) : mapTelegramError(e)); }
}
