// PostgreSQL access: pool, transactions, migrations (advisory-locked), LISTEN/NOTIFY helpers.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config, ROOT } from '../config.js';
import { logger, attachDbSink } from './logger.js';
import { backoff } from './resilience.js';

const log = logger('db');
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8 -> number (ids stay < 2^53)
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric -> number

function postgresConnectionOptions() {
  const url = new URL(config.DATABASE_URL);
  const host = url.hostname.toLowerCase();
  const sslMode = String(url.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? '').toLowerCase();
  const ssl = config.DATABASE_SSL === 'true'
    || (config.DATABASE_SSL === 'auto' && (sslMode === 'require' || /(?:^|\.)railway\.(?:app|internal)$/.test(host)));
  return {
    connectionString: config.DATABASE_URL,
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    // API and worker each have a pool. A default of 12 per process can exceed
    // the connection quota of small Railway Postgres plans and causes 53300.
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    maxLifetimeSeconds: Number(process.env.PG_MAX_LIFETIME_S || 300),
    connectionTimeoutMillis: config.PG_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    application_name: `nabd-${process.env.NABD_ROLE || 'app'}`,
  };
}
export const databaseConnectionOptions = postgresConnectionOptions;
export const pool = new pg.Pool({
  ...postgresConnectionOptions(),
});
pool.on('error', (e) => log.error('idle pg client error', { err: e }));

export const query = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;
export const many = async (text, params) => (await pool.query(text, params)).rows;

export async function tx(fn) {
  const c = await pool.connect();
  const swallow = () => {}; // a checked-out client emitting 'error' must never become an uncaught exception
  c.on('error', swallow);
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally { c.off('error', swallow); c.release(); }
}

export async function dbPing() {
  const t = Date.now(); let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await pool.query('SELECT 1'); return Date.now() - t; }
    catch (e) { last = e; if (attempt < 2) await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); }
  }
  throw last;
}
export async function notify(channel, payload, client = pool) {
  await client.query('SELECT pg_notify($1, $2)', [channel, typeof payload === 'string' ? payload : JSON.stringify(payload)]);
}

export async function migrate() {
  const dir = path.join(ROOT, 'src', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const c = await pool.connect();
  c.on('error', () => {});
  try {
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    const applied = [];
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (id) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
        log.info('migration applied', { file: f });
      } catch (e) { await c.query('ROLLBACK'); throw new Error(`migration ${f} failed: ${e.message}`); }
    }
    return applied;
  } finally {
    try { await c.query('SELECT pg_advisory_unlock(727274)'); } catch { /* ignore */ }
    c.release();
  }
}

/** Dedicated LISTEN connection with automatic, backed-off reconnection. */
export function listen(channel, handler) {
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error('invalid channel name');
  let closed = false; let client = null; let attempt = 0; let timer = null;
  const schedule = () => { if (closed || timer) return; timer = setTimeout(() => { timer = null; void connect(); }, backoff(attempt++, 1000, 15000)); };
  async function connect() {
    if (closed) return;
    try {
      client = new pg.Client({ ...postgresConnectionOptions(), application_name: `nabd-listen-${channel}` });
      client.on('error', () => {});
      client.on('end', schedule);
      client.on('notification', (m) => { try { handler(m.payload); } catch (e) { log.error('listener handler failed', { err: e }); } });
      await client.connect();
      await client.query(`LISTEN ${channel}`);
      attempt = 0;
    } catch { try { client?.end(); } catch { /* ignore */ } schedule(); }
  }
  void connect();
  return { close() { closed = true; clearTimeout(timer); try { client?.end(); } catch { /* ignore */ } } };
}

attachDbSink(async (rows) => {
  const cols = rows.map((r) => [r.level, r.source, r.msg, r.ctx ? JSON.stringify(r.ctx) : null, r.reqId ?? null]);
  await pool.query(
    `INSERT INTO system_logs (level, source, message, context, request_id)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::jsonb[], $5::text[])`,
    [0, 1, 2, 3, 4].map((i) => cols.map((c) => c[i])),
  );
});
export async function closeDb() { await pool.end(); }
