import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/icecast.service.js', () => ({
  fetchNowPlaying: vi.fn(() => {
    throw new Error('fail');
  })
}));

const { buildApp } = await import('../src/app.js');

describe('GET /api/nowplaying', () => {
  it('returns fallback JSON on error', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/nowplaying' });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data).toHaveProperty('station');
    expect(data).toHaveProperty('title');
    expect(data).toHaveProperty('listeners');
    await app.close();
  });
});
