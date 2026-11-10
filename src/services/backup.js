// Encrypted backups (AES-256-GCM, MASTER_KEY): database (pg_dump), configuration and rules. Secrets are never stored in plaintext.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { many, one, query } from '../lib/db.js';
import { encryptionKey } from '../lib/crypto.js';
import { REGISTRY } from '../lib/settings.js';
import { AppError } from '../lib/errors.js';
import { getSetting } from '../lib/settings.js';

export const MAGIC = Buffer.from('NABDBK1');
export const backupDir = () => path.join(config.DATA_DIR, 'backups');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export async function encryptFile(src, dest) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const out = fs.createWriteStream(dest, { mode: 0o600 }); out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(fs.createReadStream(src), c, out, { end: false });
  out.end(c.getAuthTag()); await new Promise((r, j) => { out.on('finish', r); out.on('error', j); });
}
export async function decryptFile(src, dest) {
  const st = await fs.promises.stat(src); const fd = await fs.promises.open(src, 'r');
  const head = Buffer.alloc(MAGIC.length + 12); const tag = Buffer.alloc(16);
  await fd.read(head, 0, head.length, 0); await fd.read(tag, 0, 16, st.size - 16); await fd.close();
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a NABD backup file');
  const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), head.subarray(MAGIC.length)); d.setAuthTag(tag);
  await pipeline(fs.createReadStream(src, { start: head.length, end: st.size - 17 }), d, fs.createWriteStream(dest, { mode: 0o600 }));
}
const sha256File = (f) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });

function pgEnv() {
  const u = new URL(config.DATABASE_URL);
  return { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1) };
}
const runDump = (file) => new Promise((resolve, reject) => {
  const p = spawn(config.PG_DUMP_PATH, ['--format=custom', '--no-owner', '--no-privileges', '--file', file], { env: pgEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  p.on('error', (e) => reject(new AppError('INTERNAL', { message: `pg_dump not available: ${e.message}` })));
  p.on('close', (code) => (code === 0 ? resolve() : reject(new AppError('INTERNAL', { message: `pg_dump failed: ${err.slice(0, 200)}` }))));
});

async function configSnapshot() {
  const rows = await many('SELECT key, value, is_secret FROM settings ORDER BY key');
  const settings = {}; for (const r of rows) settings[r.key] = REGISTRY[r.key]?.secret ? { secret: true, omitted: true } : r.value;
  const providers = (await many('SELECT id, enabled, base_url, model, temperature, max_tokens, timeout_ms, retry_count FROM ai_providers ORDER BY id'));
  return { version: 1, created_at: new Date().toISOString(), settings, ai_providers: providers };
}
async function rulesSnapshot() {
  const [radars, keywords, variants, rules, automations] = await Promise.all([
    many('SELECT * FROM ai_rules WHERE deleted_at IS NULL ORDER BY id'), many('SELECT * FROM keywords WHERE deleted_at IS NULL ORDER BY id'),
    many('SELECT * FROM keyword_variants ORDER BY id'), many('SELECT * FROM rules WHERE deleted_at IS NULL ORDER BY id'), many('SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY id'),
  ]);
  return { version: 1, created_at: new Date().toISOString(), radars, keywords, keyword_variants: variants, rules, automations };
}

export async function createBackup({ kind = 'database', createdBy = null } = {}) {
  fs.mkdirSync(backupDir(), { recursive: true, mode: 0o700 });
  const base = path.join(backupDir(), `${kind}-${stamp()}`);
  const tmp = `${base}.tmp`; const final = kind === 'database' ? `${base}.dump.enc` : `${base}.json.enc`;
  try {
    if (kind === 'database') await runDump(tmp);
    else if (kind === 'config') fs.writeFileSync(tmp, JSON.stringify(await configSnapshot(), null, 2), { mode: 0o600 });
    else if (kind === 'rules') fs.writeFileSync(tmp, JSON.stringify(await rulesSnapshot(), null, 2), { mode: 0o600 });
    else throw new AppError('VALIDATION', { message: 'unknown backup kind' });
    await encryptFile(tmp, final);
    const st = await fs.promises.stat(final);
    const row = await one('INSERT INTO backups (kind, file_name, size_bytes, sha256, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [kind, path.basename(final), st.size, await sha256File(final), createdBy]);
    await prune(kind);
    return row;
  } catch (e) {
    await query("INSERT INTO backups (kind, file_name, status, error, created_by) VALUES ($1,$2,'failed',$3,$4)", [kind, path.basename(final), String(e.message).slice(0, 300), createdBy]).catch(() => {});
    throw e;
  } finally { fs.rmSync(tmp, { force: true }); }
}
async function prune(kind) {
  const keep = await getSetting('backup.keep');
  const old = await many("SELECT id, file_name FROM backups WHERE kind = $1 AND status = 'ok' ORDER BY created_at DESC OFFSET $2", [kind, keep]);
  for (const b of old) { fs.rmSync(path.join(backupDir(), b.file_name), { force: true }); await query('DELETE FROM backups WHERE id = $1', [b.id]); }
}
export const backupPath = (fileName) => { const p = path.join(backupDir(), path.basename(fileName)); return p.startsWith(backupDir()) ? p : null; };
