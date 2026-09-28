import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from './config.ts';
import { StratumClient } from './mining/stratum-client.ts';
import { Miner } from './mining/miner.ts';
import { Logger } from './lib/logger.ts';
import { parseLatestChangelogEntry } from './lib/changelog.ts';
import { createHttpServer } from './server/http-server.ts';
import { attachWebSocketServer, broadcastJob, broadcastStrategy } from './server/ws-server.ts';
import type { MiningJob, ShareInfo } from './lib/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Render (and most PaaS hosts) assign the port to listen on via PORT;
// falls back to 8080 for local development.
const PORT = Number(process.env.PORT) || 8080;

Logger.info('Starting Bitcoin JS Solo Miner...');

const stratum = new StratumClient(config);
const miner = new Miner();

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const changelogEntry = parseLatestChangelogEntry(path.join(__dirname, 'CHANGELOG.md'));
const versionInfo = {
  version: packageJson.version as string,
  date: changelogEntry?.date ?? '',
  changes: changelogEntry?.changes ?? []
};

const { server, broadcastStats } = createHttpServer({
  miner,
  stratum,
  config,
  publicDir: path.join(__dirname, 'public'),
  releasesDir: path.join(__dirname, 'releases'),
  versionInfo
});

const wss = attachWebSocketServer(server, { miner, stratum });

stratum.on('job', (job: MiningJob, difficulty: number) => {
  if (job.clean_jobs) miner.interruptWorkers();
  miner.startNewJob(job, difficulty);
  broadcastJob(wss, { ...job, target: miner.target }, difficulty, miner.getAppliedStrategy());
});

miner.on('strategy', (strategy: { method: number; customNonce: number }) => {
  broadcastStrategy(wss, strategy);
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

stratum.on('share-result', ({ accepted }: { accepted: boolean }) => {
  miner.recordShareResult(accepted);
});

miner.on('stats', broadcastStats);

server.listen(PORT, () => {
  // Render (and similar hosts) expose the service's real public URL via
  // RENDER_EXTERNAL_URL; fall back to localhost for local development.
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const pad = ' '.repeat(Math.max(0, 43 - url.length));
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │   Bitcoin JS Solo Miner running at:          │');
  console.log(`  │   ${url}${pad}│`);
  console.log('  │   Open it in a browser to mine via WebGPU    │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
  Logger.info(`Web UI running at ${url}`);
});

stratum.connect();
