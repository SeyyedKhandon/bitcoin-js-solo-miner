import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { MiningMethod } from './strategies.js';
import { processMiningNotification } from './coinbase-decoder.js';
import { getTargetFromNbits, getHashDifficulty } from '../lib/hash.js';
import { Logger } from '../lib/logger.js';
import { config } from '../config.js';

const workerUrl = new URL('./worker.js', import.meta.url);

/**
 * Coordinates a pool of CPU worker threads, tracks hashrate/share stats,
 * and dispatches pool jobs to the workers. Mining stays off until start()
 * is called explicitly - receiving a job only records it, so the server
 * doesn't spin up CPU mining on its own the moment it connects to a pool.
 */
export class Miner extends EventEmitter {
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

  initWorkers() {
    for (const w of this.workers) w.terminate();
    this.workers = [];

    Logger.info(`Initializing ${this.totalThreads} CPU worker thread(s)...`);

    for (let i = 0; i < this.totalThreads; i++) {
      const worker = new Worker(workerUrl);
      worker.on('message', (msg) => this._handleWorkerMessage(msg));
      worker.on('error', (err) => Logger.error(`Worker error: ${err.message}`));
      this.workers.push(worker);
    }
  }

  _handleWorkerMessage(msg) {
    if (msg.type === 'hashrate') {
      this.stats.totalHashes += msg.count;
      this.recordHash(msg.latestHash, { version: msg.version, en1: msg.en1, en2: msg.en2, nonce: msg.nonce });
    } else if (msg.type === 'share') {
      this.stats.sharesFound++;
      this.emit('share', msg.shareInfo);
    }
  }

  /**
   * Records a hash for the Latest Hash / Best Hash display. Called for
   * every CPU worker batch, and for any browser miner (WebGPU, browser
   * CPU) that reports one over the WebSocket - see server/ws-server.js.
   */
  recordHash(hash, { version, en1, en2, nonce }) {
    if (!hash) return;

    const hashObj = {
      hash,
      zeros: hash.match(/^0*/)[0].length,
      difficulty: getHashDifficulty(hash),
      version,
      en1,
      en2,
      nonce
    };

    this.latestHash = hashObj;
    if (this.bestHash === 'N/A' || hashObj.difficulty > this.bestHash.difficulty) {
      this.bestHash = hashObj;
    }
  }

  setThreads(n) {
    this.totalThreads = n;
    this.initWorkers();
    if (this.isMining && this.currentJob) {
      this._dispatchToWorkers();
    }
  }

  setStrategy(method, customNonce = 0) {
    this.activeMethod = method;
    this.customNonce = customNonce;
    Logger.info(`Mining strategy updated to method ${method} (Custom Nonce: ${customNonce})`);

    if (this.isMining && this.currentJob) {
      this._dispatchToWorkers();
    }
  }

  /** Records a new pool job. Only dispatches it to the workers if mining is already turned on. */
  startNewJob(job, poolDifficulty) {
    this.jobsReceived++;
    this.currentJob = job;
    this.poolDifficulty = poolDifficulty;
    this.target = getTargetFromNbits(job.nbits);

    try {
      this.blockHeader = processMiningNotification(job, job.extranonce1, job.extranonce2_size, config.workerName);
    } catch (e) {
      Logger.error(`Failed to decode block header info: ${e.message}`);
    }

    if (this.isMining) {
      this._dispatchToWorkers();
    }
  }

  /** Turns CPU mining on and starts hashing the current job, if one has been received yet. */
  start() {
    this.isMining = true;
    if (this.currentJob) {
      this._dispatchToWorkers();
    }
  }

  /** Turns CPU mining off. */
  stop() {
    this.isMining = false;
    this.interruptWorkers();
  }

  /** Tells the workers to abandon whatever they're hashing, without changing the on/off state. */
  interruptWorkers() {
    for (const w of this.workers) {
      w.postMessage({ type: 'stop' });
    }
  }

  _dispatchToWorkers() {
    if (this.activeMethod === MiningMethod.ALL_MODE) {
      this.allModeIndex++;
      if (this.allModeIndex > 12) this.allModeIndex = 1; // 1 is STANDARD; skip 0 (ALL_MODE itself)
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

  updateStats() {
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

  getStats() {
    let efficiency = '0.00%';
    if (this.stats.sharesFound + this.stats.staleShares > 0) {
      efficiency = ((this.stats.sharesFound / (this.stats.sharesFound + this.stats.staleShares)) * 100).toFixed(2) + '%';
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
