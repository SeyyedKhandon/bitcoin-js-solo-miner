# Bitcoin JS Solo Miner

An educational Bitcoin Stratum V1 solo miner, written in TypeScript, with a live browser dashboard that can mine on the CPU (server-side worker threads) or on the GPU (client-side, via WebGPU).

It mines by itself — this is not a pool-fee-free lottery ticket generator, it's a working (if slow) implementation of the same subscribe → authorize → job → hash → submit loop that ASIC miners use, so you can see every step of the process.

## Running it

```bash
npm install
npm start
```

`npm start` compiles the TypeScript (via a `prestart` hook) and runs the result. On startup the console prints the dashboard URL:

```
  ┌─────────────────────────────────────────────┐
  │   Bitcoin JS Solo Miner running at:          │
  │   http://localhost:8080                      │
  │   Open it in a browser to mine via WebGPU    │
  └─────────────────────────────────────────────┘
```

Open **http://localhost:8080** to watch live hashrate, shares, and the best hash found this session, and to control pool, thread count, and mining strategy. Every field on the dashboard has a hover tooltip explaining what it means.

To just compile without running: `npm run build`. This runs two separate `tsc` builds — one for the Node.js backend (output to `dist/`), one for the browser dashboard's TypeScript (compiled in place into `public/`, since it's loaded directly by the browser with no bundler).

## Browser GPU mining

`public/webgpu-miner.ts` runs the double-SHA256 nonce search on your GPU via [WebGPU](https://www.w3.org/TR/webgpu/) (compute shader in `public/shader.ts`), connecting back to the server over a WebSocket to receive jobs and report shares/hashrate. Requires a WebGPU-capable browser (recent Chrome/Edge, or Safari Technology Preview with the flag enabled). `public/browser-miner.ts` is a CPU equivalent using the Web Crypto API, mainly to demonstrate the architecture (it doesn't build a real Merkle root, so it can't submit valid shares, but it does report real hashrate and hash values).

## How Stratum mining works

1. **Subscribe** — the client opens a TCP socket to the pool and sends `mining.subscribe`; the pool replies with an `extranonce1` and `extranonce2` size.
2. **Authorize** — the client sends `mining.authorize` with a worker name/password (for solo pools, a Bitcoin address works as the name).
3. **Receive jobs** — the pool pushes `mining.notify` messages with everything needed to build a block header: previous block hash, coinbase transaction halves, Merkle branch, version, difficulty bits, and time.
4. **Mine** — build the coinbase (`coinb1 + extranonce1 + extranonce2 + coinb2`), double-SHA256 it, fold it up through the Merkle branch to get the Merkle root, assemble the 80-byte header (`version + prevhash + merkle_root + ntime + nbits + nonce`), and hash it repeatedly with an incrementing nonce until the hash is numerically below the target.
5. **Submit** — a nonce that satisfies the target is sent back via `mining.submit`.

The dashboard's Block Header panel decodes this same coinbase transaction for real (block height, miner tag, outputs, BIP-54/BIP-110 signaling) — ported from ESP-Miner's own `coinbase_decoder.c`, which runs this decode on real ASIC hardware.

## Configuration

Pool and mining settings live in `config.ts`. Pool host/port, mining strategy, and thread count can also be changed live from the dashboard, without restarting the server.

## Architecture

```
index.ts                    entry point: wires everything together, prints the startup banner
config.ts                   pool + mining settings
tsconfig.json                backend build config (Node, outputs to dist/)
tsconfig.public.json         frontend build config (browser, compiles in place into public/)

lib/
  types.ts                  shared TypeScript types (Job, Config, stats, WS messages, ...)
  hash.ts                   double-SHA256, Merkle hashing, target/difficulty math
  logger.ts                 timestamped console logger
  format.ts                 difficulty-suffix and sats-to-BTC formatting
  bitcoin-address.ts        Base58Check + Bech32/Bech32m address encoding

mining/
  stratum-client.ts         Stratum V1 TCP client (subscribe/authorize/notify/submit)
  strategies.ts             nonce-search strategy enum + historical-nonce data loader
  worker.ts                 per-thread hashing loop (runs in a worker_threads Worker)
  miner.ts                  coordinates worker threads, tracks stats, dispatches jobs
  coinbase-decoder.ts       decodes real block-header info from a job's coinbase tx

server/
  http-server.ts            serves the dashboard, REST API, SSE stats stream
  ws-server.ts               WebSocket server for the browser's CPU/WebGPU miners

public/
  index.html, style.css     dashboard UI (static, not compiled)
  types.ts                  shared browser-side types + ambient WebGPU/Window declarations
  app.ts                    dashboard logic (SSE consumer, config controls)
  browser-miner.ts          browser CPU miner (Web Crypto)
  webgpu-miner.ts, shader.ts   browser GPU miner and its compute shader
```

### Nonce-search strategies

`mining/strategies.ts` defines twelve ways of walking the 32-bit nonce space (sequential, top-down, randomized, golden-ratio-seeded, several `extranonce2` variants, etc.), used to compare how search order affects share-finding. `ALL_MODE` (the default) rotates through them one job at a time; pick a specific one from the dashboard's strategy dropdown, or set `miningMethod` in `config.ts`. (`LIST_NONCES`, which sampled nonces from a bundled list of real historical blocks, has no data backing it anymore and always uses nonce 0.)
