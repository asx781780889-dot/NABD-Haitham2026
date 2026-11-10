// Failure scenarios: AI outage (failover, circuit breaker, degraded mode), connection loss + catch-up, worker stop / process restart,
// idempotency, database capacity emergency, Redis outage and PostgreSQL outage. No data may be lost and nothing may loop forever.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, setupAdmin, waitFor, sleep, redisCtl, pgCtl } from '../helpers/harness.js';
import { startFakeServices, deliver, dropConnection } from '../helpers/fakes.js';

const PHONE = '+966511111111'; const HUB = -1004444444444; const PW = 'Passw0rd-Strong1';
const dialogs = [{ chatId: HUB, kind: 'supergroup', title: 'Resilience Hub', username: null, members: 10 }];
let h; let svc2; let acc; let src; let n = 5000;
const msg = (text, o = {}) => ({ chatId: HUB, title: 'Resilience Hub', senderId: 500 + (n % 50), senderUsername: `u${n % 50}`, senderName: 'U', text, ...o });
const send = (text, o = {}) => deliver(PHONE, msg(text, { tgMessageId: ++n, ...o }));
const cards = async () => (await h.ok('GET', '/api/matches?limit=100')).data;
const cardOf = (text) => waitFor(async () => (await cards()).find((c) => c.text === text), { timeout: 25000, label: `card "${text}"` });
const nonce = () => `${++n}`;

before(async () => {
  h = await startHarness(); svc2 = await startFakeServices(); await setupAdmin(h, 'admin', PW);
  h.world.addAccount(PHONE, { userId: 8001, username: 'res_acc', dialogs });
  const a = await h.ok('POST', '/api/accounts', { name: 'Resilience', phone: PHONE, api_id: 1, api_hash: 'd'.repeat(32) }); acc = a.data.id;
  await h.ok('POST', `/api/accounts/${acc}/login/code`, { code: '12345' });
  await waitFor(async () => (await h.ok('GET', `/api/accounts/${acc}`)).data.status === 'connected', { label: 'connected' });
  await h.ok('POST', `/api/accounts/${acc}/sync`);
  src = (await h.ok('GET', `/api/sources?account_id=${acc}`)).data[0]; await h.ok('PATCH', `/api/sources/${src.id}`, { monitoring_enabled: true });
  await h.ok('PUT', '/api/ai/providers/custom', { enabled: true, base_url: `${h.svc.url}/v1`, model: 'm1', api_key: 'k1', retry_count: 0 });
  await h.ok('PUT', '/api/ai/providers/local', { enabled: true, base_url: `${svc2.url}/v1`, model: 'm2', retry_count: 0 });
  await h.ok('PUT', '/api/settings', { values: { 'ai.primary': 'custom', 'ai.fallback': 'local', 'ai.breaker_threshold': 2, 'ai.breaker_cooldown_s': 600, 'ai.requests_per_minute': 600, 'queue.attempts': 2, 'queue.backoff_ms': 300, 'telegram.reconnect_base_ms': 500, 'telegram.catchup_delay_ms': 100 } });
  await h.ok('POST', '/api/system/workers/ai/restart');
  const d = await h.ok('POST', '/api/radar/draft', { description: 'people who need help with graduation projects' });
  await h.ok('POST', '/api/radar', { ...d.data, confirm: true });
  await h.ok('POST', '/api/automations', { name: 'ai down', trigger: 'ai_failure', actions: [{ type: 'create_alert', title: 'AI down: {{payload.providers}}', severity: 'high' }] });
});
after(async () => { await svc2?.close(); await h.stop(); });

test('AI outage: failover to the fallback provider, then circuit breaker opens and skips the dead provider', async () => {
  h.svc.ai.mode = 'fail';
  const t1 = `احتاج مساعده بمشروع التخرج ${nonce()}`; send(t1); const c1 = await cardOf(t1);
  assert.ok(c1.ai_confidence >= 90, 'AI result must come from the fallback'); assert.equal((await h.db.one('SELECT provider FROM ai_results ORDER BY id DESC LIMIT 1')).provider, 'local'); assert.ok(svc2.ai.calls >= 1);
  const t2 = `احتاج مساعده بمشروع التخرج ${nonce()}`; send(t2); await cardOf(t2);
  const prov = (await h.ok('GET', '/api/ai/providers')).data.find((p) => p.id === 'custom'); assert.equal(prov.breaker.state, 'open'); assert.ok(prov.breaker.failures >= 2);
  const before = h.svc.ai.calls; const t3 = `احتاج مساعده بمشروع التخرج ${nonce()}`; send(t3); await cardOf(t3); assert.equal(h.svc.ai.calls, before, 'an open circuit must not hit the failing provider');
  assert.ok((await h.ok('GET', '/api/system/status')).status.ai.status === 'warning', 'dashboard shows the degraded AI status');
});
test('both providers down: pipeline degrades to keyword-only (flagged), Telegram ingestion is unaffected, automation fires', async () => {
  svc2.ai.mode = 'fail'; await h.ok('POST', '/api/ai/providers/local/reset');
  const t = `احتاج مساعده بمشروع التخرج ${nonce()}`; send(t);
  const c = await cardOf(t); assert.equal(c.ai_degraded, true); assert.equal(c.ai_confidence, null); assert.ok(c.score >= 70);
  assert.equal((await h.ok('GET', `/api/accounts/${acc}`)).data.status, 'connected', 'AI failure must not disturb Telegram');
  await waitFor(async () => (await h.ok('GET', '/api/alerts')).data.some((a) => a.title.startsWith('AI down:')), { label: 'ai_failure automation alert' });
  h.svc.ai.mode = 'ok'; svc2.ai.mode = 'ok'; await h.ok('POST', '/api/ai/providers/custom/reset'); await h.ok('POST', '/api/ai/providers/local/reset');
  const t2 = `احتاج مساعده بمشروع التخرج ${nonce()}`; send(t2); const c2 = await cardOf(t2); assert.equal(c2.ai_degraded, false); assert.ok(c2.ai_confidence >= 90, 'AI is used again after recovery');
});
test('idempotency: re-delivered updates and re-run stages never create a second message or card', async () => {
  const t = `احتاج مساعدة في مشروع التخرج ${nonce()}`; const id = ++n; send(t, { tgMessageId: id }); send(t, { tgMessageId: id }); send(t, { tgMessageId: id });
  const c = await cardOf(t); await sleep(1200);
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM messages WHERE tg_message_id = $1 AND tg_chat_id = $2', [id, HUB])).n, 1);
  const { stageProcess, stageKeyword } = await import('../../src/workers/pipeline.js'); const m = await h.db.one('SELECT id FROM messages WHERE tg_message_id = $1', [id]);
  await stageProcess(m.id); await stageKeyword(m.id); await sleep(300);
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM message_matches WHERE message_id = $1', [m.id])).n, 1); assert.equal((await cards()).filter((x) => x.text === t).length, 1); void c;
});
test('connection loss: watchdog detects it, reconnects with backoff and catches up on missed messages', async () => {
  const t0 = `احتاج مساعدة في مشروع التخرج ${nonce()}`; send(t0); await cardOf(t0);
  const last = (await h.db.one('SELECT last_tg_message_id AS m FROM telegram_sources WHERE id = $1', [src.id])).m;
  dropConnection(PHONE);
  const missed = [`احتاج مساعدة في مشروع التخرج غاب ${nonce()}`, `ابي احد يساعدني في مشروع التخرج غاب ${nonce()}`];
  h.world.history.set(HUB, missed.map((text, i) => ({ chatId: HUB, kind: 'supergroup', title: 'Resilience Hub', tgMessageId: last + 1 + i, senderId: 900 + i, senderUsername: `m${i}`, senderName: 'M', text, date: new Date() })));
  await waitFor(async () => (await h.ok('GET', `/api/accounts/${acc}`)).data.status !== 'connected', { timeout: 15000, label: 'disconnect detected' });
  await waitFor(async () => (await h.ok('GET', `/api/accounts/${acc}`)).data.status === 'connected', { timeout: 25000, label: 'auto reconnect' });
  for (const t of missed) await cardOf(t);
  assert.equal((await h.ok('GET', `/api/accounts/${acc}`)).data.reconnect_attempts, 0, 'attempt counter resets after success');
});
test('worker module failure: stopped processor leaves messages queued; restarting it drains them (no loss)', async () => {
  await h.ok('POST', '/api/system/workers/processor/stop', undefined, { 'x-confirm-password': PW });
  await waitFor(async () => (await h.ok('GET', '/api/system/workers')).data.find((w) => w.name === 'processor').status === 'stopped', { label: 'processor stopped' });
  const t = `احتاج مساعدة في مشروع التخرج ${nonce()}`; send(t); await sleep(2500);
  assert.equal((await cards()).some((c) => c.text === t), false, 'nothing is processed while the module is stopped');
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM messages WHERE text = $1', [t])).n, 1, 'but the message is safely stored');
  await h.ok('POST', '/api/system/workers/processor/start'); await cardOf(t);
});
test('process restart: pending messages survive and are processed after the worker comes back; API stays up meanwhile', async () => {
  const t = `ابي احد يساعدني في مشروع التخرج ${nonce()}`;
  await h.stopWorkers();
  assert.equal((await h.api('GET', '/health')).status, 200); const w = await h.ok('GET', '/api/system/workers'); assert.equal(w.process_online, false);
  assert.equal((await h.api('POST', `/api/accounts/${acc}/connect`, {})).body.error.code, 'WORKER_OFFLINE', 'actions that need the worker explain what to do');
  await h.db.query(`INSERT INTO messages (account_id, source_id, tg_chat_id, tg_message_id, sender_id, sender_username, text, lang, sent_at) VALUES ($1,$2,$3,$4,777,'late',$5,'ar',now())`, [acc, src.id, HUB, ++n, t]);
  await sleep(500); assert.equal((await cards()).some((c) => c.text === t), false);
  await h.restartWorkers(); await cardOf(t);
  await waitFor(async () => (await h.ok('GET', `/api/accounts/${acc}`)).data.status === 'connected', { timeout: 25000, label: 'account reconnects after restart' });
  assert.equal((await h.ok('GET', '/api/system/workers')).process_online, true);
});
test('retry-failed recovers messages that exhausted their attempts', async () => {
  const t = `احتاج مساعدة في مشروع التخرج ${nonce()}`;
  await h.db.query(`INSERT INTO messages (account_id, source_id, tg_chat_id, tg_message_id, sender_id, text, lang, sent_at, state, attempts, error) VALUES ($1,$2,$3,$4,778,$5,'ar',now(),'failed',5,'boom')`, [acc, src.id, HUB, ++n, t]);
  const r = await h.ok('POST', '/api/system/queues/retry-failed'); assert.ok(r.messages >= 1); await cardOf(t);
});
test('database capacity ladder: emergency mode pauses ingestion (never deletes), then recovers automatically', async () => {
  const { levelFor } = await import('../../src/services/dbmonitor.js');
  assert.deepEqual([69, 70, 80, 90, 95, 98, 100].map(levelFor), ['normal', 'warning', 'high_risk', 'critical', 'emergency_prep', 'emergency', 'emergency']);
  const before = (await h.db.one('SELECT count(*)::int AS n FROM messages')).n;
  await h.ok('PUT', '/api/settings', { values: { 'database.size_limit_mb': 1 } });
  const st = await h.ok('GET', '/api/system/database'); assert.equal(st.data.level, 'emergency'); assert.ok(st.data.tables.length > 0 && st.data.connections.max > 0 && Array.isArray(st.data.long_running_queries));
  await waitFor(async () => (await h.ok('GET', '/api/system/database')).data.emergency_active === true, { timeout: 15000, label: 'emergency mode on' });
  assert.ok((await h.ok('GET', '/api/alerts')).data.some((a) => /Database at/.test(a.title) && a.severity === 'critical'), 'critical alert raised');
  const t = `احتاج مساعدة في مشروع التخرج ${nonce()}`; send(t); await sleep(1500);
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM messages WHERE text = $1', [t])).n, 0, 'ingestion paused in emergency mode');
  assert.ok((await h.db.one('SELECT count(*)::int AS n FROM messages')).n >= before, 'nothing was deleted');
  await h.ok('PUT', '/api/settings', { values: { 'database.size_limit_mb': 0 } });
  await waitFor(async () => (await h.ok('GET', '/api/system/database')).data.emergency_active === false, { timeout: 15000, label: 'emergency mode auto-clears' });
  const t2 = `احتاج مساعدة في مشروع التخرج ${nonce()}`; send(t2); await cardOf(t2);
});
test('Redis outage: clear warning, login still works, messages keep flowing through inline processing, full recovery', { skip: !redisCtl.available() && 'redis-cli not available' }, async () => {
  redisCtl.stop(); await sleep(600);
  const ready = await h.api('GET', '/ready'); assert.equal(ready.status, 200); assert.equal(ready.body.status, 'degraded'); assert.equal(ready.body.redis, false);
  await waitFor(async () => (await h.ok('GET', '/api/system/status')).status.redis.status === 'offline', { label: 'redis offline in status' });
  const q = await h.ok('GET', '/api/system/queues'); assert.equal(q.redis, false);
  assert.equal((await h.api('POST', '/api/auth/login', { username: 'admin', password: PW })).status, 200, 'login keeps working (in-memory limiter fallback)');
  const t = `احتاج مساعدة في مشروع التخرج ${nonce()}`; send(t); await cardOf(t);
  redisCtl.start();
  await waitFor(async () => (await h.api('GET', '/ready')).body.status === 'ready', { timeout: 30000, label: 'redis recovered' });
  const t2 = `ابي احد يساعدني في مشروع التخرج ${nonce()}`; send(t2); await cardOf(t2);
  assert.equal((await h.ok('GET', '/api/system/status')).status.redis.status, 'online');
});
test('PostgreSQL outage: API answers with a clear 503, Telegram worker stays alive and buffers, nothing is lost after recovery', { skip: !pgCtl.available() && 'pg_ctlcluster not available' }, async () => {
  const t = `احتاج مساعدة في مشروع التخرج ${nonce()}`;
  pgCtl.stop(); await sleep(800);
  assert.equal((await h.api('GET', '/health')).status, 200); assert.equal((await h.api('GET', '/ready')).status, 503);
  const r = await h.api('GET', '/api/matches'); assert.equal(r.status, 503); assert.equal(r.body.error.code, 'DB_UNAVAILABLE'); assert.ok(r.body.error.message_ar.includes('قاعدة البيانات'));
  assert.equal(send(t), 1, 'telegram connection is still delivering updates'); await sleep(1500);
  pgCtl.start();
  await waitFor(async () => (await h.api('GET', '/ready')).status === 200, { timeout: 30000, label: 'database back' });
  await cardOf(t);
  await waitFor(async () => (await h.ok('GET', '/api/system/workers')).process_online, { timeout: 20000, label: 'workers heartbeat resumes' });
});
