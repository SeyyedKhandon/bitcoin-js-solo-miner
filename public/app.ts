const evtSource = new EventSource('/api/events');

// DOM Elements
const els = {
    status: document.getElementById('connection-status')!,
    hashrate1s: document.getElementById('val-hashrate-1s')!,
    hashrate1m: document.getElementById('val-hashrate-1m')!,
    hashrate1h: document.getElementById('val-hashrate-1h')!,
    totalHashes: document.getElementById('val-total-hashes')!,
    shares: document.getElementById('val-shares')!,
    staleShares: document.getElementById('val-stale-shares')!,
    efficiency: document.getElementById('val-efficiency'),
    difficulty: document.getElementById('val-difficulty'),
    poolDiff: document.getElementById('val-pool-diff'),
    target: document.getElementById('val-target'),
    // Configuration inputs
    protocolSelect: document.getElementById('protocol-select') as HTMLSelectElement | null,
    threadsSelect: document.getElementById('threads-select') as HTMLSelectElement | null,
    difficultyNbits: document.getElementById('val-difficulty-nbits'),
    poolMode: document.getElementById('val-pool-mode'),
    jobsReceived: document.getElementById('val-jobs-received'),
    currentJob: document.getElementById('val-current-job'),
    customNonceInput: document.getElementById('custom-nonce-input') as HTMLInputElement,

    latestZeros: document.getElementById('val-latest-zeros')!,
    latestDiff: document.getElementById('val-latest-diff')!,
    latestHash: document.getElementById('val-latest-hash')!,
    latestVer: document.getElementById('val-latest-ver')!,
    latestEn1: document.getElementById('val-latest-en1')!,
    latestEn2: document.getElementById('val-latest-en2')!,
    latestNonce: document.getElementById('val-latest-nonce')!,
    latestMethod: document.getElementById('val-latest-method')!,

    bestZeros: document.getElementById('val-best-zeros')!,
    bestDiff: document.getElementById('val-best-diff')!,
    bestHash: document.getElementById('val-best-hash')!,
    bestVer: document.getElementById('val-best-ver')!,
    bestEn1: document.getElementById('val-best-en1')!,
    bestEn2: document.getElementById('val-best-en2')!,
    bestNonce: document.getElementById('val-best-nonce')!,
    bestMethod: document.getElementById('val-best-method')!,
};

interface HashRecord {
    hash: string;
    zeros: number;
    difficulty: number;
    version?: string;
    en1?: string;
    en2?: string;
    nonce?: string;
    method?: string;
}

interface CoinbaseOutput {
    address: string;
    valueSatoshis: number;
    isUserOutput: boolean;
}

interface BlockHeaderInfo {
    networkDifficulty: number;
    blockHeight: number;
    scriptsig: string | null;
    outputs: CoinbaseOutput[];
    totalValueSatoshis: number;
    userValueSatoshis: number;
    bip54Signaling: boolean;
    bip110Signaling: boolean;
}

interface MinerStatsMessage {
    hashrate1s: number;
    hashrate1m: number;
    hashrate1h: number;
    totalHashes: number;
    sharesFound: number;
    staleShares: number;
    efficiency: string;
    difficultyDecimal: number | string;
    difficultyNbits: string;
    target: string;
    protocol?: string;
    jobsReceived?: number;
    currentJobId: string | null;
    threads?: number;
    activeMethod?: number;
    customNonce: number;
    isMining?: boolean;
    latestHash: HashRecord | 'N/A';
    bestHash: HashRecord | 'N/A';
    blockHeader: BlockHeaderInfo | null;
}

interface StoredPreferences {
    nodeMining: boolean;
    browserMining: boolean;
    webgpuMining: boolean;
    threads: number;
    protocol: string;
    strategy: number;
    customNonce: number;
}

const PREFERENCES_KEY = 'bitcoinJsSoloMiner.preferences';

// CPU mining (the Node.js server-side miner) is the default running method
// on a first-ever visit; the browser/WebGPU miners are opt-in extras.
const DEFAULT_PREFERENCES: StoredPreferences = {
    nodeMining: true,
    browserMining: false,
    webgpuMining: false,
    threads: 1,
    protocol: 'SV1',
    strategy: 0,
    customNonce: 0,
};

function loadPreferences(): StoredPreferences {
    try {
        const raw = localStorage.getItem(PREFERENCES_KEY);
        if (!raw) return { ...DEFAULT_PREFERENCES };
        return { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_PREFERENCES };
    }
}

function savePreference<K extends keyof StoredPreferences>(key: K, value: StoredPreferences[K]): void {
    try {
        const current = loadPreferences();
        current[key] = value;
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify(current));
    } catch {
        // localStorage unavailable (private browsing, storage full, etc.) -
        // preferences just won't persist across reloads.
    }
}

function formatNumber(num: number): string {
    return new Intl.NumberFormat().format(num);
}

function diffSuffix(value: number): string {
    if (value == null || value <= 0) return '0';
    const suffixes = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
    const power = Math.max(0, Math.floor(Math.log10(value) / 3));
    const scaled = value / Math.pow(1000, power);
    const suffix = suffixes[power] || '';
    const space = suffix ? ' ' : '';
    return power > 0 ? scaled.toFixed(2) + space + suffix : scaled.toFixed(0) + space + suffix;
}

/**
 * Formats a single hash's difficulty. These are almost always far below 1
 * (a 4-leading-zero hash is ~0.0000002), so rounding to 2 decimals like the
 * network difficulty would render every one of them as a useless "0".
 */
function hashDiffText(value: number): string {
    if (!value || value <= 0) return '0';
    // diffSuffix drops the decimals below 1000 (1.5 -> "1"), so only hand it
    // the big values it was written for.
    if (value >= 1000) return diffSuffix(value);
    return value.toPrecision(3).replace(/(\.\d*?)0+(e|$)/, '$1$2').replace(/\.(e|$)/, '$1');
}

function satsToBtc(satoshis: number): string {
    if (!satoshis) return '0 BTC';
    return (satoshis / 100_000_000).toFixed(8) + ' BTC';
}

function leadingZeroBitsHex(hex: string | undefined): string {
    if (!hex) return '-';
    let bits = 0;
    for (const ch of hex) {
        const nibble = parseInt(ch, 16);
        if (isNaN(nibble)) break;
        if (nibble === 0) {
            bits += 4;
            continue;
        }
        bits += Math.clz32(nibble) - 28; // leading zero bits within this nibble
        break;
    }
    const hexZeros = Math.floor(bits / 4);
    return `${bits} bits (${hexZeros} hex digits)`;
}

function renderBlockHeader(blockHeader: BlockHeaderInfo, targetHex: string | undefined): void {
    const heightEl = document.getElementById('val-block-height');
    const diffEl = document.getElementById('val-block-difficulty');
    const valueEl = document.getElementById('val-block-value');
    const scriptsigEl = document.getElementById('val-block-scriptsig');
    const outputsEl = document.getElementById('val-block-outputs');
    const signalsEl = document.getElementById('val-block-signals');
    if (!heightEl || !diffEl || !valueEl || !scriptsigEl || !outputsEl || !signalsEl || !blockHeader) return;

    heightEl.textContent = String(blockHeader.blockHeight);
    diffEl.textContent = `${diffSuffix(blockHeader.networkDifficulty)} (${leadingZeroBitsHex(targetHex)} required)`;
    valueEl.textContent = satsToBtc(blockHeader.totalValueSatoshis);
    scriptsigEl.textContent = blockHeader.scriptsig || '-';

    outputsEl.innerHTML = '';
    for (const output of blockHeader.outputs) {
        const row = document.createElement('div');
        const addr = document.createElement('strong');
        addr.textContent = output.address + (output.isUserOutput ? ' ★' : '');
        row.appendChild(addr);
        if (output.valueSatoshis > 0) {
            const value = document.createElement('span');
            value.textContent = satsToBtc(output.valueSatoshis);
            row.appendChild(value);
        }
        outputsEl.appendChild(row);
    }

    const signals: string[] = [];
    if (blockHeader.bip54Signaling) signals.push('BIP-54');
    if (blockHeader.bip110Signaling) signals.push('BIP-110');
    signalsEl.textContent = signals.join(' ');
}

evtSource.onopen = () => {
    els.status.textContent = 'Connected & Mining';
    els.status.style.color = 'var(--accent)';
};

evtSource.onerror = () => {
    els.status.textContent = 'Disconnected';
    els.status.style.color = '#ff5f56';
};

evtSource.onmessage = (event: MessageEvent) => {
    const data: MinerStatsMessage = JSON.parse(event.data);

    // Update Summary Stats
    els.hashrate1s.textContent = formatNumber(data.hashrate1s);
    els.hashrate1m.textContent = formatNumber(data.hashrate1m);
    els.hashrate1h.textContent = formatNumber(data.hashrate1h);

    els.totalHashes.textContent = formatNumber(data.totalHashes);
    els.shares.textContent = String(data.sharesFound);
    els.staleShares.textContent = String(data.staleShares);
    if (els.efficiency) els.efficiency.textContent = data.efficiency;
    if (els.difficulty) els.difficulty.textContent = isNaN(Number(data.difficultyDecimal)) ? String(data.difficultyDecimal) : formatNumber(Number(data.difficultyDecimal));
    if (els.poolDiff) els.poolDiff.textContent = isNaN(Number(data.difficultyDecimal)) ? String(data.difficultyDecimal) : formatNumber(Number(data.difficultyDecimal));
    if (els.difficultyNbits) els.difficultyNbits.textContent = data.difficultyNbits;
    if (els.target) els.target.textContent = data.target ? data.target.substring(0, 32) + '...' : '-';
    const targetZerosEl = document.getElementById('val-target-zeros');
    if (targetZerosEl) targetZerosEl.textContent = leadingZeroBitsHex(data.target);
    if (els.poolMode) els.poolMode.textContent = data.protocol || 'SV1';
    if (els.jobsReceived) els.jobsReceived.textContent = formatNumber(data.jobsReceived || 0);
    if (els.currentJob) els.currentJob.textContent = data.currentJobId || 'None';
    if (els.threadsSelect && data.threads) els.threadsSelect.value = String(data.threads);

    // Sync the dropdown with the backend's actual strategy
    const strategySelect = document.getElementById('strategy-select') as HTMLSelectElement | null;
    const customNonceGroup = document.getElementById('custom-nonce-group') as HTMLElement | null;
    if (strategySelect && customNonceGroup && data.activeMethod !== undefined && parseInt(strategySelect.value, 10) !== data.activeMethod) {
        strategySelect.value = String(data.activeMethod);
        if (data.activeMethod === 9) customNonceGroup.style.display = "block";
        else customNonceGroup.style.display = "none";
        els.customNonceInput.value = String(data.customNonce);
    }

    // Sync protocol config if it changed
    if (els.protocolSelect && data.protocol && els.protocolSelect.value !== data.protocol) {
        els.protocolSelect.value = data.protocol;
    }

    // Sync the Node CPU miner button with the backend's actual state
    const toggleNodeMiningBtn = document.getElementById('toggle-node-mining') as HTMLButtonElement | null;
    if (toggleNodeMiningBtn && data.isMining !== undefined) {
        toggleNodeMiningBtn.textContent = data.isMining ? 'Stop Node CPU Miner' : 'Start Node CPU Miner';
        toggleNodeMiningBtn.style.background = data.isMining ? '#ff5f56' : '#4CAF50';
    }

    // Update Latest Hash
    if (data.latestHash && data.latestHash !== 'N/A') {
        els.latestZeros.textContent = `${data.latestHash.zeros} Zeros`;
        els.latestDiff.textContent = `Diff: ${hashDiffText(data.latestHash.difficulty)}`;
        els.latestHash.textContent = data.latestHash.hash;
        els.latestVer.textContent = data.latestHash.version || '-';
        els.latestEn1.textContent = data.latestHash.en1 || '-';
        els.latestEn2.textContent = data.latestHash.en2 || '-';
        els.latestNonce.textContent = data.latestHash.nonce || '-';
        els.latestMethod.textContent = data.latestHash.method || '-';
    }

    // Update Best Hash
    if (data.bestHash && data.bestHash !== 'N/A') {
        els.bestZeros.textContent = `${data.bestHash.zeros} Zeros`;
        els.bestDiff.textContent = `Diff: ${hashDiffText(data.bestHash.difficulty)}`;
        els.bestHash.textContent = data.bestHash.hash;
        els.bestVer.textContent = data.bestHash.version || '-';
        els.bestEn1.textContent = data.bestHash.en1 || '-';
        els.bestEn2.textContent = data.bestHash.en2 || '-';
        els.bestNonce.textContent = data.bestHash.nonce || '-';
        els.bestMethod.textContent = data.bestHash.method || '-';
    }

    // Update real Block Header info (decoded from the current job's coinbase tx)
    if (data.blockHeader) {
        renderBlockHeader(data.blockHeader, data.target);
    }
};

interface VersionInfo {
    version: string;
    date: string;
    changes: string[];
}

async function loadVersionInfo(): Promise<void> {
    const versionEl = document.getElementById('app-version');
    if (!versionEl) return;
    try {
        const res = await fetch('/api/version');
        const info: VersionInfo = await res.json();
        versionEl.textContent = `v${info.version}`;
        const changesText = info.changes.length ? info.changes.map(c => `• ${c}`).join('\n') : 'No changelog entry found.';
        const heading = info.date ? `v${info.version} — published ${info.date}` : `v${info.version}`;
        versionEl.setAttribute('data-tooltip', `${heading}\n${changesText}`);
    } catch (err) {
        console.error('Failed to load version info', err);
        versionEl.textContent = 'v?';
        versionEl.setAttribute('data-tooltip', 'Could not load version info.');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadVersionInfo();

    const strategySelect = document.getElementById('strategy-select') as HTMLSelectElement | null;
    const customNonceGroup = document.getElementById('custom-nonce-group') as HTMLElement | null;
    const customNonceInput = document.getElementById('custom-nonce-input') as HTMLInputElement | null;
    const toggleBrowserMiningBtn = document.getElementById('toggle-browser-mining') as HTMLButtonElement | null;
    const toggleWebGPUMiningBtn = document.getElementById('toggle-webgpu-mining') as HTMLButtonElement | null;
    const toggleNodeMiningBtn = document.getElementById('toggle-node-mining') as HTMLButtonElement | null;

    function sendStrategy(): void {
        if (!strategySelect || !customNonceInput) return;
        const method = parseInt(strategySelect.value, 10);
        const customNonce = parseInt(customNonceInput.value, 10) || 0;
        savePreference('strategy', method);
        savePreference('customNonce', customNonce);
        fetch('/api/strategy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method, customNonce })
        }).catch(err => console.error("Failed to update strategy", err));
    }

    async function setProtocol(protocol: string): Promise<void> {
        // Get host and port from inputs, fallback to ckpool if missing (but do not overwrite active config with a hardcode)
        const hostInput = document.getElementById('pool-host-input') as HTMLInputElement | null;
        const portInput = document.getElementById('pool-port-input') as HTMLInputElement | null;
        const host = hostInput && hostInput.value ? hostInput.value : "eusolo.ckpool.org";
        const port = portInput && portInput.value ? portInput.value : 3333;

        try {
            await fetch('/api/pool', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, protocol })
            });
        } catch (err) {
            console.error(err);
        }
    }

    async function setThreads(threads: number): Promise<void> {
        try {
            await fetch('/api/threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threads })
            });
        } catch (err) {
            console.error(err);
        }
    }

    async function setNodeMining(on: boolean): Promise<void> {
        try {
            await fetch('/api/miner-toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: on ? 'start' : 'stop' })
            });
        } catch (err) {
            console.error("Failed to toggle miner", err);
        }
    }

    function setBrowserMining(on: boolean): void {
        if (!toggleBrowserMiningBtn) return;
        if (on) {
            window.startBrowserMining();
            toggleBrowserMiningBtn.textContent = 'Stop Browser CPU Mining';
            toggleBrowserMiningBtn.style.background = '#ff5f56';
        } else {
            window.stopBrowserMining();
            toggleBrowserMiningBtn.textContent = 'Start Browser CPU Mining';
            toggleBrowserMiningBtn.style.background = 'var(--accent)';
        }
    }

    function setWebGPUMining(on: boolean): void {
        if (!toggleWebGPUMiningBtn) return;
        if (on) {
            window.startWebGPUMining();
            toggleWebGPUMiningBtn.textContent = 'Stop WebGPU Mining';
            toggleWebGPUMiningBtn.style.background = '#ff5f56';
        } else {
            window.stopWebGPUMining();
            toggleWebGPUMiningBtn.textContent = 'Start WebGPU Mining';
            toggleWebGPUMiningBtn.style.background = '#61dafb';
        }
    }

    if (els.protocolSelect) {
        els.protocolSelect.addEventListener('change', () => {
            const protocol = els.protocolSelect!.value;
            savePreference('protocol', protocol);
            setProtocol(protocol);
        });
    }

    if (els.threadsSelect) {
        els.threadsSelect.addEventListener('change', (e) => {
            const threads = parseInt((e.target as HTMLSelectElement).value, 10);
            savePreference('threads', threads);
            setThreads(threads);
        });
    }

    if (strategySelect) {
        strategySelect.addEventListener('change', (e) => {
            if ((e.target as HTMLSelectElement).value === "9") { // CUSTOM_NONCE
                if (customNonceGroup) customNonceGroup.style.display = "block";
            } else {
                if (customNonceGroup) customNonceGroup.style.display = "none";
            }
            sendStrategy();
        });
    }

    if (customNonceInput) {
        customNonceInput.addEventListener('change', sendStrategy);
    }

    let isBrowserMining = false;
    if (toggleBrowserMiningBtn) {
        toggleBrowserMiningBtn.addEventListener('click', () => {
            isBrowserMining = !isBrowserMining;
            savePreference('browserMining', isBrowserMining);
            setBrowserMining(isBrowserMining);
        });
    }

    let isWebGPUMining = false;
    if (toggleWebGPUMiningBtn) {
        toggleWebGPUMiningBtn.addEventListener('click', () => {
            isWebGPUMining = !isWebGPUMining;
            savePreference('webgpuMining', isWebGPUMining);
            setWebGPUMining(isWebGPUMining);
        });
    }

    if (toggleNodeMiningBtn) {
        toggleNodeMiningBtn.addEventListener('click', () => {
            const isCurrentlyMining = (toggleNodeMiningBtn.textContent || '').includes('Stop');
            savePreference('nodeMining', !isCurrentlyMining);
            setNodeMining(!isCurrentlyMining);
        });
    }

    // Apply saved (or default) preferences once, on first render. CPU mining
    // (the Node.js server-side miner) defaults to on for a first-ever visit;
    // everything else defaults to off/unset until the user changes it.
    const prefs = loadPreferences();

    if (els.threadsSelect) els.threadsSelect.value = String(prefs.threads);
    setThreads(prefs.threads);

    if (els.protocolSelect) els.protocolSelect.value = prefs.protocol;
    setProtocol(prefs.protocol);

    if (strategySelect) strategySelect.value = String(prefs.strategy);
    if (customNonceInput) customNonceInput.value = String(prefs.customNonce);
    if (customNonceGroup) customNonceGroup.style.display = prefs.strategy === 9 ? "block" : "none";
    sendStrategy();

    setNodeMining(prefs.nodeMining);

    if (prefs.browserMining) {
        isBrowserMining = true;
        setBrowserMining(true);
    }
    if (prefs.webgpuMining) {
        isWebGPUMining = true;
        setWebGPUMining(true);
    }
});
