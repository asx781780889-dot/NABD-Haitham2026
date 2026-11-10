// Event bus over PostgreSQL LISTEN/NOTIFY: works even when Redis is down. Events carry ids; consumers hydrate.
import { notify, listen } from './db.js';
import { logger } from './logger.js';

const log = logger('bus');
export const EVENTS = 'nabd_events';
export const CONTROL = 'nabd_control';

export async function publish(type, payload = {}, client) {
  let s = JSON.stringify({ t: type, ...payload });
  if (Buffer.byteLength(s) > 7000) s = JSON.stringify({ t: type, id: payload.id, trimmed: true });
  try { await notify(EVENTS, s, client); } catch (e) { log.warn('publish failed', { type, err: e.message }); }
}
export function subscribe(fn, channel = EVENTS) {
  return listen(channel, (p) => { let m; try { m = JSON.parse(p); } catch { return; } fn(m); });
}
export async function sendControl(cmd) { await notify(CONTROL, cmd); }
