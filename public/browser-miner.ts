// Coordinates a pool of Web Worker mining threads (browser-worker.ts) and
// reports their combined progress to the server over the WebSocket.
//
// This used to hash on the page's main thread through crypto.subtle, one
// awaited digest at a time, which capped out around 22k H/s. The workers use
// a synchronous SHA-256 and run in parallel, so the browser miner now scales
// with the machine instead of with promise-scheduling overhead.
import { MiningMethod, methodName, resolveMethod } from './strategies.js';
import type { BrowserJob } from './types.js';

interface MinerState {
    isMining: boolean;
    job: BrowserJob | null;
    ws: WebSocket | null;
    workers: Worker[];
    workerCount: number;
    method: number;
    customNonce: number;
    /** Hashes completed since the last report to the server. */
    pendingCount: number;
    /** Best hash seen since the last report, and its metadata. */
    bestHash: string | null;
    bestNonce: string;
    bestExtranonce2: string;
    bestMethod: number;
    reportTimer: number | null;
}

const minerState: MinerState = {
    isMining: false,
    job: null,
    ws: null,
    workers: [],
    workerCount: defaultWorkerCount(),
    method: MiningMethod.STANDARD,
    customNonce: 0,
    pendingCount: 0,
    bestHash: null,
    bestNonce: '',
    bestExtranonce2: '',
    bestMethod: MiningMethod.STANDARD,
    reportTimer: null,
};

function defaultWorkerCount(): number {
    // Leave a core for the page itself so the dashboard stays responsive.
    const cores = navigator.hardwareConcurrency || 4;
    return Math.max(1, Math.min(8, cores - 1));
}

export function getBrowserWorkerCount(): number {
    return minerState.workerCount;
}

/** Changes the pool size; restarts the pool if mining is already running. */
export function setBrowserWorkerCount(count: number): void {
    const next = Math.max(1, Math.min(32, Math.floor(count) || 1));
    if (next === minerState.workerCount) return;
    minerState.workerCount = next;
    console.log(`Browser CPU miner -> ${next} worker${next > 1 ? 's' : ''}`);
    if (minerState.isMining) {
        terminateWorkers();
        spawnWorkers();
        dispatchWork();
    }
}

function terminateWorkers(): void {
    for (const worker of minerState.workers) {
        worker.postMessage({ type: 'stop' });
        worker.terminate();
    }
    minerState.workers = [];
}

function spawnWorkers(): void {
    for (let i = 0; i < minerState.workerCount; i++) {
        const worker = new Worker(new URL('./browser-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent) => handleWorkerMessage(event.data);
        worker.onerror = (e) => console.error('Browser mining worker error:', e.message);
        minerState.workers.push(worker);
    }
}

function handleWorkerMessage(msg: any): void {
    if (msg.type === 'progress') {
        minerState.pendingCount += msg.count;
        // Keep the single best hash across all workers for this report window.
        if (msg.bestHash && (minerState.bestHash === null || msg.bestHash < minerState.bestHash)) {
            minerState.bestHash = msg.bestHash;
            minerState.bestNonce = msg.bestNonce;
            minerState.bestExtranonce2 = msg.extranonce2;
            minerState.bestMethod = msg.method;
        }
    } else if (msg.type === 'share') {
        if (minerState.ws && minerState.ws.readyState === WebSocket.OPEN) {
            minerState.ws.send(JSON.stringify({ type: 'share', source: 'browser-cpu', shareInfo: msg.shareInfo }));
        }
    }
}

function dispatchWork(): void {
    if (!minerState.job) return;
    minerState.workers.forEach((worker, index) => {
        worker.postMessage({
            type: 'work',
            job: minerState.job,
            method: minerState.method,
            customNonce: minerState.customNonce,
            workerId: index,
            totalWorkers: minerState.workers.length,
        });
    });
}

/**
 * Reports combined progress once a second rather than per batch, so a large
 * worker pool doesn't flood the socket.
 */
function report(): void {
    const job = minerState.job;
    if (!job || minerState.pendingCount === 0) return;
    if (!minerState.ws || minerState.ws.readyState !== WebSocket.OPEN) return;

    minerState.ws.send(JSON.stringify({
        type: 'hashrate',
        source: 'browser-cpu',
        count: minerState.pendingCount,
        latestHash: minerState.bestHash,
        version: job.version,
        en1: job.extranonce1,
        en2: minerState.bestExtranonce2,
        nonce: minerState.bestNonce,
        method: `${methodName(resolveMethod(minerState.bestMethod))} × ${minerState.workers.length}`,
    }));

    minerState.pendingCount = 0;
    minerState.bestHash = null;
}

/** Adopts a strategy pushed by the server (ALL_MODE already resolved). */
function applyStrategy(msg: { method?: number; customNonce?: number }): void {
    if (typeof msg.method !== 'number') return;
    const changed = msg.method !== minerState.method;
    minerState.method = msg.method;
    minerState.customNonce = msg.customNonce ?? 0;
    if (changed) {
        console.log('Browser CPU miner strategy ->', methodName(resolveMethod(msg.method)));
        for (const worker of minerState.workers) {
            worker.postMessage({ type: 'strategy', method: minerState.method, customNonce: minerState.customNonce });
        }
    }
}

function startBrowserMining(): void {
    if (minerState.isMining) return;
    minerState.isMining = true;
    spawnWorkers();

    minerState.ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`);

    minerState.ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'job') {
                console.log('Browser miner received new job:', msg.job.jobId);
                minerState.job = msg.job;
                applyStrategy(msg);
                if (minerState.isMining) dispatchWork();
            } else if (msg.type === 'strategy') {
                applyStrategy(msg);
            }
        } catch (e) {
            console.error('WS error:', e);
        }
    };

    minerState.ws.onopen = () => {
        console.log('Browser miner connected to Stratum proxy.');
        minerState.ws!.send(JSON.stringify({ type: 'hello', source: 'browser-cpu' }));
    };

    minerState.reportTimer = window.setInterval(report, 1000);
    console.log(`Browser mining started on ${minerState.workerCount} worker(s).`);
}

function stopBrowserMining(): void {
    minerState.isMining = false;
    terminateWorkers();
    if (minerState.reportTimer !== null) {
        clearInterval(minerState.reportTimer);
        minerState.reportTimer = null;
    }
    if (minerState.ws) {
        minerState.ws.close();
        minerState.ws = null;
    }
    minerState.pendingCount = 0;
    minerState.bestHash = null;
    console.log('Browser mining stopped.');
}

window.startBrowserMining = startBrowserMining;
window.stopBrowserMining = stopBrowserMining;
window.setBrowserWorkerCount = setBrowserWorkerCount;
window.getBrowserWorkerCount = getBrowserWorkerCount;
