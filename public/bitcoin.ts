// Real Bitcoin header/merkle-root construction for the browser miners,
// mirroring mining/worker.ts's (verified-correct) algorithm exactly.

async function sha256(data: Uint8Array): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return new Uint8Array(digest);
}

export async function doubleSha256(data: Uint8Array): Promise<Uint8Array> {
    return sha256(await sha256(data));
}

export function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/**
 * Real Merkle root for a Stratum job: double-SHA256 the coinbase
 * transaction, then fold it through the Merkle branch. The result is
 * already in the correct raw byte order to embed directly in a block
 * header - verified against a real mined block's actual txid list and
 * merkle root.
 */
export async function calculateMerkleRoot(
    coinb1: string, extranonce1: string, extranonce2: string, coinb2: string, merkleBranch: string[]
): Promise<Uint8Array> {
    const coinbase = coinb1 + extranonce1 + extranonce2 + coinb2;
    let hash = await doubleSha256(hexToBytes(coinbase));
    for (const branch of merkleBranch) {
        const pair = new Uint8Array(64);
        pair.set(hash, 0);
        pair.set(hexToBytes(branch), 32);
        hash = await doubleSha256(pair);
    }
    return hash;
}

/**
 * Builds the 76-byte pre-nonce portion of a block header (version +
 * prevhash + merkleRoot + ntime + nbits), with the correct byte-order
 * fix-up: pool-supplied fields (version/prevhash/ntime/nbits) get a
 * per-4-byte-word swap, the merkle root does not (it's already correct
 * as computed). Verified end-to-end against a real mined block's actual
 * header and hash - see mining/worker.ts for the same logic and its
 * verification notes.
 */
export function buildHeaderBase(version: string, prevhash: string, merkleRootHex: string, ntime: string, nbits: string): Uint8Array {
    const baseHeaderHex = version + prevhash + merkleRootHex + ntime + nbits;
    const header = hexToBytes(baseHeaderHex);

    const MERKLE_ROOT_START = 36; // version(4) + prevhash(32)
    const MERKLE_ROOT_END = 68;   // + merkleRoot(32)
    for (let i = 0; i < header.length; i += 4) {
        if (i >= MERKLE_ROOT_START && i < MERKLE_ROOT_END) continue;
        const tmp0 = header[i];
        header[i] = header[i + 3];
        header[i + 3] = tmp0;
        const tmp1 = header[i + 1];
        header[i + 1] = header[i + 2];
        header[i + 2] = tmp1;
    }

    return header;
}
