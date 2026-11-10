// Saved results: immutable snapshot so the record survives message retention cleanup.
import { one } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { CARD_SELECT, toCard } from './cards.js';

export async function saveMatch(matchId, { userId = null, notes = null, tags = [] } = {}) {
  const row = await one(`${CARD_SELECT} WHERE mm.id = $1`, [matchId]);
  if (!row) throw new AppError('NOT_FOUND', { status: 404 });
  const c = toCard(row);
  return one(
    `INSERT INTO saved_results (match_id, user_id, source_title, account_name, sender_id, sender_username, message_text, message_link, message_at, rule_name, intent, score, priority, ai_classification, notes, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (match_id) WHERE deleted_at IS NULL AND match_id IS NOT NULL DO UPDATE SET updated_at = now()
     RETURNING id`,
    [matchId, userId, c.source.title, c.account.name, c.sender.id, c.sender.username, c.text, c.links.message, c.sent_at, c.rule?.name ?? c.keyword ?? null, c.intent, c.score, c.priority,
      JSON.stringify({ match_type: c.match_type, ai_confidence: c.ai_confidence, reason: c.ai_reason, intent: c.intent }), notes, tags],
  );
}
