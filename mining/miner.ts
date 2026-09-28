import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { MiningMethod, ALL_MODE_METHODS, methodName } from './strategies.ts';
import { processMiningNotification } from './coinbase-decoder.ts';
import { getTargetFromNbits, getHashDifficulty } from '../lib/hash.ts';
import { Logger } from '../lib/logger.ts';
import { config } from '../config.ts';
import type {
  MiningJob,
  MiningNotificationResult,
  HashRecord,
  MinerStats,
  WorkerOutboundMessage
} from '../lib/types.ts';

const workerUrl = new URL('./worker.ts', import.meta.url);

interface HashMeta {
  version?: string;
  en1?: string;
  en2?: string;
  nonce?: string;
  /** Which miner/strategy produced it, e.g. "STANDARD" or "WebGPU". */
  method?: string;
}

/**
 * Coordinates a pool of CPU worker threads, tracks hashrate/share stats,
 * and dispatches pool jobs to the workers. Mining stays off until start()
 * is called explicitly - receiving a job only records it, so the server
 * doesn't spin up CPU mining on its own the moment it connects to a pool.
 */
export class Miner extends EventEmitter {
  activeMethod: number;
  allModeIndex: number;
  customNonce: number;

  currentJob: MiningJob | null;
  poolDifficulty: number;
  target: string;
  blockHeader: MiningNotificationResult | null;
  isMining: boolean;
  jobsReceived: number;

  totalThreads: number;
  workers: Worker[];

  stats: {
    hashrate1s: number;
    hashrate1m: number;
    hashrate1h: number;
    totalHashes: number;
    sharesFound: number;
    staleShares: number;
  };

  bestHash: HashRecord | 'N/A';
  latestHash: HashRecord | 'N/A';

  history1m: number[];
  history1h: number[];
  lastHashes: number;

  constructor() {
    super();
    this.activeMethod = config.miningMethod ?? MiningMethod.ALL_MODE;
    this.allModeIndex = 0; // Tracks which method ALL_MODE is currently testing
    this.customNonce = config.customNonce || 0;

    this.currentJob = null;
    this.poolDifficulty = 0;
    this.target = '';
    this.blockHeader = null; // Real decoded block header info (height, difficulty, coinbase outputs)
    this.isMining = false; // Stays false until start() is called by the user
    this.jobsReceived = 0;

    this.totalThreads = config.threads || 1;
    this.workers = [];

    this.stats = {
      hashrate1s: 0,
      hashrate1m: 0,
      hashrate1h: 0,
      totalHashes: 0,
      sharesFound: 0,
      staleShares: 0
    };

    this.bestHash = 'N/A';
    this.latestHash = 'N/A';

    this.history1m = [];
    this.history1h = [];
    this.lastHashes = 0;

    setInterval(() => this.updateStats(), 1000);

    this.initWorkers();
  }

  initWorkers(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];

    Logger.info(`Initializing ${this.totalThreads} CPU worker thread(s)...`);

    for (let i = 0; i < this.totalThreads; i++) {
      const worker = new Worker(workerUrl);
      worker.on('message', (msg: WorkerOutboundMessage) => this._handleWorkerMessage(msg));
      worker.on('error', (err: Error) => Logger.error(`Worker error: ${err.message}`));
      this.workers.push(worker);
    }
  }

  _handleWorkerMessage(msg: WorkerOutboundMessage): void {
    if (msg.type === 'hashrate') {
      this.stats.totalHashes += msg.count;
      this.recordHash(msg.latestHash, {
        version: msg.version,
        en1: msg.en1,
        en2: msg.en2,
        nonce: msg.nonce,
        method: msg.method !== undefined ? `CPU · ${methodName(msg.method)}` : undefined
      });
    } else if (msg.type === 'share') {
      this.stats.sharesFound++;
      this.emit('share', msg.shareInfo);
    }
  }

  /**
   * Records the pool's verdict on a submitted share (see the 'share-result'
   * event on StratumClient). sharesFound already counts every share the
   * instant it's found locally, so only rejections need recording here -
   * getStats() derives the accepted count as sharesFound - staleShares.
   */
  recordShareResult(accepted: boolean): void {
    if (!accepted) this.stats.staleShares++;
  }

  /**
   * Records a hash for the Latest Hash / Best Hash display. Called for
   * every CPU worker batch, and for any browser miner (WebGPU, browser
   * CPU) that reports one over the WebSocket - see server/ws-server.ts.
   */
  recordHash(hash: string | null | undefined, { version, en1, en2, nonce, method }: HashMeta): void {
    if (!hash) return;

    const hashObj: HashRecord = {
      hash,
      zeros: hash.match(/^0*/)![0].length,
      difficulty: getHashDifficulty(hash),
      version,
      en1,
      en2,
      nonce,
      method
    };

    this.latestHash = hashObj;
    // Rank by the hash's own value, not by the derived difficulty float:
    // difficulty is a rounded approximation, so two hashes whose difficulty
    // rounds to the same number could never displace each other, which
    // froze Best Hash on whatever arrived first. Smaller hash = better.
    if (this.bestHash === 'N/A' || BigInt(`0x${hash}`) < BigInt(`0x${this.bestHash.hash}`)) {
      this.bestHash = hashObj;
    }
  }

  setThreads(n: number): void {
    this.totalThreads = n;
    this.initWorkers();
    if (this.isMining && this.currentJob) {
      this._dispatchToWorkers();
    }
  }

  setStrategy(method: number, customNonce = 0): void {
    this.activeMethod = method;
    this.customNonce = customNonce;
    Logger.info(`Mining strategy updated to method ${method} (Custom Nonce: ${customNonce})`);

    if (this.isMining && this.currentJob) {
      this._dispatchToWorkers();
    }

    // Browser miners mine independently of the worker threads, so they need
    // to be told about the change too - see broadcastStrategy in ws-server.
    this.emit('strategy', this.getAppliedStrategy());
  }

  /**
   * The concrete strategy currently in effect, with ALL_MODE resolved to
   * whichever method it has rotated to. This is what the workers actually
   * apply, and what browser miners are told to apply.
   */
  getAppliedStrategy(): { method: number; customNonce: number } {
    return {
      method: this.activeMethod === MiningMethod.ALL_MODE ? this.allModeIndex : this.activeMethod,
      customNonce: this.customNonce
    };
  }

  /** Records a new pool job. Only dispatches it to the workers if mining is already turned on. */
  startNewJob(job: MiningJob, poolDifficulty: number): void {
    this.jobsReceived++;
    this.currentJob = job;
    this.poolDifficulty = poolDifficulty;
    this.target = getTargetFromNbits(job.nbits);

    try {
      this.blockHeader = processMiningNotification(job, job.extranonce1, job.extranonce2_size, config.workerName);
    } catch (e) {
      Logger.error(`Failed to decode block header info: ${(e as Error).message}`);
    }

    if (this.isMining) {
      this._dispatchToWorkers();
    }
  }

  /** Turns CPU mining on and starts hashing the current job, if one has been received yet. */
  start(): void {
    this.isMining = true;
    if (this.currentJob) {
      this._dispatchToWorkers();
    }
  }

  /** Turns CPU mining off. */
  stop(): void {
    this.isMining = false;
    this.interruptWorkers();
  }

  /** Tells the workers to abandon whatever they're hashing, without changing the on/off state. */
  interruptWorkers(): void {
    for (const w of this.workers) {
      w.postMessage({ type: 'stop' });
    }
  }

  _dispatchToWorkers(): void {
    if (!this.currentJob) return;

    if (this.activeMethod === MiningMethod.ALL_MODE) {
      const currentPos = ALL_MODE_METHODS.indexOf(this.allModeIndex);
      this.allModeIndex = ALL_MODE_METHODS[(currentPos + 1) % ALL_MODE_METHODS.length];
    }

    Logger.info(`Starting job ${this.currentJob.jobId} | Target: ${this.target}`);

    for (let i = 0; i < this.workers.length; i++) {
      this.workers[i].postMessage({
        type: 'start',
        payload: {
          job: this.currentJob,
          target: this.target,
          activeMethod: this.activeMethod,
          allModeIndex: this.allModeIndex,
          customNonce: this.customNonce,
          extranonce2Counter: 0,
          workerId: i,
          totalThreads: this.totalThreads
        }
      });
    }
  }

  updateStats(): void {
    const hashesThisSecond = this.stats.totalHashes - this.lastHashes;
    this.lastHashes = this.stats.totalHashes;

    this.stats.hashrate1s = hashesThisSecond;

    this.history1m.push(hashesThisSecond);
    if (this.history1m.length > 60) this.history1m.shift();
    this.stats.hashrate1m = Math.floor(this.history1m.reduce((a, b) => a + b, 0) / this.history1m.length);

    this.history1h.push(hashesThisSecond);
    if (this.history1h.length > 3600) this.history1h.shift();
    this.stats.hashrate1h = Math.floor(this.history1h.reduce((a, b) => a + b, 0) / this.history1h.length);

    this.emit('stats', this.getStats());
  }

  getStats(): MinerStats {
    // sharesFound counts every share the instant it's found locally (before
    // the pool has responded); staleShares counts how many of those were
    // then rejected - so accepted = sharesFound - staleShares.
    let efficiency = '0.00%';
    if (this.stats.sharesFound > 0) {
      const accepted = this.stats.sharesFound - this.stats.staleShares;
      efficiency = ((accepted / this.stats.sharesFound) * 100).toFixed(2) + '%';
    }

    return {
      hashrate1s: this.stats.hashrate1s,
      hashrate1m: this.stats.hashrate1m,
      hashrate1h: this.stats.hashrate1h,
      totalHashes: this.stats.totalHashes,
      sharesFound: this.stats.sharesFound,
      staleShares: this.stats.staleShares,
      efficiency,
      bestHash: this.bestHash,
      latestHash: this.latestHash,
      poolUser: config.workerName,
      poolUrl: `${config.poolHost}:${config.poolPort}`,
      difficultyNbits: this.currentJob ? this.currentJob.nbits : '-',
      target: this.target,
      difficultyDecimal: this.poolDifficulty || 'Waiting...',
      activeMethod: this.activeMethod,
      jobsReceived: this.jobsReceived,
      currentJobId: this.currentJob ? this.currentJob.jobId : null,
      customNonce: this.customNonce,
      threads: this.totalThreads,
      isMining: this.isMining,
      blockHeader: this.blockHeader
    };
  }
}
