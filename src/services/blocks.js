// Block lists (users / sources / keywords / advertisements), enforced before any result is shown.
import { many, one, query, tx } from '../lib/db.js';
import { normalizeText, normalizeAdText, adFingerprint } from '../engine/normalize.js';
import { quickMatch } from '../engine/keywords.js';
import { publish } from '../lib/bus.js';

const c = { at: 0, users: new Set(), sources: new Set(), keywords: [] };
export const invalidateBlocks = () => { c.at = 0; };
async function load() {
  if (Date.now() - c.at < 10000) return c;
  const [u, s, k] = await Promise.all([many('SELECT tg_user_id FROM blocked_users'), many('SELECT tg_chat_id FROM blocked_sources'), many('SELECT phrase FROM blocked_keywords')]);
  c.users = new Set(u.map((r) => r.tg_user_id)); c.sources = new Set(s.map((r) => r.tg_chat_id)); c.keywords = k.map((r) => r.phrase); c.at = Date.now();
  return c;
}
export async function blockedSets() { const { users, sources } = await load(); return { users, sources }; }
export async function checkBlocked({ senderId, tgChatId, analysis, text }) {
  const b = await load();
  if (senderId != null && b.users.has(senderId)) return 'blocked_user';
  if (b.sources.has(tgChatId)) return 'blocked_source';
  const norm = normalizeAdText(text);
  const state = await one(
    `SELECT ($1::bigint IS NOT NULL AND EXISTS (SELECT 1 FROM blocked_users WHERE tg_user_id = $1)) AS user_blocked,
            ($2::text IS NOT NULL AND EXISTS (SELECT 1 FROM blocked_advertisements WHERE fingerprint = $2)) AS ad_blocked`,
    [senderId ?? null, norm ? adFingerprint(text) : null]);
  if (state?.user_blocked) return 'blocked_user';
  if (state?.ad_blocked) return 'blocked_advertisement';
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

/**
 * Permanently suppress an exact-normalised ad, hide all stored copies, and block each
 * known Telegram sender that posted one. The advisory lock closes the race with card creation.
 */
export async function blockAdvertisement({ text, matchId = null, userId = null }) {
  const result = await tx(async (client) => {
    const source = matchId == null ? null : (await client.query(
      `SELECT m.id AS message_id, m.text, m.sender_id, m.sender_username
         FROM message_matches mm JOIN messages m ON m.id = mm.message_id WHERE mm.id = $1`, [matchId])).rows[0] ?? null;
    const sourceText = String(source?.text ?? text ?? '');
    const norm = normalizeAdText(sourceText);
    if (!norm) return { blocked_messages: 0, blocked_users: 0, match_ids: [] };
    const fingerprint = adFingerprint(sourceText);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`blocked-ad:${fingerprint}`]);
    await client.query(
      `INSERT INTO blocked_advertisements (fingerprint, norm_text, sample_text, reason, created_by)
       VALUES ($1,$2,$3,'operator marked as advertisement',$4) ON CONFLICT (fingerprint) DO NOTHING`,
      [fingerprint, norm, sourceText.slice(0, 1000), userId]);

    // Scan in bounded batches: SQL's normalizer intentionally differs from JS on some Arabic
    // variants and elongation, so a SQL pre-filter could silently miss a copy we must block.
    const matching = [];
    let cursor = 0;
    while (true) {
      const rows = (await client.query(
        `SELECT id, sender_id, sender_username, text FROM messages
          WHERE id > $1 AND text IS NOT NULL ORDER BY id LIMIT 1000`, [cursor])).rows;
      if (!rows.length) break;
      for (const m of rows) if (normalizeAdText(m.text) === norm) matching.push(m);
      cursor = rows[rows.length - 1].id;
    }
    if (source && !matching.some((m) => m.id === source.message_id)) matching.push({ id: source.message_id, sender_id: source.sender_id, sender_username: source.sender_username, text: sourceText });
    const messageIds = [...new Set(matching.map((m) => Number(m.id)))];
    const senders = new Map();
    for (const m of matching) if (m.sender_id != null) senders.set(Number(m.sender_id), m.sender_username ?? null);
    const senderIds = [...senders.keys()];
    if (senderIds.length) await client.query(
      `INSERT INTO blocked_users (tg_user_id, username, reason, created_by)
       SELECT v.tg_user_id, v.username, 'posted a blocked advertisement', $3
         FROM unnest($1::bigint[], $2::text[]) AS v(tg_user_id, username)
       ON CONFLICT (tg_user_id) DO NOTHING`,
      [senderIds, senderIds.map((id) => senders.get(id)), userId]);
    let matchIds = [];
    if (messageIds.length) {
      await client.query("UPDATE messages SET state = 'skipped', skip_reason = 'blocked_advertisement', processed_at = now() WHERE id = ANY($1::bigint[])", [messageIds]);
      matchIds = (await client.query(
        `SELECT id FROM message_matches WHERE message_id = ANY($1::bigint[])
         UNION SELECT match_id AS id FROM match_occurrences WHERE message_id = ANY($1::bigint[])`, [messageIds])).rows.map((r) => r.id);
      if (matchIds.length) {
        await client.query("UPDATE message_matches SET status = 'ignored', ad_label = 'ad', ad_score = GREATEST(COALESCE(ad_score,0),70) WHERE id = ANY($1::bigint[])", [matchIds]);
        await client.query('UPDATE saved_results SET deleted_at = now() WHERE deleted_at IS NULL AND match_id = ANY($1::bigint[])', [matchIds]);
        await client.query("UPDATE notifications SET status = 'read', read_at = now(), error = 'suppressed: blocked advertisement' WHERE match_id = ANY($1::bigint[]) AND status <> 'read'", [matchIds]);
      }
    }
    await client.query(
      `INSERT INTO ad_examples (text,label,match_id,tg_user_id,created_by) VALUES ($1,'ad',$2,$3,$4)`,
      [sourceText.slice(0, 1000), matchId, source?.sender_id ?? null, userId]);
    return { blocked_messages: messageIds.length, blocked_users: senderIds.length, match_ids: matchIds };
  });
  invalidateBlocks();
  for (const id of result.match_ids) await publish('match.update', { id });
  return { blocked_messages: result.blocked_messages, blocked_users: result.blocked_users };
}

/** Complete a no-card message under the same fingerprint lock used by ad blocking. */
export async function completeWithoutCard({ messageId, senderId, username, text, skipReason = null }) {
  const norm = normalizeAdText(text);
  if (!norm) {
    await query("UPDATE messages SET state = 'done', skip_reason = $2, processed_at = now(), error = NULL WHERE id = $1", [messageId, skipReason]);
    return false;
  }
  const blocked = await tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`blocked-ad:${adFingerprint(text)}`]);
    const exists = (await client.query('SELECT 1 FROM blocked_advertisements WHERE fingerprint = $1', [adFingerprint(text)])).rowCount > 0;
    if (exists) {
      if (senderId != null) await client.query(
        `INSERT INTO blocked_users (tg_user_id, username, reason)
         VALUES ($1,$2,'posted a blocked advertisement') ON CONFLICT (tg_user_id) DO NOTHING`, [senderId, username ?? null]);
      await client.query("UPDATE messages SET state = 'skipped', skip_reason = 'blocked_advertisement', processed_at = now(), error = NULL WHERE id = $1", [messageId]);
      return true;
    }
    await client.query("UPDATE messages SET state = 'done', skip_reason = $2, processed_at = now(), error = NULL WHERE id = $1", [messageId, skipReason]);
    return false;
  });
  if (blocked) invalidateBlocks();
  return blocked;
}

/** SQL fragment hiding blocked users/sources from queries on message_matches aliased as `mm`. */
export const BLOCK_FILTER_SQL = `NOT EXISTS (SELECT 1 FROM blocked_users bu WHERE bu.tg_user_id = mm.sender_id)
  AND NOT EXISTS (SELECT 1 FROM blocked_sources bs WHERE bs.tg_chat_id = mm.chat_id)
  AND NOT EXISTS (SELECT 1 FROM messages bm WHERE bm.id = mm.message_id AND bm.skip_reason = 'blocked_advertisement')
  AND NOT EXISTS (SELECT 1 FROM match_occurrences bmo JOIN messages bm ON bm.id = bmo.message_id WHERE bmo.match_id = mm.id AND bm.skip_reason = 'blocked_advertisement')`;
