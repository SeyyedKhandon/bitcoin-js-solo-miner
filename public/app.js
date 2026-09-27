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

    bestZeros: document.getElementById('val-best-zeros'),
    bestDiff: document.getElementById('val-best-diff'),
    bestHash: document.getElementById('val-best-hash'),
    bestVer: document.getElementById('val-best-ver'),
    bestEn1: document.getElementById('val-best-en1'),
    bestEn2: document.getElementById('val-best-en2'),
    bestNonce: document.getElementById('val-best-nonce'),
};

function formatNumber(num) {
    return new Intl.NumberFormat().format(num);
}

function diffSuffix(value) {
    if (value == null || value <= 0) return '0';
    const suffixes = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
    const power = Math.max(0, Math.floor(Math.log10(value) / 3));
    const scaled = value / Math.pow(1000, power);
    const suffix = suffixes[power] || '';
    const space = suffix ? ' ' : '';
    return power > 0 ? scaled.toFixed(2) + space + suffix : scaled.toFixed(0) + space + suffix;
}

function satsToBtc(satoshis) {
    if (!satoshis) return '0 BTC';
    return (satoshis / 100_000_000).toFixed(8) + ' BTC';
}

function renderBlockHeader(blockHeader) {
    const heightEl = document.getElementById('val-block-height');
    const diffEl = document.getElementById('val-block-difficulty');
    const valueEl = document.getElementById('val-block-value');
    const scriptsigEl = document.getElementById('val-block-scriptsig');
    const outputsEl = document.getElementById('val-block-outputs');
    const signalsEl = document.getElementById('val-block-signals');
    if (!heightEl || !blockHeader) return;

    heightEl.textContent = blockHeader.blockHeight;
    diffEl.textContent = diffSuffix(blockHeader.networkDifficulty);
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

evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    // Update Summary Stats
    els.hashrate1s.textContent = formatNumber(data.hashrate1s);
    els.hashrate1m.textContent = formatNumber(data.hashrate1m);
    els.hashrate1h.textContent = formatNumber(data.hashrate1h);

    els.totalHashes.textContent = formatNumber(data.totalHashes);
    els.shares.textContent = data.sharesFound;
    els.staleShares.textContent = data.staleShares;
    if (els.efficiency) els.efficiency.textContent = data.efficiency;
    if (els.difficulty) els.difficulty.textContent = isNaN(data.difficultyDecimal) ? data.difficultyDecimal : formatNumber(data.difficultyDecimal);
    if (els.poolDiff) els.poolDiff.textContent = isNaN(data.difficultyDecimal) ? data.difficultyDecimal : formatNumber(data.difficultyDecimal);
    if (els.difficultyNbits) els.difficultyNbits.textContent = data.difficultyNbits;
    if (els.target) els.target.textContent = data.target ? data.target.substring(0, 32) + '...' : '-';
    if (els.poolMode) els.poolMode.textContent = data.protocol || 'SV1';
    if (els.jobsReceived) els.jobsReceived.textContent = formatNumber(data.jobsReceived || 0);
    if (els.currentJob) els.currentJob.textContent = data.currentJobId || 'None';
    if (els.threadsSelect && data.threads) els.threadsSelect.value = data.threads;

    // Sync the dropdown with the backend's actual strategy
    const strategySelect = document.getElementById('strategy-select');
    const customNonceGroup = document.getElementById('custom-nonce-group');
    if (strategySelect && data.activeMethod !== undefined && parseInt(strategySelect.value, 10) !== data.activeMethod) {
        strategySelect.value = data.activeMethod;
        if (data.activeMethod === 9) customNonceGroup.style.display = "block";
        else customNonceGroup.style.display = "none";
        els.customNonceInput.value = data.customNonce;
    }

    // Sync protocol config if it changed
    if (els.protocolSelect && data.protocol && els.protocolSelect.value !== data.protocol) {
        els.protocolSelect.value = data.protocol;
    }

    // Sync the Node CPU miner button with the backend's actual state
    const toggleNodeMiningBtn = document.getElementById('toggle-node-mining');
    if (toggleNodeMiningBtn && data.isMining !== undefined) {
        toggleNodeMiningBtn.textContent = data.isMining ? 'Stop Node CPU Miner' : 'Start Node CPU Miner';
        toggleNodeMiningBtn.style.background = data.isMining ? '#ff5f56' : '#4CAF50';
    }

    // Update Latest Hash
    if (data.latestHash) {
        els.latestZeros.textContent = `${data.latestHash.zeros} Zeros`;
        els.latestDiff.textContent = `Diff: ${formatNumber(data.latestHash.difficulty.toFixed(2))}`;
        els.latestHash.textContent = data.latestHash.hash;
        els.latestVer.textContent = data.latestHash.version;
        els.latestEn1.textContent = data.latestHash.en1;
        els.latestEn2.textContent = data.latestHash.en2;
        els.latestNonce.textContent = data.latestHash.nonce;
    }

    // Update Best Hash
    if (data.bestHash) {
        els.bestZeros.textContent = `${data.bestHash.zeros} Zeros`;
        els.bestDiff.textContent = `Diff: ${formatNumber(data.bestHash.difficulty.toFixed(2))}`;
        els.bestHash.textContent = data.bestHash.hash;
        els.bestVer.textContent = data.bestHash.version;
        els.bestEn1.textContent = data.bestHash.en1;
        els.bestEn2.textContent = data.bestHash.en2;
        els.bestNonce.textContent = data.bestHash.nonce;
    }

    // Update real Block Header info (decoded from the current job's coinbase tx)
    if (data.blockHeader) {
        renderBlockHeader(data.blockHeader);
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const strategySelect = document.getElementById('strategy-select');
    const customNonceGroup = document.getElementById('custom-nonce-group');
    const customNonceInput = document.getElementById('custom-nonce-input');

    function sendStrategy() {
        const method = parseInt(strategySelect.value, 10);
        const customNonce = parseInt(customNonceInput.value, 10) || 0;
        fetch('/api/strategy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method, customNonce })
        }).catch(err => console.error("Failed to update strategy", err));
    }

    if (els.protocolSelect) {
        els.protocolSelect.addEventListener('change', async () => {
            const protocol = els.protocolSelect.value;
            // Get host and port from inputs, fallback to ckpool if missing (but do not overwrite active config with a hardcode)
            const hostInput = document.getElementById('pool-host-input');
            const portInput = document.getElementById('pool-port-input');
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
        });
    }

    if (els.threadsSelect) {
        els.threadsSelect.addEventListener('change', async (e) => {
            const threads = parseInt(e.target.value, 10);
            try {
                await fetch('/api/threads', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ threads })
                });
            } catch (err) {
                console.error(err);
            }
        });
    }

    if (strategySelect) {
        strategySelect.addEventListener('change', (e) => {
            if (e.target.value === "9") { // CUSTOM_NONCE
                customNonceGroup.style.display = "block";
            } else {
                customNonceGroup.style.display = "none";
            }
            sendStrategy();
        });
    }

    if (customNonceInput) {
        customNonceInput.addEventListener('change', sendStrategy);
    }

    const toggleBrowserMiningBtn = document.getElementById('toggle-browser-mining');
    if (toggleBrowserMiningBtn) {
        let isBrowserMining = false;
        toggleBrowserMiningBtn.addEventListener('click', () => {
            if (isBrowserMining) {
                window.stopBrowserMining();
                isBrowserMining = false;
                toggleBrowserMiningBtn.textContent = 'Start Browser CPU Mining';
                toggleBrowserMiningBtn.style.background = 'var(--accent)';
            } else {
                window.startBrowserMining();
                isBrowserMining = true;
                toggleBrowserMiningBtn.textContent = 'Stop Browser CPU Mining';
                toggleBrowserMiningBtn.style.background = '#ff5f56';
            }
        });
    }

    const toggleWebGPUMiningBtn = document.getElementById('toggle-webgpu-mining');
    if (toggleWebGPUMiningBtn) {
        let isWebGPUMining = false;
        toggleWebGPUMiningBtn.addEventListener('click', () => {
            if (isWebGPUMining) {
                window.stopWebGPUMining();
                isWebGPUMining = false;
                toggleWebGPUMiningBtn.textContent = 'Start WebGPU Mining';
                toggleWebGPUMiningBtn.style.background = '#61dafb';
            } else {
                window.startWebGPUMining();
                isWebGPUMining = true;
                toggleWebGPUMiningBtn.textContent = 'Stop WebGPU Mining';
                toggleWebGPUMiningBtn.style.background = '#ff5f56';
            }
        });
    }

    const toggleNodeMiningBtn = document.getElementById('toggle-node-mining');
    if (toggleNodeMiningBtn) {
        toggleNodeMiningBtn.addEventListener('click', () => {
            const isMining = toggleNodeMiningBtn.textContent.includes('Stop');
            const state = isMining ? 'stop' : 'start';
            fetch('/api/miner-toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state })
            }).catch(err => console.error("Failed to toggle miner", err));
        });
    }
});
