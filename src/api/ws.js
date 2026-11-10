// Real-time channel: authenticated WebSocket fed by the PostgreSQL event bus. Blocks are enforced here, before anything reaches the browser.
import { WebSocketServer } from 'ws';
import { subscribe } from '../lib/bus.js';
import { one, many } from '../lib/db.js';
import { hydrateCards } from '../services/cards.js';
import { blockedSets } from '../services/blocks.js';
import { channelPlan } from '../services/notifier.js';
import { systemStatus } from '../services/status.js';
import { SAFE_ACCOUNT_COLUMNS } from '../services/accounts.js';
import { COOKIE, parseCookies, sessionFromToken, originAllowed } from './middleware.js';
import { logger } from '../lib/logger.js';

const log = logger('ws');

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const reject = (socket, code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (!req.url?.startsWith('/ws')) return reject(socket, 404, 'Not Found');
      if (!originAllowed(req.headers.origin, req.headers.host)) return reject(socket, 403, 'Forbidden');
      const user = await sessionFromToken(parseCookies(req.headers.cookie)[COOKIE]);
      if (!user) return reject(socket, 401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => { ws.user = { id: user.id, role: user.role }; wss.emit('connection', ws); });
    } catch { reject(socket, 500, 'Internal Server Error'); }
  });
  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
  const broadcast = (msg) => { if (!wss.clients.size) return; const s = JSON.stringify(msg); for (const ws of wss.clients) send(ws, s); };
  wss.on('connection', (ws) => {
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); ws.on('error', () => {});
    ws.on('message', (d) => { try { if (JSON.parse(d.toString()).t === 'ping') send(ws, { t: 'pong' }); } catch { /* ignore */ } });
    send(ws, { t: 'hello', server_time: Date.now() });
    systemStatus().then((s) => send(ws, { t: 'system.status', status: s })).catch(() => {});
  });

  const pending = new Map(); let flushTimer = null;
  async function flushMatches() {
    flushTimer = null; const batch = [...pending]; pending.clear();
    try {
      const cards = await hydrateCards(batch.map(([id]) => id));
      const { users, sources } = await blockedSets(); const kinds = new Map(batch);
      for (const c of cards) {
        if ((c.sender.id != null && users.has(c.sender.id)) || sources.has(c.source.tg_chat_id) || c.status === 'ignored') continue;
        const plan = await channelPlan(c.priority, new Set(c.force_channels));
        broadcast({ t: kinds.get(c.id), card: c, ui: { browser: plan.browser, sound: plan.sound } });
      }
    } catch (e) { log.warn('match broadcast failed', { err: e.message }); }
  }
  const sub = subscribe(async (m) => {
    try {
      if (m.t === 'match.new' || m.t === 'match.update') { pending.set(m.id, m.t === 'match.new' || pending.get(m.id) === 'match.new' ? 'match.new' : 'match.update'); flushTimer ??= setTimeout(flushMatches, 120); }
      else if (m.t === 'alert.new') { const a = await one('SELECT id, kind, severity, title, body, match_id, created_at FROM notifications WHERE id = $1', [m.id]); if (a) broadcast({ t: 'alert.new', alert: a }); }
      else if (m.t === 'account.status') { const a = await one(`SELECT ${SAFE_ACCOUNT_COLUMNS} FROM telegram_accounts a WHERE a.id = $1`, [m.id]); if (a) broadcast({ t: 'account.status', account: a }); }
      else if (m.t === 'worker.status' || m.t === 'job.update' || m.t === 'system.status') broadcast({ t: m.t, id: m.id ?? null });
    } catch (e) { log.debug('event relay failed', { err: e.message }); }
  });
  const timers = [
    setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch { /* closed */ } } }, 30000),
    setInterval(async () => { if (!wss.clients.size) return; try { broadcast({ t: 'system.status', status: await systemStatus(true) }); } catch { /* db down: next tick */ } }, 5000),
    setInterval(async () => {
      if (!wss.clients.size) return;
      try { const r = await one("SELECT count(*)::int AS per_minute FROM messages WHERE created_at > now() - interval '1 minute'"); broadcast({ t: 'stats.tick', ...r }); } catch { /* ignore */ }
    }, 4000),
  ];
  timers.forEach((t) => t.unref());
  return { wss, clients: () => wss.clients.size, close: () => { timers.forEach(clearInterval); sub.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); } };
}
export { many };
