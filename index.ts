import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.ts';
import { StratumClient } from './mining/stratum-client.ts';
import { Miner } from './mining/miner.ts';
import { Logger } from './lib/logger.ts';
import { createHttpServer } from './server/http-server.ts';
import { attachWebSocketServer, broadcastJob } from './server/ws-server.ts';
import type { MiningJob, ShareInfo } from './lib/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8080;

Logger.info('Starting Bitcoin JS Solo Miner...');

const stratum = new StratumClient(config);
const miner = new Miner();

const { server, broadcastStats } = createHttpServer({
  miner,
  stratum,
  config,
  publicDir: path.join(__dirname, 'public')
});

const wss = attachWebSocketServer(server, { miner, stratum });

stratum.on('job', (job: MiningJob, difficulty: number) => {
  if (job.clean_jobs) miner.interruptWorkers();
  miner.startNewJob(job, difficulty);
  broadcastJob(wss, { ...job, target: miner.target }, difficulty);
});

stratum.on('disconnected', () => {
  miner.interruptWorkers();
  Logger.info('Reconnecting in 5 seconds...');
  setTimeout(() => stratum.connect(), 5000);
});

miner.on('share', (shareInfo: ShareInfo) => {
  Logger.warn(`Valid share found! Hash: ${shareInfo.hash}`);
  stratum.submit(shareInfo.jobId, shareInfo.extranonce2, shareInfo.ntime, shareInfo.nonce);
});

miner.on('stats', broadcastStats);

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │   Bitcoin JS Solo Miner running at:          │');
  console.log(`  │   ${url}${' '.repeat(43 - url.length)}│`);
  console.log('  │   Open it in a browser to mine via WebGPU    │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
  Logger.info(`Web UI running at ${url}`);
});

stratum.connect();
