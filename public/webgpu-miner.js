import { webgpuMinerShader } from './shader.js';

const wgMinerState = {
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
    bindGroup: null,
    nonceOffset: 0,
    isHashing: false
};

function hexToU32Array(hex) {
    if (hex.length % 8 !== 0) throw new Error("Hex must be multiple of 8 chars for u32");
    const arr = new Uint32Array(hex.length / 8);
    for (let i = 0; i < arr.length; i++) {
        // Parse 4 bytes (8 hex chars), but remember Bitcoin headers are little endian in memory
        // and we parse it as Big Endian words or Little Endian words depending on shader.
        // Actually, let's just pass raw bytes packed in u32s.
        const chunk = hex.substr(i * 8, 8);
        arr[i] = parseInt(chunk, 16);
    }
    return arr;
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

async function initWebGPU() {
    if (!navigator.gpu) {
        throw new Error("WebGPU not supported on this browser.");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("No appropriate GPUAdapter found.");
    }

    wgMinerState.device = await adapter.requestDevice();

    const shaderModule = wgMinerState.device.createShaderModule({
        code: webgpuMinerShader,
    });

    wgMinerState.pipeline = wgMinerState.device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: shaderModule,
            entryPoint: 'main',
        },
    });

    // Buffers
    wgMinerState.headerBuffer = wgMinerState.device.createBuffer({
        size: 20 * 4, // 80 bytes (20 u32s)
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    wgMinerState.targetBuffer = wgMinerState.device.createBuffer({
        size: 8 * 4, // 32 bytes
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    wgMinerState.resultBuffer = wgMinerState.device.createBuffer({
        size: 256 * 4, // 1 atomic count + up to 255 nonces
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    wgMinerState.resultReadBuffer = wgMinerState.device.createBuffer({
        size: 256 * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    wgMinerState.bindGroup = wgMinerState.device.createBindGroup({
        layout: wgMinerState.pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: wgMinerState.headerBuffer } },
            { binding: 1, resource: { buffer: wgMinerState.targetBuffer } },
            { binding: 2, resource: { buffer: wgMinerState.resultBuffer } },
        ],
    });
}

async function mineWebGPULoop() {
    try {
        if (!wgMinerState.isMining || !wgMinerState.job || !wgMinerState.device || wgMinerState.isHashing) return;
        wgMinerState.isHashing = true;

        const job = wgMinerState.job;
        const extranonce2Bytes = crypto.getRandomValues(new Uint8Array(job.extranonce2_size || 8));
        const extranonce2 = bytesToHex(extranonce2Bytes);

        // Mock header construction
        const headerHex = job.version + job.prevhash + "0000000000000000000000000000000000000000000000000000000000000000" + job.ntime + job.nbits + "00000000";
        const headerBytes = hexToBytes(headerHex);

        // Byte swap for endianness (simplified, bitcoin uses little endian fields)
        const swappedHeader = new Uint8Array(80);
        for (let i = 0; i < 80; i += 4) {
            swappedHeader[i] = headerBytes[i+3];
            swappedHeader[i+1] = headerBytes[i+2];
            swappedHeader[i+2] = headerBytes[i+1];
            swappedHeader[i+3] = headerBytes[i];
        }

        // Convert to u32 array for WebGPU
        const headerU32 = new Uint32Array(20);
        for (let i=0; i<19; i++) {
            // Just send first 76 bytes, last 4 is nonce which shader handles
            headerU32[i] = (swappedHeader[i*4] << 24) | (swappedHeader[i*4+1] << 16) | (swappedHeader[i*4+2] << 8) | swappedHeader[i*4+3];
        }

        // Convert target hex to u32 array
        // Target in bitcoin is 256-bit little-endian integer.
        const targetBytes = hexToBytes(wgMinerState.targetHex);
        const targetU32 = new Uint32Array(8);
        for (let i=0; i<8; i++) {
            targetU32[i] = (targetBytes[i*4+3] << 24) | (targetBytes[i*4+2] << 16) | (targetBytes[i*4+1] << 8) | targetBytes[i*4];
        }

        wgMinerState.device.queue.writeBuffer(wgMinerState.headerBuffer, 0, headerU32);
        wgMinerState.device.queue.writeBuffer(wgMinerState.targetBuffer, 0, targetU32);

        // Clear result buffer
        const zeroResult = new Uint32Array(256);
        wgMinerState.device.queue.writeBuffer(wgMinerState.resultBuffer, 0, zeroResult);

        const WORKGROUP_SIZE = 64;
        const NUM_WORKGROUPS = 10000; // 640k nonces per frame
        const hashesDone = WORKGROUP_SIZE * NUM_WORKGROUPS;

        const commandEncoder = wgMinerState.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(wgMinerState.pipeline);
        passEncoder.setBindGroup(0, wgMinerState.bindGroup);
        passEncoder.dispatchWorkgroups(NUM_WORKGROUPS);
        passEncoder.end();

        commandEncoder.copyBufferToBuffer(
            wgMinerState.resultBuffer, 0,
            wgMinerState.resultReadBuffer, 0,
            256 * 4
        );

        wgMinerState.device.queue.submit([commandEncoder.finish()]);

        await wgMinerState.resultReadBuffer.mapAsync(GPUMapMode.READ);
        const arrayBuffer = wgMinerState.resultReadBuffer.getMappedRange();
        const resultU32 = new Uint32Array(arrayBuffer);
        
        const count = resultU32[0];
        if (count > 0) {
            console.log(`WEBGPU: Found ${count} nonces!`);
            for (let i = 1; i <= count && i < 256; i++) {
                const foundNonce = resultU32[i];
                const nonceBuffer = new Uint8Array(4);
                nonceBuffer[0] = (foundNonce >>> 24) & 0xFF;
                nonceBuffer[1] = (foundNonce >>> 16) & 0xFF;
                nonceBuffer[2] = (foundNonce >>> 8) & 0xFF;
                nonceBuffer[3] = foundNonce & 0xFF;

                wgMinerState.ws.send(JSON.stringify({
                    type: 'share',
                    source: 'webgpu',
                    shareInfo: {
                        jobId: job.jobId,
                        extranonce2: extranonce2,
                        ntime: job.ntime,
                        nonce: bytesToHex(nonceBuffer),
                        hash: "WEBGPU_FOUND_HASH_PLACEHOLDER"
                    }
                }));
            }
        }

        wgMinerState.resultReadBuffer.unmap();
        wgMinerState.hashCount += hashesDone;

        // Send hashrate update
        if (wgMinerState.ws && wgMinerState.ws.readyState === WebSocket.OPEN) {
            wgMinerState.ws.send(JSON.stringify({
                type: 'hashrate',
                source: 'webgpu',
                count: hashesDone
            }));
        }

        // Randomize nonce offset next run if we want full coverage
        wgMinerState.nonceOffset += NUM_WORKGROUPS;
        
        wgMinerState.isHashing = false;
        if (wgMinerState.isMining) {
            requestAnimationFrame(mineWebGPULoop);
        }
    } catch(e) {
        console.error("WebGPU loop error:", e);
        wgMinerState.isHashing = false;
    }
}

export async function startWebGPUMining() {
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
    wgMinerState.ws = new WebSocket(`ws://${window.location.host}`);
    
    wgMinerState.ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'job') {
                console.log("WebGPU miner received new job:", msg.job.jobId);
                wgMinerState.job = msg.job;
                wgMinerState.targetHex = msg.job.target || "000000000000000000021a420000000000000000000000000000000000000000"; // fallback
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
        wgMinerState.ws.send(JSON.stringify({ type: 'hello', source: 'webgpu' }));
    };
    
    console.log("WebGPU mining started.");
}

export function stopWebGPUMining() {
    wgMinerState.isMining = false;
    if (wgMinerState.ws) {
        wgMinerState.ws.close();
        wgMinerState.ws = null;
    }
    console.log("WebGPU mining stopped.");
}

window.startWebGPUMining = startWebGPUMining;
window.stopWebGPUMining = stopWebGPUMining;
