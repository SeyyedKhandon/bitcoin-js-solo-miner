import { getTargetFromNbits, getHashDifficulty } from '../lib/hash.js';
import { decodeAddressFromScriptPubKey } from '../lib/bitcoin-address.js';
import type { MiningJob, MiningNotificationResult } from '../lib/types.js';

const MAX_DISPLAYED_OUTPUTS = 20;
const BIP110_SIGNAL_BIT = 4;
const BIP110_SIGNAL_EXPIRY_BLOCK = 965664;

interface VarintResult {
  value: number;
  offset: number;
}

/** Reads a Bitcoin varint starting at `offset`; returns { value, offset: nextOffset }. */
export function decodeVarint(buf: Buffer, offset: number): VarintResult {
  const first = buf[offset];
  offset += 1;

  if (first < 0xfd) return { value: first, offset };
  if (first === 0xfd) {
    return { value: buf.readUInt16LE(offset), offset: offset + 2 };
  }
  if (first === 0xfe) {
    return { value: buf.readUInt32LE(offset), offset: offset + 4 };
  }
  return { value: Number(buf.readBigUInt64LE(offset)), offset: offset + 8 };
}

function detectNetwork(userAddress: string | undefined): { hrp: string; isTestnet: boolean } {
  if (userAddress) {
    if (userAddress.startsWith('bcrt1')) return { hrp: 'bcrt', isTestnet: true };
    if (userAddress.startsWith('tb1')) return { hrp: 'tb', isTestnet: true };
    if (userAddress[0] === 'm' || userAddress[0] === 'n' || userAddress[0] === '2') return { hrp: 'tb', isTestnet: true };
  }
  return { hrp: 'bc', isTestnet: false };
}

/**
 * Decodes real block-header info out of a Stratum job's coinbase transaction:
 * network difficulty (from nbits), the block height and miner tag (BIP34
 * scriptSig), and the coinbase transaction's outputs (addresses + values,
 * including the SegWit witness-commitment OP_RETURN). Also detects BIP-54
 * and BIP-110 signaling. Ported from ESP-Miner's coinbase_decoder.c, which
 * runs this same decode on real ASIC hardware.
 *
 * Throws if the coinbase doesn't match the standard single-input layout
 * pools use; callers should treat that as "couldn't decode this job" rather
 * than a fatal error.
 */
export function processMiningNotification(
  job: MiningJob,
  extranonce1Hex: string,
  extranonce2Len: number,
  userAddress: string | undefined
): MiningNotificationResult {
  const { hrp, isTestnet } = detectNetwork(userAddress);

  const result: MiningNotificationResult = {
    networkDifficulty: getHashDifficulty(getTargetFromNbits(job.nbits)),
    blockHeight: 0,
    scriptsig: null,
    outputs: [],
    totalValueSatoshis: 0,
    userValueSatoshis: 0,
    bip54Signaling: false,
    bip110Signaling: false
  };

  const c1 = Buffer.from(job.coinb1, 'hex');
  const c1Len = c1.length;
  let c1Offset = 41; // version(4) + input count(1) + prevhash(32) + prevout index(4)
  if (c1Len < c1Offset) throw new Error('coinbase1 shorter than expected input prefix');

  const scriptsigLen = c1[c1Offset];
  c1Offset += 1;
  if (c1Len < c1Offset) throw new Error('coinbase1 too short for scriptsig length');

  const blockHeightLen = c1[c1Offset];
  c1Offset += 1;
  if (c1Len < c1Offset || blockHeightLen === 0 || blockHeightLen > 4) {
    throw new Error('invalid BIP34 block height length');
  }

  let blockHeight = 0;
  for (let i = 0; i < blockHeightLen; i++) blockHeight |= c1[c1Offset + i] << (8 * i);
  blockHeight = blockHeight >>> 0;
  c1Offset += blockHeightLen;
  result.blockHeight = blockHeight;

  const versionInt = parseInt(job.version, 16);
  result.bip110Signaling = blockHeight < BIP110_SIGNAL_EXPIRY_BLOCK && (versionInt & (1 << BIP110_SIGNAL_BIT)) !== 0;

  const extranonce1Len = extranonce1Hex.length / 2;
  let scriptsigLength = scriptsigLen - 1 - blockHeightLen;

  // If the scriptSig's tag extends past what's left in coinbase1, it runs into
  // the extranonces - subtract those out to get just the printable tag length.
  if (c1Len - c1Offset < scriptsigLength) {
    scriptsigLength -= (extranonce1Len + extranonce2Len);
  }

  const c2 = Buffer.from(job.coinb2, 'hex');
  const c2Len = c2.length;

  if (scriptsigLength > 0) {
    const c1TagLen = Math.min(c1Len - c1Offset, scriptsigLength);
    const c2TagLen = scriptsigLength - c1TagLen;
    if (c2Len >= c2TagLen) {
      const tagBytes = c2TagLen > 0
        ? Buffer.concat([c1.subarray(c1Offset, c1Offset + c1TagLen), c2.subarray(0, c2TagLen)])
        : c1.subarray(c1Offset, c1Offset + c1TagLen);

      let tag = '';
      for (const b of tagBytes) tag += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
      result.scriptsig = tag;
    }
  }

  // Figure out where, within coinbase2, the outputs section begins - the
  // scriptSig tag (and the extranonces) may spill over into its front.
  const rawScriptsigRemainder = (scriptsigLen - 1 - blockHeightLen) - (c1Len - c1Offset);
  let c2Offset = 0;
  if (rawScriptsigRemainder > 0) {
    const remainderInC2 = rawScriptsigRemainder - (extranonce1Len + extranonce2Len);
    if (remainderInC2 > 0) c2Offset = remainderInC2;
  }

  let offset = c2Offset;
  if (offset + 4 > c2Len) return result; // no room for the rest of the transaction

  const nSequence = c2.readUInt32LE(offset);
  offset += 4;

  if (offset >= c2Len) return result;
  const numOutputsVarint = decodeVarint(c2, offset);
  const numOutputs = numOutputsVarint.value;
  offset = numOutputsVarint.offset;

  for (let i = 0; i < numOutputs && offset < c2Len; i++) {
    if (offset + 8 > c2Len) break;
    const valueSatoshis = Number(c2.readBigUInt64LE(offset));
    offset += 8;
    result.totalValueSatoshis += valueSatoshis;

    if (offset >= c2Len) break;
    const scriptLenVarint = decodeVarint(c2, offset);
    const scriptLen = scriptLenVarint.value;
    offset = scriptLenVarint.offset;
    if (offset + scriptLen > c2Len) break;

    const scriptBuf = c2.subarray(offset, offset + scriptLen);
    if (result.outputs.length < MAX_DISPLAYED_OUTPUTS) {
      const address = decodeAddressFromScriptPubKey(scriptBuf, hrp, isTestnet);
      const isUserOutput = valueSatoshis > 0 && !!userAddress && userAddress.startsWith(address);
      if (isUserOutput) result.userValueSatoshis += valueSatoshis;
      result.outputs.push({ address, valueSatoshis, isUserOutput });
    }

    offset += scriptLen;
  }

  let nLockTime = 0;
  if (offset + 4 <= c2Len) nLockTime = c2.readUInt32LE(offset);

  result.bip54Signaling = (nLockTime === ((blockHeight - 1) >>> 0)) && (nSequence !== 0xffffffff);

  return result;
}
