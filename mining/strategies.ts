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
  INVERTED_VERSION: 3,
  RANDOMIZED: 4,
  RANDOM_INVERTED: 5,
  GOLDEN_RATIO: 6,
  RANDOM_EN2: 7,
  EN2_BIGENDIAN: 8,
  CUSTOM_NONCE: 9,
  RANDOM_EN2_RIGHT: 10,
  RANDOM_EN2_MIDDLE: 11,
  LIST_NONCES: 12,
} as const;

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
