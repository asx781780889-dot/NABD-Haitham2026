// Message fingerprints: exact hash, normalised hash and SimHash bands for near-duplicate detection.
import { sha256, simhash, simhashBands, simhashToBigintString, simhashFromBands, hamming, dice, trigrams } from './similarity.js';

export function fingerprint(an) {
  const h = simhash(an.tokens);
  return { exact: sha256(an.raw), norm: sha256(an.norm), simhash: simhashToBigintString(h), bands: simhashBands(h), h };
}
export const bandDistance = (rowBands, h) => hamming(simhashFromBands(rowBands), h);
/** Final duplicate decision between a candidate row and the new message. */
export function isDuplicate({ sameNorm, distance, textSim }, { maxDistance = 3, minSimilarity = 0.9 } = {}) {
  return !!sameNorm || (distance != null && distance <= maxDistance && (textSim ?? 1) >= minSimilarity * 0.9) || (textSim != null && textSim >= minSimilarity);
}
export const textSimilarity = (a, b) => dice(trigrams(a), trigrams(b));
