// Account helpers: secret loading, encrypted session storage and UI-safe serialisation.
import { one, tx } from '../lib/db.js';
import { decrypt, encrypt } from '../lib/crypto.js';

export async function loadAccountSecrets(id) {
  const r = await one('SELECT a.*, s.session_enc FROM telegram_accounts a LEFT JOIN telegram_sessions s ON s.account_id = a.id AND s.is_active WHERE a.id = $1 AND a.deleted_at IS NULL', [id]);
  if (!r) return null;
  return { id: r.id, name: r.name, phone: decrypt(r.phone_enc), apiId: Number(decrypt(r.api_id_enc)), apiHash: decrypt(r.api_hash_enc), session: r.session_enc ? decrypt(r.session_enc) : '', status: r.status, enabled: r.enabled };
}
export async function storeSession(accountId, sessionString) {
  await tx(async (c) => {
    await c.query('UPDATE telegram_sessions SET is_active = false, revoked_at = now() WHERE account_id = $1 AND is_active', [accountId]);
    await c.query('INSERT INTO telegram_sessions (account_id, session_enc) VALUES ($1, $2)', [accountId, encrypt(sessionString)]);
  });
}
export const SAFE_ACCOUNT_COLUMNS = `a.id, a.name, a.description, a.tags, a.phone_masked, a.tg_user_id, a.tg_username, a.tg_first_name, a.status, a.enabled, a.last_connected_at, a.last_error, a.last_error_at,
  a.reconnect_attempts, a.cooldown_until, a.groups_count, a.channels_count, a.chats_count, a.messages_processed, a.matches_count, a.errors_count, a.created_at,
  EXISTS (SELECT 1 FROM telegram_sessions s WHERE s.account_id = a.id AND s.is_active) AS has_session`;
