// Fixed-window rate limiter: Redis when healthy, per-process memory fallback otherwise (never fails open).
import { redis, redisState } from './redis.js';

const mem = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of mem) if (v.resetAt < now) mem.delete(k); }, 30000).unref();

function memHit(key, limit, windowSec) {
  const now = Date.now(); let e = mem.get(key);
  if (!e || e.resetAt < now) { e = { count: 0, resetAt: now + windowSec * 1000 }; mem.set(key, e); }
  e.count++;
  return { allowed: e.count <= limit, remaining: Math.max(0, limit - e.count), resetSec: Math.ceil((e.resetAt - now) / 1000) };
}
export async function hit(key, limit, windowSec = 60) {
  if (!redisState.ok) return memHit(key, limit, windowSec);
  try {
    const k = `rl:${key}`;
    const [[, n], [, ttl]] = await redis().multi().incr(k).ttl(k).exec();
    if (ttl < 0) await redis().expire(k, windowSec);
    return { allowed: n <= limit, remaining: Math.max(0, limit - n), resetSec: ttl > 0 ? ttl : windowSec };
  } catch { return memHit(key, limit, windowSec); }
}
export const resetLimit = async (key) => { mem.delete(key); if (redisState.ok) try { await redis().del(`rl:${key}`); } catch { /* ignore */ } };
