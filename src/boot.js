// Shared process bootstrap: wait for PostgreSQL, run migrations, apply log settings.
import { config } from './config.js';
import { dbPing, migrate, closeDb } from './lib/db.js';
import { getSetting } from './lib/settings.js';
import { setLogLevels, logger, flushLogs } from './lib/logger.js';
import { sleep } from './lib/resilience.js';
import { closeRedis } from './lib/redis.js';
import { closeQueues } from './lib/queue.js';
import { flushStats } from './services/stats.js';

const log = logger('boot');

export async function bootstrap(role) {
  process.env.NABD_ROLE = role;
  for (let i = 0; ; i++) {
    try { await dbPing(); break; } catch (e) {
      if (i >= 30) { log.critical('database unreachable, giving up', { err: e.message }); process.exit(1); }
      if (i % 5 === 0) log.warn('waiting for PostgreSQL…', { err: e.message });
      await sleep(2000);
    }
  }
  if (config.AUTO_MIGRATE) await migrate();
  setLogLevels({ console: await getSetting('logs.level'), db: await getSetting('logs.db_level') });
  log.info(`${role} ready`, { node: process.version, env: config.NODE_ENV });
}
export async function shutdownCommon() {
  await flushStats().catch(() => {}); await flushLogs().catch(() => {});
  await closeQueues().catch(() => {}); await closeRedis().catch(() => {}); await closeDb().catch(() => {});
}

/** Transient infrastructure errors (DB / Redis / socket resets) must be logged, never fatal: the services recover on their own. */
export const isTransient = (e) => /Connection terminated|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|terminating connection|57P0[1-3]|Connection is closed|Stream isn't writeable/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
