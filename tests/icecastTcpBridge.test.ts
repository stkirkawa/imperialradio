import { createServer as createHttpServer } from 'node:http';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createIcecastTcpBridge } from '../src/services/icecastTcpBridge.service.js';

describe('Icecast raw TCP bridge', () => {
  let bridge: ReturnType<typeof createIcecastTcpBridge> | undefined;
  let target: ReturnType<typeof createHttpServer> | undefined;

  afterEach(async () => {
    await Promise.all([bridge, target].filter(Boolean).map((server) => new Promise<void>((resolve) => {
      server!.close(() => resolve());
    })));
    bridge = undefined;
    target = undefined;
  });

  it('frames an unbounded Icecast source body for the local HTTP ingress', async () => {
    const received = new Promise<{ method: string; authorization: string; body: Buffer }>((resolve) => {
      target = createHttpServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          resolve({
            method: request.method || '',
            authorization: request.headers.authorization || '',
            body: Buffer.concat(chunks)
          });
          response.writeHead(200);
          response.end('accepted');
        });
      });
    });

    await new Promise<void>((resolve) => target!.listen(0, '127.0.0.1', resolve));
    const targetPort = (target!.address() as { port: number }).port;
    bridge = createIcecastTcpBridge('127.0.0.1', targetPort);
    await new Promise<void>((resolve) => bridge!.listen(0, '127.0.0.1', resolve));
    const bridgePort = (bridge.address() as { port: number }).port;

    const clientResponse = new Promise<string>((resolve, reject) => {
      const client = createConnection({ host: '127.0.0.1', port: bridgePort });
      const response: Buffer[] = [];
      client.on('data', (chunk) => response.push(chunk));
      client.on('end', () => resolve(Buffer.concat(response).toString('latin1')));
      client.on('error', reject);
      client.on('connect', () => {
        client.write([
          'SOURCE /dj-test HTTP/1.0',
          'Authorization: Basic c291cmNlOnRlc3Q=',
          'Content-Type: audio/mpeg',
          '',
          ''
        ].join('\r\n'));
        client.end(Buffer.from([0xff, 0xfb, 0x90, 0x64]));
      });
    });

    await expect(received).resolves.toEqual({
      method: 'SOURCE',
      authorization: 'Basic c291cmNlOnRlc3Q=',
      body: Buffer.from([0xff, 0xfb, 0x90, 0x64])
    });
    await expect(clientResponse).resolves.toContain('accepted');
  });
});
