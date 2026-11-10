import { describe, expect, it } from 'vitest';
import { createIcecastIngestServer } from '../src/services/icecastIngest.service.js';

describe('Icecast HTTP ingress', () => {
  it('allows continuous source requests without disabling the header timeout', async () => {
    const server = createIcecastIngestServer();
    expect(server.requestTimeout).toBe(0);
    expect(server.headersTimeout).toBe(60_000);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
});
