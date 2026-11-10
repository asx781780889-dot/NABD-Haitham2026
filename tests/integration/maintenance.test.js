// Encrypted backups (database / config / rules), safe retention cleanup, and MASTER_KEY rotation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startHarness, setupAdmin, waitFor } from '../helpers/harness.js';

const PW = 'Passw0rd-Strong1'; let h; let acc; let src;
before(async () => { h = await startHarness(); await setupAdmin(h, 'admin', PW); });
after(async () => { await h.stop(); });

const taskDone = (id) => waitFor(async () => { const t = (await h.ok('GET', `/api/system/tasks/${id}`)).data; return ['completed', 'failed'].includes(t.state) ? t : null; }, { timeout: 60000, label: `task ${id}` });
const pgEnv = () => { const u = new URL(process.env.DATABASE_URL); return { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: u.username, PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) }; };

test('backups: config / rules / database are encrypted, contain no plaintext secrets, and the dump is restorable', async () => {
  await h.ok('PUT', '/api/ai/providers/custom', { enabled: true, base_url: `${h.svc.url}/v1`, model: 'm', api_key: 'sk-super-secret-key' });
  await h.ok('PUT', '/api/settings', { values: { 'notify.telegram.bot_token': 'bot-super-secret', 'general.app_name': 'Backup Test' } });
  await h.ok('POST', '/api/radar', { name: 'R', intent: 'I', signals: ['كلمة اختبار'], min_score: 70, confirm: true });
  const { decryptFile, MAGIC } = await import('../../src/services/backup.js');
  const out = {};
  for (const kind of ['config', 'rules', 'database']) {
    const r = await h.ok('POST', '/api/system/backups', { kind }); const t = await taskDone(r.task.id); assert.equal(t.state, 'completed', `${kind}: ${t.error}`);
    const list = (await h.ok('GET', '/api/system/backups')).data; const b = list.find((x) => x.kind === kind && x.status === 'ok'); assert.ok(b && b.size_bytes > 100 && b.sha256.length === 64);
    const file = path.join(process.env.DATA_DIR ?? path.resolve('data'), 'backups', b.file_name); const raw = fs.readFileSync(file);
    assert.ok(raw.subarray(0, MAGIC.length).equals(MAGIC), 'encrypted container header'); assert.equal(raw.includes('sk-super-secret-key'), false); assert.equal(raw.includes('Backup Test'), false, 'even non-secret config is encrypted at rest');
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'backup files are private (0600)');
    const plain = path.join(os.tmpdir(), `nabd-test-${kind}`); await decryptFile(file, plain); out[kind] = { plain, id: b.id };
  }
  const cfg = fs.readFileSync(out.config.plain, 'utf8'); assert.ok(cfg.includes('Backup Test') && cfg.includes('"omitted": true') && !cfg.includes('bot-super-secret') && !cfg.includes('sk-super-secret-key'));
  const rules = JSON.parse(fs.readFileSync(out.rules.plain, 'utf8')); assert.equal(rules.radars[0].intent, 'I');
  const dump = fs.readFileSync(out.database.plain); assert.equal(dump.subarray(0, 5).toString(), 'PGDMP');
  const list = spawnSync('pg_restore', ['--list', out.database.plain], { encoding: 'utf8', env: pgEnv() }); assert.equal(list.status, 0, list.stderr); assert.ok(list.stdout.includes('message_matches') && list.stdout.includes('audit_logs'));
  const noPw = await h.api('GET', `/api/system/backups/${out.database.id}/download`); assert.equal(noPw.status, 401, 'download needs step-up auth');
  const dl = await h.api('GET', `/api/system/backups/${out.database.id}/download`, undefined, { 'x-confirm-password': PW }); assert.equal(dl.status, 200); assert.ok(dl.buf.subarray(0, 7).equals(MAGIC));
  await h.ok('DELETE', `/api/system/backups/${out.rules.id}`, undefined, { 'x-confirm-password': PW }); assert.ok(!(await h.ok('GET', '/api/system/backups')).data.some((x) => x.id === out.rules.id));
  const audit = (await h.ok('GET', '/api/system/audit?limit=100')).data.map((a) => a.action); for (const a of ['BACKUP_REQUESTED', 'BACKUP_CREATED', 'BACKUP_DOWNLOADED', 'BACKUP_DELETED']) assert.ok(audit.includes(a), a);
});

test('retention cleanup: dry-run is exact, unmatched old messages are soft-deleted then purged, matched messages are never touched', async () => {
  const phone = await h.db.one("INSERT INTO telegram_accounts (name, phone_enc, phone_masked, phone_hash, api_id_enc, api_hash_enc) VALUES ('c','x','x','h-cleanup','x','x') RETURNING id"); acc = phone.id;
  src = (await h.db.one("INSERT INTO telegram_sources (account_id, tg_chat_id, kind, title, monitoring_enabled) VALUES ($1, -1005, 'supergroup', 'G', true) RETURNING id", [acc])).id;
  const ins = (n, age, state = 'done') => h.db.one(`INSERT INTO messages (account_id, source_id, tg_chat_id, tg_message_id, sender_id, text, sent_at, state, created_at) VALUES ($1,$2,-1005,$3::bigint,1,'msg ' || ($3::bigint)::text, now(), $4, now() - make_interval(days => $5)) RETURNING id`, [acc, src, n, state, age]);
  const old = [await ins(1, 20), await ins(2, 20), await ins(3, 20, 'skipped')]; const matched = await ins(4, 20); const fresh = await ins(5, 0); const pending = await ins(6, 20, 'pending');
  await h.db.query("INSERT INTO message_matches (message_id, account_id, source_id, match_type, score, priority) VALUES ($1,$2,$3,'exact',100,'high')", [matched.id, acc, src]);
  const prev = (await h.ok('POST', '/api/system/database/cleanup-preview')).data; assert.equal(prev.messages_to_soft_delete, 3, JSON.stringify(prev));
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM messages WHERE deleted_at IS NOT NULL')).n, 0, 'preview must not change anything');
  const noPw = await h.api('POST', '/api/system/database/cleanup'); assert.equal(noPw.status, 401);
  const r = await h.ok('POST', '/api/system/database/cleanup', {}, { 'x-confirm-password': PW }); const t = await taskDone(r.task.id); assert.equal(t.state, 'completed', t.error); assert.equal(t.result.messages_soft_deleted, 3); assert.equal(t.result.messages_purged, 0, 'grace period protects fresh soft-deletes');
  const state = async (id) => (await h.db.one('SELECT deleted_at FROM messages WHERE id = $1', [id]))?.deleted_at;
  for (const m of old) assert.ok(await state(m.id), 'old unmatched soft-deleted'); for (const m of [matched, fresh, pending]) assert.equal(await state(m.id), null, 'matched / recent / pending untouched');
  await h.db.query("UPDATE messages SET deleted_at = now() - interval '30 days' WHERE deleted_at IS NOT NULL"); await h.db.query("UPDATE messages SET deleted_at = now() - interval '30 days' WHERE id = $1", [matched.id]);
  const t2 = await taskDone((await h.ok('POST', '/api/system/database/cleanup', {}, { 'x-confirm-password': PW })).task.id); assert.equal(t2.result.messages_purged, 3, JSON.stringify(t2.result));
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM messages WHERE id = ANY($1)', [[matched.id, fresh.id, pending.id]])).n, 3, 'a message backing a card survives even if wrongly soft-deleted');
  assert.equal((await h.db.one('SELECT count(*)::int AS n FROM message_matches WHERE message_id = $1', [matched.id])).n, 1);
});

test('MASTER_KEY rotation re-encrypts every secret and the new key alone can read them', async () => {
  const before = await h.db.one("SELECT api_key_enc FROM ai_providers WHERE id = 'custom'");
  const NEW = Buffer.from('rotated-key-rotated-key-rotated!!').toString('base64'); const env = { ...process.env, MASTER_KEY_OLD: process.env.MASTER_KEY, MASTER_KEY: NEW };
  const dry = spawnSync('node', ['scripts/rotate-key.js', '--dry-run'], { env, encoding: 'utf8' }); assert.ok(/Dry run OK/.test(dry.stdout), dry.stdout + dry.stderr);
  assert.equal((await h.db.one("SELECT api_key_enc FROM ai_providers WHERE id = 'custom'")).api_key_enc, before.api_key_enc, 'dry run changes nothing');
  const run = spawnSync('node', ['scripts/rotate-key.js'], { env, encoding: 'utf8' }); assert.ok(/Re-encrypted \d+ records \(skipped 1 unreadable\)/.test(run.stdout), `the deliberately corrupt row must be reported, not fatal: ${run.stdout}${run.stderr}`);
  const after2 = await h.db.one("SELECT api_key_enc FROM ai_providers WHERE id = 'custom'"); assert.notEqual(after2.api_key_enc, before.api_key_enc);
  const probe = spawnSync('node', ['-e', `import('./src/lib/crypto.js').then(c => { console.log(c.decrypt(process.argv[1])); process.exit(0); }).catch(e => { console.log('ERR ' + e.message); process.exit(0); })`, after2.api_key_enc], { env: { ...process.env, MASTER_KEY: NEW, MASTER_KEY_OLD: '' }, encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), 'sk-super-secret-key'); const oldOnly = spawnSync('node', ['-e', `import('./src/lib/crypto.js').then(c => { try { c.decrypt(process.argv[1]); console.log('READABLE'); } catch (e) { console.log('DENIED'); } process.exit(0); })`, after2.api_key_enc], { env: { ...process.env, MASTER_KEY_OLD: '' }, encoding: 'utf8' });
  assert.equal(oldOnly.stdout.trim(), 'DENIED', 'the old key can no longer read rotated secrets');
});
