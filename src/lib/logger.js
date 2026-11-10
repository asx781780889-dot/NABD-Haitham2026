// Structured logger: 5 levels, JSON lines on stdout, in-memory ring buffer, async DB sink for WARNING+.
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';

export const als = new AsyncLocalStorage();
export const LEVELS = { debug: 10, info: 20, warning: 30, error: 40, critical: 50 };
let consoleMin = LEVELS[config.LOG_LEVEL] ?? 20;
let dbMin = LEVELS.warning;
const ring = [];
const RING_MAX = 500;
let dbSink = null;
const buf = [];
const SENSITIVE = /pass(word)?|secret|token|api_?key|api_?hash|session|authorization|cookie|^code$|phone_?code|^phone$/i;

export function redact(v, depth = 0) {
  if (v == null || depth > 4) return v;
  if (v instanceof Error) return { name: v.name, message: v.message, code: v.code, stack: config.isProd ? undefined : v.stack?.split('\n').slice(0, 4).join('\n') };
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = SENSITIVE.test(k) ? '[redacted]' : redact(x, depth + 1);
    return o;
  }
  if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '…';
  return v;
}

function emit(level, source, msg, ctx) {
  const n = LEVELS[level];
  if (n < consoleMin && n < dbMin) return;
  const reqId = als.getStore()?.reqId;
  const rec = { ts: new Date().toISOString(), level, source, msg: String(msg), ...(ctx !== undefined ? { ctx: redact(ctx) } : {}), ...(reqId ? { reqId } : {}) };
  if (n >= consoleMin) {
    if (!config.isTest) process.stdout.write(JSON.stringify(rec) + '\n');
    ring.push(rec);
    if (ring.length > RING_MAX) ring.shift();
  }
  if (n >= dbMin && dbSink) {
    buf.push(rec);
    if (buf.length >= 50) void flushLogs();
  }
}

export function logger(source) {
  return {
    debug: (m, c) => emit('debug', source, m, c),
    info: (m, c) => emit('info', source, m, c),
    warn: (m, c) => emit('warning', source, m, c),
    error: (m, c) => emit('error', source, m, c),
    critical: (m, c) => emit('critical', source, m, c),
  };
}
export const recentLogs = (n = 100) => ring.slice(-n);
export function setLogLevels({ console: c, db }) {
  if (c && LEVELS[c]) consoleMin = LEVELS[c];
  if (db && LEVELS[db]) dbMin = LEVELS[db];
}
export function attachDbSink(fn) { dbSink = fn; }
export async function flushLogs() {
  if (!dbSink || !buf.length) return;
  const rows = buf.splice(0, buf.length);
  try { await dbSink(rows); } catch { /* never recurse on log failures */ }
}
setInterval(flushLogs, 5000).unref();
