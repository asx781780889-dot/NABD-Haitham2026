// HTTP middleware: request ids, session auth, CSRF + Origin checks, rate limiting, RBAC, step-up auth, error handling.
import crypto from 'node:crypto';
import { ZodError } from 'zod';
import { query, one } from '../lib/db.js';
import { sha256, safeEqual, verifyPassword } from '../lib/crypto.js';
import { AppError, errorBody, newErrorId } from '../lib/errors.js';
import { als, logger } from '../lib/logger.js';
import { hit } from '../lib/ratelimit.js';
import { getSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';

const log = logger('api');
export const COOKIE = 'nabd_sid';
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const extraOrigins = new Set((config.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ } } }
  return out;
}
export function originAllowed(origin, host) {
  if (!origin) return true;
  try { return new URL(origin).host === host || extraOrigins.has(origin); } catch { return false; }
}

export function requestContext(req, res, next) {
  const given = req.headers['x-request-id'];
  req.id = typeof given === 'string' && /^[\w-]{6,64}$/.test(given) ? given : crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  req.audit = (action, o) => audit(req, action, o);
  als.run({ reqId: req.id }, next);
}

export async function sessionFromToken(token) {
  if (!token) return null;
  const row = await one(`SELECT s.id AS sid, s.csrf_token, s.last_seen_at, u.id, u.username, u.role, u.display_name, u.language, u.theme, u.is_active
    FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND u.deleted_at IS NULL`, [sha256(token)]);
  if (!row || !row.is_active) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60 * 1000) query('UPDATE user_sessions SET last_seen_at = now() WHERE id = $1', [row.sid]).catch(() => {});
  return row;
}
export const authenticate = h(async (req, res, next) => {
  const row = await sessionFromToken(parseCookies(req.headers.cookie)[COOKIE]);
  if (row) { req.user = { id: row.id, username: row.username, role: row.role, display_name: row.display_name, language: row.language, theme: row.theme }; req.session = { id: row.sid, csrf: row.csrf_token }; }
  next();
});

export function csrfGuard(req, res, next) {
  if (SAFE.has(req.method)) return next();
  if (!originAllowed(req.headers.origin, req.headers.host)) return next(new AppError('CSRF', { status: 403 }));
  if (req.user) { const t = req.headers['x-csrf-token']; if (typeof t !== 'string' || !safeEqual(t, req.session.csrf)) return next(new AppError('CSRF', { status: 403 })); }
  next();
}
export const rateLimiter = h(async (req, res, next) => {
  const r = await hit(`api:${req.user?.id ?? req.ip}`, await getSetting('security.rate_limit_per_min'), 60);
  res.setHeader('X-RateLimit-Remaining', String(r.remaining));
  if (!r.allowed) { res.setHeader('Retry-After', String(r.resetSec)); return next(new AppError('RATE_LIMITED', { status: 429 })); }
  next();
});
const PAUSE_ALLOWED = new Set(['/system/pause', '/auth/login', '/auth/me', '/auth/logout', '/setup/status']);
export const systemPauseGuard = h(async (req, res, next) => {
  if (!await getSetting('system.paused') || PAUSE_ALLOWED.has(req.path)) return next();
  return next(new AppError('SYSTEM_PAUSED', { status: 423 }));
});

const RANK = { viewer: 1, operator: 2, admin: 3 };
export const need = (role) => (req, res, next) => {
  if (!req.user) return next(new AppError('UNAUTHENTICATED', { status: 401 }));
  if (RANK[req.user.role] < RANK[role]) return next(new AppError('FORBIDDEN', { status: 403 }));
  next();
};
/** Step-up authentication for dangerous operations: the current password must be supplied in X-Confirm-Password. */
export const reauth = h(async (req, res, next) => {
  const pw = req.headers['x-confirm-password'];
  if (typeof pw !== 'string' || !pw) return next(new AppError('REAUTH_REQUIRED', { status: 401 }));
  const r = await hit(`reauth:${req.user.id}`, 6, 60);
  if (!r.allowed) return next(new AppError('RATE_LIMITED', { status: 429 }));
  const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!u || !(await verifyPassword(pw, u.password_hash))) { await audit(req, 'REAUTH_FAILED', { result: 'denied' }); return next(new AppError('REAUTH_REQUIRED', { status: 401, message: 'wrong password' })); }
  next();
});

export const paging = (q, { max = 200, def = 50 } = {}) => {
  const limit = Math.min(max, Math.max(1, parseInt(q.limit, 10) || def)); const page = Math.max(1, parseInt(q.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
};
export const pageMeta = (total, p) => ({ total, page: p.page, limit: p.limit, pages: Math.max(1, Math.ceil(total / p.limit)) });
/** cols: {column: 'jsonb'|undefined}. Only whitelisted columns present in `obj` are updated. */
export function buildUpdate(obj, cols, start = 2) {
  const sets = []; const vals = [];
  for (const [k, kind] of Object.entries(cols)) {
    if (obj[k] === undefined) continue;
    vals.push(kind === 'jsonb' ? JSON.stringify(obj[k]) : obj[k]);
    sets.push(`${k} = $${start + vals.length - 1}${kind === 'jsonb' ? '::jsonb' : ''}`);
  }
  return { sets, vals };
}
export const idParam = (req) => { const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) throw new AppError('VALIDATION', { details: [{ path: ['id'], message: 'invalid id' }] }); return id; };
export const csv = (v) => (v == null || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));

export function notFound(req, res, next) { next(new AppError('NOT_FOUND', { status: 404 })); }
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const id = newErrorId(); let e = err;
  if (err instanceof ZodError) e = new AppError('VALIDATION', { details: err.issues.map((i) => ({ path: i.path, message: i.message })) });
  else if (err?.type === 'entity.parse.failed') e = new AppError('VALIDATION', { message: 'invalid JSON body' });
  else if (err?.type === 'entity.too.large') e = new AppError('VALIDATION', { status: 413, message: 'payload too large' });
  else if (err?.code === '23505' || err?.code === '23503') e = new AppError('CONFLICT', { status: 409 });
  else if (err?.code === '23514' || err?.code === '22P02' || err?.code === '22003') e = new AppError('VALIDATION', { message: 'invalid value' });
  else if (!(err instanceof AppError) && (['ECONNREFUSED', '57P01', '08006', '08001', '53300'].includes(err?.code) || /Connection terminated|timeout exceeded when trying to connect/i.test(err?.message ?? ''))) e = new AppError('DB_UNAVAILABLE', { status: 503, cause: err });
  const status = e instanceof AppError ? e.status : 500;
  if (status >= 500) log.error('request failed', { id, method: req.method, path: req.path, err });
  if (res.headersSent) return;
  res.status(status).json(errorBody(e instanceof AppError ? e : new AppError('INTERNAL', { status: 500 }), id));
}
