// Usage: node scripts/create-admin.js <username> [password]   (prompts are avoided so it works in headless shells)
import crypto from 'node:crypto';
import { one, query, closeDb, migrate } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/crypto.js';

const [username, given] = process.argv.slice(2);
if (!username) { console.error('Usage: node scripts/create-admin.js <username> [password]'); process.exit(1); }
const password = given ?? crypto.randomBytes(9).toString('base64url') + '1';
try {
  await migrate();
  const hash = await hashPassword(password);
  const ex = await one('SELECT id FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL', [username]);
  if (ex) { await query("UPDATE users SET password_hash = $2, role = 'admin', is_active = true, failed_logins = 0, locked_until = NULL WHERE id = $1", [ex.id, hash]); console.log(`Updated admin "${username}".`); }
  else { await query("INSERT INTO users (username, password_hash, role, display_name) VALUES ($1,$2,'admin',$1)", [username, hash]); console.log(`Created admin "${username}".`); }
  if (!given) console.log(`Generated password: ${password}   (change it after the first login)`);
} catch (e) { console.error('Failed:', e.message); process.exitCode = 1; } finally { await closeDb(); }
