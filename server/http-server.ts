import http from 'http';
import fs from 'fs';
import path from 'path';
import type { Miner } from '../mining/miner.ts';
import type { StratumClient } from '../mining/stratum-client.ts';
import type { Config, MinerStats } from '../lib/types.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.svg': 'image/svg+xml'
};

interface VersionInfo {
  version: string;
  date: string;
  changes: string[];
}

/**
 * Past releases are snapshotted into releases/<version>/ by
 * scripts/snapshot-release.mjs. Serving them from disk (rather than reading
 * a git tag) keeps the history working on a host that only has the deployed
 * files, and avoids having to rebuild old TypeScript on demand.
 */
function listReleases(releasesDir: string): string[] {
  try {
    return fs.readdirSync(releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

interface CreateHttpServerOptions {
  miner: Miner;
  stratum: StratumClient;
  config: Config;
  publicDir: string;
  versionInfo: VersionInfo;
  releasesDir: string;
}

/**
 * Creates the HTTP server: serves the browser dashboard from `publicDir`,
 * exposes a small REST API to control the miner, and streams live stats
 * over Server-Sent Events at /api/events.
 */
export function createHttpServer({ miner, stratum, config, publicDir, versionInfo, releasesDir }: CreateHttpServerOptions) {
  const sseClients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    if (req.url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        // Reverse proxies (nginx and most PaaS routers) buffer responses by
        // default, which holds the stream back until the buffer fills and
        // can surface as a dead or 502'd stream behind a proxy.
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*'
      });
      // Tell EventSource to back off a little before reconnecting, so a
      // proxy hiccup doesn't turn into a reconnect storm.
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.url === '/api/versions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ current: versionInfo.version, versions: listReleases(releasesDir) }));
      return;
    }

    // /v/<version>/<file> serves a snapshotted release of the dashboard.
    if (req.url && req.url.startsWith('/v/')) {
      const rest = decodeURIComponent(req.url.slice(3).split('?')[0]);
      const slash = rest.indexOf('/');
      const version = slash === -1 ? rest : rest.slice(0, slash);
      const file = slash === -1 || !rest.slice(slash + 1) ? 'index.html' : rest.slice(slash + 1);

      // Only ever serve a version that really exists as a snapshot, so a
      // crafted path cannot walk out of the releases directory.
      if (!listReleases(releasesDir).includes(version)) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(`Unknown release "${version}"`);
        return;
      }
      serveStaticFile(req, res, path.join(releasesDir, version), file);
      return;
    }

    if (req.url === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(versionInfo));
      return;
    }

    if (req.url === '/api/strategy' && req.method === 'POST') {
      return readJsonBody(req, res, (payload: any) => {
        const method = parseInt(payload.method, 10);
        const customNonce = parseInt(payload.customNonce, 10) || 0;
        if (isNaN(method) || method < 0 || method > 12) {
          throw new Error('Invalid method');
        }
        miner.setStrategy(method, customNonce);
        return { success: true, method, customNonce };
      });
    }

    if (req.url === '/api/pool' && req.method === 'POST') {
      return readJsonBody(req, res, (payload: any) => {
        const { host, protocol } = payload;
        const port = parseInt(payload.port, 10);
        if (!host || !port) throw new Error('Invalid config');

        // Validate before touching `config`: this used to assign the new
        // host/port/protocol first and only then reject SV2, which left the
        // live config permanently switched to an unsupported protocol (and
        // the pool host overwritten) without ever reconnecting.
        if (protocol === 'SV2') {
          throw new Error('Stratum V2 is not implemented yet');
        }

        // The dashboard re-sends the stored pool settings on every page
        // load, so reconnecting unconditionally tore down the pool session
        // (new extranonce1, lost job) every time anyone opened or refreshed
        // the page. Only reconnect when something actually changed.
        const unchanged = config.poolHost === host
          && config.poolPort === port
          && (!protocol || config.protocol === protocol);
        if (unchanged) {
          return { success: true, host, port, protocol, reconnected: false };
        }

        config.poolHost = host;
        config.poolPort = port;
        if (protocol) config.protocol = protocol;

        miner.stop();
        stratum.client.destroy();
        stratum.config = config;
        stratum.connect();

        return { success: true, host, port, protocol, reconnected: true };
      });
    }

    if (req.url === '/api/worker' && req.method === 'POST') {
      return readJsonBody(req, res, (payload: any) => {
        const address = String(payload.address || '').trim();
        // Deliberately loose: pools accept a worker suffix (addr.worker1) and
        // this miner should not be the thing that rejects a valid address
        // format it has not heard of. Just rule out obvious nonsense.
        if (address.length < 14 || address.length > 120 || /\s/.test(address)) {
          throw new Error('That does not look like a Bitcoin address');
        }

        if (config.workerName === address) {
          return { success: true, address, reconnected: false };
        }

        // The pool ties the payout address to the authorised session, so a
        // new address only takes effect on a fresh connection.
        config.workerName = address;
        miner.stop();
        stratum.client.destroy();
        stratum.config = config;
        stratum.connect();
        return { success: true, address, reconnected: true };
      });
    }

    if (req.url === '/api/threads' && req.method === 'POST') {
      return readJsonBody(req, res, (payload: any) => {
        if (payload.threads) {
          config.threads = payload.threads;
          miner.setThreads(payload.threads);
        }
        return { status: 'ok', threads: config.threads };
      });
    }

    if (req.url === '/api/miner-toggle' && req.method === 'POST') {
      return readJsonBody(req, res, (payload: any) => {
        if (payload.state === 'stop') {
          miner.stop();
        } else {
          miner.start();
        }
        return { state: payload.state, isMining: miner.isMining };
      });
    }

    serveStaticFile(req, res, publicDir);
  });

  function broadcastStats(stats: MinerStats): void {
    const data = `data: ${JSON.stringify(stats)}\n\n`;
    for (const client of sseClients) client.write(data);
  }

  return { server, broadcastStats };
}

function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: (payload: any) => unknown
): void {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const result = handler(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message || 'Invalid request' }));
    }
  });
}

function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse, publicDir: string, explicitPath?: string): void {
  const urlPath = explicitPath !== undefined
    ? explicitPath
    : (req.url === '/' ? 'index.html' : decodeURIComponent((req.url || '').split('?')[0]));
  const filePath = path.normalize(path.join(publicDir, urlPath));

  // Keep requests confined to publicDir (blocks '../' traversal)
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('404 Not Found', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content, 'utf-8');
  });
}
