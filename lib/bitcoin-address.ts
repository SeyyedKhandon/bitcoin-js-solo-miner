import { doubleSha256 } from './hash.js';

// Bitcoin script opcodes relevant to standard output types
const OP_0 = 0x00;
const OP_PUSHDATA_20 = 0x14;
const OP_PUSHDATA_32 = 0x20;
const OP_1 = 0x51;
const OP_RETURN = 0x6a;
const OP_DUP = 0x76;
const OP_EQUAL = 0x87;
const OP_EQUALVERIFY = 0x88;
const OP_HASH160 = 0xa9;
const OP_CHECKSIG = 0xac;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58Check-encodes a version byte + payload hash (used for P2PKH/P2SH addresses). */
export function base58CheckEncode(version: number, hash: Buffer | Uint8Array): string {
  const payload = Buffer.concat([Buffer.from([version]), hash]);
  const checksum = doubleSha256(payload).subarray(0, 4);
  const full = Buffer.concat([payload, checksum]);

  let num = BigInt('0x' + full.toString('hex'));
  let out = '';
  while (num > 0n) {
    const rem = num % 58n;
    num /= 58n;
    out = BASE58_ALPHABET[Number(rem)] + out;
  }
  for (const byte of full) {
    if (byte === 0) out = '1' + out;
    else break;
  }
  return out;
}

// --- Bech32 / Bech32m (BIP-173 / BIP-350), used for segwit addresses ---
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function bech32CreateChecksum(hrp: string, data: number[], constValue: number): number[] {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ constValue;
  const result: number[] = [];
  for (let i = 0; i < 6; i++) result.push((mod >>> (5 * (5 - i))) & 31);
  return result;
}

function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0, bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >>> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}

/** Encodes a witness program as a bech32 (v0) or bech32m (v1+) segwit address. */
export function segwitAddrEncode(hrp: string, witver: number, program: Buffer | Uint8Array): string {
  const constValue = witver === 0 ? BECH32_CONST : BECH32M_CONST;
  const data = [witver, ...convertBits([...program], 8, 5, true)];
  const checksum = bech32CreateChecksum(hrp, data, constValue);
  const combined = [...data, ...checksum];
  return hrp + '1' + combined.map(d => BECH32_CHARSET[d]).join('');
}

function bin2hex(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

/**
 * Decodes a coinbase transaction output's scriptPubKey into a human-readable
 * address (P2PKH, P2SH, P2WPKH, P2WSH, P2TR), an "OP_RETURN: ..." string for
 * data-carrying outputs (e.g. the SegWit witness commitment), or a hex dump
 * for anything else - mirroring ESP-Miner's coinbase_decode_address_from_scriptpubkey.
 */
export function decodeAddressFromScriptPubKey(script: Buffer, hrp: string, isTestnet: boolean): string {
  const len = script.length;
  if (len === 0) return 'unknown';

  const p2pkhVersion = isTestnet ? 0x6f : 0x00;
  const p2shVersion = isTestnet ? 0xc4 : 0x05;

  // P2PKH: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  if (len === 25 && script[0] === OP_DUP && script[1] === OP_HASH160 &&
      script[2] === OP_PUSHDATA_20 && script[23] === OP_EQUALVERIFY && script[24] === OP_CHECKSIG) {
    return base58CheckEncode(p2pkhVersion, script.subarray(3, 23));
  }

  // P2SH: OP_HASH160 <20 bytes> OP_EQUAL
  if (len === 23 && script[0] === OP_HASH160 && script[1] === OP_PUSHDATA_20 && script[22] === OP_EQUAL) {
    return base58CheckEncode(p2shVersion, script.subarray(2, 22));
  }

  // P2WPKH: OP_0 <20 bytes>
  if (len === 22 && script[0] === OP_0 && script[1] === OP_PUSHDATA_20) {
    return segwitAddrEncode(hrp, 0, script.subarray(2, 22));
  }

  // P2WSH: OP_0 <32 bytes>
  if (len === 34 && script[0] === OP_0 && script[1] === OP_PUSHDATA_32) {
    return segwitAddrEncode(hrp, 0, script.subarray(2, 34));
  }

  // P2TR: OP_1 <32 bytes>
  if (len === 34 && script[0] === OP_1 && script[1] === OP_PUSHDATA_32) {
    return segwitAddrEncode(hrp, 1, script.subarray(2, 34));
  }

  // OP_RETURN: OP_RETURN <data> - e.g. the SegWit witness commitment
  if (len > 0 && script[0] === OP_RETURN) {
    let offset = 1;
    if (len > 1 && script[1] > 0 && script[1] <= 0x4b && script[1] + 2 === len) {
      offset = 2;
    }
    let out = 'OP_RETURN: ';
    for (let i = offset; i < len; i++) {
      const c = script[i];
      out += (c >= 32 && c <= 126) ? String.fromCharCode(c) : '.';
    }
    return out;
  }

  // Unknown format
  return 'UNKNOWN:' + bin2hex(script.subarray(0, Math.min(len, 32)));
}
