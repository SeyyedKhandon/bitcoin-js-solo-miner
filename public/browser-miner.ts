import { calculateMerkleRoot, buildHeaderBase, bytesToHex } from './bitcoin.js';
import { MiningMethod, getExtranonce2, getStartNonce, isRandomMethod, methodName, resolveMethod } from './strategies.js';
import type { BrowserJob } from './types.js';

interface MinerState {
    isMining: boolean;
    job: BrowserJob | null;
    ws: WebSocket | null;
    hashCount: number;
    /** Strategy pushed by the server (ALL_MODE already resolved). */
    method: number;
    customNonce: number;
    /** This miner's own extranonce2 counter, for the counter-based strategies. */
    extranonce2Counter: number;
    /** Where the next batch resumes for the sequential strategies. */
    nextNonce: number | null;
}

const minerState: MinerState = {
    isMining: false,
    job: null,
    ws: null,
    hashCount: 0,
    method: MiningMethod.STANDARD,
    customNonce: 0,
    extranonce2Counter: 0,
    nextNonce: null,
};

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

async function doubleSha256(buffer: Uint8Array): Promise<Uint8Array> {
    const hash1 = await crypto.subtle.digest('SHA-256', buffer as BufferSource);
    const hash2 = await crypto.subtle.digest('SHA-256', hash1);
    return new Uint8Array(hash2);
}

/** Adopts a strategy pushed by the server (ALL_MODE already resolved). */
function applyStrategy(msg: { method?: number; customNonce?: number }): void {
    if (typeof msg.method !== 'number') return;
    const changed = msg.method !== minerState.method;
    minerState.method = msg.method;
    minerState.customNonce = msg.customNonce ?? 0;
    if (changed) {
        console.log('Browser CPU miner strategy ->', methodName(resolveMethod(msg.method)));
        minerState.nextNonce = null; // re-derive the start nonce for the new strategy
    }
}

async function mineLoop(): Promise<void> {
    if (!minerState.isMining || !minerState.job) return;

    const job = minerState.job;

    const method = resolveMethod(minerState.method);
    const extranonce2 = getExtranonce2(method, job.extranonce2_size, minerState.extranonce2Counter);

    // Real Merkle root and real header, built the same verified way the
    // server-side worker does it - see mining/worker.ts.
    const merkleRoot = await calculateMerkleRoot(job.coinb1, job.extranonce1, extranonce2, job.coinb2, job.merkle_branch);
    const headerBase = buildHeaderBase(job.version, job.prevhash, bytesToHex(merkleRoot), job.ntime, job.nbits);

    const header = new Uint8Array(80);
    header.set(headerBase, 0);

    const target = job.target ? BigInt(`0x${job.target}`) : null;
    // The random strategies re-pick a starting point every batch; the
    // sequential ones sweep onward from where the last batch stopped, so
    // they aren't restarted every 100 hashes.
    const resumeNonce = !isRandomMethod(method) && minerState.nextNonce !== null;
    let nonce = resumeNonce ? minerState.nextNonce! : getStartNonce(method, minerState.customNonce);
    // Reports the best (lowest-value) hash seen this batch, not just the
    // last nonce tried - otherwise the Best Hash display only ever sampled
    // 1-in-100 arbitrary hashes instead of the actual best one found.
    let latestHash: string | null = null;
    let latestNonce = nonce;
    let bestHashBigInt: bigint | null = null;

    for (let i = 0; i < 100; i++) {
        if (!minerState.isMining) break;

        header[76] = (nonce >>> 24) & 0xFF;
        header[77] = (nonce >>> 16) & 0xFF;
        header[78] = (nonce >>> 8) & 0xFF;
        header[79] = nonce & 0xFF;

        const resultBytes = await doubleSha256(header);
        const hashHex = bytesToHex(resultBytes.slice().reverse());
        const hashBigInt = BigInt(`0x${hashHex}`);
        if (bestHashBigInt === null || hashBigInt < bestHashBigInt) {
            bestHashBigInt = hashBigInt;
            latestHash = hashHex;
            latestNonce = nonce;
        }

        if (target !== null && hashBigInt <= target) {
            const nonceBuffer = new Uint8Array(4);
            nonceBuffer[0] = (nonce >>> 24) & 0xFF;
            nonceBuffer[1] = (nonce >>> 16) & 0xFF;
            nonceBuffer[2] = (nonce >>> 8) & 0xFF;
            nonceBuffer[3] = nonce & 0xFF;

            if (minerState.ws && minerState.ws.readyState === WebSocket.OPEN) {
                minerState.ws.send(JSON.stringify({
                    type: 'share',
                    source: 'browser-cpu',
                    shareInfo: {
                        jobId: job.jobId,
                        extranonce2,
                        ntime: job.ntime,
                        nonce: bytesToHex(nonceBuffer),
                        hash: hashHex
                    }
                }));
            }
        }

        minerState.hashCount++;
        nonce = (nonce + 1) >>> 0;
        // Rolling past the end of the nonce space means this extranonce2 is
        // exhausted - advance it, as the server worker does.
        if (nonce === 0) minerState.extranonce2Counter++;
    }
    minerState.nextNonce = nonce;

    if (minerState.ws && minerState.ws.readyState === WebSocket.OPEN) {
        minerState.ws.send(JSON.stringify({
            type: 'hashrate',
            source: 'browser-cpu',
            count: 100,
            latestHash,
            version: job.version,
            en1: job.extranonce1,
            en2: extranonce2,
            nonce: (latestNonce >>> 0).toString(16).padStart(8, '0'),
            method: methodName(method)
        }));
    }

    setTimeout(mineLoop, 0);
}

function startBrowserMining(): void {
    if (minerState.isMining) return;
    minerState.isMining = true;

    minerState.ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`);

    minerState.ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'job') {
                console.log("Browser miner received new job:", msg.job.jobId);
                minerState.job = msg.job;
                applyStrategy(msg);
                // A new job means a new coinbase, so restart the sweep.
                minerState.nextNonce = null;
                minerState.extranonce2Counter = 0;
                if (minerState.isMining) {
                    mineLoop();
                }
            } else if (msg.type === 'strategy') {
                applyStrategy(msg);
            }
        } catch(e) {
            console.error("WS error:", e);
        }
    };

    minerState.ws.onopen = () => {
        console.log("Browser miner connected to Stratum proxy.");
        minerState.ws!.send(JSON.stringify({ type: 'hello', source: 'browser-cpu' }));
    };

    console.log("Browser mining started.");
}

function stopBrowserMining(): void {
    minerState.isMining = false;
    if (minerState.ws) {
        minerState.ws.close();
        minerState.ws = null;
    }
    console.log("Browser mining stopped.");
}

window.startBrowserMining = startBrowserMining;
window.stopBrowserMining = stopBrowserMining;
