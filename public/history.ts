// Performance history: a hashrate chart over time, and a per-strategy
// scoreboard. Both are kept in localStorage so they survive a reload and a
// server restart - the server itself only ever reports "right now".

const STORAGE_KEY = 'bitcoinJsSoloMiner.history';

/** ~15 minutes at one sample a second. Each sample is a few bytes of JSON. */
const MAX_SAMPLES = 900;

/** Writing to localStorage every tick is wasteful; batch it. */
const PERSIST_EVERY_MS = 10000;

export interface HashrateSample {
    /** Epoch ms. */
    t: number;
    /** Hashes per second. */
    h: number;
}

export interface StrategyStat {
    /** Hashes attributed to this strategy. */
    tries: number;
    /** Best (numerically lowest) hash seen while this strategy was running. */
    bestHash: string;
    bestZeros: number;
    /** Peak hashrate observed under this strategy. */
    peak: number;
}

interface HistoryState {
    samples: HashrateSample[];
    strategies: Record<string, StrategyStat>;
    /** totalHashes at the previous sample, to derive a per-tick delta. */
    lastTotalHashes: number;
}

function emptyState(): HistoryState {
    return { samples: [], strategies: {}, lastTotalHashes: 0 };
}

function load(): HistoryState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return emptyState();
        const parsed = JSON.parse(raw);
        return {
            samples: Array.isArray(parsed.samples) ? parsed.samples : [],
            strategies: parsed.strategies && typeof parsed.strategies === 'object' ? parsed.strategies : {},
            lastTotalHashes: Number(parsed.lastTotalHashes) || 0,
        };
    } catch {
        return emptyState();
    }
}

const state: HistoryState = load();
let lastPersistedAt = 0;

function persist(force = false): void {
    const now = Date.now();
    if (!force && now - lastPersistedAt < PERSIST_EVERY_MS) return;
    lastPersistedAt = now;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Storage full or unavailable - the history is a nicety, so drop the
        // oldest half and try once more rather than breaking the dashboard.
        state.samples = state.samples.slice(-Math.floor(MAX_SAMPLES / 2));
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* give up */ }
    }
}

export function clearHistory(): void {
    state.samples = [];
    state.strategies = {};
    state.lastTotalHashes = 0;
    persist(true);
}

interface StatsLike {
    hashrate1s: number;
    totalHashes: number;
    latestHash: { hash: string; zeros: number; method?: string } | 'N/A';
}

/**
 * Records one tick of live stats. Hashes are attributed to whichever miner
 * and strategy reported the most recent hash, which is how the per-strategy
 * totals are built up - the server only tracks a single global counter.
 */
export function recordSample(stats: StatsLike): void {
    const now = Date.now();
    state.samples.push({ t: now, h: stats.hashrate1s });
    if (state.samples.length > MAX_SAMPLES) {
        state.samples.splice(0, state.samples.length - MAX_SAMPLES);
    }

    const delta = stats.totalHashes - state.lastTotalHashes;
    state.lastTotalHashes = stats.totalHashes;

    const latest = stats.latestHash;
    if (latest !== 'N/A' && latest && latest.method) {
        const key = latest.method;
        const entry = state.strategies[key] || { tries: 0, bestHash: '', bestZeros: 0, peak: 0 };
        // A restarted server resets totalHashes, so ignore negative deltas
        // rather than subtracting from the running total.
        if (delta > 0) entry.tries += delta;
        if (stats.hashrate1s > entry.peak) entry.peak = stats.hashrate1s;
        if (!entry.bestHash || latest.hash < entry.bestHash) {
            entry.bestHash = latest.hash;
            entry.bestZeros = latest.zeros;
        }
        state.strategies[key] = entry;
    }

    persist();
}

function formatRate(value: number): string {
    if (!value) return '0';
    const units = ['', 'k', 'M', 'G', 'T'];
    const power = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log10(value) / 3)));
    const scaled = value / Math.pow(1000, power);
    return `${scaled.toFixed(power > 0 ? 2 : 0)} ${units[power]}H/s`;
}

function formatCount(value: number): string {
    return new Intl.NumberFormat().format(Math.round(value));
}

function clockLabel(t: number): string {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * Draws the hashrate chart as inline SVG. Deliberately dependency-free and
 * drawn from CSS variables, so it follows whichever theme is active.
 */
function renderChart(container: HTMLElement): void {
    const samples = state.samples;
    if (samples.length < 2) {
        container.innerHTML = '<div class="chart-empty">collecting samples…</div>';
        return;
    }

    const W = 1000;
    const H = 220;
    const padL = 74;
    const padR = 12;
    const padT = 12;
    const padB = 26;

    const peak = Math.max(...samples.map((s) => s.h), 1);
    const yMax = peak * 1.15;
    const t0 = samples[0].t;
    const t1 = samples[samples.length - 1].t;
    const span = Math.max(1, t1 - t0);

    const x = (t: number) => padL + ((t - t0) / span) * (W - padL - padR);
    const y = (h: number) => padT + (1 - h / yMax) * (H - padT - padB);

    const points = samples.map((s) => `${x(s.t).toFixed(1)},${y(s.h).toFixed(1)}`).join(' ');
    const area = `${padL},${y(0).toFixed(1)} ${points} ${x(t1).toFixed(1)},${y(0).toFixed(1)}`;

    const gridLines = [0, 0.25, 0.5, 0.75, 1]
        .map((f) => {
            const gy = padT + f * (H - padT - padB);
            const value = yMax * (1 - f);
            return `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" class="chart-grid"/>`
                + `<text x="${padL - 8}" y="${(gy + 4).toFixed(1)}" class="chart-axis" text-anchor="end">${formatRate(value)}</text>`;
        })
        .join('');

    const timeLabels = [0, 0.5, 1]
        .map((f) => {
            const tx = padL + f * (W - padL - padR);
            const anchor = f === 0 ? 'start' : f === 1 ? 'end' : 'middle';
            return `<text x="${tx.toFixed(1)}" y="${H - 8}" class="chart-axis" text-anchor="${anchor}">${clockLabel(t0 + f * span)}</text>`;
        })
        .join('');

    container.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg" role="img"
             aria-label="Hashrate over the last ${Math.round(span / 1000)} seconds">
            ${gridLines}
            <polygon points="${area}" class="chart-area"/>
            <polyline points="${points}" class="chart-line"/>
            ${timeLabels}
        </svg>`;
}

function renderStrategies(container: HTMLElement): void {
    const entries = Object.entries(state.strategies)
        .filter(([, s]) => s.tries > 0 || s.bestHash)
        // Best hash first - the whole point of rotating strategies is to
        // compare how they did.
        .sort((a, b) => (a[1].bestHash || 'f').localeCompare(b[1].bestHash || 'f'));

    if (!entries.length) {
        container.innerHTML = '<div class="chart-empty">no strategy samples yet…</div>';
        return;
    }

    const rows = entries.map(([name, s]) => `
        <div class="strategy-row">
            <span class="strategy-name">${name}</span>
            <span class="strategy-tries">${formatCount(s.tries)} tries</span>
            <span class="strategy-peak">peak ${formatRate(s.peak)}</span>
            <span class="strategy-hash">${s.bestHash ? s.bestHash.slice(0, 24) + '…' : '-'}</span>
            <span class="strategy-zeros">${s.bestZeros} ◇</span>
        </div>`).join('');

    container.innerHTML = rows;
}

export function renderHistory(): void {
    const chartEl = document.getElementById('perf-chart');
    const strategiesEl = document.getElementById('perf-strategies');
    if (chartEl) renderChart(chartEl);
    if (strategiesEl) renderStrategies(strategiesEl);
}

// Persist whatever is buffered if the tab goes away.
window.addEventListener('pagehide', () => persist(true));
