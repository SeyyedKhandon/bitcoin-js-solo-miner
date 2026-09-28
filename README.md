# Bitcoin JS Solo Miner

A Bitcoin Stratum V1 solo miner written in TypeScript, with a terminal-style browser dashboard. Mines on the server's CPU (worker threads), in the browser (Web Workers), or on the GPU (WebGPU).

It implements the full subscribe → authorize → job → hash → submit loop that real ASIC miners use, and exposes every step: live hashrate, share and block difficulty, and the actual block header decoded from each job's coinbase transaction.

```
┌─ JS SOLO MINER  v0.1.10 ──────────────── history ▾ ── theme ▾ ── Connected & Mining ─┐
└──────────────────────────────────────────────────────────────────────────────────────┘

┌─ MINING CONFIG ──────────────────────────────────────────────────────────────────────┐
│ ┌ SERVER CPU ──────────┐ ┌ BROWSER CPU ─────────┐ ┌ GPU (WEBGPU) ──────────────────┐ │
│ │ [ Stop Node Miner  ] │ │ [ Start Browser CPU ]│ │ [ Start WebGPU Mining        ] │ │
│ │ PARALLEL WORKERS     │ │ BROWSER WORKERS      │ │ GPU INTENSITY                  │ │
│ │ ▾ 8 workers          │ │ ▾ 8 workers          │ │ ▾ 75% - heavy                  │ │
│ └──────────────────────┘ └──────────────────────┘ └────────────────────────────────┘ │
│ NONCE SEARCH STRATEGY                                            PROTOCOL            │
│ ▾ 0 - ALL_MODE                                                   ▾ Stratum V1 (SV1)  │
│ PAYOUT BITCOIN ADDRESS                                                               │
│ bc1q46yjwqmfr24jcuyhpn4ytw43jg574vrgas0nms              [ Save Address ]             │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌─ MINING STATISTICS ──────────────────────────────────────────────────────────────────┐
│ HASHRATE        JOBS       TOTAL TRIES      SHARES       NETWORK TARGET              │
│ 82,400,000 H/s  4          1,341,780,000    0            10,000                      │
│ 1m 20,496,500   cur 6ab5…  hashes computed  stale 0      nbits 17021ec5 · zeros 78   │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌─ LATEST HASH FOUND ──────────────────────────────────────────────────────────────────┐
│ 00096a6084f2acab418392c249d1ed365fb1f709a1802bba2a134501005d17d7   Diff: 1.6e-6  3 ◇ │
│ METHOD              VERSION     EXTRANONCE1   EXTRANONCE2         NONCE              │
│ CPU · EN2_BIGENDIAN 20000000    5f6fe06a      0000000000000000    002212af           │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌─ BEST HASH (SESSION) ────────────────────────────────────────────────────────────────┐
│ 0000033a8bffead2d8fad0b77a5c8c5a6a80ca0126e7a8d7a8d9be368e905b93   Diff: 0.00121 5 ◇ │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌─ POOL INFO ───────────────┐ ┌─ BLOCK HEADER ─────────────────────────────────────────┐
│ URL   eusolo.ckpool.org   │ │ HEIGHT      968967                                     │
│ DIFF  10,000              │ │ DIFFICULTY  132.76 T (78 bits required)                │
│ FEE   2%                  │ │ VALUE       3.15029550 BTC                             │
│ MODE  SV1                 │ │ SCRIPTSIG   ckpool.eu/solo.ckpool.org/                 │
└───────────────────────────┘ └────────────────────────────────────────────────────────┘
```

Five themes ship with it — `matrix`, `vscode dark`, `amber`, `ice` and `paper` — switchable from the header.

## Requirements

Node.js 23.6+ (types are stripped natively at runtime — no build step for the backend).

## Usage

```bash
npm install
npm start
```

Then open **http://localhost:8080**. Node CPU mining starts automatically on first load.

Settings (miner selection, worker counts, GPU intensity, strategy, theme, payout address) are saved to `localStorage` and restored next visit. The backend is a single shared process, so pool-level settings apply to every connected client, not per-visitor.

Other scripts:

```bash
npm run build       # compile the dashboard's TypeScript only
npm run typecheck   # type-check the whole project, emitting nothing
npm run snapshot    # snapshot the built dashboard into releases/<version>/
```

## The three miners

| Miner | Where it runs | Throughput* |
| --- | --- | --- |
| Server CPU | Node `worker_threads` | ~740 kH/s per worker |
| Browser CPU | Web Workers, synchronous SHA-256 | ~890 kH/s per worker |
| GPU | WebGPU compute shader | ~82 MH/s |

<sub>*Measured on one development machine; yours will differ.</sub>

All three build a real Merkle root and 80-byte header and can submit genuine shares. The GPU miner's intensity control is a real duty cycle: it measures how long each batch takes and idles for the remainder, so 25/50/75% genuinely leave the card idle rather than just shrinking the batch.

## Is it correct?

Mining code fails silently — a byte-order mistake just means you hash garbage forever. So the header, Merkle and target logic are checked against external ground truth:

- **The real genesis block.** Fetching block 0's header and coinbase from a public explorer, running them through this project's Merkle-root and header assembly, and hashing reproduces `000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f` exactly.
- **ckpool's own validation.** ckpool's `share_diff()` — the C function the real pool uses to verify submissions — was ported and fed the exact fields this miner would submit. It reconstructs an identical hash, so a share found here would validate at the pool.
- **The SHA-256 implementation** matches Node's `crypto` across random inputs, and the browser workers' hashes re-derive exactly under the verified Node implementation using live pool jobs.

## How Stratum mining works

1. **Subscribe** — open a TCP socket to the pool, send `mining.subscribe`; the pool replies with `extranonce1` and an `extranonce2` size.
2. **Authorize** — send `mining.authorize` (for solo pools, a Bitcoin address serves as the username).
3. **Receive jobs** — the pool pushes `mining.notify` with the previous block hash, coinbase transaction halves, Merkle branch, version, difficulty bits, and time.
4. **Mine** — assemble the coinbase (`coinb1 + extranonce1 + extranonce2 + coinb2`), double-SHA256 it, fold it through the Merkle branch for the Merkle root, build the 80-byte header, and hash it with an incrementing nonce until the result is below the target.
5. **Submit** — send a satisfying nonce back via `mining.submit`.

The dashboard's Block Header panel decodes the same coinbase transaction for real (height, miner tag, outputs, BIP-54/BIP-110 signaling), ported from ESP-Miner's `coinbase_decoder.c`.

### Nonce-search strategies

`mining/strategies.ts` defines twelve ways of walking the 32-bit nonce space (sequential, top-down, randomized, golden-ratio-seeded, several `extranonce2` variants). `ALL_MODE` (default) rotates through them per job. Two of them — `INVERTED_VERSION` and `RANDOM_INVERTED` — are deprecated: they alter the header version without negotiating BIP320 version-rolling, so the pool reconstructs a different header and rejects any share found under them.

Worth being clear: every nonce is equally likely to be the winning one. These strategies are an experiment in search order, not an edge.

## Configuration

Pool and mining defaults live in `config.ts`. Pool, worker count, strategy and payout address can also be changed live from the dashboard.

## Architecture

```
index.ts                    entry point
config.ts                   pool + mining settings

lib/
  types.ts                  shared types (Job, Config, stats, WS messages, ...)
  hash.ts                   double-SHA256, Merkle hashing, target/difficulty math
  changelog.ts              parses the latest CHANGELOG entry for the UI
  logger.ts                 timestamped console logger
  format.ts                 difficulty-suffix and sats-to-BTC formatting
  bitcoin-address.ts        Base58Check + Bech32/Bech32m address encoding

mining/
  stratum-client.ts         Stratum V1 TCP client
  strategies.ts             nonce-search strategies
  worker.ts                 per-thread hashing loop (worker_threads)
  miner.ts                  coordinates worker threads, tracks stats
  coinbase-decoder.ts       decodes block-header info from a job's coinbase tx

server/
  http-server.ts            dashboard, REST API, SSE stats stream, release history
  ws-server.ts              WebSocket endpoint for browser CPU/WebGPU miners

public/
  index.html, style.css     dashboard UI (TUI styling, five themes)
  app.ts                    dashboard logic
  sha256.ts                 synchronous SHA-256 with an 80-byte header fast path
  browser-miner.ts          coordinates the browser Web Worker pool
  browser-worker.ts         one browser mining thread
  webgpu-miner.ts, shader.ts   browser GPU miner and WGSL compute shader
  strategies.ts             browser-side port of the nonce strategies

scripts/
  snapshot-release.mjs      snapshots a build into releases/<version>/
```

## Version history

The dashboard can be viewed as it looked at an earlier release, picked from the header. Each release is snapshotted into `releases/<version>/` and served at `/v/<version>/`. Only the interface is versioned — an older build still talks to the current server, so it may not show fields added later.

To cut a release: bump `package.json`, add a `CHANGELOG.md` entry, run `npm run snapshot`, commit, then tag.

## Deployment

This is a persistent process — it holds a TCP connection to the pool, runs worker threads, and serves a WebSocket. **Static hosting (GitHub Pages, Netlify) cannot run it**, because the Stratum connection is a raw TCP socket that browsers cannot open; the server exists precisely to proxy it.

`render.yaml` is included for one-click deployment to [Render](https://render.com). Render's free tier spins down after 15 minutes of inactivity and takes ~a minute to wake, so for an always-on instance either keep it warm with an uptime pinger (the free tier's 750 instance-hours/month covers one continuously running service) or use a host that does not sleep, such as an Oracle Cloud Always Free VM.

## Reality check

Solo mining at these hashrates will not find a block. A GPU at ~80 MH/s against a network around 10²¹ H/s has odds that work out to one block roughly every few hundred million years. This is a tool for understanding how mining actually works — and for the very small chance that makes solo mining fun — not an income source.

## Donate

If this was useful, the same address the miner ships with:

```
bc1q46yjwqmfr24jcuyhpn4ytw43jg574vrgas0nms
```

[bitcoin:bc1q46yjwqmfr24jcuyhpn4ytw43jg574vrgas0nms](bitcoin:bc1q46yjwqmfr24jcuyhpn4ytw43jg574vrgas0nms)

## License

MIT
