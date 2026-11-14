import { one, query } from '../lib/db.js';
import { safeRedis } from '../lib/redis.js';
import { getSetting } from '../lib/settings.js';
import { hamming } from '../engine/similarity.js';
import { publish } from '../lib/bus.js';
const fallback = new Map(); const seen = new Set(); const results = new Map(); const MAX = 20000;
const key = (id) => `ads:fp:${id}`;
function prune() { while (fallback.size > MAX) fallback.delete(fallback.keys().next().value); }
export async function observe({ messageId, senderId, chatId, sourceId, normHash, simhash, tokensCount, rulesScore = 0 }) {
  if (senderId == null || Number(tokensCount) < 4) return { behaviorScore: 0, repeat: 0, groups: 0 };
  const idKey = `${senderId}:${messageId}`; if (seen.has(idKey)) return { behaviorScore: 0, repeat: 0, groups: 0, duplicate: true }; seen.add(idKey); if (seen.size > 100000) seen.delete(seen.values().next().value);
  const windowHours = await getSetting('ads.behavior.window_hours'); const now = Date.now();
  const item = { n: normHash, h: simhash ?? null, c: Number(chatId), t: now };
  let history = await safeRedis(async (r) => { const k = key(senderId); const old = await r.lrange(k, 0, 29); await r.multi().lpush(k, JSON.stringify(item)).ltrim(k, 0, 29).expire(k, windowHours * 3600).exec(); return old.map((x) => JSON.parse(x)); }, null);
  if (!history) { history = (fallback.get(senderId) ?? []).filter((x) => now - x.t < windowHours * 3600000); history.push(item); fallback.set(senderId, history.slice(-30)); prune(); }
  const matches = history.filter((x) => x.n === normHash || (x.h && simhash?.hi != null && hamming(x.h, simhash) <= 3));
  const repeat = matches.length; const groups = new Set(history.map((x) => x.c)).size;
  const burst = history.filter((x) => now - x.t < 600000).length >= 3 && new Set(history.filter((x) => now - x.t < 600000).map((x) => x.c)).size >= 2);
  const seven = await one(`SELECT count(*)::int AS n FROM message_matches WHERE sender_id = $1 AND created_at > now() - interval '7 days' AND deleted_at IS NULL`, [senderId]).catch(() => ({ n: 0 }));
  const behaviorScore = Math.max(0, Math.min(100, repeat >= 3 ? 60 : repeat === 2 ? 45 : repeat === 1 ? 30 : 0) + (groups >= 3 ? 40 : groups >= 2 ? 25 : 0) + (burst ? 15 : 0) + Math.min(25, 5 * (seven?.n ?? 0)));
  const out = { behaviorScore, repeat, groups, burst, history: seven?.n ?? 0, senderId, sourceId, rulesScore }; results.set(Number(messageId), out); if (results.size > 10000) results.delete(results.keys().next().value); return out;
}
export const getObserved = (messageId) => results.get(Number(messageId)) ?? { behaviorScore: 0, repeat: 0, groups: 0, history: 0 };
export async function updateSenderProfile({ senderId, username, displayName, adScore, isAd, behavior }) {
  if (senderId == null) return null;
  const row = await one(`INSERT INTO sender_profiles (tg_user_id, username, display_name, ad_score, ad_messages, total_messages, groups_count, repeat_count, ad_events, last_ad_at)
    VALUES ($1,$2,$3,$4,$5,1,$6,$7,CASE WHEN $5 > 0 THEN ARRAY[now()]::timestamptz[] ELSE '{}'::timestamptz[] END,CASE WHEN $5 > 0 THEN now() ELSE NULL END)
    ON CONFLICT (tg_user_id) DO UPDATE SET username=COALESCE(EXCLUDED.username,sender_profiles.username), display_name=COALESCE(EXCLUDED.display_name,sender_profiles.display_name),
      ad_score=GREATEST(sender_profiles.ad_score,EXCLUDED.ad_score), ad_messages=sender_profiles.ad_messages+EXCLUDED.ad_messages, total_messages=sender_profiles.total_messages+1,
      groups_count=GREATEST(sender_profiles.groups_count,EXCLUDED.groups_count), repeat_count=sender_profiles.repeat_count+EXCLUDED.repeat_count,
      ad_events=(sender_profiles.ad_events || EXCLUDED.ad_events)[GREATEST(1,array_length(sender_profiles.ad_events || EXCLUDED.ad_events,1)-19):], last_ad_at=CASE WHEN EXCLUDED.ad_messages>0 THEN now() ELSE sender_profiles.last_ad_at END, updated_at=now()
    RETURNING *`, [senderId, username ?? null, displayName ?? null, Number(adScore) || 0, isAd ? 1 : 0, behavior?.groups ?? 0, behavior?.repeat ?? 0]);
  if (row?.status_source !== 'operator') {
    const status = row.ad_messages >= (await getSetting('ads.behavior.advertiser_after')) || row.ad_score >= 70 ? 'advertiser' : row.ad_score >= 40 ? 'suspect' : 'unknown';
    if (status !== row.status) await query('UPDATE sender_profiles SET status=$2,status_source=\'auto\',updated_at=now() WHERE tg_user_id=$1', [senderId, status]);
    if (status === 'advertiser') {
      const cards = await query(`UPDATE message_matches SET ad_label='ad', ad_score=GREATEST(COALESCE(ad_score,0),$2) WHERE sender_id=$1 AND created_at>now()-interval '48 hours' AND deleted_at IS NULL AND id IN (SELECT id FROM message_matches WHERE sender_id=$1 ORDER BY created_at DESC LIMIT 50) RETURNING id`, [senderId, Number(adScore) || 0]);
      for (const c of cards.rows) await publish('match.update', { id: c.id });
    }
  }
  return { ...row, status: row.status_source === 'operator' ? row.status : (row.ad_messages >= 3 || row.ad_score >= 70 ? 'advertiser' : row.ad_score >= 40 ? 'suspect' : 'unknown') };
}
