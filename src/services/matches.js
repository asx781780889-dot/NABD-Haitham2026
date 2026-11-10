// Card persistence with cross-account / near-duplicate detection (one card, many "detected by" accounts).
import { tx } from '../lib/db.js';
import { getSettings } from '../lib/settings.js';
import { publish } from '../lib/bus.js';
import { normalizeText } from '../engine/normalize.js';
import { bandDistance, isDuplicate, textSimilarity } from '../engine/dedupe.js';
import { isChannelId } from '../telegram/links.js';

async function findDuplicate(c, { msg, an, fp }, cfg) {
  const { rows } = await c.query(
    `SELECT mm.id, mm.norm_hash, mm.sh0, mm.sh1, mm.sh2, mm.sh3, mm.sender_id, mm.chat_id, m.tg_chat_id, m.tg_message_id, m.text
       FROM message_matches mm JOIN messages m ON m.id = mm.message_id
      WHERE mm.deleted_at IS NULL AND mm.created_at > now() - make_interval(hours => $1)
        AND (mm.norm_hash = $2 OR mm.sh0 = $3 OR mm.sh1 = $4 OR mm.sh2 = $5 OR mm.sh3 = $6 OR (m.tg_chat_id = $7 AND m.tg_message_id = $8))
      ORDER BY mm.id LIMIT 60`,
    [Math.max(1, Math.round(cfg.window_hours)), fp.norm, ...fp.bands, msg.tg_chat_id, msg.tg_message_id],
  );
  const globalId = isChannelId(msg.tg_chat_id);
  for (const r of rows) {
    if (globalId && r.tg_chat_id === msg.tg_chat_id && r.tg_message_id === msg.tg_message_id) return r; // same Telegram message seen by another account
    const sameNorm = r.norm_hash === fp.norm;
    const dist = r.sh0 == null ? null : bandDistance([r.sh0, r.sh1, r.sh2, r.sh3], fp.h);
    const near = dist != null && dist <= cfg.simhash_distance && an.tokens.length >= 4;
    if (!sameNorm && !near) continue;
    const sameSender = r.sender_id != null && r.sender_id === msg.sender_id; const sameChat = r.chat_id === msg.tg_chat_id;
    const allowed = cfg.scope === 'aggressive' || (cfg.scope === 'normal' ? sameSender || sameChat : sameSender && sameChat);
    if (!allowed) continue;
    const sim = sameNorm ? 1 : textSimilarity(an.norm, normalizeText(r.text ?? ''));
    if (isDuplicate({ sameNorm, distance: near ? dist : null, textSim: sim }, { maxDistance: cfg.simhash_distance, minSimilarity: cfg.similarity })) return r;
  }
  return null;
}

/** Idempotent: re-processing the same message never produces a second card. */
export async function persistCard(i) {
  const cfg = await getSettings('dedupe.');
  const { msg, fp, card } = i;
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`dedupe:${msg.sender_id ?? msg.tg_chat_id}`]);
    const done = () => c.query("UPDATE messages SET state = 'done', processed_at = now(), error = NULL WHERE id = $1", [msg.id]);
    const ex = (await c.query('SELECT id FROM message_matches WHERE message_id = $1', [msg.id])).rows[0];
    if (ex) { await done(); return { id: ex.id, created: false, duplicate: false }; }
    const dup = await findDuplicate(c, i, cfg);
    if (dup) {
      const ins = await c.query('INSERT INTO match_occurrences (match_id, message_id, account_id, source_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [dup.id, msg.id, msg.account_id, msg.source_id]);
      if (ins.rowCount) await c.query('UPDATE message_matches SET occurrences = occurrences + 1, last_seen_at = now() WHERE id = $1', [dup.id]);
      await done();
      await publish('match.update', { id: dup.id }, c);
      return { id: dup.id, created: false, duplicate: true };
    }
    const r = await c.query(
      `INSERT INTO message_matches (message_id, account_id, source_id, ai_rule_id, keyword_id, rule_id, match_type, score, priority, intent, ai_confidence, ai_reason,
         keyword_text, context_ok, extra, tags, exact_hash, norm_hash, simhash, sh0, sh1, sh2, sh3, sender_id, chat_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`,
      [msg.id, msg.account_id, msg.source_id, card.aiRuleId ?? null, card.keywordId ?? null, card.ruleId ?? null, card.matchType, card.score, card.priority, card.intent ?? null,
        card.aiConfidence ?? null, card.aiReason ?? null, card.keywordText ?? null, card.contextOk ?? null, JSON.stringify(card.extra ?? {}), [...(card.tags ?? [])],
        fp.exact, fp.norm, fp.simhash, ...fp.bands, msg.sender_id, msg.tg_chat_id],
    );
    const id = r.rows[0].id;
    await c.query('INSERT INTO match_occurrences (match_id, message_id, account_id, source_id) VALUES ($1,$2,$3,$4)', [id, msg.id, msg.account_id, msg.source_id]);
    await done();
    await publish('match.new', { id }, c);
    return { id, created: true, duplicate: false };
  });
}
