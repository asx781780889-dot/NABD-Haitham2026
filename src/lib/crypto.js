// AES-256-GCM secret encryption (key-id tagged for rotation), scrypt password hashing, token helpers.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt);

function toKey(s) {
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) { const b = Buffer.from(s, 'base64'); if (b.length === 32) return b; }
  return crypto.createHash('sha256').update(s).digest();
}
const keys = [config.MASTER_KEY, config.MASTER_KEY_OLD].filter(Boolean).map((s) => {
  const key = toKey(s);
  return { key, kid: crypto.createHash('sha256').update(key).digest('hex').slice(0, 8) };
});
export const currentKid = keys[0].kid;

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys[0].key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', currentKid, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
export function decrypt(token) {
  const [v, kid, iv, tag, ct] = String(token).split('.');
  if (v !== 'v1' || !ct) throw new Error('invalid ciphertext format');
  const k = keys.find((x) => x.kid === kid);
  if (!k) throw new Error('unknown encryption key id (MASTER_KEY changed?)');
  const d = crypto.createDecipheriv('aes-256-gcm', k.key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
export const needsRewrap = (token) => String(token).split('.')[1] !== currentKid;
export const keyedHash = (data) => crypto.createHmac('sha256', keys[0].key).update(String(data)).digest('hex');
export const encryptionKey = () => keys[0].key; // used for backup file encryption

const SCRYPT = { N: 16384, r: 8, p: 1 };
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(pw, salt, 64, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}
export async function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64url');
    const dk = await scrypt(pw, Buffer.from(salt, 'base64url'), want.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(dk, want);
  } catch { return false; }
}
export const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function maskPhone(phone) {
  const d = String(phone).replace(/[^\d]/g, '');
  if (d.length < 7) return '•••';
  return `+${d.slice(0, Math.min(3, d.length - 6))}${'•'.repeat(Math.max(3, d.length - 7))}${d.slice(-4)}`;
}
