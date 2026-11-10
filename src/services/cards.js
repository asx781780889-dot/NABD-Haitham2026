// Live Card projection shared by REST, WebSocket, notifications and exports.
import { many } from '../lib/db.js';
import { telegramLinks } from '../telegram/links.js';

export const CARD_SELECT = `SELECT mm.id, mm.message_id, mm.score, mm.bucket, mm.match_type, mm.priority, mm.intent, mm.ai_confidence, mm.ai_reason,
  mm.keyword_text, mm.context_ok, mm.status, mm.pinned, mm.feedback, mm.tags, mm.occurrences, mm.created_at, mm.extra, mm.ai_rule_id, mm.keyword_id, mm.sender_id AS m_sender_id,
  m.text, m.tg_message_id, m.tg_chat_id, m.sender_username, m.sender_name, m.sent_at, m.lang,
  s.id AS source_id, s.title AS source_title, s.kind AS source_kind, s.username AS source_username,
  a.id AS account_id, a.name AS account_name, r.name AS rule_name,
  EXISTS (SELECT 1 FROM saved_results sr WHERE sr.match_id = mm.id AND sr.deleted_at IS NULL) AS saved,
  (SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', a2.id, 'name', a2.name)), '[]'::jsonb)
     FROM match_occurrences mo JOIN telegram_accounts a2 ON a2.id = mo.account_id WHERE mo.match_id = mm.id) AS detected_by
  FROM message_matches mm
  JOIN messages m ON m.id = mm.message_id
  LEFT JOIN telegram_sources s ON s.id = mm.source_id
  LEFT JOIN telegram_accounts a ON a.id = mm.account_id
  LEFT JOIN ai_rules r ON r.id = mm.ai_rule_id`;

export function toCard(r) {
  const links = telegramLinks({ chatId: r.tg_chat_id, kind: r.source_kind, username: r.source_username, messageId: r.tg_message_id, senderId: r.m_sender_id, senderUsername: r.sender_username });
  return {
    id: r.id, message_id: r.message_id, tg_message_id: r.tg_message_id, score: r.score, bucket: r.bucket, match_type: r.match_type,
    priority: r.priority, intent: r.intent, ai_confidence: r.ai_confidence, ai_reason: r.ai_reason, keyword: r.keyword_text, context_ok: r.context_ok,
    status: r.status, pinned: r.pinned, feedback: r.feedback, saved: r.saved, tags: r.tags, occurrences: r.occurrences,
    created_at: r.created_at, sent_at: r.sent_at, text: r.text, lang: r.lang,
    sender: { id: r.m_sender_id, username: r.sender_username, name: r.sender_name },
    source: { id: r.source_id, title: r.source_title, kind: r.source_kind, username: r.source_username, tg_chat_id: r.tg_chat_id },
    account: { id: r.account_id, name: r.account_name },
    rule: r.ai_rule_id ? { id: r.ai_rule_id, name: r.rule_name } : null,
    detected_by: r.detected_by ?? [], links,
    ai_degraded: !!r.extra?.ai_degraded, force_channels: r.extra?.force_channels ?? [], factors: r.extra?.factors ?? [],
  };
}
export async function hydrateCards(ids) {
  if (!ids.length) return [];
  const rows = await many(`${CARD_SELECT} WHERE mm.id = ANY($1::bigint[]) AND mm.deleted_at IS NULL`, [ids]);
  return rows.map(toCard);
}
