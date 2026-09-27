export interface Config {
  poolHost: string;
  poolPort: number;
  protocol: string;
  workerName: string;
  workerPassword: string;
  logLevel: string;
  miningMethod: number;
  customNonce: number;
  threads: number;
}

/** A Stratum V1 job, built from a mining.notify message. */
export interface MiningJob {
  jobId: string;
  prevhash: string;
  coinb1: string;
  coinb2: string;
  merkle_branch: string[];
  version: string;
  nbits: string;
  ntime: string;
  clean_jobs: boolean;
  extranonce1: string;
  extranonce2_size: number;
  /** Only present on the copy broadcast to browser miners: the decoded network target. */
  target?: string;
}

export interface ShareInfo {
  jobId: string;
  extranonce2: string;
  ntime: string;
  nonce: string;
  hash: string;
}

/** A hash worth showing on the dashboard, with its computed zero-count and difficulty. */
export interface HashRecord {
  hash: string;
  zeros: number;
  difficulty: number;
  version?: string;
  en1?: string;
  en2?: string;
  nonce?: string;
  /** Which miner/strategy produced it, e.g. "STANDARD" or "WebGPU". */
  method?: string;
}

export interface CoinbaseOutput {
  address: string;
  valueSatoshis: number;
  isUserOutput: boolean;
}

/** Real block-header info decoded from a job's coinbase transaction. */
export interface MiningNotificationResult {
  networkDifficulty: number;
  blockHeight: number;
  scriptsig: string | null;
  outputs: CoinbaseOutput[];
  totalValueSatoshis: number;
  userValueSatoshis: number;
  bip54Signaling: boolean;
  bip110Signaling: boolean;
}

/** The shape broadcast to the dashboard over Server-Sent Events. */
export interface MinerStats {
  hashrate1s: number;
  hashrate1m: number;
  hashrate1h: number;
  totalHashes: number;
  sharesFound: number;
  staleShares: number;
  efficiency: string;
  bestHash: HashRecord | 'N/A';
  latestHash: HashRecord | 'N/A';
  difficultyNbits: string;
  target: string;
  difficultyDecimal: number | string;
  activeMethod: number;
  jobsReceived: number;
  currentJobId: string | null;
  customNonce: number;
  threads: number;
  isMining: boolean;
  blockHeader: MiningNotificationResult | null;
}

/** Payload sent to a worker_threads Worker to (re)start it on a job. */
export interface WorkerStartPayload {
  job: MiningJob;
  target: string;
  activeMethod: number;
  allModeIndex: number;
  customNonce: number;
  extranonce2Counter: number;
  workerId: number;
  totalThreads: number;
}

export type WorkerInboundMessage =
  | { type: 'start'; payload: WorkerStartPayload }
  | { type: 'stop' };

export type WorkerOutboundMessage =
  | { type: 'hashrate'; count: number; latestHash: string; version?: string; en1?: string; en2?: string; nonce?: string; method?: number }
  | { type: 'share'; shareInfo: ShareInfo };

/** Who reported a hash/share/hello over the browser-miner WebSocket. */
export type MinerSource = 'browser-cpu' | 'webgpu';

export type BrowserWsMessage =
  | { type: 'hello'; source: MinerSource }
  | { type: 'share'; source: MinerSource; shareInfo: ShareInfo }
  | { type: 'hashrate'; source: MinerSource; count: number; latestHash?: string | null; version?: string; en1?: string; en2?: string; nonce?: string; method?: string };
