// Live system status for the dashboard (Telegram, Database, AI, Workers, Queue, Redis, API, Scheduler, Storage) - cached 3 s.
import { one, many, dbPing } from '../lib/db.js';
import { pingRedis, redisState } from '../lib/redis.js';
import { queueCounts } from '../lib/queue.js';
import { activeChain, providersSnapshot } from '../ai/manager.js';
import { databaseStatus } from './dbmonitor.js';
import { getSetting } from '../lib/settings.js';

let cache = { at: 0, v: null };
const S = (status, detail, extra = {}) => ({ status, detail, ...extra });

export async function workerRows() {
  const rows = await many("SELECT *, (last_heartbeat > now() - interval '25 seconds') AS online FROM workers WHERE last_heartbeat > now() - interval '1 day' ORDER BY name, last_heartbeat DESC");
  const seen = new Set(); const out = [];
  for (const r of rows) { if (seen.has(r.name)) continue; seen.add(r.name); out.push(r); }
  return out;
}
export async function workersOnline() { return (await one("SELECT count(*)::int AS n FROM workers WHERE last_heartbeat > now() - interval '25 seconds'")).n > 0; }

export async function systemStatus(force = false) {
  if (!force && Date.now() - cache.at < 3000 && cache.v) return cache.v;
  const out = { api: S('online', `pid ${process.pid}`, { uptime_s: Math.round(process.uptime()) }) };
  try { const ms = await dbPing(); out.database = S('online', `${ms} ms`); } catch (e) { out.database = S('error', e.message); }
  if (out.database.status === 'error') { cache = { at: Date.now(), v: { ...out, redis: S('offline', '-'), queue: S('offline', '-'), workers: S('offline', '-'), scheduler: S('offline', '-'), telegram: S('offline', '-'), ai: S('offline', '-'), storage: S('offline', '-') } }; return cache.v; }
  const [redis, counts, workers, accounts, chain, providers, db] = await Promise.all([pingRedis(), queueCounts(), workerRows(), many("SELECT status FROM telegram_accounts WHERE deleted_at IS NULL"), activeChain().catch(() => []), providersSnapshot().catch(() => []), databaseStatus().catch(() => null)]);
  out.redis = redis.ok ? S('online', `${redis.latencyMs} ms`) : S('offline', redisState.lastError ?? 'unreachable');
  if (!redis.ok) out.queue = S('offline', 'Redis unavailable: degraded inline processing');
  else {
    const sum = (k) => Object.values(counts).reduce((a, c) => a + (c?.[k] ?? 0), 0);
    const failed = sum('failed'); const waiting = sum('waiting') + sum('delayed');
    out.queue = S(failed > 0 || waiting > 5000 ? 'warning' : 'online', `${waiting} waiting · ${sum('active')} active · ${failed} failed`, { counts });
  }
  const online = workers.filter((w) => w.online);
  out.workers = !workers.length ? S('offline', 'no worker process has reported') : !online.length ? S('offline', 'heartbeat lost') : online.some((w) => w.status === 'error' || w.status === 'stopped') ? S('warning', `${online.filter((w) => w.status === 'running').length}/${online.length} modules running`) : S('online', `${online.length} modules running`);
  const sch = workers.find((w) => w.name === 'scheduler');
  out.scheduler = sch?.online && sch.status === 'running' ? S('online', 'ok') : S('offline', sch ? 'stopped' : 'not running');
  const connected = accounts.filter((a) => a.status === 'connected').length;
  out.telegram = !accounts.length ? S('warning', 'no accounts yet') : connected === accounts.length ? S('online', `${connected}/${accounts.length} connected`) : connected === 0 ? S(accounts.some((a) => a.status === 'error' || a.status === 'auth_required') ? 'error' : 'offline', `0/${accounts.length} connected`) : S('warning', `${connected}/${accounts.length} connected`);
  if (!chain.length) out.ai = S('warning', 'no provider configured');
  else {
    const states = chain.map((id) => providers.find((p) => p.id === id)?.breaker?.state ?? 'closed');
    out.ai = states.every((s) => s === 'open') ? S('error', 'all providers failing (circuit open)') : states.some((s) => s !== 'closed') ? S('warning', 'a provider is failing; failover active') : S('online', chain.join(' → '));
  }
  out.storage = !db ? S('warning', 'unknown') : db.level === 'normal' ? S('online', `${db.percent}%`, { level: db.level, percent: db.percent }) : S(['warning', 'high_risk'].includes(db.level) ? 'warning' : 'error', `${db.percent}% (${db.level})`, { level: db.level, percent: db.percent });
  cache = { at: Date.now(), v: out }; return out;
}

export async function overview() {
  const r = await one(`SELECT
    (SELECT count(*)::int FROM telegram_accounts WHERE deleted_at IS NULL) AS accounts_total,
    (SELECT count(*)::int FROM telegram_accounts WHERE deleted_at IS NULL AND status = 'connected') AS accounts_connected,
    (SELECT count(*)::int FROM telegram_accounts WHERE deleted_at IS NULL AND status <> 'connected') AS accounts_disconnected,
    (SELECT count(*)::int FROM telegram_sources WHERE deleted_at IS NULL AND kind IN ('group','supergroup')) AS groups,
    (SELECT count(*)::int FROM telegram_sources WHERE deleted_at IS NULL AND kind = 'channel') AS channels,
    (SELECT count(*)::int FROM telegram_sources WHERE deleted_at IS NULL AND kind IN ('private','saved')) AS chats,
    (SELECT COALESCE(sum(messages_processed), 0)::bigint FROM telegram_accounts WHERE deleted_at IS NULL) AS messages_processed,
    (SELECT count(*)::int FROM message_matches mm WHERE mm.deleted_at IS NULL AND mm.status <> 'ignored' AND NOT EXISTS (SELECT 1 FROM blocked_users bu WHERE bu.tg_user_id = mm.sender_id) AND NOT EXISTS (SELECT 1 FROM blocked_sources bs WHERE bs.tg_chat_id = mm.chat_id)) AS matches,
    (SELECT count(*)::int FROM message_matches mm WHERE mm.deleted_at IS NULL AND mm.status <> 'ignored' AND mm.priority IN ('high','critical') AND NOT EXISTS (SELECT 1 FROM blocked_users bu WHERE bu.tg_user_id = mm.sender_id) AND NOT EXISTS (SELECT 1 FROM blocked_sources bs WHERE bs.tg_chat_id = mm.chat_id)) AS matches_high,
    (SELECT count(*)::int FROM ai_rules WHERE deleted_at IS NULL AND status = 'active') AS ai_rules,
    (SELECT count(*)::int FROM notifications WHERE channel = 'dashboard' AND status <> 'read') AS alerts_unread,
    (SELECT count(*)::int FROM jobs WHERE state IN ('queued','running','paused')) AS tasks_active,
    (SELECT count(*)::int FROM jobs WHERE state = 'failed') AS tasks_failed,
    (SELECT count(*)::int FROM messages WHERE created_at > now() - interval '1 minute') AS messages_last_minute,
    (SELECT count(*)::int FROM messages WHERE state = 'pending') AS messages_pending`);
  return { ...r, processing_paused: await getSetting('processing.paused') };
}
