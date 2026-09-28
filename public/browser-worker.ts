// One browser mining thread. Runs in a Web Worker so several can hash in
// parallel without touching the page's main thread, using the synchronous
// SHA-256 in sha256.ts rather than the async WebCrypto API.
import { hexToBytes, bytesToHex, buildHeaderBase } from './bitcoin.js';
import { doubleSha256, setHeaderPrefix, hashHeaderNonce } from './sha256.js';
import { getExtranonce2, getStartNonce, isRandomMethod, resolveMethod } from './strategies.js';
import type { BrowserJob } from './types.js';

/** Nonces hashed between yields, so 'stop'/'work' messages stay responsive. */
const BATCH = 20000;

interface WorkerState {
    mining: boolean;
    job: BrowserJob | null;
    method: number;
    customNonce: number;
    workerId: number;
    totalWorkers: number;
    extranonce2Counter: number;
    nonce: number;
    scheduled: boolean;
}

const state: WorkerState = {
    mining: false,
    job: null,
    method: 1,
    customNonce: 0,
    workerId: 0,
    totalWorkers: 1,
    extranonce2Counter: 0,
    nonce: 0,
    scheduled: false,
};

/** Merkle root for a Stratum job, synchronously - mirrors public/bitcoin.ts. */
function calculateMerkleRootSync(
    coinb1: string, extranonce1: string, extranonce2: string, coinb2: string, branch: string[]
): Uint8Array {
    let hash = doubleSha256(hexToBytes(coinb1 + extranonce1 + extranonce2 + coinb2));
    for (const step of branch) {
        const pair = new Uint8Array(64);
        pair.set(hash, 0);
        pair.set(hexToBytes(step), 32);
        hash = doubleSha256(pair);
    }
    return hash;
}

/** This worker's slice of the 32-bit nonce space. */
function sliceStart(): number {
    return Math.floor(0xFFFFFFFF / state.totalWorkers) * state.workerId;
}

function sliceSize(): number {
    return Math.floor(0xFFFFFFFF / state.totalWorkers);
}

const digest = new Uint8Array(32);
const display = new Uint8Array(32);

function reverseInto(src: Uint8Array, dst: Uint8Array): void {
    for (let i = 0; i < 32; i++) dst[i] = src[31 - i];
}

/** True when `display` is numerically <= the 32-byte target. */
function meetsTarget(target: Uint8Array): boolean {
    for (let i = 0; i < 32; i++) {
        if (display[i] !== target[i]) return display[i] < target[i];
    }
    return true;
}

function mineBatch(): void {
    state.scheduled = false;
    if (!state.mining || !state.job) return;

    const job = state.job;
    const method = resolveMethod(state.method);
    const extranonce2 = getExtranonce2(method, job.extranonce2_size, state.extranonce2Counter);

    const merkleRoot = calculateMerkleRootSync(job.coinb1, job.extranonce1, extranonce2, job.coinb2, job.merkle_branch);
    const headerBase = buildHeaderBase(job.version, job.prevhash, bytesToHex(merkleRoot), job.ntime, job.nbits);
    setHeaderPrefix(headerBase);

    const target = job.target ? hexToBytes(job.target) : null;

    // Random strategies re-pick their starting point each batch; sequential
    // ones sweep onward from where the last batch stopped.
    if (isRandomMethod(method) || state.nonce === 0) {
        const start = getStartNonce(method, state.customNonce);
        state.nonce = isRandomMethod(method) ? start : (sliceStart() + start) >>> 0;
    }

    let nonce = state.nonce;
    let bestHex: string | null = null;
    let bestNonce = nonce;
    let bestFirstWord = 0xFFFFFFFF;

    for (let i = 0; i < BATCH; i++) {
        hashHeaderNonce(nonce, digest);
        reverseInto(digest, display);

        // Rank on the leading 32 bits; only the winner is hex-encoded, since
        // doing that for every attempt would cost more than the hash itself.
        const firstWord = ((display[0] << 24) | (display[1] << 16) | (display[2] << 8) | display[3]) >>> 0;
        if (firstWord <= bestFirstWord) {
            bestFirstWord = firstWord;
            bestNonce = nonce;
            bestHex = null; // encoded once the batch ends
        }

        if (target !== null && meetsTarget(target)) {
            const nonceBuf = new Uint8Array(4);
            nonceBuf[0] = (nonce >>> 24) & 0xff;
            nonceBuf[1] = (nonce >>> 16) & 0xff;
            nonceBuf[2] = (nonce >>> 8) & 0xff;
            nonceBuf[3] = nonce & 0xff;
            self.postMessage({
                type: 'share',
                shareInfo: {
                    jobId: job.jobId,
                    extranonce2,
                    ntime: job.ntime,
                    nonce: bytesToHex(nonceBuf),
                    hash: bytesToHex(display),
                },
            });
        }

        nonce = (nonce + 1) >>> 0;
        // Sweeping past this worker's slice means the extranonce2 is spent.
        if (!isRandomMethod(method) && nonce >= (sliceStart() + sliceSize()) >>> 0) {
            state.extranonce2Counter++;
            nonce = sliceStart() >>> 0;
            break;
        }
    }
    state.nonce = nonce;

    if (bestHex === null) {
        hashHeaderNonce(bestNonce, digest);
        reverseInto(digest, display);
        bestHex = bytesToHex(display);
    }

    self.postMessage({
        type: 'progress',
        count: BATCH,
        bestHash: bestHex,
        bestNonce: (bestNonce >>> 0).toString(16).padStart(8, '0'),
        extranonce2,
        method,
    });

    schedule();
}

function schedule(): void {
    if (!state.mining || state.scheduled) return;
    state.scheduled = true;
    // setTimeout rather than a straight loop, so incoming messages get a turn.
    setTimeout(mineBatch, 0);
}

self.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    if (msg.type === 'work') {
        const jobChanged = !state.job || state.job.jobId !== msg.job.jobId;
        state.job = msg.job;
        state.method = msg.method ?? state.method;
        state.customNonce = msg.customNonce ?? 0;
        state.workerId = msg.workerId ?? 0;
        state.totalWorkers = msg.totalWorkers ?? 1;
        if (jobChanged) {
            state.extranonce2Counter = 0;
            state.nonce = 0; // re-derive the start for the new coinbase
        }
        state.mining = true;
        schedule();
    } else if (msg.type === 'strategy') {
        state.method = msg.method ?? state.method;
        state.customNonce = msg.customNonce ?? 0;
        state.nonce = 0;
    } else if (msg.type === 'stop') {
        state.mining = false;
    }
};
