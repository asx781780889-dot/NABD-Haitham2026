// Dev/QA only: boots the whole stack (real PostgreSQL + Redis, real API + workers) with a fake Telegram transport and a fake AI service,
// serves the frontend and exposes a tiny control API so a browser test can inject Telegram messages. Never used in production.
import http from 'node:http';
import { startHarness } from './harness.js';
import { world, deliver } from './fakes.js';

const PORT = Number(process.env.UI_PORT || 18090);
const h = await startHarness({ serveStatic: true, port: PORT });
const ctl = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {}; const out = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/info') return out({ ai: `${h.svc.url}/v1`, port: h.srv.port });
  if (req.url === '/add-account') { world.addAccount(body.phone, { userId: body.userId, username: body.username, password: body.password ?? null, dialogs: body.dialogs }); return out({ ok: true }); }
  if (req.url === '/deliver') return out({ delivered: deliver(body.phone, body.msg) });
  if (req.url === '/ai-mode') { h.svc.ai.mode = body.mode; return out({ ok: true }); }
  res.writeHead(404); res.end();
});
ctl.listen(PORT + 1, '127.0.0.1', () => console.log(`READY http://127.0.0.1:${PORT} control:${PORT + 1}`));
const stop = async () => { ctl.close(); await h.stop(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
