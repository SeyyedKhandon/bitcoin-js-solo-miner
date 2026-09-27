import crypto from 'crypto';

/**
 * Reverses a hex string byte by byte (used for endianness swaps).
 * e.g. "01020304" -> "04030201"
 */
export function reverseHexBytes(hexStr: string): string {
  const match = hexStr.match(/[a-fA-F0-9]{2}/g);
  return match ? match.reverse().join('') : '';
}

/**
 * Reverses a Buffer directly.
 */
export function reverseBuffer(buf: Buffer): Buffer {
  const reversed = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    reversed[buf.length - 1 - i] = buf[i];
  }
  return reversed;
}

/**
 * Performs a double SHA-256 hash on a Buffer, as Bitcoin block headers require.
 */
export function doubleSha256(buffer: Buffer | Uint8Array): Buffer {
  const hash1 = crypto.createHash('sha256').update(buffer).digest();
  return crypto.createHash('sha256').update(hash1).digest();
}

/**
 * Double-sha256 a pair of hex strings together (used to walk up the Merkle branch).
 */
export function doubleSha256Pair(hex1: string, hex2: string): string {
  const buf = Buffer.concat([Buffer.from(hex1, 'hex'), Buffer.from(hex2, 'hex')]);
  return doubleSha256(buf).toString('hex');
}

/**
 * Expands the pool's compact 'nbits' encoding into a full 32-byte target hex string.
 * The first byte (big-endian) is the exponent, the remaining 3 bytes are the mantissa;
 * target = mantissa * 256^(exponent - 3).
 */
export function getTargetFromNbits(nbitsHex: string): string {
  const exponent = parseInt(nbitsHex.substring(0, 2), 16);
  const mantissa = parseInt(nbitsHex.substring(2, 8), 16);
  const target = BigInt(mantissa) * (2n ** BigInt(8 * (exponent - 3)));
  return target.toString(16).padStart(64, '0');
}

/**
 * Converts a hash into a difficulty value (how many multiples of the difficulty-1 target it beats).
 */
export function getHashDifficulty(hashHex: string): number {
  // Max target (Difficulty 1)
  const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
  const hashBigInt = BigInt(`0x${hashHex}`);
  if (hashBigInt === 0n) return 0;

  // Scale before the (integer) BigInt division so sub-1 difficulties survive.
  // Scaling by only 1000 truncated everything below difficulty 0.001 to
  // exactly 0 - which is nearly every hash a CPU/GPU actually finds.
  const SCALE = 10n ** 18n;
  return Number((maxTarget * SCALE) / hashBigInt) / 1e18;
}
