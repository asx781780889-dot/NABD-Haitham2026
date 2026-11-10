// PostgreSQL health & capacity monitoring with the 70/80/90/95/98 % escalation ladder. Never deletes anything by itself.
import fs from 'node:fs';
import { one, many } from '../lib/db.js';
import { getSetting } from '../lib/settings.js';
import { config } from '../config.js';

export const LEVELS = [
  { id: 'emergency', min: 98 }, { id: 'emergency_prep', min: 95 }, { id: 'critical', min: 90 },
  { id: 'high_risk', min: 80 }, { id: 'warning', min: 70 }, { id: 'normal', min: 0 },
];
export const levelFor = (pct) => LEVELS.find((l) => pct >= l.min).id;
const tryQ = async (sql, params) => { try { return await many(sql, params); } catch { return null; } };

async function capacityBytes(size) {
  const mb = await getSetting('database.size_limit_mb');
  if (mb > 0) return { limit: mb * 1024 * 1024, source: 'configured' };
  try { const s = await fs.promises.statfs(config.DATA_DIR); return { limit: size + s.bavail * s.bsize, source: 'disk' }; } catch { return { limit: 0, source: 'unknown' }; }
}

export async function databaseStatus() {
  const size = (await one('SELECT pg_database_size(current_database()) AS b')).b;
  const { limit, source } = await capacityBytes(size);
  const percent = limit ? Math.round((size / limit) * 1000) / 10 : 0;
  const [tables, indexes, temp, conns, maxConn, slow, wal, slots] = await Promise.all([
    many(`SELECT relname AS name, pg_total_relation_size(relid)::bigint AS bytes, n_live_tup::bigint AS rows FROM pg_stat_user_tables ORDER BY 2 DESC LIMIT 8`),
    many(`SELECT indexrelname AS name, relname AS table, pg_relation_size(indexrelid)::bigint AS bytes FROM pg_stat_user_indexes ORDER BY 3 DESC LIMIT 8`),
    one('SELECT temp_files::bigint AS files, temp_bytes::bigint AS bytes FROM pg_stat_database WHERE datname = current_database()'),
    one('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()'),
    one("SELECT setting::int AS n FROM pg_settings WHERE name = 'max_connections'"),
    many(`SELECT pid, state, EXTRACT(EPOCH FROM (now() - query_start))::int AS seconds, left(query, 140) AS query FROM pg_stat_activity
           WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid() AND now() - query_start > interval '60 seconds' ORDER BY query_start LIMIT 10`),
    tryQ('SELECT COALESCE(sum(size), 0)::bigint AS bytes FROM pg_ls_waldir()'),
    tryQ("SELECT slot_name AS name, active, COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::bigint AS lag_bytes FROM pg_replication_slots"),
  ]);
  return {
    size_bytes: size, limit_bytes: limit, limit_source: source, percent, level: levelFor(percent), ladder: LEVELS.filter((l) => l.min).map((l) => ({ ...l })),
    tables, indexes, wal_bytes: wal?.[0]?.bytes ?? null, temp: { files: temp?.files ?? 0, bytes: temp?.bytes ?? 0 }, replication_slots: slots,
    connections: { used: conns.n, max: maxConn.n }, long_running_queries: slow, emergency_active: await getSetting('database.emergency_active'), checked_at: new Date().toISOString(),
  };
}
