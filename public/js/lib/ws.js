// WebSocket client with capped exponential reconnect; a simple pub/sub for pages.
const subs = new Map(); let sock = null; let attempt = 0; let timer = null; let wanted = false;
export const live = { open: false };
const emit = (t, d) => { for (const fn of subs.get(t) ?? []) { try { fn(d); } catch (e) { console.error(e); } } for (const fn of subs.get('*') ?? []) { try { fn(t, d); } catch { /* ignore */ } } };
export function on(type, fn) { if (!subs.has(type)) subs.set(type, new Set()); subs.get(type).add(fn); return () => subs.get(type)?.delete(fn); }
export function connect() {
  wanted = true; if (sock && sock.readyState <= 1) return;
  sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  sock.onopen = () => { attempt = 0; live.open = true; emit('ws:open'); };
  sock.onmessage = (e) => { try { const m = JSON.parse(e.data); emit(m.t, m); } catch { /* ignore */ } };
  sock.onclose = () => { live.open = false; emit('ws:close'); if (wanted) timer = setTimeout(connect, Math.min(15000, 800 * 2 ** attempt++)); };
  sock.onerror = () => sock.close();
}
export function disconnect() { wanted = false; clearTimeout(timer); sock?.close(); }
