// Redis client (fail-fast, degrades gracefully) and BullMQ connection options.
import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger('redis');
export const redisState = { ok: false, lastError: null, lastOkAt: null };
let client = null;

export function redisOptions(extra = {}) {
  const u = new URL(config.REDIS_URL);
  return {
    host: u.hostname, port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    ...extra,
  };
}

export function redis() {
  if (client) return client;
  client = new Redis(redisOptions({ enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000, retryStrategy: (n) => Math.min(n * 500, 10000) }));
  client.on('ready', () => { if (!redisState.ok) log.info('redis connected'); redisState.ok = true; redisState.lastOkAt = Date.now(); redisState.lastError = null; });
  client.on('error', (e) => { if (redisState.ok || redisState.lastError !== e.message) log.warn('redis error', { err: e.message }); redisState.ok = false; redisState.lastError = e.message; });
  client.on('end', () => { redisState.ok = false; });
  return client;
}

/** Run a redis operation; on failure mark Redis degraded and return the fallback. */
export async function safeRedis(fn, fallback = null) {
  try { return await fn(redis()); } catch (e) { redisState.ok = false; redisState.lastError = e.message; return fallback; }
}
export async function pingRedis() {
  const t = Date.now();
  try { await redis().ping(); redisState.ok = true; return { ok: true, latencyMs: Date.now() - t }; }
  catch (e) { redisState.ok = false; redisState.lastError = e.message; return { ok: false, error: e.message }; }
}
export async function closeRedis() { if (client) { try { await client.quit(); } catch { client.disconnect(); } client = null; } }
