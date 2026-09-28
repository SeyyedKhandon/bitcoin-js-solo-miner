/** The subset of a Stratum job the browser miners need. */
export interface BrowserJob {
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
  target?: string;
}

declare global {
  interface Window {
    startBrowserMining: () => void;
    stopBrowserMining: () => void;
    setBrowserWorkerCount: (count: number) => void;
    getBrowserWorkerCount: () => number;
    startWebGPUMining: () => Promise<void>;
    setWebGPUIntensity: (pct: number) => void;
    stopWebGPUMining: () => void;
  }

  // TypeScript's bundled DOM lib includes the WebGPU interface types
  // (GPUDevice, GPUBuffer, etc.) but not these runtime flag/enum objects -
  // declare just the ones this project actually uses.
  const GPUBufferUsage: {
    MAP_READ: number;
    MAP_WRITE: number;
    COPY_SRC: number;
    COPY_DST: number;
    INDEX: number;
    VERTEX: number;
    UNIFORM: number;
    STORAGE: number;
    INDIRECT: number;
    QUERY_RESOLVE: number;
  };

  const GPUMapMode: {
    READ: number;
    WRITE: number;
  };
}
