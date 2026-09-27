# Bitcoin JS Solo Miner

An educational Bitcoin Stratum V1 solo miner in Node.js, with a live browser dashboard that can mine on the CPU (server-side worker threads) or on the GPU (client-side, via WebGPU).

It mines by itself — this is not a pool-fee-free lottery ticket generator, it's a working (if slow) implementation of the same subscribe → authorize → job → hash → submit loop that ASIC miners use, so you can see every step of the process.

## Running it

```bash
npm install
npm start
```

This connects to the configured pool and starts a CPU worker thread. On startup the console prints the dashboard URL:

```
  ┌─────────────────────────────────────────────┐
  │   Bitcoin JS Solo Miner running at:          │
  │   http://localhost:8080                      │
  │   Open it in a browser to mine via WebGPU    │
  └─────────────────────────────────────────────┘
```

Open **http://localhost:8080** to watch live hashrate, shares, and the best hash found this session, and to control pool, thread count, and mining strategy.

## Browser GPU mining

`public/webgpu-miner.js` runs the double-SHA256 nonce search on your GPU via [WebGPU](https://www.w3.org/TR/webgpu/) (compute shader in `public/shader.js`), connecting back to the server over a WebSocket to receive jobs and report shares/hashrate. Requires a WebGPU-capable browser (recent Chrome/Edge, or Safari Technology Preview with the flag enabled).

## How Stratum mining works

1. **Subscribe** — the client opens a TCP socket to the pool and sends `mining.subscribe`; the pool replies with an `extranonce1` and `extranonce2` size.
2. **Authorize** — the client sends `mining.authorize` with a worker name/password (for solo pools, a Bitcoin address works as the name).
3. **Receive jobs** — the pool pushes `mining.notify` messages with everything needed to build a block header: previous block hash, coinbase transaction halves, Merkle branch, version, difficulty bits, and time.
4. **Mine** — build the coinbase (`coinb1 + extranonce1 + extranonce2 + coinb2`), double-SHA256 it, fold it up through the Merkle branch to get the Merkle root, assemble the 80-byte header (`version + prevhash + merkle_root + ntime + nbits + nonce`), and hash it repeatedly with an incrementing nonce until the hash is numerically below the target.
5. **Submit** — a nonce that satisfies the target is sent back via `mining.submit`.

## Configuration

Pool and mining settings live in `config.js`. Pool host/port, mining strategy, and thread count can also be changed live from the dashboard, without restarting the server.

## Architecture

```
index.js                    entry point: wires everything together, prints the startup banner
config.js                   pool + mining settings

lib/
  hash.js                   double-SHA256, Merkle hashing, target/difficulty math
  logger.js                 timestamped console logger

mining/
  stratum-client.js         Stratum V1 TCP client (subscribe/authorize/notify/submit)
  strategies.js             nonce-search strategy enum + historical-nonce data loader
  worker.js                 per-thread hashing loop (runs in a worker_threads Worker)
  miner.js                  coordinates worker threads, tracks stats, dispatches jobs

server/
  http-server.js            serves the dashboard, REST API, SSE stats stream
  ws-server.js               WebSocket server for the browser's WebGPU miner

public/
  index.html, style.css     dashboard UI
  app.js                    dashboard logic (SSE consumer, config controls)
  webgpu-miner.js, shader.js   browser GPU miner and its compute shader

data/
  bitcoin_last_10000_nonces.txt   nonce samples for the LIST_NONCES strategy
```

### Nonce-search strategies

`mining/strategies.js` defines twelve ways of walking the 32-bit nonce space (sequential, top-down, randomized, golden-ratio-seeded, several `extranonce2` variants, sampling nonces from real historical blocks, etc.), used to compare how search order affects share-finding. `ALL_MODE` (the default) rotates through them one job at a time; pick a specific one from the dashboard's strategy dropdown, or set `miningMethod` in `config.js`.
