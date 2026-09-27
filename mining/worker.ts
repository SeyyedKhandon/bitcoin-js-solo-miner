import { parentPort } from 'worker_threads';
import crypto from 'crypto';
import { doubleSha256, doubleSha256Pair } from '../lib/hash.js';
import { MiningMethod, getRandomNonceFromList } from './strategies.js';
import type { MiningJob, WorkerInboundMessage, WorkerStartPayload } from '../lib/types.js';

if (!parentPort) {
  throw new Error('mining/worker.ts must be run as a worker_threads Worker');
}
const port = parentPort;

interface WorkerState extends Omit<WorkerStartPayload, 'job'> {
  isMining: boolean;
  job: MiningJob | null;
}

let state: WorkerState = {
  isMining: false,
  job: null,
  target: '',
  activeMethod: 0,
  allModeIndex: 0,
  customNonce: 0,
  extranonce2Counter: 0,
  workerId: 0,
  totalThreads: 1
};

function getExtranonce2(method: number): string {
  const size = state.job!.extranonce2_size;
  const en2Buf = Buffer.allocUnsafe(size);
  en2Buf.fill(0);

  if (method === MiningMethod.RANDOM_EN2) {
    return crypto.randomBytes(size).toString('hex');
  }

  if (method === MiningMethod.EN2_BIGENDIAN) {
    en2Buf.writeUInt32BE(state.extranonce2Counter, 0);
    return en2Buf.toString('hex');
  }

  en2Buf.writeUInt32BE(state.extranonce2Counter, size - 4);

  if (method === MiningMethod.RANDOM_EN2_RIGHT) {
    crypto.randomFillSync(en2Buf, size - 4, 4);
  } else if (method === MiningMethod.RANDOM_EN2_MIDDLE) {
    const mid = Math.floor(size / 2);
    crypto.randomFillSync(en2Buf, mid > 2 ? mid - 2 : 0, Math.min(4, size));
  }

  return en2Buf.toString('hex');
}

function calculateMerkleRoot(extranonce2: string): string {
  const { coinb1, extranonce1, coinb2, merkle_branch } = state.job!;
  const coinbase = coinb1 + extranonce1 + extranonce2 + coinb2;
  let hash = doubleSha256(Buffer.from(coinbase, 'hex')).toString('hex');
  for (const branch of merkle_branch) {
    hash = doubleSha256Pair(hash, branch);
  }
  return hash;
}

const RANDOM_METHODS: number[] = [
  MiningMethod.RANDOMIZED, MiningMethod.RANDOM_INVERTED,
  MiningMethod.GOLDEN_RATIO, MiningMethod.RANDOM_EN2,
  MiningMethod.RANDOM_EN2_RIGHT, MiningMethod.RANDOM_EN2_MIDDLE,
  MiningMethod.LIST_NONCES
];

let currentNonce = 0;

function mineChunk(): void {
  if (!state.isMining || !state.job) return;

  const CHUNK_SIZE = 5000;
  const appliedMethod = state.activeMethod === MiningMethod.ALL_MODE ? state.allModeIndex : state.activeMethod;

  const extranonce2 = getExtranonce2(appliedMethod);
  const merkleRoot = calculateMerkleRoot(extranonce2);
  let { version, prevhash, ntime, nbits } = state.job;

  if (appliedMethod === MiningMethod.INVERTED_VERSION || appliedMethod === MiningMethod.RANDOM_INVERTED) {
    const verBuf = Buffer.from(version, 'hex');
    for (let i = 0; i < verBuf.length; i++) verBuf[i] = ~verBuf[i];
    version = verBuf.toString('hex');
  }

  const baseHeaderHex = version + prevhash + merkleRoot + ntime + nbits;
  const baseHeaderBuf = Buffer.from(baseHeaderHex, 'hex');

  // Divide the nonce space evenly across worker threads
  const chunkSpace = Math.floor(0xFFFFFFFF / state.totalThreads);
  const startNonce = state.workerId * chunkSpace;

  let nonce = 0;
  switch (appliedMethod) {
    case MiningMethod.TOP_DOWN:
      nonce = 0x00E00000 + startNonce;
      break;
    case MiningMethod.RANDOMIZED:
    case MiningMethod.RANDOM_INVERTED:
      nonce = startNonce + Math.floor(Math.random() * chunkSpace);
      break;
    case MiningMethod.GOLDEN_RATIO: {
      const phiPrime = 0x9E3779B9;
      const trueEntropy = crypto.randomBytes(4).readUInt32BE(0);
      const timeEntropy = Date.now() & 0xFFFFFFFF;
      const seeded = ((trueEntropy * phiPrime) ^ timeEntropy) >>> 0;
      nonce = startNonce + (seeded % chunkSpace);
      break;
    }
    case MiningMethod.CUSTOM_NONCE:
      nonce = state.customNonce >>> 0;
      break;
    case MiningMethod.LIST_NONCES:
      nonce = getRandomNonceFromList();
      break;
    default:
      nonce = startNonce;
      break;
  }

  const isRandomMethod = RANDOM_METHODS.includes(appliedMethod);
  if (currentNonce > 0 && !isRandomMethod) nonce = currentNonce;

  // Block headers are stored little-endian; byte-swap each 4-byte field
  for (let i = 0; i < baseHeaderBuf.length; i += 4) {
    let tmp = baseHeaderBuf[i];
    baseHeaderBuf[i] = baseHeaderBuf[i + 3];
    baseHeaderBuf[i + 3] = tmp;
    tmp = baseHeaderBuf[i + 1];
    baseHeaderBuf[i + 1] = baseHeaderBuf[i + 2];
    baseHeaderBuf[i + 2] = tmp;
  }

  const header = Buffer.allocUnsafe(80);
  baseHeaderBuf.copy(header, 0);

  const targetBigInt = BigInt(`0x${state.target}`);
  const unboundedMethods: number[] = [MiningMethod.CUSTOM_NONCE, MiningMethod.LIST_NONCES];
  const isBounded = !unboundedMethods.includes(appliedMethod);

  let hashesDone = 0;

  for (let i = 0; i < CHUNK_SIZE; i++) {
    if ((isBounded && nonce > startNonce + chunkSpace) || nonce > 0xFFFFFFFF) {
      state.extranonce2Counter++;
      currentNonce = 0;
      port.postMessage({ type: 'hashrate', count: hashesDone, latestHash: doubleSha256(header).reverse().toString('hex') });
      setImmediate(mineChunk);
      return;
    }

    header.writeUInt32LE(nonce, 76);
    const hashResult = doubleSha256(header);

    // Hash is little-endian; reverse to get the conventional display order
    const hashHex = hashResult.reverse().toString('hex');
    const hashBigInt = BigInt(`0x${hashHex}`);

    if (hashBigInt <= targetBigInt) {
      const nonceBuffer = Buffer.allocUnsafe(4);
      nonceBuffer.writeUInt32BE(nonce, 0); // Pool wants big-endian
      port.postMessage({
        type: 'share',
        shareInfo: {
          jobId: state.job.jobId,
          extranonce2,
          ntime: state.job.ntime,
          nonce: nonceBuffer.toString('hex'),
          hash: hashHex
        }
      });
    }

    if (appliedMethod !== MiningMethod.LIST_NONCES) nonce++;
    hashesDone++;
  }

  currentNonce = nonce;

  const nonceBuffer = Buffer.allocUnsafe(4);
  nonceBuffer.writeUInt32BE(nonce >>> 0, 0);

  port.postMessage({
    type: 'hashrate',
    count: hashesDone,
    latestHash: doubleSha256(header).reverse().toString('hex'),
    version: state.job.version,
    en1: state.job.extranonce1,
    en2: extranonce2,
    nonce: nonceBuffer.toString('hex')
  });

  if (state.isMining) setImmediate(mineChunk);
}

port.on('message', (msg: WorkerInboundMessage) => {
  if (msg.type === 'start') {
    const wasMining = state.isMining;
    state = { ...state, ...msg.payload, isMining: true };
    currentNonce = 0;
    if (!wasMining) mineChunk();
  } else if (msg.type === 'stop') {
    state.isMining = false;
  }
});
