import { calculateMerkleRoot, buildHeaderBase, bytesToHex } from './bitcoin.js';
import type { BrowserJob } from './types.js';

interface MinerState {
    isMining: boolean;
    job: BrowserJob | null;
    ws: WebSocket | null;
    hashCount: number;
}

const minerState: MinerState = {
    isMining: false,
    job: null,
    ws: null,
    hashCount: 0,
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

async function mineLoop(): Promise<void> {
    if (!minerState.isMining || !minerState.job) return;

    const job = minerState.job;

    const extranonce2Bytes = crypto.getRandomValues(new Uint8Array(job.extranonce2_size) as Uint8Array<ArrayBuffer>);
    const extranonce2 = bytesToHex(extranonce2Bytes);

    // Real Merkle root and real header, built the same verified way the
    // server-side worker does it - see mining/worker.ts.
    const merkleRoot = await calculateMerkleRoot(job.coinb1, job.extranonce1, extranonce2, job.coinb2, job.merkle_branch);
    const headerBase = buildHeaderBase(job.version, job.prevhash, bytesToHex(merkleRoot), job.ntime, job.nbits);

    const header = new Uint8Array(80);
    header.set(headerBase, 0);

    const target = job.target ? BigInt(`0x${job.target}`) : null;
    let nonce = Math.floor(Math.random() * 0xFFFFFFFF);
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
    }

    if (minerState.ws && minerState.ws.readyState === WebSocket.OPEN) {
        minerState.ws.send(JSON.stringify({
            type: 'hashrate',
            source: 'browser-cpu',
            count: 100,
            latestHash,
            version: job.version,
            en1: job.extranonce1,
            en2: extranonce2,
            nonce: (latestNonce >>> 0).toString(16).padStart(8, '0')
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
                if (minerState.isMining) {
                    mineLoop();
                }
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
