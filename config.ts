import type { Config } from './lib/types.ts';

export const config: Config = {
  // Pool settings
  poolHost: "eusolo.ckpool.org",
  poolPort: 3333,
  protocol: "SV1",

  // Miner credentials
  // This is a donation address, used only for testing solo mining.
  workerName: "bc1q46yjwqmfr24jcuyhpn4ytw43jg574vrgas0nms",
  workerPassword: "x",

  // Logging configuration
  logLevel: "info", // 'debug', 'info', 'warn', or 'error'

  // Mining strategy (see mining/strategies.ts for the full list)
  miningMethod: 0, // 0 = ALL_MODE (cycles through every strategy)
  customNonce: 0,
  threads: 1,
};
