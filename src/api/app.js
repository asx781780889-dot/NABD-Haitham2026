// Express application: security headers, auth, CSRF, rate limits, REST routes, health/ready/metrics and the static frontend.
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { config, ROOT } from '../config.js';
import { dbPing, one } from '../lib/db.js';
import { redisState, pingRedis } from '../lib/redis.js';
import { requestContext, authenticate, csrfGuard, rateLimiter, systemPauseGuard, errorHandler, notFound, h } from './middleware.js';
import { systemStatus, workerRows } from '../services/status.js';
import { queueCounts } from '../lib/queue.js';
import { databaseStatus } from '../services/dbmonitor.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import sourceRoutes from './routes/sources.js';
import matchRoutes from './routes/matches.js';
import radarRoutes from './routes/radar.js';
import systemRoutes from './routes/system.js';

export function createApp({ getWsClients = () => 0 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } },
    crossOriginEmbedderPolicy: false, hsts: config.isProd && config.COOKIE_SECURE === 'true',
  }));
  app.use(requestContext);
  app.use(express.json({ limit: '1mb' }));

  const started = Date.now();
  app.get('/health', (req, res) => res.json({ status: 'ok', uptime_s: Math.round((Date.now() - started) / 1000), version: '1.0.0' }));
  app.get('/ready', h(async (req, res) => {
    const out = { database: false, redis: false, workers: false };
    try { await dbPing(); out.database = true; } catch (e) {
      // Safe public diagnostic: no DSN, username, or password is exposed.
      out.database_error = { code: e?.code ?? 'UNKNOWN', message: String(e?.message ?? 'connection failed').slice(0, 180) };
    }
    out.redis = (await pingRedis()).ok;
    if (out.database) out.workers = (await workerRows()).some((w) => w.online);
    const ready = out.database; // Redis / workers degrade functionality but do not make the API unusable
    res.status(ready ? 200 : 503).json({ status: ready ? (out.redis && out.workers ? 'ready' : 'degraded') : 'not_ready', ...out });
  }));
  app.get('/metrics', authenticate, h(async (req, res) => {
    const token = process.env.METRICS_TOKEN; const ip = req.socket.remoteAddress ?? '';
    const ok = token ? req.headers.authorization === `Bearer ${token}` : (req.user || /^(::1|127\.|::ffff:127\.)/.test(ip));
    if (!ok) return res.status(401).type('text/plain').send('unauthorized\n');
    const L = []; const g = (name, help, val, labels = '') => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${val}`); };
    g('nabd_up', 'API process up', 1); g('process_uptime_seconds', 'Process uptime', Math.round(process.uptime())); g('process_resident_memory_bytes', 'RSS', process.memoryUsage().rss);
    g('nabd_ws_clients', 'Connected websocket clients', getWsClients());
    let dbUp = 1; try { await dbPing(); } catch { dbUp = 0; }
    g('nabd_database_up', 'Database reachable', dbUp); g('nabd_redis_up', 'Redis reachable', redisState.ok ? 1 : 0);
    if (dbUp) {
      const [s, st, w, acc, ai, counts] = await Promise.all([databaseStatus(), systemStatus(), workerRows(), one("SELECT count(*) FILTER (WHERE status = 'connected')::int AS c, count(*)::int AS t FROM telegram_accounts WHERE deleted_at IS NULL"),
        one("SELECT count(*)::int AS calls, count(*) FILTER (WHERE status = 'error')::int AS errors FROM api_usage WHERE created_at > now() - interval '24 hours'"), queueCounts()]);
      g('nabd_database_size_bytes', 'Database size', s.size_bytes); g('nabd_database_used_percent', 'Database capacity used', s.percent);
      g('nabd_workers_online', 'Worker modules online', w.filter((x) => x.online).length); g('nabd_accounts_connected', 'Connected Telegram accounts', acc.c); g('nabd_accounts_total', 'Telegram accounts', acc.t);
      g('nabd_ai_calls_24h', 'AI calls in last 24h', ai.calls); g('nabd_ai_errors_24h', 'AI errors in last 24h', ai.errors); g('nabd_system_component_ok', 'Components online (count)', Object.values(st).filter((c) => c.status === 'online').length);
      L.push('# TYPE nabd_queue_jobs gauge');
      for (const [q, c] of Object.entries(counts)) for (const [state, n] of Object.entries(c ?? {})) L.push(`nabd_queue_jobs{queue="${q}",state="${state}"} ${n}`);
    }
    res.type('text/plain; version=0.0.4').send(`${L.join('\n')}\n`);
  }));

  app.use('/api', authenticate, rateLimiter, csrfGuard, systemPauseGuard);
  app.use('/api/auth', authRoutes.auth); app.use('/api/setup', authRoutes.setup); app.use('/api/users', authRoutes.users);
  app.use('/api/accounts', accountRoutes);
  app.use('/api/sources', sourceRoutes);
  app.use('/api', matchRoutes);
  app.use('/api', radarRoutes);
  app.use('/api', systemRoutes);
  app.use('/api', notFound);

  if (config.SERVE_STATIC) {
    app.use(express.static(path.join(ROOT, 'public'), { maxAge: '5m', etag: true, index: 'index.html' }));
  }
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
