// /api/auth, /api/setup (first-run onboarding) and /api/users (RBAC administration).
import express from 'express';
import { z } from 'zod';
import { query, one, many, tx } from '../../lib/db.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { getSetting, setSetting } from '../../lib/settings.js';
import { hit, resetLimit } from '../../lib/ratelimit.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../config.js';
import { h, need, reauth, COOKIE, parseCookies, idParam } from '../middleware.js';
import { pingRedis } from '../../lib/redis.js';
import { dbPing } from '../../lib/db.js';
import { workerRows } from '../../services/status.js';
import { aiAvailable } from '../../ai/manager.js';

const auth = express.Router(); const setup = express.Router(); const users = express.Router();
const DUMMY = await hashPassword('nabd-dummy-password');
const username = z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/, 'letters, digits, . _ - only');
const actor = (req, name) => ({ ip: req.ip, headers: req.headers, id: req.id, username: name, user: req.user });
const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, display_name: u.display_name, language: u.language, theme: u.theme });

async function checkPassword(pw) {
  const min = await getSetting('security.password_min_length');
  if (pw.length < min || !/[A-Za-z\u0600-\u06FF]/.test(pw) || !/\d/.test(pw)) throw new AppError('VALIDATION', { details: [{ path: ['password'], message: `at least ${min} characters, with letters and digits` }] });
}
async function startSession(req, res, userId) {
  const token = randomToken(32); const csrf = randomToken(24); const ttl = await getSetting('security.session_ttl_hours');
  await query('INSERT INTO user_sessions (token_hash, user_id, csrf_token, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6))',
    [sha256(token), userId, csrf, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 200), ttl]);
  const secure = config.COOKIE_SECURE === 'true' || (config.COOKIE_SECURE === 'auto' && req.secure);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge: ttl * 3600 * 1000, path: '/' });
  return csrf;
}

auth.post('/login', h(async (req, res) => {
  const { username: name, password } = z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(200) }).parse(req.body);
  const lim = await getSetting('security.login_rate_limit_per_min');
  const [a, b] = await Promise.all([hit(`login:ip:${req.ip}`, lim, 60), hit(`login:u:${name.toLowerCase()}`, lim, 60)]);
  if (!a.allowed || !b.allowed) { res.setHeader('Retry-After', String(Math.max(a.resetSec, b.resetSec))); throw new AppError('RATE_LIMITED', { status: 429 }); }
  const u = await one('SELECT * FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL', [name]);
  if (u?.locked_until && new Date(u.locked_until) > new Date()) { await audit(actor(req, name), 'LOGIN_LOCKED', { result: 'denied' }); throw new AppError('ACCOUNT_LOCKED', { status: 423 }); }
  const ok = await verifyPassword(password, u?.password_hash ?? DUMMY);
  if (!u || !ok || !u.is_active) {
    if (u) {
      const max = await getSetting('security.max_failed_logins'); const mins = await getSetting('security.lockout_minutes');
      await query('UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id = $1', [u.id, max, mins]);
    }
    await audit(actor(req, name), 'LOGIN_FAILED', { result: 'denied' });
    throw new AppError('INVALID_CREDENTIALS', { status: 401 });
  }
  await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  await resetLimit(`login:u:${name.toLowerCase()}`);
  const csrf = await startSession(req, res, u.id);
  await audit(actor(req, u.username), 'LOGIN_SUCCESS', { entity: 'user', entityId: u.id });
  res.json({ user: publicUser(u), csrf });
}));
auth.post('/logout', h(async (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await query('DELETE FROM user_sessions WHERE token_hash = $1', [sha256(token)]);
  res.clearCookie(COOKIE, { path: '/' });
  if (req.user) await req.audit('LOGOUT');
  res.json({ ok: true });
}));
auth.get('/me', h(async (req, res) => {
  if (!req.user) throw new AppError('UNAUTHENTICATED', { status: 401 });
  res.json({ user: req.user, csrf: req.session.csrf, defaults: { language: await getSetting('language.default'), theme: await getSetting('appearance.theme') }, setup_complete: await getSetting('general.setup_complete') });
}));
auth.post('/password', need('viewer'), h(async (req, res) => {
  const { current, next } = z.object({ current: z.string().min(1), next: z.string().min(8).max(200) }).parse(req.body);
  const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(current, u.password_hash))) throw new AppError('INVALID_CREDENTIALS', { status: 401 });
  await checkPassword(next);
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(next)]);
  await query('DELETE FROM user_sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.session.id]);
  await req.audit('PASSWORD_CHANGED', { entity: 'user', entityId: req.user.id });
  res.json({ ok: true });
}));
auth.patch('/preferences', need('viewer'), h(async (req, res) => {
  const b = z.object({ language: z.enum(['ar', 'en']).optional(), theme: z.enum(['dark', 'light']).optional(), display_name: z.string().trim().max(80).optional() }).parse(req.body);
  await query('UPDATE users SET language = COALESCE($2, language), theme = COALESCE($3, theme), display_name = COALESCE($4, display_name) WHERE id = $1', [req.user.id, b.language ?? null, b.theme ?? null, b.display_name ?? null]);
  res.json({ ok: true });
}));

setup.get('/status', h(async (req, res) => {
  const n = (await one('SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL')).n;
  res.json({ needs_admin: n === 0, setup_complete: await getSetting('general.setup_complete'), language: await getSetting('language.default') });
}));
setup.post('/admin', h(async (req, res) => {
  const b = z.object({ username, password: z.string().min(8).max(200), display_name: z.string().trim().max(80).optional() }).parse(req.body);
  await checkPassword(b.password);
  const hash = await hashPassword(b.password);
  const u = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(727275)');
    if ((await c.query('SELECT count(*)::int AS n FROM users')).rows[0].n > 0) throw new AppError('SETUP_DONE', { status: 409 });
    return (await c.query("INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,'admin',$3) RETURNING *", [b.username, hash, b.display_name ?? b.username])).rows[0];
  });
  const csrf = await startSession(req, res, u.id);
  await audit(actor(req, u.username), 'ADMIN_CREATED', { entity: 'user', entityId: u.id });
  res.status(201).json({ user: publicUser(u), csrf });
}));
setup.get('/checks', need('admin'), h(async (req, res) => {
  const out = {};
  try { out.database = { ok: true, ms: await dbPing() }; } catch (e) { out.database = { ok: false, error: e.message }; }
  out.redis = await pingRedis();
  out.ai = { ok: await aiAvailable() };
  out.accounts = { count: (await one('SELECT count(*)::int AS n FROM telegram_accounts WHERE deleted_at IS NULL')).n, connected: (await one("SELECT count(*)::int AS n FROM telegram_accounts WHERE deleted_at IS NULL AND status = 'connected'")).n };
  out.radars = { count: (await one("SELECT count(*)::int AS n FROM ai_rules WHERE deleted_at IS NULL AND status = 'active'")).n };
  out.workers = { online: (await workerRows()).filter((w) => w.online).length };
  res.json(out);
}));
setup.post('/complete', need('admin'), h(async (req, res) => { await setSetting('general.setup_complete', true, req.user.id); await req.audit('SETUP_COMPLETED'); res.json({ ok: true }); }));

const roleS = z.enum(['admin', 'operator', 'viewer']);
const adminCount = async (c = { query }) => (await c.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active AND deleted_at IS NULL")).rows[0].n;
users.get('/', need('admin'), h(async (req, res) => res.json({ data: await many('SELECT id, username, role, display_name, is_active, last_login_at, created_at, locked_until FROM users WHERE deleted_at IS NULL ORDER BY id') })));
users.post('/', need('admin'), reauth, h(async (req, res) => {
  const b = z.object({ username, password: z.string().min(8).max(200), role: roleS, display_name: z.string().trim().max(80).optional() }).parse(req.body);
  await checkPassword(b.password);
  const u = await one('INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,$3,$4) RETURNING id, username, role, display_name', [b.username, await hashPassword(b.password), b.role, b.display_name ?? b.username]);
  await req.audit('USER_CREATED', { entity: 'user', entityId: u.id, details: { role: b.role } });
  res.status(201).json({ data: u });
}));
users.patch('/:id', need('admin'), h(async (req, res) => {
  const id = idParam(req);
  const b = z.object({ role: roleS.optional(), is_active: z.boolean().optional(), display_name: z.string().trim().max(80).optional(), password: z.string().min(8).max(200).optional() }).parse(req.body);
  if (b.password || b.role || b.is_active === false) await new Promise((ok, no) => reauth(req, res, (e) => (e ? no(e) : ok())));
  const cur = await one('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!cur) throw new AppError('NOT_FOUND', { status: 404 });
  if (cur.role === 'admin' && ((b.role && b.role !== 'admin') || b.is_active === false) && (await adminCount()) <= 1) throw new AppError('BAD_STATE', { status: 409, message: 'cannot demote or disable the last admin' });
  if (b.password) await checkPassword(b.password);
  await query('UPDATE users SET role = COALESCE($2, role), is_active = COALESCE($3, is_active), display_name = COALESCE($4, display_name), password_hash = COALESCE($5, password_hash), failed_logins = 0, locked_until = NULL WHERE id = $1',
    [id, b.role ?? null, b.is_active ?? null, b.display_name ?? null, b.password ? await hashPassword(b.password) : null]);
  if (b.password || b.is_active === false || b.role) await query('DELETE FROM user_sessions WHERE user_id = $1', [id]);
  await req.audit('USER_UPDATED', { entity: 'user', entityId: id, details: { role: b.role, is_active: b.is_active, password_reset: !!b.password } });
  res.json({ ok: true });
}));
users.delete('/:id', need('admin'), reauth, h(async (req, res) => {
  const id = idParam(req);
  if (id === req.user.id) throw new AppError('BAD_STATE', { status: 409, message: 'cannot delete yourself' });
  const cur = await one('SELECT role FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!cur) throw new AppError('NOT_FOUND', { status: 404 });
  if (cur.role === 'admin' && (await adminCount()) <= 1) throw new AppError('BAD_STATE', { status: 409, message: 'cannot delete the last admin' });
  await query("UPDATE users SET deleted_at = now(), is_active = false, username = username || '#' || id WHERE id = $1", [id]);
  await query('DELETE FROM user_sessions WHERE user_id = $1', [id]);
  await req.audit('USER_DELETED', { entity: 'user', entityId: id });
  res.json({ ok: true });
}));

export default { auth, setup, users };
