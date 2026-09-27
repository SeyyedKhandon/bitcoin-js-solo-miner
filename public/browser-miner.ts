// No import statement here on purpose: this file is loaded as a classic
// (non-module) <script>, and any import/export - even type-only - would
// make TypeScript emit an 'export {}' marker that throws a SyntaxError in
// that context. Duplicating this tiny type locally avoids that.
interface BrowserJob {
    jobId: string;
    prevhash: string;
    coinb1: string;
    coinb2: string;
    merkle_branch: string[];
    version: string;
    nbits: string;
    ntime: string;
    clean_jobs: boolean;
    extranonce1: string;
    extranonce2_size: number;
    target?: string;
}

interface MinerState {
    isMining: boolean;
    job: BrowserJob | null;
    target: string;
    difficulty: number;
    ws: WebSocket | null;
    hashCount: number;
    startTime: number;
}

const minerState: MinerState = {
    isMining: false,
    job: null,
    target: '',
    difficulty: 0,
    ws: null,
    hashCount: 0,
    startTime: 0
};

// Web Crypto API is CPU bound, but we do this to show the browser mining architecture.
// A true WebGPU implementation would replace this function.
async function hashDoubleSha256(buffer: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const hash1 = await crypto.subtle.digest('SHA-256', buffer);
    const hash2 = await crypto.subtle.digest('SHA-256', hash1);
    return new Uint8Array(hash2);
}

function hexToBytes(hex: string): Uint8Array {
    let bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

function reverseBytes(hex: string): string {
    return bytesToHex(hexToBytes(hex).reverse());
}

async function mineLoop(): Promise<void> {
    if (!minerState.isMining || !minerState.job) return;

    const job = minerState.job;

    // Simplification for the mock: just pick a random extranonce2 and nonce
    const extranonce2Bytes = crypto.getRandomValues(new Uint8Array(job.extranonce2_size) as Uint8Array<ArrayBuffer>);
    const extranonce2 = bytesToHex(extranonce2Bytes);

    // We would calculate the merkle root properly here
    // For the sake of this mock browser miner architecture, we will just construct a dummy header
    // In reality, this requires full merkle branch hashing
    const headerHex = job.version + job.prevhash + "0000000000000000000000000000000000000000000000000000000000000000" + job.ntime + job.nbits + "00000000";
    const headerBytes = hexToBytes(headerHex);

    // Byte swap for endianness (simplified)
    const swappedHeader = new Uint8Array(80);
    for (let i = 0; i < 80; i += 4) {
        swappedHeader[i] = headerBytes[i+3];
        swappedHeader[i+1] = headerBytes[i+2];
        swappedHeader[i+2] = headerBytes[i+1];
        swappedHeader[i+3] = headerBytes[i];
    }

    const nonceOffset = 76;
    let nonce = Math.floor(Math.random() * 0xFFFFFFFF);
    let latestHash: string | null = null;
    let latestNonce = nonce;

    for (let i = 0; i < 100; i++) {
        if (!minerState.isMining) break;

        swappedHeader[nonceOffset] = (nonce >>> 24) & 0xFF;
        swappedHeader[nonceOffset + 1] = (nonce >>> 16) & 0xFF;
        swappedHeader[nonceOffset + 2] = (nonce >>> 8) & 0xFF;
        swappedHeader[nonceOffset + 3] = nonce & 0xFF;

        const resultBytes = await hashDoubleSha256(swappedHeader);
        latestHash = reverseBytes(bytesToHex(resultBytes));
        latestNonce = nonce;

        minerState.hashCount++;
        nonce++;
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

    minerState.ws = new WebSocket(`ws://${window.location.host}`);

    minerState.ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'job') {
                console.log("Browser miner received new job:", msg.job.jobId);
                minerState.job = msg.job;
                minerState.difficulty = msg.difficulty;
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

// Export to window
window.startBrowserMining = startBrowserMining;
window.stopBrowserMining = stopBrowserMining;
