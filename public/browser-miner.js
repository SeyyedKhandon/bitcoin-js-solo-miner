const minerState = {
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
async function hashDoubleSha256(buffer) {
    const hash1 = await crypto.subtle.digest('SHA-256', buffer);
    const hash2 = await crypto.subtle.digest('SHA-256', hash1);
    return new Uint8Array(hash2);
}

function hexToBytes(hex) {
    let bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

function reverseBytes(hex) {
    return bytesToHex(hexToBytes(hex).reverse());
}

async function mineLoop() {
    if (!minerState.isMining || !minerState.job) return;

    const job = minerState.job;

    // Simplification for the mock: just pick a random extranonce2 and nonce
    const extranonce2Bytes = crypto.getRandomValues(new Uint8Array(job.extranonce2_size));
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

    for (let i = 0; i < 100; i++) {
        if (!minerState.isMining) break;

        swappedHeader[nonceOffset] = (nonce >>> 24) & 0xFF;
        swappedHeader[nonceOffset + 1] = (nonce >>> 16) & 0xFF;
        swappedHeader[nonceOffset + 2] = (nonce >>> 8) & 0xFF;
        swappedHeader[nonceOffset + 3] = nonce & 0xFF;

        const resultBytes = await hashDoubleSha256(swappedHeader);
        const resultHex = reverseBytes(bytesToHex(resultBytes));

        minerState.hashCount++;
        nonce++;
    }

    setTimeout(mineLoop, 0);
}

function startBrowserMining() {
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
    };

    console.log("Browser mining started.");
}

function stopBrowserMining() {
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
