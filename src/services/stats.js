// Batched counters: hourly aggregates for analytics + running totals on accounts/sources/radars/keywords.
import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const log = logger('stats');
const hourly = new Map(); const acc = new Map(); const src = new Map(); const radar = new Map(); const kw = new Map();
const add = (m, k, f, n) => { if (!k) return; const o = m.get(k) ?? {}; o[f] = (o[f] ?? 0) + n; m.set(k, o); };

export function bump({ accountId = 0, sourceId = 0, ...counts }, at = Date.now()) {
  const hour = new Date(Math.floor(at / 3600000) * 3600000).toISOString();
  const key = `${hour}|${accountId}|${sourceId}`;
  const o = hourly.get(key) ?? { hour, accountId, sourceId };
  for (const [f, n] of Object.entries(counts)) o[f] = (o[f] ?? 0) + n;
  hourly.set(key, o);
  if (counts.messages) { add(acc, accountId, 'messages', counts.messages); add(src, sourceId, 'messages', counts.messages); }
  if (counts.matches) { add(acc, accountId, 'matches', counts.matches); add(src, sourceId, 'matches', counts.matches); }
  if (counts.errors) add(acc, accountId, 'errors', counts.errors);
}
export const bumpRadar = (id) => add(radar, id, 'hits', 1);
export const bumpKeyword = (id) => add(kw, id, 'hits', 1);

export async function flushStats() {
  if (!hourly.size && !acc.size && !radar.size && !kw.size) return;
  const rows = [...hourly.values()]; hourly.clear();
  const A = [...acc.entries()]; acc.clear(); const S = [...src.entries()]; src.clear();
  const R = [...radar.entries()]; radar.clear(); const K = [...kw.entries()]; kw.clear();
  try {
    if (rows.length) {
      const g = (f) => rows.map((r) => r[f] ?? 0);
      await query(
        `INSERT INTO stats_hourly (bucket, account_id, source_id, messages, matches, high, duplicates, ai_calls, errors)
         SELECT * FROM unnest($1::timestamptz[], $2::bigint[], $3::bigint[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[])
         ON CONFLICT (bucket, account_id, source_id) DO UPDATE SET messages = stats_hourly.messages + EXCLUDED.messages,
           matches = stats_hourly.matches + EXCLUDED.matches, high = stats_hourly.high + EXCLUDED.high, duplicates = stats_hourly.duplicates + EXCLUDED.duplicates,
           ai_calls = stats_hourly.ai_calls + EXCLUDED.ai_calls, errors = stats_hourly.errors + EXCLUDED.errors`,
        [rows.map((r) => r.hour), rows.map((r) => r.accountId), rows.map((r) => r.sourceId), g('messages'), g('matches'), g('high'), g('duplicates'), g('ai_calls'), g('errors')],
      );
    }
    if (A.length) await query(`UPDATE telegram_accounts t SET messages_processed = messages_processed + v.m, matches_count = matches_count + v.x, errors_count = errors_count + v.e
      FROM unnest($1::bigint[], $2::int[], $3::int[], $4::int[]) AS v(id, m, x, e) WHERE t.id = v.id`, [A.map(([i]) => i), A.map(([, o]) => o.messages ?? 0), A.map(([, o]) => o.matches ?? 0), A.map(([, o]) => o.errors ?? 0)]);
    if (S.length) await query(`UPDATE telegram_sources t SET messages_count = messages_count + v.m, matches_count = matches_count + v.x
      FROM unnest($1::bigint[], $2::int[], $3::int[]) AS v(id, m, x) WHERE t.id = v.id`, [S.map(([i]) => i), S.map(([, o]) => o.messages ?? 0), S.map(([, o]) => o.matches ?? 0)]);
    if (R.length) await query('UPDATE ai_rules t SET hits = hits + v.n FROM unnest($1::bigint[], $2::int[]) AS v(id, n) WHERE t.id = v.id', [R.map(([i]) => i), R.map(([, o]) => o.hits)]);
    if (K.length) await query('UPDATE keywords t SET hits = hits + v.n FROM unnest($1::bigint[], $2::int[]) AS v(id, n) WHERE t.id = v.id', [K.map(([i]) => i), K.map(([, o]) => o.hits)]);
  } catch (e) { log.warn('stats flush failed; counters dropped', { err: e.message }); }
}
setInterval(flushStats, 5000).unref();
