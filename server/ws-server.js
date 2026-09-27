import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from '../lib/logger.js';

/**
 * Attaches a WebSocket server used by the browser's WebGPU miner: it
 * receives job broadcasts and reports shares/hashrate back to the pool
 * via the Stratum client.
 */
export function attachWebSocketServer(httpServer, { miner, stratum }) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    Logger.info('Browser connected via WebSocket for GPU mining');

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

      if (msg.type === 'share') {
        Logger.warn(`GPU share found! Hash: ${msg.shareInfo.hash}`);
        stratum.submit(msg.shareInfo.jobId, msg.shareInfo.extranonce2, msg.shareInfo.ntime, msg.shareInfo.nonce);
      } else if (msg.type === 'hashrate') {
        miner.stats.totalHashes += msg.count;
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
