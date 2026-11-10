// Backup helper (backups are AES-256-GCM encrypted with MASTER_KEY).
//   node scripts/restore.js decrypt <file.enc> <out>          decrypt any backup file (JSON for config/rules, custom-format dump for database)
//   node scripts/restore.js database <db-backup.dump.enc> --yes   restore into DATABASE_URL (stop the app first!)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decryptFile } from '../src/services/backup.js';
import { config } from '../src/config.js';

const [cmd, file, out] = process.argv.slice(2);
try {
  if (cmd === 'decrypt' && file && out) { await decryptFile(file, out); console.log(`Decrypted → ${out}`); }
  else if (cmd === 'database' && file) {
    if (!process.argv.includes('--yes')) { console.error('This REPLACES the current database content. Stop the app, then re-run with --yes.'); process.exit(2); }
    const tmp = path.join(os.tmpdir(), `nabd-restore-${Date.now()}.dump`); await decryptFile(file, tmp);
    const u = new URL(config.DATABASE_URL);
    const r = spawnSync('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', u.pathname.slice(1), tmp], { stdio: 'inherit', env: { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password) } });
    fs.rmSync(tmp, { force: true }); process.exit(r.status ?? 1);
  } else { console.error('Usage:\n  node scripts/restore.js decrypt <file.enc> <out>\n  node scripts/restore.js database <file.dump.enc> --yes'); process.exit(1); }
} catch (e) { console.error('Failed:', e.message); process.exit(1); }
