import { webgpuMinerShader } from './shader.js';
import { calculateMerkleRoot, buildHeaderBase, hexToBytes, bytesToHex, doubleSha256 } from './bitcoin.js';
import { MiningMethod, getExtranonce2, getStartNonce, isRandomMethod, methodName, resolveMethod } from './strategies.js';
const WORKGROUP_SIZE = 64;
/** Workgroups dispatched at 100% intensity; buffers are always sized for this. */
const MAX_WORKGROUPS = 10000;
/**
 * How much of the GPU a single dispatch uses. Lower values submit smaller
 * batches, so the card stays available for the desktop and the browser keeps
 * repainting; 100% mines as hard as the GPU allows.
 */
function activeWorkgroups() {
    return Math.max(1, Math.round(MAX_WORKGROUPS * wgMinerState.intensityPct / 100));
}
function noncesPerDispatch() {
    return WORKGROUP_SIZE * activeWorkgroups();
}
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
    nonceOffsetBuffer: null,
    bestPerWorkgroupBuffer: null,
    bestPerWorkgroupReadBuffer: null,
    bindGroup: null,
    isHashing: false,
    extranonce2: '',
    nonceBase: 0,
    method: MiningMethod.STANDARD,
    customNonce: 0,
    extranonce2Counter: 0,
    intensityPct: 50
};
/**
 * Paces the next dispatch so the GPU genuinely idles between batches.
 *
 * Shrinking the batch alone is not a real utilisation limit: the loop still
 * submits work every frame, so a card that can finish a small batch quickly
 * just goes back to being busy immediately. Idling for a measured share of
 * each cycle is what actually caps utilisation - at P%, work for T ms then
 * stay idle for T * (100 - P) / P ms, giving a ~P% duty cycle whatever the
 * card's speed.
 */
function scheduleNextDispatch(lastDispatchMs) {
    const pct = wgMinerState.intensityPct;
    if (pct >= 100) {
        requestAnimationFrame(mineWebGPULoop);
        return;
    }
    const idleMs = Math.min(1000, lastDispatchMs * (100 - pct) / pct);
    setTimeout(mineWebGPULoop, Math.max(0, Math.round(idleMs)));
}
/** Sets how hard the GPU is driven. Takes effect on the next dispatch. */
export function setWebGPUIntensity(pct) {
    if (!Number.isFinite(pct))
        return;
    wgMinerState.intensityPct = Math.min(100, Math.max(1, pct));
    console.log(`WebGPU intensity -> ${wgMinerState.intensityPct}% (${noncesPerDispatch().toLocaleString()} nonces per dispatch)`);
}
/** Adopts a strategy pushed by the server (ALL_MODE already resolved). */
function applyStrategy(msg) {
    if (typeof msg.method !== 'number')
        return;
    const changed = msg.method !== wgMinerState.method;
    wgMinerState.method = msg.method;
    wgMinerState.customNonce = msg.customNonce ?? 0;
    if (changed) {
        console.log('WebGPU miner strategy ->', methodName(resolveMethod(msg.method)));
        // Re-derive the sweep start and extranonce2 for the new strategy.
        wgMinerState.extranonce2 = '';
        wgMinerState.nonceBase = getStartNonce(resolveMethod(msg.method), wgMinerState.customNonce);
    }
}
/**
 * Builds an explanation for a failed adapter request. "No adapter" usually
 * isn't a browser-support problem - it's most often a Linux box where the
 * browser has WebGPU but cannot reach a GPU through Vulkan, which the old
 * catch-all "your browser may not support it" message actively misdiagnosed.
 */
function noAdapterHelp() {
    const ua = navigator.userAgent;
    const isLinux = /Linux/i.test(ua) && !/Android/i.test(ua);
    const isFirefox = /Firefox/i.test(ua);
    const lines = [
        'WebGPU is available in this browser, but it could not find a usable GPU adapter.',
        ''
    ];
    if (isLinux) {
        lines.push('On Linux this is usually a driver or flag issue rather than missing hardware:', '• WebGPU needs Vulkan - install your GPU\'s Vulkan driver (e.g. "sudo apt install mesa-vulkan-drivers", plus the vendor driver for NVIDIA).', '• Verify Vulkan works outside the browser with "vulkaninfo" (from vulkan-tools).');
        if (isFirefox) {
            lines.push('• In Firefox, set dom.webgpu.enabled to true in about:config, then restart.');
        }
        else {
            lines.push('• In Chrome/Chromium, enable chrome://flags/#enable-unsafe-webgpu and restart, or launch with --enable-unsafe-webgpu.', '• Check chrome://gpu - the "WebGPU" and "Vulkan" rows there say what was blocked and why.');
        }
        lines.push('• Headless/remote/VM sessions and software rendering (llvmpipe) often have no usable adapter at all.');
    }
    else {
        lines.push('Check that your GPU drivers are up to date, and that hardware acceleration is enabled in the browser settings.', 'In Chrome/Chromium, chrome://gpu shows whether WebGPU was blocklisted and why.');
    }
    lines.push('', 'CPU mining still works - only GPU mining is unavailable.');
    return lines.join('\n');
}
async function initWebGPU() {
    if (!navigator.gpu) {
        throw new Error('This browser does not expose WebGPU at all (navigator.gpu is missing). ' +
            'It needs a recent Chrome/Edge/Chromium, or Firefox with dom.webgpu.enabled. ' +
            'CPU mining still works.');
    }
    // Ask for a discrete GPU first, then accept whatever is available -
    // some systems only return an adapter for one of these.
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        || await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error(noAdapterHelp());
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
        size: MAX_WORKGROUPS * 2 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    wgMinerState.bestPerWorkgroupReadBuffer = device.createBuffer({
        size: MAX_WORKGROUPS * 2 * 4,
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
function packHeaderU32(header) {
    const words = new Uint32Array(20);
    for (let i = 0; i < 19; i++) {
        words[i] = (header[i * 4 + 3] << 24) | (header[i * 4 + 2] << 16) | (header[i * 4 + 1] << 8) | header[i * 4];
    }
    return words;
}
/** Packs the target in natural big-endian order (word 0 = target's own most significant bytes). */
function packTargetU32(target) {
    const words = new Uint32Array(8);
    for (let i = 0; i < 8; i++) {
        words[i] = (target[i * 4] << 24) | (target[i * 4 + 1] << 16) | (target[i * 4 + 2] << 8) | target[i * 4 + 3];
    }
    return words;
}
async function mineWebGPULoop() {
    try {
        if (!wgMinerState.isMining || !wgMinerState.job || !wgMinerState.device || wgMinerState.isHashing)
            return;
        wgMinerState.isHashing = true;
        const dispatchStartedAt = performance.now();
        const device = wgMinerState.device;
        const job = wgMinerState.job;
        // Advance through the nonce space by one dispatch worth of nonces
        // each dispatch. Once the 32-bit space is exhausted, roll a fresh
        // extranonce2 (changing the Merkle root) and start over at 0.
        const method = resolveMethod(wgMinerState.method);
        if (!wgMinerState.extranonce2 || wgMinerState.nonceBase + noncesPerDispatch() > 0xFFFFFFFF) {
            if (wgMinerState.extranonce2)
                wgMinerState.extranonce2Counter++;
            wgMinerState.extranonce2 = getExtranonce2(method, job.extranonce2_size || 8, wgMinerState.extranonce2Counter);
            wgMinerState.nonceBase = getStartNonce(method, wgMinerState.customNonce);
        }
        else if (isRandomMethod(method)) {
            // These strategies re-pick where they look every dispatch rather
            // than sweeping onward.
            wgMinerState.extranonce2 = getExtranonce2(method, job.extranonce2_size || 8, wgMinerState.extranonce2Counter);
            wgMinerState.nonceBase = getStartNonce(method, wgMinerState.customNonce);
        }
        const extranonce2 = wgMinerState.extranonce2;
        const nonceBase = wgMinerState.nonceBase;
        const merkleRoot = await calculateMerkleRoot(job.coinb1, job.extranonce1, extranonce2, job.coinb2, job.merkle_branch);
        // stopWebGPUMining may have freed the device while we were awaiting.
        if (!wgMinerState.isMining || !wgMinerState.device) {
            wgMinerState.isHashing = false;
            return;
        }
        const headerBase = buildHeaderBase(job.version, job.prevhash, bytesToHex(merkleRoot), job.ntime, job.nbits);
        const header = new Uint8Array(80);
        header.set(headerBase, 0);
        // header[76..79] (nonce) is filled in by the shader from nonceOffset + global_id.x
        const headerU32 = packHeaderU32(header);
        const targetU32 = packTargetU32(hexToBytes(wgMinerState.targetHex));
        device.queue.writeBuffer(wgMinerState.headerBuffer, 0, headerU32);
        device.queue.writeBuffer(wgMinerState.targetBuffer, 0, targetU32);
        device.queue.writeBuffer(wgMinerState.nonceOffsetBuffer, 0, new Uint32Array([nonceBase]));
        const zeroResult = new Uint32Array(256);
        device.queue.writeBuffer(wgMinerState.resultBuffer, 0, zeroResult);
        const commandEncoder = device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(wgMinerState.pipeline);
        passEncoder.setBindGroup(0, wgMinerState.bindGroup);
        const dispatchedWorkgroups = activeWorkgroups();
        passEncoder.dispatchWorkgroups(dispatchedWorkgroups);
        passEncoder.end();
        commandEncoder.copyBufferToBuffer(wgMinerState.resultBuffer, 0, wgMinerState.resultReadBuffer, 0, 256 * 4);
        commandEncoder.copyBufferToBuffer(wgMinerState.bestPerWorkgroupBuffer, 0, wgMinerState.bestPerWorkgroupReadBuffer, 0, dispatchedWorkgroups * 2 * 4);
        device.queue.submit([commandEncoder.finish()]);
        if (!wgMinerState.isMining || !wgMinerState.resultReadBuffer) {
            wgMinerState.isHashing = false;
            return;
        }
        await wgMinerState.resultReadBuffer.mapAsync(GPUMapMode.READ);
        const arrayBuffer = wgMinerState.resultReadBuffer.getMappedRange();
        const resultU32 = new Uint32Array(arrayBuffer.slice(0));
        wgMinerState.resultReadBuffer.unmap();
        await wgMinerState.bestPerWorkgroupReadBuffer.mapAsync(GPUMapMode.READ);
        const bestArrayBuffer = wgMinerState.bestPerWorkgroupReadBuffer.getMappedRange();
        const bestPerWorkgroupU32 = new Uint32Array(bestArrayBuffer.slice(0));
        wgMinerState.bestPerWorkgroupReadBuffer.unmap();
        const count = resultU32[0];
        let latestHash = null;
        let latestNonceHex = null;
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
        const dispatchedNonces = WORKGROUP_SIZE * dispatchedWorkgroups;
        wgMinerState.hashCount += dispatchedNonces;
        // Find this dispatch's actual best hash: each workgroup already
        // reduced its own 64 threads down to one (topWord, nonce) pair
        // (see bestPerWorkgroup in shader.ts), so this is a cheap min-scan
        // over one pair per workgroup rather than every hash - and,
        // unlike a random sample, it's guaranteed to be the true best.
        if (!latestHash) {
            let bestWord = bestPerWorkgroupU32[0];
            let bestNonce = bestPerWorkgroupU32[1];
            for (let i = 1; i < dispatchedWorkgroups; i++) {
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
            }
            catch (e) {
                console.error('WebGPU best-hash recompute failed:', e);
            }
        }
        if (wgMinerState.ws && wgMinerState.ws.readyState === WebSocket.OPEN) {
            wgMinerState.ws.send(JSON.stringify({
                type: 'hashrate',
                source: 'webgpu',
                count: dispatchedNonces,
                latestHash,
                version: job.version,
                en1: job.extranonce1,
                en2: extranonce2,
                nonce: latestNonceHex || (nonceBase >>> 0).toString(16).padStart(8, '0'),
                method: methodName(method)
            }));
        }
        wgMinerState.nonceBase = nonceBase + dispatchedNonces;
        wgMinerState.isHashing = false;
        if (wgMinerState.isMining) {
            scheduleNextDispatch(performance.now() - dispatchStartedAt);
        }
    }
    catch (e) {
        // Stopping tears down the device and buffers, so a dispatch that was
        // in flight at that moment will throw - that is expected, not an error.
        if (wgMinerState.isMining)
            console.error("WebGPU loop error:", e);
        wgMinerState.isHashing = false;
    }
}
export async function startWebGPUMining() {
    if (wgMinerState.isMining)
        return;
    if (!wgMinerState.device) {
        try {
            await initWebGPU();
            console.log("WebGPU Initialized!");
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error("WebGPU Init failed:", message);
            alert(message);
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
                applyStrategy(msg);
                // A new job means a new coinbase/Merkle root - reset nonce progress.
                wgMinerState.extranonce2 = '';
                wgMinerState.extranonce2Counter = 0;
                wgMinerState.nonceBase = getStartNonce(resolveMethod(wgMinerState.method), wgMinerState.customNonce);
                if (wgMinerState.isMining) {
                    mineWebGPULoop();
                }
            }
            else if (msg.type === 'strategy') {
                applyStrategy(msg);
            }
        }
        catch (e) {
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
    releaseGPUResources();
    console.log("WebGPU mining stopped.");
}
/**
 * Frees the GPU device and its buffers when mining stops. Without this a
 * stopped miner held the adapter, the pipeline and ~160KB of readback
 * buffers open for the lifetime of the tab, which shows up as the GPU
 * still being in use. startWebGPUMining re-initialises from scratch.
 */
function releaseGPUResources() {
    const buffers = [
        wgMinerState.headerBuffer, wgMinerState.targetBuffer,
        wgMinerState.resultBuffer, wgMinerState.resultReadBuffer,
        wgMinerState.nonceOffsetBuffer,
        wgMinerState.bestPerWorkgroupBuffer, wgMinerState.bestPerWorkgroupReadBuffer,
    ];
    for (const buffer of buffers) {
        // An in-flight dispatch may still hold a mapped buffer; destroying
        // it is still the right call, we just don't want the throw.
        try {
            buffer?.destroy();
        }
        catch { /* already gone */ }
    }
    wgMinerState.headerBuffer = null;
    wgMinerState.targetBuffer = null;
    wgMinerState.resultBuffer = null;
    wgMinerState.resultReadBuffer = null;
    wgMinerState.nonceOffsetBuffer = null;
    wgMinerState.bestPerWorkgroupBuffer = null;
    wgMinerState.bestPerWorkgroupReadBuffer = null;
    wgMinerState.bindGroup = null;
    wgMinerState.pipeline = null;
    try {
        wgMinerState.device?.destroy();
    }
    catch { /* already gone */ }
    wgMinerState.device = null;
}
window.setWebGPUIntensity = setWebGPUIntensity;
window.startWebGPUMining = startWebGPUMining;
window.stopWebGPUMining = stopWebGPUMining;
