// Block lists (users / sources / keywords) with a short in-process cache; enforced in the backend before any result is shown.
import { many, query } from '../lib/db.js';
import { normalizeText } from '../engine/normalize.js';
import { quickMatch } from '../engine/keywords.js';

const c = { at: 0, users: new Set(), sources: new Set(), keywords: [] };
export const invalidateBlocks = () => { c.at = 0; };
async function load() {
  if (Date.now() - c.at < 10000) return c;
  const [u, s, k] = await Promise.all([many('SELECT tg_user_id FROM blocked_users'), many('SELECT tg_chat_id FROM blocked_sources'), many('SELECT phrase FROM blocked_keywords')]);
  c.users = new Set(u.map((r) => r.tg_user_id)); c.sources = new Set(s.map((r) => r.tg_chat_id)); c.keywords = k.map((r) => r.phrase); c.at = Date.now();
  return c;
}
export async function blockedSets() { const { users, sources } = await load(); return { users, sources }; }
export async function checkBlocked({ senderId, tgChatId, analysis }) {
  const b = await load();
  if (senderId != null && b.users.has(senderId)) return 'blocked_user';
  if (b.sources.has(tgChatId)) return 'blocked_source';
  if (analysis && b.keywords.some((p) => quickMatch(analysis, p, 'contains').ok)) return 'blocked_keyword';
  return null;
}
export async function blockUser({ tgUserId, username = null, reason = null, userId = null }) {
  await query('INSERT INTO blocked_users (tg_user_id, username, reason, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (tg_user_id) DO NOTHING', [tgUserId, username, reason, userId]);
  invalidateBlocks();
}
export async function blockSource({ tgChatId, kind = 'group', title = null, reason = null, userId = null }) {
  await query('INSERT INTO blocked_sources (tg_chat_id, kind, title, reason, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tg_chat_id) DO NOTHING', [tgChatId, kind, title, reason, userId]);
  invalidateBlocks();
}
export async function blockKeyword({ phrase, reason = null, userId = null }) {
  const norm = normalizeText(phrase);
  if (!norm) return false;
  await query('INSERT INTO blocked_keywords (phrase, norm_phrase, reason, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (norm_phrase) DO NOTHING', [phrase, norm, reason, userId]);
  invalidateBlocks();
  return true;
}
/** SQL fragment hiding blocked users/sources from queries on message_matches aliased as `mm`. */
export const BLOCK_FILTER_SQL = `NOT EXISTS (SELECT 1 FROM blocked_users bu WHERE bu.tg_user_id = mm.sender_id)
  AND NOT EXISTS (SELECT 1 FROM blocked_sources bs WHERE bs.tg_chat_id = mm.chat_id)`;
