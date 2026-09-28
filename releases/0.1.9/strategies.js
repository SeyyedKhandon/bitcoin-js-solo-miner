// Browser-side port of the nonce-search strategies the Node.js workers use,
// shared by the browser CPU and WebGPU miners so the dashboard's strategy
// selector applies to them too. The numeric values must stay in sync with
// MiningMethod in mining/strategies.ts, since the server sends the resolved
// method over the WebSocket.
export const MiningMethod = {
    ALL_MODE: 0,
    STANDARD: 1,
    TOP_DOWN: 2,
    INVERTED_VERSION: 3,
    RANDOMIZED: 4,
    RANDOM_INVERTED: 5,
    GOLDEN_RATIO: 6,
    RANDOM_EN2: 7,
    EN2_BIGENDIAN: 8,
    CUSTOM_NONCE: 9,
    RANDOM_EN2_RIGHT: 10,
    RANDOM_EN2_MIDDLE: 11,
    LIST_NONCES: 12,
};
const METHOD_NAMES = Object.fromEntries(Object.entries(MiningMethod).map(([name, value]) => [value, name]));
export function methodName(method) {
    return METHOD_NAMES[method] || `UNKNOWN (${method})`;
}
/**
 * INVERTED_VERSION and RANDOM_INVERTED flip the header version without
 * telling the pool, so any share found under them is rejected - see the
 * deprecation note in mining/strategies.ts. The browser miners deliberately
 * do not implement the version flip; they fall back to the equivalent
 * strategy without it.
 */
export function resolveMethod(method) {
    if (method === MiningMethod.INVERTED_VERSION)
        return MiningMethod.STANDARD;
    if (method === MiningMethod.RANDOM_INVERTED)
        return MiningMethod.RANDOMIZED;
    return method;
}
function bytesToHexLocal(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++)
        hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
}
/**
 * Builds the extranonce2 for a batch, mirroring getExtranonce2() in
 * mining/worker.ts. `counter` is this miner's own extranonce2 counter.
 */
export function getExtranonce2(method, size, counter) {
    if (size <= 0)
        return '';
    const buf = new Uint8Array(size);
    if (method === MiningMethod.RANDOM_EN2) {
        crypto.getRandomValues(buf);
        return bytesToHexLocal(buf);
    }
    const view = new DataView(buf.buffer);
    if (method === MiningMethod.EN2_BIGENDIAN) {
        if (size >= 4)
            view.setUint32(0, counter >>> 0, false);
        return bytesToHexLocal(buf);
    }
    // Everything else writes the counter into the last 4 bytes, then some
    // variants randomise part of the buffer on top of it.
    if (size >= 4)
        view.setUint32(size - 4, counter >>> 0, false);
    if (method === MiningMethod.RANDOM_EN2_RIGHT && size >= 4) {
        const rand = new Uint8Array(4);
        crypto.getRandomValues(rand);
        buf.set(rand, size - 4);
    }
    else if (method === MiningMethod.RANDOM_EN2_MIDDLE) {
        const mid = Math.floor(size / 2);
        const offset = mid > 2 ? mid - 2 : 0;
        const length = Math.min(4, size - offset);
        if (length > 0) {
            const rand = new Uint8Array(length);
            crypto.getRandomValues(rand);
            buf.set(rand, offset);
        }
    }
    return bytesToHexLocal(buf);
}
/**
 * Strategies that re-pick their starting point every batch rather than
 * sweeping onward from where the last one stopped - mirrors RANDOM_METHODS
 * in mining/worker.ts.
 */
const RANDOM_METHODS = [
    MiningMethod.RANDOMIZED,
    MiningMethod.RANDOM_INVERTED,
    MiningMethod.GOLDEN_RATIO,
    MiningMethod.RANDOM_EN2,
    MiningMethod.RANDOM_EN2_RIGHT,
    MiningMethod.RANDOM_EN2_MIDDLE,
    MiningMethod.LIST_NONCES,
];
export function isRandomMethod(method) {
    return RANDOM_METHODS.includes(method);
}
/**
 * Picks the starting nonce for a batch, mirroring the switch in
 * mining/worker.ts. The browser miners are a single searcher rather than a
 * pool of threads, so the whole 32-bit space is theirs.
 */
export function getStartNonce(method, customNonce) {
    const SPACE = 0xFFFFFFFF;
    switch (method) {
        case MiningMethod.TOP_DOWN:
            return 0x00E00000;
        case MiningMethod.RANDOMIZED:
            return Math.floor(Math.random() * SPACE);
        case MiningMethod.GOLDEN_RATIO: {
            const PHI_PRIME = 0x9E3779B9;
            const entropy = crypto.getRandomValues(new Uint32Array(1))[0];
            const timeEntropy = Date.now() & 0xFFFFFFFF;
            return (Math.imul(entropy, PHI_PRIME) ^ timeEntropy) >>> 0;
        }
        case MiningMethod.CUSTOM_NONCE:
            return customNonce >>> 0;
        case MiningMethod.LIST_NONCES:
            // The historical-nonce list is a server-side data file the
            // browser has no access to, and the server falls back to 0 when
            // it is absent (the normal case) - match that.
            return 0;
        default:
            return 0;
    }
}
