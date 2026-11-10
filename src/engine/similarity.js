// Similarity primitives: Levenshtein, trigram Dice, SimHash (64-bit via two 32-bit lanes) and hashes.
import crypto from 'node:crypto';

export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  const al = a.length; const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  if (Math.abs(al - bl) > max) return max + 1;
  let prev = new Array(bl + 1); let cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i; let rowMin = i; const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[bl];
}
export function similarity(a, b) {
  const L = Math.max(a.length, b.length);
  return L === 0 ? 1 : 1 - levenshtein(a, b) / L;
}
export const squash = (s) => String(s).replace(/\s+/g, '').replace(/(.)\1+/gu, '$1');

export function trigrams(s) {
  const t = ` ${s} `; const set = new Set();
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
  return set;
}
export function dice(a, b) {
  const A = a instanceof Set ? a : trigrams(a); const B = b instanceof Set ? b : trigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size);
}

function h32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
const popcnt = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

/** SimHash over token bigrams (+ unigrams). Returns {hi, lo} uint32 lanes. */
export function simhash(tokens) {
  const feats = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) feats.push(tokens[i] + ' ' + tokens[i + 1]);
  const v = new Int32Array(64);
  for (const f of feats) {
    const hi = h32(f, 0x811c9dc5); const lo = h32(f, 0x9747b28c);
    for (let b = 0; b < 32; b++) { v[b] += (hi >>> b) & 1 ? 1 : -1; v[32 + b] += (lo >>> b) & 1 ? 1 : -1; }
  }
  let hi = 0; let lo = 0;
  for (let b = 0; b < 32; b++) { if (v[b] > 0) hi |= 1 << b; if (v[32 + b] > 0) lo |= 1 << b; }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}
export const hamming = (a, b) => popcnt((a.hi ^ b.hi) >>> 0) + popcnt((a.lo ^ b.lo) >>> 0);
export const simhashBands = (h) => [h.hi >>> 16, h.hi & 0xffff, h.lo >>> 16, h.lo & 0xffff];
export const simhashFromBands = (b) => ({ hi: ((b[0] << 16) | b[1]) >>> 0, lo: ((b[2] << 16) | b[3]) >>> 0 });
export const simhashToBigintString = (h) => BigInt.asIntN(64, (BigInt(h.hi) << 32n) | BigInt(h.lo)).toString();
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
