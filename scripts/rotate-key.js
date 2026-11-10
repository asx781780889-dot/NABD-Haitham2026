// Re-encrypts every stored secret under a new MASTER_KEY.
//   1) stop the app, set MASTER_KEY_OLD=<current key> and MASTER_KEY=<new key>   2) node scripts/rotate-key.js [--dry-run]
// Values that cannot be decrypted (already corrupt) are reported and left untouched. Old backups stay readable only with the key that made them.
import { tx, closeDb } from '../src/lib/db.js';
import { decrypt, encrypt, keyedHash, needsRewrap } from '../src/lib/crypto.js';
import { REGISTRY } from '../src/lib/settings.js';

const dry = process.argv.includes('--dry-run'); let done = 0; let skipped = 0;
const rewrap = (v) => { if (!v) return [v, true]; if (!needsRewrap(v)) return [v, true]; try { return [encrypt(decrypt(v)), true]; } catch { return [v, false]; } };
try {
  await tx(async (c) => {
    for (const a of (await c.query('SELECT id, phone_enc, api_id_enc, api_hash_enc FROM telegram_accounts')).rows) {
      const r = [rewrap(a.phone_enc), rewrap(a.api_id_enc), rewrap(a.api_hash_enc)]; let hash = null;
      try { hash = keyedHash(decrypt(r[0][0])); } catch { /* unreadable phone */ }
      if (r.some((x) => !x[1]) || !hash) { skipped++; continue; }
      await c.query('UPDATE telegram_accounts SET phone_enc=$2, api_id_enc=$3, api_hash_enc=$4, phone_hash=$5 WHERE id=$1', [a.id, r[0][0], r[1][0], r[2][0], hash]); done++;
    }
    for (const s of (await c.query('SELECT id, session_enc FROM telegram_sessions')).rows) { const [v, ok] = rewrap(s.session_enc); if (!ok) { skipped++; continue; } await c.query('UPDATE telegram_sessions SET session_enc=$2 WHERE id=$1', [s.id, v]); done++; }
    for (const p of (await c.query('SELECT id, api_key_enc, headers_enc FROM ai_providers')).rows) { const [k, ok1] = rewrap(p.api_key_enc); const [hd, ok2] = rewrap(p.headers_enc); if (!ok1 || !ok2) { skipped++; continue; } await c.query('UPDATE ai_providers SET api_key_enc=$2, headers_enc=$3 WHERE id=$1', [p.id, k, hd]); done++; }
    for (const s of (await c.query('SELECT key, value FROM settings WHERE is_secret')).rows) if (REGISTRY[s.key]?.secret && typeof s.value === 'string' && s.value) { const [v, ok] = rewrap(s.value); if (!ok) { skipped++; continue; } await c.query('UPDATE settings SET value=$2::jsonb WHERE key=$1', [s.key, JSON.stringify(v)]); done++; }
    if (dry) throw new Error('dry-run: rolled back');
  });
  console.log(`Re-encrypted ${done} records${skipped ? ` (skipped ${skipped} unreadable)` : ''}. You can now remove MASTER_KEY_OLD.`);
} catch (e) {
  if (e.message.startsWith('dry-run')) console.log(`Dry run OK: ${done} records would be re-encrypted${skipped ? `, ${skipped} unreadable` : ''}.`);
  else { console.error(`Failed: ${e.message}`); process.exitCode = 1; }
} finally { await closeDb(); }
