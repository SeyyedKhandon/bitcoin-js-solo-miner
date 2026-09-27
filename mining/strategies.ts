import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Nonce-search strategies the worker can use when scanning the 32-bit nonce space.
 * ALL_MODE cycles through the others (one per job) so their effectiveness can be compared.
 */
export const MiningMethod = {
  ALL_MODE: 0,
  STANDARD: 1,
  TOP_DOWN: 2,
  /**
   * @deprecated Broken: flips the header version bits locally to search a
   * different hash space, but never negotiates BIP320 version-rolling with
   * the pool (no mining.configure sent, no version field in mining.submit).
   * The pool reconstructs the header using its own real version, producing
   * a completely different hash, so any share found this way is rejected.
   * Kept only so old saved method numbers don't shift; ALL_MODE skips it -
   * see ALL_MODE_METHODS.
   */
  INVERTED_VERSION: 3,
  RANDOMIZED: 4,
  /** @deprecated Same broken version-flipping as INVERTED_VERSION, just combined with randomized nonce search. ALL_MODE skips it. */
  RANDOM_INVERTED: 5,
  GOLDEN_RATIO: 6,
  RANDOM_EN2: 7,
  EN2_BIGENDIAN: 8,
  CUSTOM_NONCE: 9,
  RANDOM_EN2_RIGHT: 10,
  RANDOM_EN2_MIDDLE: 11,
  LIST_NONCES: 12,
} as const;

/**
 * The methods ALL_MODE actually cycles through, in order - excludes
 * ALL_MODE itself and the deprecated version-flipping methods
 * (INVERTED_VERSION, RANDOM_INVERTED), which can never produce a
 * pool-acceptable share.
 */
export const ALL_MODE_METHODS: number[] = [
  MiningMethod.STANDARD,
  MiningMethod.TOP_DOWN,
  MiningMethod.RANDOMIZED,
  MiningMethod.GOLDEN_RATIO,
  MiningMethod.RANDOM_EN2,
  MiningMethod.EN2_BIGENDIAN,
  MiningMethod.CUSTOM_NONCE,
  MiningMethod.RANDOM_EN2_RIGHT,
  MiningMethod.RANDOM_EN2_MIDDLE,
  MiningMethod.LIST_NONCES,
];

/**
 * Human-readable name for a MiningMethod value, for showing which strategy
 * produced a given hash on the dashboard. ALL_MODE never reaches here as a
 * label - workers report the concrete method it delegated to.
 */
export function methodName(method: number): string {
  const entry = Object.entries(MiningMethod).find(([, value]) => value === method);
  return entry ? entry[0] : `UNKNOWN (${method})`;
}

// LIST_NONCES samples from data/bitcoin_last_10000_nonces.txt when present.
// The file isn't bundled with this project - if it's absent (the normal
// case), getRandomNonceFromList() below just falls back to nonce 0.
let customNoncesList: number[] = [];
try {
  const dataPath = path.join(__dirname, '..', 'data', 'bitcoin_last_10000_nonces.txt');
  const data = fs.readFileSync(dataPath, 'utf8');
  customNoncesList = data.split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
} catch (e) {
  // Expected when the data file isn't present - nothing to warn about.
}

/** Picks a random nonce from real historical Bitcoin block nonces (MiningMethod.LIST_NONCES). */
export function getRandomNonceFromList(): number {
  if (customNoncesList.length === 0) return 0;
  return customNoncesList[Math.floor(Math.random() * customNoncesList.length)];
}
