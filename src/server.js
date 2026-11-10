// API service entry point: HTTP + WebSocket (+ optional embedded worker for single-process deployments).
import http from 'node:http';
import { config } from './config.js';
import { bootstrap, shutdownCommon, isTransient } from './boot.js';
import { createApp } from './api/app.js';
import { attachWebSocket } from './api/ws.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';

const log = logger('server');

export async function startServer({ port = config.PORT, host = config.HOST, boot = true } = {}) {
  if (boot) await bootstrap('api');
  redis(); // start connecting; the API stays usable while Redis is down
  let ws = null;
  const app = createApp({ getWsClients: () => ws?.clients() ?? 0 });
  const server = http.createServer(app);
  server.headersTimeout = 20000; server.requestTimeout = 60000; server.keepAliveTimeout = 5000;
  ws = attachWebSocket(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const addr = server.address();
  log.info('NABD AI API listening', { host, port: addr.port });
  let workers = null;
  if (config.EMBED_WORKER) { const { startWorkers } = await import('./worker.js'); workers = await startWorkers({ boot: false }); log.info('embedded worker started'); }
  return { app, server, ws, port: addr.port, async close() { await workers?.stop(); ws.close(); await new Promise((r) => server.close(r)); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startServer();
  console.log(`\n  NABD AI is running →  http://${config.HOST === '0.0.0.0' ? '127.0.0.1' : config.HOST}:${s.port}\n`);
  let closing = false;
  const down = async (sig) => {
    if (closing) return; closing = true; log.info(`received ${sig}, shutting down`);
    const t = setTimeout(() => process.exit(1), 15000); t.unref();
    await s.close(); await shutdownCommon(); process.exit(0);
  };
  process.on('SIGINT', () => void down('SIGINT')); process.on('SIGTERM', () => void down('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: e, transient: isTransient(e) }));
  process.on('uncaughtException', (e) => { if (isTransient(e)) return log.error('transient infrastructure error (service keeps running)', { err: e }); log.critical('uncaught exception', { err: e }); void down('uncaughtException'); });
}
