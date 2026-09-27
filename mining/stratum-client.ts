import net from 'net';
import { EventEmitter } from 'events';
import { Logger } from '../lib/logger.ts';
import type { Config, MiningJob } from '../lib/types.ts';

interface StratumResponse {
  id: number | null;
  result?: unknown;
  error?: unknown;
}

interface StratumNotification {
  id: null;
  method: string;
  params: unknown[];
}

type StratumMessage = StratumResponse | StratumNotification;

/**
 * A minimal Stratum V1 client: connects over TCP, subscribes, authorizes,
 * and emits 'job' events as the pool streams in mining.notify messages.
 */
export class StratumClient extends EventEmitter {
  config: Config;
  client: net.Socket;
  msgId: number;
  buffer: string;
  extranonce1: string | null;
  extranonce2_size: number | null;
  difficulty: number | null;

  constructor(config: Config) {
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

  _setupEventHandlers(): void {
    this.client.on('connect', () => {
      Logger.info(`Connected to pool ${this.config.poolHost}:${this.config.poolPort}`);
      this.emit('connected');
      this.subscribe();
    });

    this.client.on('data', (data: Buffer) => {
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
            Logger.error(`Failed to parse pool message: ${(e as Error).message} - ${line}`);
          }
        }
      }
    });

    this.client.on('close', () => {
      Logger.warn('Connection to pool closed');
      this.emit('disconnected');
    });

    this.client.on('error', (err: Error) => {
      Logger.error(`Pool connection error: ${err.message}`);
    });
  }

  connect(): void {
    Logger.info(`Connecting to ${this.config.poolHost}:${this.config.poolPort}...`);
    this.client.connect(this.config.poolPort, this.config.poolHost);
  }

  send(method: string, params: unknown[] = []): void {
    const msg = { id: this.msgId++, method, params };
    this.client.write(JSON.stringify(msg) + '\n');
  }

  subscribe(): void {
    Logger.info('Sending mining.subscribe...');
    this.send('mining.subscribe', ['NodeJsMiner/1.0.0']);
  }

  authorize(): void {
    Logger.info(`Sending mining.authorize for ${this.config.workerName}...`);
    this.send('mining.authorize', [this.config.workerName, this.config.workerPassword]);
  }

  submit(jobId: string, extranonce2: string, ntime: string, nonce: string): void {
    Logger.info(`Submitting share for job ${jobId} (nonce: ${nonce})`);
    this.send('mining.submit', [this.config.workerName, jobId, extranonce2, ntime, nonce]);
  }

  _handleMessage(msg: StratumMessage): void {
    if (msg.id !== null) {
      const response = msg as StratumResponse;

      // Response to a request we sent
      if (response.error) {
        Logger.error(`Pool error: ${JSON.stringify(response.error)}`);
        return;
      }

      // Subscription response: [ [...], extranonce1, extranonce2_size ]
      if (Array.isArray(response.result) && response.result.length === 3) {
        Logger.info('Subscribed!');
        this.extranonce1 = response.result[1];
        this.extranonce2_size = response.result[2];
        Logger.info(`Extranonce1: ${this.extranonce1}, Extranonce2 Size: ${this.extranonce2_size}`);
        this.authorize();
        return;
      }

      // Authorization response
      if (response.result === true) {
        Logger.info(`Authorized successfully as ${this.config.workerName}`);
        return;
      }
      return;
    }

    const notification = msg as StratumNotification;

    // Notification from the pool
    if (notification.method === 'mining.set_difficulty') {
      this.difficulty = notification.params[0] as number;
      Logger.info(`Difficulty set to ${this.difficulty}`);
    } else if (notification.method === 'mining.notify') {
      const p = notification.params;
      Logger.info(`Received new job: ${p[0]}`);

      const job: MiningJob = {
        jobId: p[0] as string,
        prevhash: p[1] as string,
        coinb1: p[2] as string,
        coinb2: p[3] as string,
        merkle_branch: p[4] as string[],
        version: p[5] as string,
        nbits: p[6] as string,
        ntime: p[7] as string,
        clean_jobs: p[8] as boolean,
        extranonce1: this.extranonce1 as string,
        extranonce2_size: this.extranonce2_size as number,
      };

      this.emit('job', job, this.difficulty);
    }
  }
}
