# Bitcoin JS Solo Miner

A Bitcoin Stratum V1 solo miner written in TypeScript, with a live browser dashboard for mining on the CPU (server-side worker threads) or GPU (client-side, via WebGPU).

It implements the full subscribe → authorize → job → hash → submit loop that real ASIC miners use, with a dashboard exposing every step: live hashrate, share/block difficulty, and the actual block header decoded from each job's coinbase transaction.

## Requirements

Node.js 23.6+ (types are stripped natively at runtime — no build step for the backend).

## Usage

```bash
npm install
npm start
```

`npm start` compiles the browser dashboard's TypeScript into `public/`, then runs the backend directly from source. On startup:

```
  ┌─────────────────────────────────────────────┐
  │   Bitcoin JS Solo Miner running at:          │
  │   http://localhost:8080                      │
  │   Open it in a browser to mine via WebGPU    │
  └─────────────────────────────────────────────┘
```

Open **http://localhost:8080**.

Node CPU mining starts automatically on first load. Mining method, thread count, Stratum protocol, and strategy are saved to `localStorage` and restored on your next visit. The backend is a single shared process — these settings apply to all connected clients, not per-visitor.

Other scripts:
- `npm run build` — compile the dashboard's TypeScript only.
- `npm run typecheck` — type-check the whole project without emitting anything.

## Browser GPU mining

`public/webgpu-miner.ts` runs the double-SHA256 nonce search on the GPU via [WebGPU](https://www.w3.org/TR/webgpu/), connecting to the server over a WebSocket for jobs and to report hashrate/shares. Requires a WebGPU-capable browser. `public/browser-miner.ts` is a CPU equivalent via the Web Crypto API. Both build a real Merkle root and header (`public/bitcoin.ts`) and can submit genuine shares, same as the server-side miner.

## How Stratum mining works

1. **Subscribe** — open a TCP socket to the pool, send `mining.subscribe`; the pool replies with `extranonce1` and an `extranonce2` size.
2. **Authorize** — send `mining.authorize` (for solo pools, a Bitcoin address serves as the username).
3. **Receive jobs** — the pool pushes `mining.notify` with the previous block hash, coinbase transaction halves, Merkle branch, version, difficulty bits, and time.
4. **Mine** — assemble the coinbase (`coinb1 + extranonce1 + extranonce2 + coinb2`), double-SHA256 it, fold it through the Merkle branch for the Merkle root, build the 80-byte header, and hash it with an incrementing nonce until the result is below the target.
5. **Submit** — send a satisfying nonce back via `mining.submit`.

The dashboard's Block Header panel decodes the same coinbase transaction for real (height, miner tag, outputs, BIP-54/BIP-110 signaling), ported from ESP-Miner's `coinbase_decoder.c`.

## Configuration

Pool and mining defaults live in `config.ts`. Pool, thread count, and strategy can also be changed live from the dashboard.

## Architecture

```
index.ts                    entry point
config.ts                   pool + mining settings

lib/
  types.ts                  shared types (Job, Config, stats, WS messages, ...)
  hash.ts                   double-SHA256, Merkle hashing, target/difficulty math
  logger.ts                 timestamped console logger
  format.ts                 difficulty-suffix and sats-to-BTC formatting
  bitcoin-address.ts        Base58Check + Bech32/Bech32m address encoding

mining/
  stratum-client.ts         Stratum V1 TCP client
  strategies.ts             nonce-search strategy enum
  worker.ts                 per-thread hashing loop (worker_threads)
  miner.ts                  coordinates worker threads, tracks stats
  coinbase-decoder.ts       decodes block-header info from a job's coinbase tx

server/
  http-server.ts            dashboard, REST API, SSE stats stream
  ws-server.ts               WebSocket endpoint for browser CPU/WebGPU miners

public/
  index.html, style.css     dashboard UI (static)
  app.ts                    dashboard logic
  browser-miner.ts          browser CPU miner
  webgpu-miner.ts, shader.ts   browser GPU miner and compute shader
```

### Nonce-search strategies

`mining/strategies.ts` defines twelve ways of walking the 32-bit nonce space (sequential, top-down, randomized, golden-ratio-seeded, several `extranonce2` variants, etc.). `ALL_MODE` (default) rotates through them per job; pick one explicitly from the dashboard, or set `miningMethod` in `config.ts`.

## Deployment

`render.yaml` is included for one-click deployment to [Render](https://render.com). As a persistent process (TCP pool connection, worker threads, WebSocket server), it requires a host that runs long-lived processes — not static or serverless hosting.
