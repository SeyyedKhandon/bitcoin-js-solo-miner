"use strict";
const evtSource = new EventSource('/api/events');
// DOM Elements
const els = {
    status: document.getElementById('connection-status'),
    hashrate1s: document.getElementById('val-hashrate-1s'),
    hashrate1m: document.getElementById('val-hashrate-1m'),
    hashrate1h: document.getElementById('val-hashrate-1h'),
    totalHashes: document.getElementById('val-total-hashes'),
    shares: document.getElementById('val-shares'),
    staleShares: document.getElementById('val-stale-shares'),
    efficiency: document.getElementById('val-efficiency'),
    difficulty: document.getElementById('val-difficulty'),
    poolDiff: document.getElementById('val-pool-diff'),
    target: document.getElementById('val-target'),
    // Configuration inputs
    protocolSelect: document.getElementById('protocol-select'),
    threadsSelect: document.getElementById('threads-select'),
    difficultyNbits: document.getElementById('val-difficulty-nbits'),
    poolMode: document.getElementById('val-pool-mode'),
    jobsReceived: document.getElementById('val-jobs-received'),
    currentJob: document.getElementById('val-current-job'),
    customNonceInput: document.getElementById('custom-nonce-input'),
    latestZeros: document.getElementById('val-latest-zeros'),
    latestDiff: document.getElementById('val-latest-diff'),
    latestHash: document.getElementById('val-latest-hash'),
    latestVer: document.getElementById('val-latest-ver'),
    latestEn1: document.getElementById('val-latest-en1'),
    latestEn2: document.getElementById('val-latest-en2'),
    latestNonce: document.getElementById('val-latest-nonce'),
    latestMethod: document.getElementById('val-latest-method'),
    bestZeros: document.getElementById('val-best-zeros'),
    bestDiff: document.getElementById('val-best-diff'),
    bestHash: document.getElementById('val-best-hash'),
    bestVer: document.getElementById('val-best-ver'),
    bestEn1: document.getElementById('val-best-en1'),
    bestEn2: document.getElementById('val-best-en2'),
    bestNonce: document.getElementById('val-best-nonce'),
    bestMethod: document.getElementById('val-best-method'),
};
const PREFERENCES_KEY = 'bitcoinJsSoloMiner.preferences';
// CPU mining (the Node.js server-side miner) is the default running method
// on a first-ever visit; the browser/WebGPU miners are opt-in extras.
const DEFAULT_PREFERENCES = {
    nodeMining: true,
    browserMining: false,
    webgpuMining: false,
    threads: 1,
    protocol: 'SV1',
    strategy: 0,
    customNonce: 0,
    // Half the GPU by default, so starting the GPU miner doesn't make the
    // machine feel unusable before the user has touched anything.
    gpuIntensity: 50,
    // 0 means "pick a sensible default from the CPU's core count".
    browserWorkers: 0,
    theme: 'matrix',
    // Empty means "whatever the server is already configured with".
    payoutAddress: '',
};
function loadPreferences() {
    try {
        const raw = localStorage.getItem(PREFERENCES_KEY);
        if (!raw)
            return { ...DEFAULT_PREFERENCES };
        return { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) };
    }
    catch {
        return { ...DEFAULT_PREFERENCES };
    }
}
function savePreference(key, value) {
    try {
        const current = loadPreferences();
        current[key] = value;
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify(current));
    }
    catch {
        // localStorage unavailable (private browsing, storage full, etc.) -
        // preferences just won't persist across reloads.
    }
}
// Tracks which miners are running so the header's pulse animation - and so
// the continuous compositing it causes - only runs while something mines.
const miningActive = { node: false, browser: false, webgpu: false };
// When the current job last changed, so Pool Info can show its age.
let currentJobId = null;
let currentJobSince = Date.now();
function jobAgeText() {
    const seconds = Math.floor((Date.now() - currentJobSince) / 1000);
    if (seconds < 60)
        return `${seconds}s ago`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}
function refreshMiningIndicator() {
    const any = miningActive.node || miningActive.browser || miningActive.webgpu;
    document.body.classList.toggle('is-mining', any);
}
function setNodeMiningIndicator(on) {
    miningActive.node = on;
    refreshMiningIndicator();
}
const THEMES = ['matrix', 'vscode', 'amber', 'ice', 'paper'];
function applyTheme(theme) {
    const value = THEMES.includes(theme) ? theme : 'matrix';
    document.documentElement.setAttribute('data-theme', value);
}
// Applied immediately rather than on DOMContentLoaded, so the page does not
// flash the default palette before the saved one is restored.
applyTheme(loadPreferences().theme);
function formatNumber(num) {
    return new Intl.NumberFormat().format(num);
}
function diffSuffix(value) {
    if (value == null || value <= 0)
        return '0';
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
function hashDiffText(value) {
    if (!value || value <= 0)
        return '0';
    // diffSuffix drops the decimals below 1000 (1.5 -> "1"), so only hand it
    // the big values it was written for.
    if (value >= 1000)
        return diffSuffix(value);
    return value.toPrecision(3).replace(/(\.\d*?)0+(e|$)/, '$1$2').replace(/\.(e|$)/, '$1');
}
function satsToBtc(satoshis) {
    if (!satoshis)
        return '0 BTC';
    return (satoshis / 100_000_000).toFixed(8) + ' BTC';
}
function leadingZeroBitsHex(hex) {
    if (!hex)
        return '-';
    let bits = 0;
    for (const ch of hex) {
        const nibble = parseInt(ch, 16);
        if (isNaN(nibble))
            break;
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
function renderBlockHeader(blockHeader, targetHex) {
    const heightEl = document.getElementById('val-block-height');
    const diffEl = document.getElementById('val-block-difficulty');
    const valueEl = document.getElementById('val-block-value');
    const scriptsigEl = document.getElementById('val-block-scriptsig');
    const outputsEl = document.getElementById('val-block-outputs');
    const signalsEl = document.getElementById('val-block-signals');
    if (!heightEl || !diffEl || !valueEl || !scriptsigEl || !outputsEl || !signalsEl || !blockHeader)
        return;
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
    const signals = [];
    if (blockHeader.bip54Signaling)
        signals.push('BIP-54');
    if (blockHeader.bip110Signaling)
        signals.push('BIP-110');
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
evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    // Update Summary Stats
    els.hashrate1s.textContent = formatNumber(data.hashrate1s);
    els.hashrate1m.textContent = formatNumber(data.hashrate1m);
    els.hashrate1h.textContent = formatNumber(data.hashrate1h);
    els.totalHashes.textContent = formatNumber(data.totalHashes);
    els.shares.textContent = String(data.sharesFound);
    els.staleShares.textContent = String(data.staleShares);
    if (els.efficiency)
        els.efficiency.textContent = data.efficiency;
    if (els.difficulty)
        els.difficulty.textContent = isNaN(Number(data.difficultyDecimal)) ? String(data.difficultyDecimal) : formatNumber(Number(data.difficultyDecimal));
    if (els.poolDiff)
        els.poolDiff.textContent = isNaN(Number(data.difficultyDecimal)) ? String(data.difficultyDecimal) : formatNumber(Number(data.difficultyDecimal));
    if (els.difficultyNbits)
        els.difficultyNbits.textContent = data.difficultyNbits;
    if (els.target)
        els.target.textContent = data.target ? data.target.substring(0, 32) + '...' : '-';
    const targetZerosEl = document.getElementById('val-target-zeros');
    if (targetZerosEl)
        targetZerosEl.textContent = leadingZeroBitsHex(data.target);
    if (els.poolMode)
        els.poolMode.textContent = data.protocol || 'SV1';
    const poolUserEl = document.getElementById('val-pool-user');
    const poolUrlEl = document.getElementById('val-pool-url');
    if (poolUserEl && data.poolUser)
        poolUserEl.textContent = data.poolUser;
    // Reflect the address the server is really using, so the field shows the
    // configured default rather than looking empty. Never overwrite what the
    // user is in the middle of typing.
    const addressField = document.getElementById('payout-address-input');
    if (addressField && data.poolUser && !addressField.value && document.activeElement !== addressField) {
        addressField.value = data.poolUser;
    }
    if (poolUrlEl && data.poolUrl)
        poolUrlEl.textContent = data.poolUrl;
    if (data.currentJobId !== currentJobId) {
        currentJobId = data.currentJobId;
        currentJobSince = Date.now();
    }
    const jobAgeEl = document.getElementById('val-pool-jobage');
    if (jobAgeEl)
        jobAgeEl.textContent = currentJobId ? jobAgeText() : '-';
    if (els.jobsReceived)
        els.jobsReceived.textContent = formatNumber(data.jobsReceived || 0);
    if (els.currentJob)
        els.currentJob.textContent = data.currentJobId || 'None';
    if (els.threadsSelect && data.threads)
        els.threadsSelect.value = String(data.threads);
    // Sync the dropdown with the backend's actual strategy
    const strategySelect = document.getElementById('strategy-select');
    const customNonceGroup = document.getElementById('custom-nonce-group');
    if (strategySelect && customNonceGroup && data.activeMethod !== undefined && parseInt(strategySelect.value, 10) !== data.activeMethod) {
        strategySelect.value = String(data.activeMethod);
        if (data.activeMethod === 9)
            customNonceGroup.style.display = "block";
        else
            customNonceGroup.style.display = "none";
        els.customNonceInput.value = String(data.customNonce);
    }
    // Sync protocol config if it changed
    if (els.protocolSelect && data.protocol && els.protocolSelect.value !== data.protocol) {
        els.protocolSelect.value = data.protocol;
    }
    // Sync the Node CPU miner button with the backend's actual state
    const toggleNodeMiningBtn = document.getElementById('toggle-node-mining');
    if (toggleNodeMiningBtn && data.isMining !== undefined) {
        toggleNodeMiningBtn.textContent = data.isMining ? 'Stop Node CPU Miner' : 'Start Node CPU Miner';
        toggleNodeMiningBtn.classList.toggle('is-running', !!data.isMining);
        setNodeMiningIndicator(data.isMining);
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
/**
 * Fills the header's history picker with the snapshotted releases, so the
 * dashboard can be viewed as it looked at an earlier version. Only the
 * interface is versioned - an old build still talks to the server running
 * now, so it may simply not show fields added later.
 */
async function loadVersionHistory() {
    const select = document.getElementById('version-history-select');
    if (!select)
        return;
    try {
        const res = await fetch('/api/versions');
        const { current, versions } = await res.json();
        // Which release is being viewed, if this page came from /v/<version>/.
        const viewing = window.location.pathname.startsWith('/v/')
            ? window.location.pathname.split('/')[2]
            : '';
        const options = [`<option value="">current (v${current})</option>`];
        for (const v of versions) {
            if (v === current && !viewing)
                continue; // already covered by "current"
            options.push(`<option value="${v}"${v === viewing ? ' selected' : ''}>v${v}</option>`);
        }
        select.innerHTML = options.join('');
        if (!viewing)
            select.value = '';
        select.addEventListener('change', () => {
            window.location.href = select.value ? `/v/${select.value}/` : '/';
        });
    }
    catch (err) {
        console.error('Failed to load version history', err);
        select.innerHTML = '<option value="">current</option>';
    }
}
async function loadVersionInfo() {
    const versionEl = document.getElementById('app-version');
    if (!versionEl)
        return;
    try {
        const res = await fetch('/api/version');
        const info = await res.json();
        versionEl.textContent = `v${info.version}`;
        const changesText = info.changes.length ? info.changes.map(c => `• ${c}`).join('\n') : 'No changelog entry found.';
        const heading = info.date ? `v${info.version} — published ${info.date}` : `v${info.version}`;
        versionEl.setAttribute('data-tooltip', `${heading}\n${changesText}`);
    }
    catch (err) {
        console.error('Failed to load version info', err);
        versionEl.textContent = 'v?';
        versionEl.setAttribute('data-tooltip', 'Could not load version info.');
    }
}
document.addEventListener('DOMContentLoaded', () => {
    loadVersionInfo();
    loadVersionHistory();
    const strategySelect = document.getElementById('strategy-select');
    const customNonceGroup = document.getElementById('custom-nonce-group');
    const customNonceInput = document.getElementById('custom-nonce-input');
    const toggleBrowserMiningBtn = document.getElementById('toggle-browser-mining');
    const toggleWebGPUMiningBtn = document.getElementById('toggle-webgpu-mining');
    const toggleNodeMiningBtn = document.getElementById('toggle-node-mining');
    function sendStrategy() {
        if (!strategySelect || !customNonceInput)
            return;
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
    /**
     * Applies a pool/protocol change, returning whether the server accepted
     * it. A rejection used to be swallowed (only network errors were caught,
     * not a non-OK status), so picking the unimplemented SV2 left the UI
     * showing a protocol the server had refused.
     */
    async function setProtocol(protocol, silent = false) {
        // Get host and port from inputs, fallback to ckpool if missing (but do not overwrite active config with a hardcode)
        const hostInput = document.getElementById('pool-host-input');
        const portInput = document.getElementById('pool-port-input');
        const host = hostInput && hostInput.value ? hostInput.value : "eusolo.ckpool.org";
        const port = portInput && portInput.value ? portInput.value : 3333;
        try {
            const res = await fetch('/api/pool', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, protocol })
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                console.error('Pool config rejected:', body.error || res.status);
                if (!silent)
                    alert(body.error || `Could not switch protocol (HTTP ${res.status}).`);
                return false;
            }
            return true;
        }
        catch (err) {
            console.error(err);
            return false;
        }
    }
    async function setThreads(threads) {
        try {
            await fetch('/api/threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threads })
            });
        }
        catch (err) {
            console.error(err);
        }
    }
    async function setNodeMining(on) {
        try {
            await fetch('/api/miner-toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: on ? 'start' : 'stop' })
            });
        }
        catch (err) {
            console.error("Failed to toggle miner", err);
        }
    }
    function setBrowserMining(on) {
        miningActive.browser = on;
        refreshMiningIndicator();
        if (!toggleBrowserMiningBtn)
            return;
        if (on) {
            window.startBrowserMining();
            toggleBrowserMiningBtn.textContent = 'Stop Browser CPU Mining';
            toggleBrowserMiningBtn.classList.add('is-running');
        }
        else {
            window.stopBrowserMining();
            toggleBrowserMiningBtn.textContent = 'Start Browser CPU Mining';
            toggleBrowserMiningBtn.classList.remove('is-running');
        }
    }
    function setWebGPUMining(on) {
        miningActive.webgpu = on;
        refreshMiningIndicator();
        if (!toggleWebGPUMiningBtn)
            return;
        if (on) {
            window.startWebGPUMining();
            toggleWebGPUMiningBtn.textContent = 'Stop WebGPU Mining';
            toggleWebGPUMiningBtn.classList.add('is-running');
        }
        else {
            window.stopWebGPUMining();
            toggleWebGPUMiningBtn.textContent = 'Start WebGPU Mining';
            toggleWebGPUMiningBtn.classList.remove('is-running');
        }
    }
    if (els.protocolSelect) {
        let lastAcceptedProtocol = els.protocolSelect.value;
        els.protocolSelect.addEventListener('change', async () => {
            const protocol = els.protocolSelect.value;
            // Only remember the choice once the server has accepted it -
            // saving first meant an unsupported protocol was replayed (and
            // rejected again) on every subsequent page load.
            if (await setProtocol(protocol)) {
                lastAcceptedProtocol = protocol;
                savePreference('protocol', protocol);
            }
            else {
                els.protocolSelect.value = lastAcceptedProtocol;
            }
        });
    }
    const themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
        themeSelect.addEventListener('change', () => {
            savePreference('theme', themeSelect.value);
            applyTheme(themeSelect.value);
        });
    }
    const addressInput = document.getElementById('payout-address-input');
    const addressSave = document.getElementById('payout-address-save');
    const addressStatus = document.getElementById('payout-address-status');
    function setAddressStatus(text, kind) {
        if (!addressStatus)
            return;
        addressStatus.textContent = text;
        addressStatus.className = `control-note${kind ? ' ' + kind : ''}`;
    }
    async function savePayoutAddress() {
        if (!addressInput)
            return;
        const address = addressInput.value.trim();
        if (!address) {
            setAddressStatus('Enter an address first.', 'err');
            return;
        }
        try {
            const res = await fetch('/api/worker', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setAddressStatus(body.error || `Server rejected the address (HTTP ${res.status}).`, 'err');
                return;
            }
            // Only remember it once the server accepted it.
            savePreference('payoutAddress', address);
            setAddressStatus(body.reconnected
                ? 'Saved. Reconnected to the pool so rewards go to this address.'
                : 'Saved. The pool was already authorised with this address.', 'ok');
        }
        catch (err) {
            console.error('Failed to save payout address', err);
            setAddressStatus('Could not reach the server.', 'err');
        }
    }
    if (addressSave)
        addressSave.addEventListener('click', savePayoutAddress);
    if (addressInput) {
        addressInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')
                savePayoutAddress();
        });
    }
    const browserWorkersSelect = document.getElementById('browser-workers-select');
    if (browserWorkersSelect) {
        const cores = navigator.hardwareConcurrency || 4;
        const choices = Array.from(new Set([1, 2, 4, 6, 8, 12, 16, cores, Math.max(1, cores - 1)]))
            .filter((n) => n >= 1 && n <= 32)
            .sort((a, b) => a - b);
        browserWorkersSelect.innerHTML = choices
            .map((n) => `<option value="${n}">${n} worker${n > 1 ? 's' : ''}${n === cores ? ' (all cores)' : ''}</option>`)
            .join('');
        browserWorkersSelect.addEventListener('change', (e) => {
            const n = parseInt(e.target.value, 10);
            savePreference('browserWorkers', n);
            window.setBrowserWorkerCount(n);
        });
    }
    const gpuIntensitySelect = document.getElementById('gpu-intensity-select');
    if (gpuIntensitySelect) {
        gpuIntensitySelect.addEventListener('change', (e) => {
            const pct = parseInt(e.target.value, 10);
            savePreference('gpuIntensity', pct);
            window.setWebGPUIntensity(pct);
        });
    }
    if (els.threadsSelect) {
        els.threadsSelect.addEventListener('change', (e) => {
            const threads = parseInt(e.target.value, 10);
            savePreference('threads', threads);
            setThreads(threads);
        });
    }
    if (strategySelect) {
        strategySelect.addEventListener('change', (e) => {
            if (e.target.value === "9") { // CUSTOM_NONCE
                if (customNonceGroup)
                    customNonceGroup.style.display = "block";
            }
            else {
                if (customNonceGroup)
                    customNonceGroup.style.display = "none";
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
    if (els.threadsSelect)
        els.threadsSelect.value = String(prefs.threads);
    setThreads(prefs.threads);
    if (els.protocolSelect)
        els.protocolSelect.value = prefs.protocol;
    // A protocol the server refuses (e.g. an SV2 selection saved before it
    // was rejected) would otherwise be replayed and 400 on every load, so
    // fall back to SV1 and repair the stored preference.
    setProtocol(prefs.protocol, true).then((ok) => {
        if (ok || prefs.protocol === 'SV1')
            return;
        console.warn(`Stored protocol "${prefs.protocol}" was refused by the server; falling back to SV1.`);
        savePreference('protocol', 'SV1');
        if (els.protocolSelect)
            els.protocolSelect.value = 'SV1';
        setProtocol('SV1', true);
    });
    if (themeSelect)
        themeSelect.value = THEMES.includes(prefs.theme) ? prefs.theme : 'matrix';
    if (addressInput && prefs.payoutAddress) {
        addressInput.value = prefs.payoutAddress;
        // Re-apply on load so a restart of the server picks the address back
        // up rather than silently falling back to the built-in default.
        savePayoutAddress();
    }
    const workerPref = prefs.browserWorkers || window.getBrowserWorkerCount();
    if (browserWorkersSelect)
        browserWorkersSelect.value = String(workerPref);
    window.setBrowserWorkerCount(workerPref);
    // The 70% option became 75%, so a stored 70 would select nothing.
    const gpuIntensity = prefs.gpuIntensity === 70 ? 75 : prefs.gpuIntensity;
    if (gpuIntensity !== prefs.gpuIntensity)
        savePreference('gpuIntensity', gpuIntensity);
    if (gpuIntensitySelect)
        gpuIntensitySelect.value = String(gpuIntensity);
    window.setWebGPUIntensity(gpuIntensity);
    if (strategySelect)
        strategySelect.value = String(prefs.strategy);
    if (customNonceInput)
        customNonceInput.value = String(prefs.customNonce);
    if (customNonceGroup)
        customNonceGroup.style.display = prefs.strategy === 9 ? "block" : "none";
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
