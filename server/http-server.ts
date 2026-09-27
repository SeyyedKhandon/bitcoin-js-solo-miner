import http from 'http';
import fs from 'fs';
import path from 'path';
import type { Miner } from '../mining/miner.js';
import type { StratumClient } from '../mining/stratum-client.js';
import type { Config, MinerStats } from '../lib/types.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.svg': 'image/svg+xml'
};

interface CreateHttpServerOptions {
  miner: Miner;
  stratum: StratumClient;
  config: Config;
  publicDir: string;
}

/**
 * Creates the HTTP server: serves the browser dashboard from `publicDir`,
 * exposes a small REST API to control the miner, and streams live stats
 * over Server-Sent Events at /api/events.
 */
export function createHttpServer({ miner, stratum, config, publicDir }: CreateHttpServerOptions) {
  const sseClients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    if (req.url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
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

        config.poolHost = host;
        config.poolPort = port;
        if (protocol) config.protocol = protocol;

        if (config.protocol === 'SV2') {
          throw new Error('Stratum V2 is not implemented yet');
        }

        miner.stop();
        stratum.client.destroy();
        stratum.config = config;
        stratum.connect();

        return { success: true, host, port, protocol };
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

function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse, publicDir: string): void {
  const urlPath = req.url === '/' ? 'index.html' : decodeURIComponent((req.url || '').split('?')[0]);
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
