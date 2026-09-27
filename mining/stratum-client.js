import net from 'net';
import { EventEmitter } from 'events';
import { Logger } from '../lib/logger.js';

/**
 * A minimal Stratum V1 client: connects over TCP, subscribes, authorizes,
 * and emits 'job' events as the pool streams in mining.notify messages.
 */
export class StratumClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = new net.Socket();
    this.msgId = 1;
    this.buffer = '';

    // Stratum session state
    this.extranonce1 = null;
    this.extranonce2_size = null;
    this.difficulty = null;

    this._setupEventHandlers();
  }

  _setupEventHandlers() {
    this.client.on('connect', () => {
      Logger.info(`Connected to pool ${this.config.poolHost}:${this.config.poolPort}`);
      this.emit('connected');
      this.subscribe();
    });

    this.client.on('data', (data) => {
      this.buffer += data.toString();

      // Messages are newline-delimited JSON
      let newlineIndex;
      while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.substring(0, newlineIndex).trim();
        this.buffer = this.buffer.substring(newlineIndex + 1);

        if (line.length > 0) {
          try {
            this._handleMessage(JSON.parse(line));
          } catch (e) {
            Logger.error(`Failed to parse pool message: ${e.message} - ${line}`);
          }
        }
      }
    });

    this.client.on('close', () => {
      Logger.warn('Connection to pool closed');
      this.emit('disconnected');
    });

    this.client.on('error', (err) => {
      Logger.error(`Pool connection error: ${err.message}`);
    });
  }

  connect() {
    Logger.info(`Connecting to ${this.config.poolHost}:${this.config.poolPort}...`);
    this.client.connect(this.config.poolPort, this.config.poolHost);
  }

  send(method, params = []) {
    const msg = { id: this.msgId++, method, params };
    this.client.write(JSON.stringify(msg) + '\n');
  }

  subscribe() {
    Logger.info('Sending mining.subscribe...');
    this.send('mining.subscribe', ['NodeJsMiner/1.0.0']);
  }

  authorize() {
    Logger.info(`Sending mining.authorize for ${this.config.workerName}...`);
    this.send('mining.authorize', [this.config.workerName, this.config.workerPassword]);
  }

  submit(jobId, extranonce2, ntime, nonce) {
    Logger.info(`Submitting share for job ${jobId} (nonce: ${nonce})`);
    this.send('mining.submit', [this.config.workerName, jobId, extranonce2, ntime, nonce]);
  }

  _handleMessage(msg) {
    if (msg.id !== null) {
      // Response to a request we sent
      if (msg.error) {
        Logger.error(`Pool error: ${JSON.stringify(msg.error)}`);
        return;
      }

      // Subscription response: [ [...], extranonce1, extranonce2_size ]
      if (msg.result && Array.isArray(msg.result) && msg.result.length === 3) {
        Logger.info('Subscribed!');
        this.extranonce1 = msg.result[1];
        this.extranonce2_size = msg.result[2];
        Logger.info(`Extranonce1: ${this.extranonce1}, Extranonce2 Size: ${this.extranonce2_size}`);
        this.authorize();
        return;
      }

      // Authorization response
      if (msg.result === true) {
        Logger.info(`Authorized successfully as ${this.config.workerName}`);
        return;
      }
      return;
    }

    // Notification from the pool
    if (msg.method === 'mining.set_difficulty') {
      this.difficulty = msg.params[0];
      Logger.info(`Difficulty set to ${this.difficulty}`);
    } else if (msg.method === 'mining.notify') {
      Logger.info(`Received new job: ${msg.params[0]}`);

      const job = {
        jobId: msg.params[0],
        prevhash: msg.params[1],
        coinb1: msg.params[2],
        coinb2: msg.params[3],
        merkle_branch: msg.params[4],
        version: msg.params[5],
        nbits: msg.params[6],
        ntime: msg.params[7],
        clean_jobs: msg.params[8],
        extranonce1: this.extranonce1,
        extranonce2_size: this.extranonce2_size,
      };

      this.emit('job', job, this.difficulty);
    }
  }
}
