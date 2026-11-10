import { createServer, createConnection, type Server, type Socket } from 'node:net';

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;

function findHeaderEnd(buffer: Buffer): number {
  return buffer.indexOf('\r\n\r\n');
}

function parseRequestHeader(header: Buffer): { requestLine: string; headers: Map<string, string> } | null {
  const lines = header.toString('latin1').split('\r\n');
  const requestLine = lines.shift();
  if (!requestLine || !/^(SOURCE|PUT|POST)\s+\S+\s+HTTP\/\d\.\d$/.test(requestLine)) return null;

  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) return null;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return { requestLine, headers };
}

function encodeChunk(chunk: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${chunk.length.toString(16)}\r\n`, 'ascii'),
    chunk,
    Buffer.from('\r\n', 'ascii')
  ]);
}

function handleConnection(client: Socket, targetHost: string, targetPort: number): void {
  let headerBuffer = Buffer.alloc(0);
  let initialBody = Buffer.alloc(0);
  let pendingBytes = 0;
  const pendingBody: Buffer[] = [];
  let backend: Socket | null = null;
  let backendReady = false;
  let clientEnded = false;
  let requestStarted = false;
  let chunkedBridge = false;

  const closeBoth = () => {
    client.destroy();
    backend?.destroy();
  };

  const forwardBody = (chunk: Buffer) => {
    if (!backend || !chunk.length) return;
    backend.write(chunkedBridge ? encodeChunk(chunk) : chunk);
  };

  client.on('data', (chunk) => {
    if (requestStarted) {
      if (!backendReady) {
        pendingBytes += chunk.length;
        if (pendingBytes > MAX_PENDING_BYTES) {
          closeBoth();
          return;
        }
        pendingBody.push(chunk);
        return;
      }
      forwardBody(chunk);
      return;
    }

    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    const headerEnd = findHeaderEnd(headerBuffer);
    if (headerEnd < 0) {
      if (headerBuffer.length > MAX_HEADER_BYTES) closeBoth();
      return;
    }
    if (headerEnd > MAX_HEADER_BYTES) {
      closeBoth();
      return;
    }

    const parsed = parseRequestHeader(headerBuffer.subarray(0, headerEnd));
    if (!parsed) {
      closeBoth();
      return;
    }

    const contentLength = parsed.headers.get('content-length');
    const transferEncoding = parsed.headers.get('transfer-encoding')?.toLowerCase();
    if (contentLength && transferEncoding) {
      closeBoth();
      return;
    }
    if (contentLength && !/^\d+$/.test(contentLength)) {
      closeBoth();
      return;
    }

    requestStarted = true;
    initialBody = headerBuffer.subarray(headerEnd + 4);
    chunkedBridge = !contentLength && !transferEncoding;
    client.pause();

    const forwardedHeaders = new Map<string, string>([['host', `${targetHost}:${targetPort}`]]);
    for (const headerName of ['authorization', 'content-type', 'icy-metadata', 'user-agent', 'expect']) {
      const value = parsed.headers.get(headerName);
      if (value) forwardedHeaders.set(headerName, value);
    }
    if (contentLength) forwardedHeaders.set('content-length', contentLength);
    else forwardedHeaders.set('transfer-encoding', transferEncoding || 'chunked');
    forwardedHeaders.set('connection', 'close');

    backend = createConnection({ host: targetHost, port: targetPort });
    backend.on('connect', () => {
      const headers = [...forwardedHeaders].map(([name, value]) => `${name}: ${value}`);
      backend!.write(`${parsed.requestLine.replace(/HTTP\/\d\.\d$/, 'HTTP/1.1')}\r\n${headers.join('\r\n')}\r\n\r\n`);
      backendReady = true;
      forwardBody(initialBody);
      initialBody = Buffer.alloc(0);
      for (const pending of pendingBody) forwardBody(pending);
      pendingBody.length = 0;
      pendingBytes = 0;
      if (clientEnded) {
        if (chunkedBridge) backend!.write('0\r\n\r\n');
        backend!.end();
      } else {
        client.resume();
      }
    });
    backend.on('data', (response) => client.write(response));
    backend.on('error', () => client.destroy());
    backend.on('close', () => {
      if (!client.destroyed) client.end();
    });
    client.on('error', () => backend?.destroy());
    client.on('end', () => {
      if (!backend || backend.destroyed) return;
      clientEnded = true;
      if (!backendReady) return;
      if (chunkedBridge) backend.write('0\r\n\r\n');
      backend.end();
    });
  });

  client.on('error', () => backend?.destroy());
  client.on('close', () => backend?.destroy());
}

export function createIcecastTcpBridge(targetHost: string, targetPort: number): Server {
  return createServer({ allowHalfOpen: true }, (client) => handleConnection(client, targetHost, targetPort));
}
