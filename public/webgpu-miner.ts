import { webgpuMinerShader } from './shader.js';
import { calculateMerkleRoot, buildHeaderBase, hexToBytes, bytesToHex, doubleSha256 } from './bitcoin.js';
import type { BrowserJob } from './types.js';

const WORKGROUP_SIZE = 64;
const NUM_WORKGROUPS = 10000;
const NONCES_PER_DISPATCH = WORKGROUP_SIZE * NUM_WORKGROUPS; // 640,000

interface WebGPUMinerState {
    isMining: boolean;
    job: BrowserJob | null;
    targetHex: string;
    ws: WebSocket | null;
    hashCount: number;
    device: GPUDevice | null;
    pipeline: GPUComputePipeline | null;
    headerBuffer: GPUBuffer | null;
    targetBuffer: GPUBuffer | null;
    resultBuffer: GPUBuffer | null;
    resultReadBuffer: GPUBuffer | null;
    nonceOffsetBuffer: GPUBuffer | null;
    bestPerWorkgroupBuffer: GPUBuffer | null;
    bestPerWorkgroupReadBuffer: GPUBuffer | null;
    bindGroup: GPUBindGroup | null;
    isHashing: boolean;
    // Nonce-space progress for the current job: which 640k-nonce slice
    // we're on, and which extranonce2 that's under. When the 32-bit nonce
    // space under the current extranonce2 is exhausted, extranonce2
    // advances and nonceBase resets - mirroring the CPU worker's
    // extranonce2Counter/currentNonce behavior in mining/worker.ts.
    extranonce2: string;
    nonceBase: number;
}

const wgMinerState: WebGPUMinerState = {
    isMining: false,
    job: null,
    targetHex: '',
    ws: null,
    hashCount: 0,
    device: null,
    pipeline: null,
    headerBuffer: null,
    targetBuffer: null,
    resultBuffer: null,
    resultReadBuffer: null,
    nonceOffsetBuffer: null,
    bestPerWorkgroupBuffer: null,
    bestPerWorkgroupReadBuffer: null,
    bindGroup: null,
    isHashing: false,
    extranonce2: '',
    nonceBase: 0
};

async function initWebGPU(): Promise<void> {
    if (!navigator.gpu) {
        throw new Error("WebGPU not supported on this browser.");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("No appropriate GPUAdapter found.");
    }

    wgMinerState.device = await adapter.requestDevice();
    const device = wgMinerState.device;

    const shaderModule = device.createShaderModule({
        code: webgpuMinerShader,
    });

    wgMinerState.pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: shaderModule,
            entryPoint: 'main',
        },
    });

    wgMinerState.headerBuffer = device.createBuffer({
        size: 20 * 4, // 80 bytes (20 u32s)
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    wgMinerState.targetBuffer = device.createBuffer({
        size: 8 * 4, // 32 bytes
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    wgMinerState.resultBuffer = device.createBuffer({
        size: 256 * 4, // 1 atomic count + up to 255 nonces
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    wgMinerState.resultReadBuffer = device.createBuffer({
        size: 256 * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    wgMinerState.nonceOffsetBuffer = device.createBuffer({
        size: 4, // one u32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // One (best top-word, best nonce) pair per workgroup, reduced locally in
    // the shader from its 64 threads - see bestPerWorkgroup in shader.ts.
    wgMinerState.bestPerWorkgroupBuffer = device.createBuffer({
        size: NUM_WORKGROUPS * 2 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    wgMinerState.bestPerWorkgroupReadBuffer = device.createBuffer({
        size: NUM_WORKGROUPS * 2 * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    wgMinerState.bindGroup = device.createBindGroup({
        layout: wgMinerState.pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: wgMinerState.headerBuffer } },
            { binding: 1, resource: { buffer: wgMinerState.targetBuffer } },
            { binding: 2, resource: { buffer: wgMinerState.resultBuffer } },
            { binding: 3, resource: { buffer: wgMinerState.nonceOffsetBuffer } },
            { binding: 4, resource: { buffer: wgMinerState.bestPerWorkgroupBuffer } },
        ],
    });
}

/** Packs header bytes into u32s matching the shader's unpack (byte 0 of each word = LSB). */
function packHeaderU32(header: Uint8Array): Uint32Array {
    const words = new Uint32Array(20);
    for (let i = 0; i < 19; i++) {
        words[i] = (header[i * 4 + 3] << 24) | (header[i * 4 + 2] << 16) | (header[i * 4 + 1] << 8) | header[i * 4];
    }
    return words;
}

/** Packs the target in natural big-endian order (word 0 = target's own most significant bytes). */
function packTargetU32(target: Uint8Array): Uint32Array {
    const words = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
        words[i] = (target[i * 4] << 24) | (target[i * 4 + 1] << 16) | (target[i * 4 + 2] << 8) | target[i * 4 + 3];
    }
    return words;
}

async function mineWebGPULoop(): Promise<void> {
    try {
        if (!wgMinerState.isMining || !wgMinerState.job || !wgMinerState.device || wgMinerState.isHashing) return;
        wgMinerState.isHashing = true;

        const device = wgMinerState.device;
        const job = wgMinerState.job;

        // Advance through the nonce space: NONCES_PER_DISPATCH new nonces
        // each dispatch. Once the 32-bit space is exhausted, roll a fresh
        // extranonce2 (changing the Merkle root) and start over at 0.
        if (!wgMinerState.extranonce2 || wgMinerState.nonceBase + NONCES_PER_DISPATCH > 0xFFFFFFFF) {
            const extranonce2Bytes = crypto.getRandomValues(new Uint8Array(job.extranonce2_size || 8) as Uint8Array<ArrayBuffer>);
            wgMinerState.extranonce2 = bytesToHex(extranonce2Bytes);
            wgMinerState.nonceBase = 0;
        }
        const extranonce2 = wgMinerState.extranonce2;
        const nonceBase = wgMinerState.nonceBase;

        const merkleRoot = await calculateMerkleRoot(job.coinb1, job.extranonce1, extranonce2, job.coinb2, job.merkle_branch);
        const headerBase = buildHeaderBase(job.version, job.prevhash, bytesToHex(merkleRoot), job.ntime, job.nbits);

        const header = new Uint8Array(80);
        header.set(headerBase, 0);
        // header[76..79] (nonce) is filled in by the shader from nonceOffset + global_id.x

        const headerU32 = packHeaderU32(header);
        const targetU32 = packTargetU32(hexToBytes(wgMinerState.targetHex));

        device.queue.writeBuffer(wgMinerState.headerBuffer!, 0, headerU32);
        device.queue.writeBuffer(wgMinerState.targetBuffer!, 0, targetU32);
        device.queue.writeBuffer(wgMinerState.nonceOffsetBuffer!, 0, new Uint32Array([nonceBase]));

        const zeroResult = new Uint32Array(256);
        device.queue.writeBuffer(wgMinerState.resultBuffer!, 0, zeroResult);

        const commandEncoder = device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(wgMinerState.pipeline!);
        passEncoder.setBindGroup(0, wgMinerState.bindGroup!);
        passEncoder.dispatchWorkgroups(NUM_WORKGROUPS);
        passEncoder.end();

        commandEncoder.copyBufferToBuffer(
            wgMinerState.resultBuffer!, 0,
            wgMinerState.resultReadBuffer!, 0,
            256 * 4
        );
        commandEncoder.copyBufferToBuffer(
            wgMinerState.bestPerWorkgroupBuffer!, 0,
            wgMinerState.bestPerWorkgroupReadBuffer!, 0,
            NUM_WORKGROUPS * 2 * 4
        );

        device.queue.submit([commandEncoder.finish()]);

        await wgMinerState.resultReadBuffer!.mapAsync(GPUMapMode.READ);
        const arrayBuffer = wgMinerState.resultReadBuffer!.getMappedRange();
        const resultU32 = new Uint32Array(arrayBuffer.slice(0));
        wgMinerState.resultReadBuffer!.unmap();

        await wgMinerState.bestPerWorkgroupReadBuffer!.mapAsync(GPUMapMode.READ);
        const bestArrayBuffer = wgMinerState.bestPerWorkgroupReadBuffer!.getMappedRange();
        const bestPerWorkgroupU32 = new Uint32Array(bestArrayBuffer.slice(0));
        wgMinerState.bestPerWorkgroupReadBuffer!.unmap();

        const count = resultU32[0];
        let latestHash: string | null = null;
        let latestNonceHex: string | null = null;

        if (count > 0) {
            console.log(`WEBGPU: Found ${count} nonce(s) beating the target!`);
            for (let i = 1; i <= count && i < 256; i++) {
                const foundNonce = resultU32[i];
                const nonceBuffer = new Uint8Array(4);
                nonceBuffer[0] = (foundNonce >>> 24) & 0xFF;
                nonceBuffer[1] = (foundNonce >>> 16) & 0xFF;
                nonceBuffer[2] = (foundNonce >>> 8) & 0xFF;
                nonceBuffer[3] = foundNonce & 0xFF;

                // Recompute the real hash for this specific nonce to report it honestly.
                const shareHeader = new Uint8Array(header);
                shareHeader.set(nonceBuffer, 76);
                const shareHash = bytesToHex((await doubleSha256(shareHeader)).slice().reverse());
                latestHash = shareHash;
                latestNonceHex = bytesToHex(nonceBuffer);

                if (wgMinerState.ws && wgMinerState.ws.readyState === WebSocket.OPEN) {
                    wgMinerState.ws.send(JSON.stringify({
                        type: 'share',
                        source: 'webgpu',
                        shareInfo: {
                            jobId: job.jobId,
                            extranonce2,
                            ntime: job.ntime,
                            nonce: bytesToHex(nonceBuffer),
                            hash: shareHash
                        }
                    }));
                }
            }
        }

        wgMinerState.hashCount += NONCES_PER_DISPATCH;

        // Find this dispatch's actual best hash: each workgroup already
        // reduced its own 64 threads down to one (topWord, nonce) pair
        // (see bestPerWorkgroup in shader.ts), so this is a cheap min-scan
        // over NUM_WORKGROUPS pairs rather than the full 640k hashes - and,
        // unlike a random sample, it's guaranteed to be the true best.
        if (!latestHash) {
            let bestWord = bestPerWorkgroupU32[0];
            let bestNonce = bestPerWorkgroupU32[1];
            for (let i = 1; i < NUM_WORKGROUPS; i++) {
                const word = bestPerWorkgroupU32[i * 2];
                if (word < bestWord) {
                    bestWord = word;
                    bestNonce = bestPerWorkgroupU32[i * 2 + 1];
                }
            }

            const bestNonceBuffer = new Uint8Array(4);
            bestNonceBuffer[0] = (bestNonce >>> 24) & 0xFF;
            bestNonceBuffer[1] = (bestNonce >>> 16) & 0xFF;
            bestNonceBuffer[2] = (bestNonce >>> 8) & 0xFF;
            bestNonceBuffer[3] = bestNonce & 0xFF;

            // Recompute the real hash for this nonce to report it honestly,
            // same as for shares above.
            const bestHeader = new Uint8Array(header);
            bestHeader.set(bestNonceBuffer, 76);
            try {
                latestHash = bytesToHex((await doubleSha256(bestHeader)).slice().reverse());
                latestNonceHex = bytesToHex(bestNonceBuffer);
            } catch (e) {
                console.error('WebGPU best-hash recompute failed:', e);
            }
        }

        if (wgMinerState.ws && wgMinerState.ws.readyState === WebSocket.OPEN) {
            wgMinerState.ws.send(JSON.stringify({
                type: 'hashrate',
                source: 'webgpu',
                count: NONCES_PER_DISPATCH,
                latestHash,
                version: job.version,
                en1: job.extranonce1,
                en2: extranonce2,
                nonce: latestNonceHex || (nonceBase >>> 0).toString(16).padStart(8, '0'),
                // Fixed scan strategy: a random extranonce2, then a
                // sequential sweep of the nonce space in dispatch-sized
                // blocks, rolling extranonce2 once the space is exhausted.
                method: 'random EN2, sequential sweep'
            }));
        }

        wgMinerState.nonceBase = nonceBase + NONCES_PER_DISPATCH;

        wgMinerState.isHashing = false;
        if (wgMinerState.isMining) {
            requestAnimationFrame(mineWebGPULoop);
        }
    } catch(e) {
        console.error("WebGPU loop error:", e);
        wgMinerState.isHashing = false;
    }
}

export async function startWebGPUMining(): Promise<void> {
    if (wgMinerState.isMining) return;

    if (!wgMinerState.device) {
        try {
            await initWebGPU();
            console.log("WebGPU Initialized!");
        } catch (e) {
            console.error("WebGPU Init failed:", e);
            alert("WebGPU failed to initialize. Your browser may not support it.");
            return;
        }
    }

    wgMinerState.isMining = true;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wgMinerState.ws = new WebSocket(`${wsProtocol}//${window.location.host}`);

    wgMinerState.ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'job') {
                console.log("WebGPU miner received new job:", msg.job.jobId);
                wgMinerState.job = msg.job;
                wgMinerState.targetHex = msg.job.target || "000000000000000000021a420000000000000000000000000000000000000000"; // fallback
                // A new job means a new coinbase/Merkle root - reset nonce progress.
                wgMinerState.extranonce2 = '';
                wgMinerState.nonceBase = 0;
                if (wgMinerState.isMining) {
                    mineWebGPULoop();
                }
            }
        } catch(e) {
            console.error("WS error:", e);
        }
    };

    wgMinerState.ws.onopen = () => {
        console.log("WebGPU miner connected to Stratum proxy.");
        wgMinerState.ws!.send(JSON.stringify({ type: 'hello', source: 'webgpu' }));
    };

    console.log("WebGPU mining started.");
}

export function stopWebGPUMining(): void {
    wgMinerState.isMining = false;
    if (wgMinerState.ws) {
        wgMinerState.ws.close();
        wgMinerState.ws = null;
    }
    console.log("WebGPU mining stopped.");
}

window.startWebGPUMining = startWebGPUMining;
window.stopWebGPUMining = stopWebGPUMining;
