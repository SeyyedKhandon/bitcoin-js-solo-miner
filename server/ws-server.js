import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from '../lib/logger.js';

const SOURCE_LABELS = {
  'browser-cpu': 'browser CPU miner',
  'webgpu': 'browser WebGPU miner'
};

function labelFor(source) {
  return SOURCE_LABELS[source] || 'browser client';
}

/**
 * Attaches a WebSocket server used by the browser's CPU and WebGPU miners:
 * it receives job broadcasts and reports shares/hashrate back to the pool
 * via the Stratum client. Both miner types share this one endpoint; each
 * message carries a `source` field so logging can tell them apart.
 */
export function attachWebSocketServer(httpServer, { miner, stratum }) {
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

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        Logger.error('Invalid WS message from browser');
        return;
      }

      if (msg.type === 'hello') {
        Logger.info(`Identified as ${labelFor(msg.source)}`);
      } else if (msg.type === 'share') {
        Logger.warn(`Share found by ${labelFor(msg.source)}! Hash: ${msg.shareInfo.hash}`);
        stratum.submit(msg.shareInfo.jobId, msg.shareInfo.extranonce2, msg.shareInfo.ntime, msg.shareInfo.nonce);
      } else if (msg.type === 'hashrate') {
        miner.stats.totalHashes += msg.count;
        if (msg.latestHash) {
          miner.recordHash(msg.latestHash, { version: msg.version, en1: msg.en1, en2: msg.en2, nonce: msg.nonce });
        }
      }
    });
  });

  return wss;
}

/** Broadcasts a new pool job to every connected browser miner. */
export function broadcastJob(wss, job, difficulty) {
  const message = JSON.stringify({ type: 'job', job, difficulty });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}
