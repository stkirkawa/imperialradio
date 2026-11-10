import { createServer, type Server } from 'node:http';
import { createConnection, type Server as TcpServer, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import { getRadioStore } from './radioStore.service.js';
import { createIcecastTcpBridge } from './icecastTcpBridge.service.js';

const activeRequests = new Map<string, Set<Socket>>();
const activeRawConnections = new Set<Socket>();
let server: Server | null = null;
let rawServer: TcpServer | null = null;
let logger: FastifyBaseLogger | null = null;

function respondUnauthorized(response: import('node:http').ServerResponse): void {
  response.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Imperial Radio DJ source"',
    'Content-Length': '0',
    Connection: 'close'
  });
  response.end();
}

function registerRequest(mediaPath: string, upstream: Socket): void {
  const requests = activeRequests.get(mediaPath) ?? new Set<Socket>();
  requests.add(upstream);
  activeRequests.set(mediaPath, requests);
  upstream.once('close', () => {
    requests.delete(upstream);
    if (requests.size === 0) activeRequests.delete(mediaPath);
  });
}

function handleSource(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void {
  const mediaPath = new URL(request.url || '/', 'http://localhost').pathname.replace(/^\/+|\/+$/g, '');
  if (!/^dj-[A-Za-z0-9_-]{20,64}$/.test(mediaPath) || !['SOURCE', 'PUT', 'POST'].includes(request.method || '')) {
    response.writeHead(404, { Connection: 'close' });
    response.end();
    return;
  }

  const authorization = request.headers.authorization || '';
  const [scheme, encoded] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !encoded) {
    respondUnauthorized(response);
    return;
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0 || decoded.slice(0, separator) !== 'source') {
    respondUnauthorized(response);
    return;
  }

  const token = decoded.slice(separator + 1);
  const dj = getRadioStore().verifyLiveBroadcastToken(token);
  const onAir = dj ? getRadioStore().getOnAir() : null;
  if (!dj || !onAir || onAir.sourceMode !== 'icecast' || onAir.mediaPath !== mediaPath) {
    respondUnauthorized(response);
    return;
  }

  const upstream = createConnection({ host: '127.0.0.1', port: 8005 });
  let transcoder: ChildProcess | null = null;
  let stopping = false;
  let stderr = '';
  const stopTranscoder = () => {
    stopping = true;
    if (transcoder && transcoder.exitCode === null && !transcoder.killed) {
      transcoder.kill();
    }
  };
  registerRequest(mediaPath, upstream);
  upstream.setTimeout(10000, () => {
    upstream.destroy(new Error('Liquidsoap harbor response timed out'));
  });
  upstream.once('connect', () => {
    const internalAuthorization = Buffer.from(`source:${env.LIVE_INGRESS_PASSWORD}`).toString('base64');
    const headers = [
      'SOURCE /dj-live HTTP/1.0',
      `Authorization: Basic ${internalAuthorization}`,
      `Content-Type: ${request.headers['content-type'] || 'audio/mpeg'}`,
      'User-Agent: Imperial Radio source relay'
    ];
    if (request.headers['icy-metadata']) headers.push(`icy-metadata: ${request.headers['icy-metadata']}`);
    upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
  });
  upstream.once('data', function handleHarborResponse(data) {
    const headerEnd = data.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      upstream.destroy(new Error('Invalid response from Liquidsoap harbor'));
      return;
    }

    const lines = data.subarray(0, headerEnd).toString('latin1').split('\r\n');
    const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(lines[0] || '');
    if (!status) {
      upstream.destroy(new Error('Invalid status from Liquidsoap harbor'));
      return;
    }
    const statusCode = Number(status[1]);
    if (statusCode < 200 || statusCode >= 300) {
      response.writeHead(statusCode, { Connection: 'close' });
      response.end();
      upstream.destroy();
      return;
    }

    const responseHeaders: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(':');
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim().toLowerCase();
      if (['connection', 'content-length', 'transfer-encoding'].includes(name)) continue;
      responseHeaders[name] = line.slice(separator + 1).trim();
    }

    const child = spawn(env.FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-i', 'pipe:0',
      '-map', '0:a:0',
      '-vn',
      '-ac', '2',
      '-ar', '44100',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      '-f', 'mp3',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    transcoder = child;

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2048);
    });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && !stopping) {
        logger?.error({ err: error, mediaPath }, 'FFmpeg DJ input failed');
      }
    });
    child.once('error', (error) => {
      logger?.error({ err: error, mediaPath }, 'Unable to start FFmpeg DJ input normalizer');
      stopTranscoder();
      upstream.destroy();
      if (!response.headersSent) response.writeHead(502, { Connection: 'close' });
      response.end();
    });
    child.once('exit', (code, signal) => {
      if (code !== 0 && !stopping) {
        logger?.error({
          mediaPath,
          exitCode: code,
          signal,
          contentType: request.headers['content-type'] || null,
          transferEncoding: request.headers['transfer-encoding'] || null,
          icyMetadata: request.headers['icy-metadata'] || null,
          detail: stderr.trim()
        }, 'FFmpeg could not decode the DJ audio input');
        request.destroy();
        upstream.destroy();
        if (!response.writableEnded) response.end();
      }
    });
    child.once('spawn', () => {
      if (upstream.destroyed || request.aborted) {
        stopTranscoder();
        return;
      }

      const input = child.stdin;
      const output = child.stdout;
      if (!input || !output) {
        logger?.error({ mediaPath }, 'FFmpeg DJ input streams are unavailable');
        stopTranscoder();
        upstream.destroy();
        if (!response.headersSent) response.writeHead(502, { Connection: 'close' });
        response.end();
        return;
      }

      response.writeHead(statusCode, responseHeaders);
      const initialAudio = data.subarray(headerEnd + 4);
      if (initialAudio.length) response.write(initialAudio);
      upstream.setTimeout(0);
      request.pipe(input);
      output.pipe(upstream);
      upstream.pipe(response);
    });
  });
  upstream.on('error', (error) => {
    logger?.error({ err: error, mediaPath }, 'Icecast DJ source relay failed');
    stopTranscoder();
    if (!response.headersSent) response.writeHead(502, { Connection: 'close' });
    response.end();
  });
  upstream.once('close', () => {
    stopTranscoder();
    if (!response.writableEnded) response.end();
  });
  request.on('aborted', () => {
    stopTranscoder();
    upstream.destroy();
  });
  response.on('close', () => {
    stopTranscoder();
    upstream.destroy();
  });
}

export function createIcecastIngestServer(): Server {
  const instance = createServer(handleSource);
  instance.requestTimeout = 0;
  instance.headersTimeout = 60_000;
  return instance;
}

export async function startIcecastIngest(log: FastifyBaseLogger): Promise<void> {
  if (server) return;
  logger = log;
  const instance = createIcecastIngestServer();
  server = instance;
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(env.ICECAST_INGEST_PORT, env.ICECAST_INGEST_HOST, () => {
      instance.removeListener('error', reject);
      resolve();
    });
  }).catch((error: unknown) => {
    server = null;
    throw new Error(`Unable to start DJ Icecast ingress on ${env.ICECAST_INGEST_HOST}:${env.ICECAST_INGEST_PORT}`, { cause: error });
  });

  const bridge = createIcecastTcpBridge('127.0.0.1', env.ICECAST_INGEST_PORT);
  rawServer = bridge;
  bridge.on('connection', (connection) => {
    activeRawConnections.add(connection);
    connection.once('close', () => activeRawConnections.delete(connection));
  });
  await new Promise<void>((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(env.ICECAST_RAW_INGEST_PORT, env.ICECAST_RAW_INGEST_HOST, () => {
      bridge.removeListener('error', reject);
      resolve();
    });
  }).catch(async (error: unknown) => {
    rawServer = null;
    await new Promise<void>((resolve, reject) => {
      instance.close((closeError) => closeError ? reject(closeError) : resolve());
    });
    server = null;
    throw new Error(`Unable to start raw DJ Icecast ingress on ${env.ICECAST_RAW_INGEST_HOST}:${env.ICECAST_RAW_INGEST_PORT}`, { cause: error });
  });
}

export async function stopIcecastPublisher(mediaPath: string): Promise<void> {
  const requests = activeRequests.get(mediaPath);
  if (!requests) return;
  activeRequests.delete(mediaPath);
  await Promise.all([...requests].map((upstream) => new Promise<void>((resolve) => {
    if (upstream.destroyed) return resolve();
    upstream.once('close', resolve);
    upstream.destroy();
  })));
}

export async function closeIcecastIngest(): Promise<void> {
  for (const mediaPath of activeRequests.keys()) await stopIcecastPublisher(mediaPath);
  for (const connection of activeRawConnections) connection.destroy();
  activeRawConnections.clear();
  if (rawServer) {
    const instance = rawServer;
    rawServer = null;
    if (instance.listening) {
      await new Promise<void>((resolve, reject) => {
        instance.close((error) => error ? reject(error) : resolve());
      });
    }
  }
  if (!server) return;
  const instance = server;
  server = null;
  if (!instance.listening) {
    logger = null;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    instance.close((error) => error ? reject(error) : resolve());
  });
  logger = null;
}
