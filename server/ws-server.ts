import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { Logger } from '../lib/logger.ts';
import type { Miner } from '../mining/miner.ts';
import type { StratumClient } from '../mining/stratum-client.ts';
import type { BrowserWsMessage, MinerSource } from '../lib/types.ts';

const SOURCE_LABELS: Record<MinerSource, string> = {
  'browser-cpu': 'browser CPU miner',
  'webgpu': 'browser WebGPU miner'
};

/** Short labels for the dashboard's "Method" field on a reported hash. */
const METHOD_LABELS: Record<MinerSource, string> = {
  'browser-cpu': 'Browser CPU',
  'webgpu': 'WebGPU'
};

function labelFor(source: MinerSource | undefined): string {
  return (source && SOURCE_LABELS[source]) || 'browser client';
}

interface AttachWebSocketServerOptions {
  miner: Miner;
  stratum: StratumClient;
}

/**
 * Attaches a WebSocket server used by the browser's CPU and WebGPU miners:
 * it receives job broadcasts and reports shares/hashrate back to the pool
 * via the Stratum client. Both miner types share this one endpoint; each
 * message carries a `source` field so logging can tell them apart.
 */
export function attachWebSocketServer(httpServer: Server, { miner, stratum }: AttachWebSocketServerOptions): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    Logger.info('Browser client connected via WebSocket');

    if (miner.currentJob) {
      ws.send(JSON.stringify({
        type: 'job',
        job: { ...miner.currentJob, target: miner.target },
        difficulty: miner.poolDifficulty
      }));
    }

    ws.on('message', (raw: Buffer) => {
      let msg: BrowserWsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        Logger.error('Invalid WS message from browser');
        return;
      }

      if (msg.type === 'hello') {
        Logger.info(`Identified as ${labelFor(msg.source)}`);
      } else if (msg.type === 'share') {
        Logger.warn(`Share found by ${labelFor(msg.source)}! Hash: ${msg.shareInfo.hash}`);
        // Mirrors Miner._handleWorkerMessage's CPU-share bookkeeping - browser
        // shares submit directly here rather than through the miner's 'share'
        // event (which would re-submit), but still need to count toward
        // sharesFound so the stale/efficiency stats (sharesFound - staleShares)
        // stay accurate regardless of which miner found the share.
        miner.stats.sharesFound++;
        stratum.submit(msg.shareInfo.jobId, msg.shareInfo.extranonce2, msg.shareInfo.ntime, msg.shareInfo.nonce);
      } else if (msg.type === 'hashrate') {
        miner.stats.totalHashes += msg.count;
        if (msg.latestHash) {
          // Browser miners scan the nonce space their own fixed way rather
          // than through the server's strategy list, so they report their
          // own scan strategy and it's shown as "<miner> · <strategy>",
          // matching how CPU worker hashes are labelled.
          const source = METHOD_LABELS[msg.source] || 'Browser';
          miner.recordHash(msg.latestHash, {
            version: msg.version,
            en1: msg.en1,
            en2: msg.en2,
            nonce: msg.nonce,
            method: msg.method ? `${source} · ${msg.method}` : source
          });
        }
      }
    });
  });

  return wss;
}

/** Broadcasts a new pool job to every connected browser miner. */
export function broadcastJob(wss: WebSocketServer, job: unknown, difficulty: number | null): void {
  const message = JSON.stringify({ type: 'job', job, difficulty });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}
