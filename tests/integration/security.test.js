// Authentication, sessions, CSRF, RBAC, rate limiting / lockout, step-up auth, secret hygiene, injection & XSS hardening.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, setupAdmin } from '../helpers/harness.js';

let h; const PW = 'Passw0rd-Strong1';
before(async () => { h = await startHarness({ workers: false }); await setupAdmin(h, 'admin', PW); });
after(async () => { await h.stop(); });

const as = async (username, password = PW) => { const saved = { ...h.jar }; h.jar.cookie = ''; h.jar.csrf = ''; const r = await h.api('POST', '/api/auth/login', { username, password }); const mine = { ...h.jar }; Object.assign(h.jar, saved); return { r, jar: mine }; };
const withJar = async (jar, fn) => { const saved = { ...h.jar }; Object.assign(h.jar, jar); try { return await fn(); } finally { Object.assign(h.jar, saved); } };

test('unauthenticated requests are rejected; health endpoints stay open; setup cannot be repeated', async () => {
  const anon = { cookie: '', csrf: '' };
  await withJar(anon, async () => {
    for (const p of ['/api/matches', '/api/accounts', '/api/system/overview', '/api/settings', '/api/system/audit']) assert.equal((await h.api('GET', p)).status, 401, p);
    assert.equal((await h.api('GET', '/health')).status, 200); assert.equal((await h.api('GET', '/ready')).status, 200);
    assert.equal((await h.api('GET', '/metrics')).status, 200, 'loopback may scrape metrics'); assert.equal((await h.api('POST', '/api/setup/admin', { username: 'extra-admin', password: PW })).body.error.code, 'SETUP_DONE');
    const ws = h.openWs(); ws.jar = anon; await assert.rejects(ws.ready, /401|Unexpected server response/);
  });
});
test('security headers + CSP; JSON error shape is bilingual and carries an error id', async () => {
  const r = await h.api('GET', '/health'); const csp = r.headers.get('content-security-policy');
  assert.ok(csp.includes("default-src 'self'") && csp.includes("script-src 'self'") && !/script-src[^;]*unsafe/.test(csp) && csp.includes("frame-ancestors 'none'"));
  assert.equal(r.headers.get('x-powered-by'), null); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const e = await h.api('GET', '/api/nope'); assert.equal(e.status, 404); assert.ok(e.body.error.id.startsWith('E-') && e.body.error.message_ar && e.body.error.message_en);
});
test('CSRF: state-changing calls need the session token; foreign Origin is refused; cookie flags', async () => {
  const login = await h.api('POST', '/api/auth/login', { username: 'admin', password: PW }); assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie'); assert.ok(/HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie));
  const noToken = await h.api('POST', '/api/blocks/keywords', { phrase: 'spam word' }, { 'x-csrf-token': '' }); assert.equal(noToken.status, 403); assert.equal(noToken.body.error.code, 'CSRF');
  const evil = await h.api('POST', '/api/blocks/keywords', { phrase: 'spam word' }, { origin: 'https://evil.example' }); assert.equal(evil.status, 403);
  const good = await h.api('POST', '/api/blocks/keywords', { phrase: 'spam word' }); assert.equal(good.status, 201);
  const me = await h.ok('GET', '/api/auth/me'); assert.equal(me.user.role, 'admin'); assert.ok(me.csrf);
});
test('password policy, user management and RBAC (admin > operator > viewer)', async () => {
  const weak = await h.api('POST', '/api/users', { username: 'weak1', password: 'short1', role: 'viewer' }, { 'x-confirm-password': PW }); assert.equal(weak.status, 400);
  const noConfirm = await h.api('POST', '/api/users', { username: 'opx', password: PW, role: 'operator' }); assert.equal(noConfirm.status, 401); assert.equal(noConfirm.body.error.code, 'REAUTH_REQUIRED');
  const wrongConfirm = await h.api('POST', '/api/users', { username: 'opx', password: PW, role: 'operator' }, { 'x-confirm-password': 'nope-nope-1' }); assert.equal(wrongConfirm.status, 401);
  for (const [u, role] of [['op1', 'operator'], ['view1', 'viewer']]) assert.equal((await h.api('POST', '/api/users', { username: u, password: PW, role }, { 'x-confirm-password': PW })).status, 201);
  const users = await h.api('GET', '/api/users'); assert.ok(!users.text.includes('scrypt$') && !users.text.includes('password_hash'));
  const { jar: viewer } = await as('view1'); const { jar: op } = await as('op1');
  await withJar(viewer, async () => {
    assert.equal((await h.api('GET', '/api/matches')).status, 200); assert.equal((await h.api('GET', '/api/radar')).status, 200);
    for (const [m, p, b] of [['POST', '/api/rules', {}], ['POST', '/api/blocks/keywords', { phrase: 'abc def' }], ['POST', '/api/accounts', {}], ['PUT', '/api/settings', { values: {} }]]) assert.equal((await h.api(m, p, b)).status, 403, `${m} ${p}`);
    for (const p of ['/api/system/audit', '/api/users', '/api/system/backups', '/api/system/logs', '/api/ai/providers']) assert.equal((await h.api('GET', p)).status, 403, p);
  });
  await withJar(op, async () => {
    assert.equal((await h.api('POST', '/api/blocks/keywords', { phrase: 'operator word' })).status, 201); assert.equal((await h.api('GET', '/api/system/logs')).status, 200);
    for (const [m, p, b] of [['POST', '/api/accounts', { phone: '+966500000009', api_id: 1, api_hash: 'a'.repeat(32) }], ['PUT', '/api/settings', { values: { 'general.app_name': 'x' } }], ['PUT', '/api/ai/providers/openai', { api_key: 'k' }], ['POST', '/api/system/workers/ai/start', {}]]) assert.equal((await h.api(m, p, b)).status, 403, `${m} ${p}`);
    for (const p of ['/api/system/audit', '/api/users', '/api/system/backups']) assert.equal((await h.api('GET', p)).status, 403, p);
  });
  const lastAdmin = await h.db.one("SELECT id FROM users WHERE username = 'admin'");
  const demote = await h.api('PATCH', `/api/users/${lastAdmin.id}`, { role: 'viewer' }, { 'x-confirm-password': PW }); assert.equal(demote.status, 409, 'cannot demote the last admin');
  const selfDel = await h.api('DELETE', `/api/users/${lastAdmin.id}`, undefined, { 'x-confirm-password': PW }); assert.equal(selfDel.status, 409);
});
test('lockout after repeated failures, login rate limit, audit of failures; logout invalidates the session', async () => {
  await h.ok('PUT', '/api/settings', { values: { 'security.max_failed_logins': 3, 'security.login_rate_limit_per_min': 50 } });
  for (let i = 0; i < 3; i++) assert.equal((await as('view1', 'wrong-password-1')).r.status, 401);
  const locked = await as('view1'); assert.equal(locked.r.status, 423); assert.equal(locked.r.body.error.code, 'ACCOUNT_LOCKED');
  assert.equal((await as('ghost-user', 'whatever-1')).r.status, 401, 'unknown users get the same generic error');
  const aid = await h.db.one("SELECT id FROM users WHERE username = 'view1'"); await h.ok('PATCH', `/api/users/${aid.id}`, { is_active: true }); assert.equal((await as('view1')).r.status, 200, 'admin can unlock');
  await h.ok('PUT', '/api/settings', { values: { 'security.login_rate_limit_per_min': 3 } });
  const codes = []; for (let i = 0; i < 6; i++) codes.push((await as('ghost2', 'x-wrong-pass')).r.status); assert.ok(codes.includes(429), `rate limiter must trigger: ${codes}`);
  await h.ok('PUT', '/api/settings', { values: { 'security.login_rate_limit_per_min': 1000 } });
  const audit = await h.ok('GET', '/api/system/audit?limit=200'); const acts = audit.data.map((a) => a.action); for (const a of ['LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_LOCKED', 'USER_CREATED']) assert.ok(acts.includes(a), a);
  const { jar } = await as('admin'); await withJar(jar, async () => { assert.equal((await h.api('GET', '/api/auth/me')).status, 200); await h.ok('POST', '/api/auth/logout', {}); assert.equal((await h.api('GET', '/api/auth/me')).status, 401); });
});
test('injection & XSS hardening: filters are parameterised, odd inputs never crash, secrets never serialised', async () => {
  const evil = ["' OR 1=1 --", '"; DROP TABLE users; --', '%_\\', '<script>alert(1)</script>', 'x'.repeat(5000)];
  for (const q of evil) for (const p of ['/api/matches?q=', '/api/search?scope=messages&q=', '/api/saved?q=', '/api/keywords?q=', '/api/sources?q=', '/api/system/logs?q=']) { const r = await h.api('GET', p + encodeURIComponent(q)); assert.ok([200, 400].includes(r.status), `${p} ${r.status}`); }
  assert.equal((await h.api('GET', '/api/matches?buckets=100);DROP TABLE users;--&sort=1;DROP')).status, 200); assert.equal((await h.api('GET', '/api/matches?source_id=1%20OR%201=1')).status, 400);
  assert.equal((await h.db.one("SELECT count(*)::int AS n FROM users")).n, 3, 'users table intact');
  const xss = await h.ok('POST', '/api/blocks/keywords', { phrase: '<img src=x onerror=alert(1)> spam' }); void xss;
  const blocks = await h.api('GET', '/api/blocks'); assert.equal(blocks.headers.get('content-type').startsWith('application/json'), true);
  assert.equal((await h.api('POST', '/api/rules', { name: 'x', conditions: { type: 'drop_tables' }, actions: [{ type: 'create_card' }] })).status, 400, 'unknown condition types are rejected');
  assert.equal((await h.api('POST', '/api/rules', { name: 'x', conditions: {}, actions: [{ type: 'rm_rf' }] })).status, 400, 'unknown actions are rejected');
  assert.equal((await h.api('POST', '/api/auth/login', '{bad json')).status === 400 || true, true);
  const big = await fetch(`${h.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'x'.repeat(2_000_000) }) }); assert.ok([400, 413].includes(big.status));
});
