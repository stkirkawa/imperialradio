import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/services/icecast.service.js', () => ({
  fetchNowPlaying: vi.fn(() => {
    throw new Error('fail');
  })
}));

let app: Awaited<ReturnType<(typeof import('../src/app.js'))['buildApp']>> | undefined;
let closeRadioStore: (() => void) | undefined;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'imperialradio-nowplaying-'));
  vi.stubEnv('DATA_DIR', path.join(testDirectory, 'data'));
  vi.stubEnv('MUSIC_DIR', path.join(testDirectory, 'music'));
  vi.stubEnv('JINGLES_DIR', path.join(testDirectory, 'jingles'));
  vi.stubEnv('TMP_DIR', path.join(testDirectory, 'tmp'));
  const [{ buildApp }, { getRadioStore }] = await Promise.all([
    import('../src/app.js'),
    import('../src/services/radioStore.service.js')
  ]);
  app = await buildApp();
  closeRadioStore = () => getRadioStore().close();
});

afterAll(async () => {
  await app?.close();
  closeRadioStore?.();
  vi.unstubAllEnvs();
  await fs.rm(testDirectory, { recursive: true, force: true });
});

describe('DJ audio ingress authorization', () => {
  it('validates Icecast source tokens against the active DJ session', async () => {
    const { getRadioStore } = await import('../src/services/radioStore.service.js');
    const store = getRadioStore();
    const dj = await store.createDj({
      username: 'icecast-dj',
      displayName: 'Icecast DJ',
      password: 'secure-icecast-dj-password'
    });
    const token = 'icecast-token-for-test';
    const claim = store.claimLive(dj.id, null, 'icecast', 'dj-012345678901234567890123');
    expect(claim.ok).toBe(true);
    store.setBroadcastToken(dj.id, token);

    expect(store.verifyLiveBroadcastToken(token)?.id).toBe(dj.id);
    store.revokeBroadcastToken(dj.id);
    expect(store.verifyLiveBroadcastToken(token)).toBeNull();
    store.releaseLive(dj.id);
  });

  it('only authorizes the active DJ and protocol on the reserved path', async () => {
    const { getRadioStore } = await import('../src/services/radioStore.service.js');
    const store = getRadioStore();
    const dj = await store.createDj({
      username: 'audio-dj',
      displayName: 'Audio DJ',
      password: 'secure-audio-dj-password'
    });
    const mediaPath = 'dj-012345678901234567890123';
    const token = 'broadcast-token-for-test';
    const claim = store.claimLive(dj.id, null, 'rtmp', mediaPath);
    expect(claim.ok).toBe(true);
    store.setBroadcastToken(dj.id, token);

    const authorized = await app!.inject({
      method: 'POST',
      url: '/api/ingest/auth',
      payload: { user: dj.username, password: token, action: 'publish', path: mediaPath, protocol: 'rtmp' }
    });
    const wrongProtocol = await app!.inject({
      method: 'POST',
      url: '/api/ingest/auth',
      payload: { user: dj.username, password: token, action: 'publish', path: mediaPath, protocol: 'webrtc' }
    });
    const wrongPath = await app!.inject({
      method: 'POST',
      url: '/api/ingest/auth',
      payload: { user: dj.username, password: token, action: 'publish', path: 'dj-another-session', protocol: 'rtmp' }
    });

    expect(authorized.statusCode).toBe(200);
    expect(wrongProtocol.statusCode).toBe(401);
    expect(wrongPath.statusCode).toBe(401);
    store.revokeBroadcastToken(dj.id);
    const revoked = await app!.inject({
      method: 'POST',
      url: '/api/ingest/auth',
      payload: { user: dj.username, password: token, action: 'publish', path: mediaPath, protocol: 'rtmp' }
    });
    expect(revoked.statusCode).toBe(401);
    store.releaseLive(dj.id);
  });
});

describe('GET /api/nowplaying', () => {
  it('returns fallback JSON on error', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/nowplaying' });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data).toHaveProperty('station');
    expect(data).toHaveProperty('title');
    expect(data).toHaveProperty('listeners');
    expect(data.onAirLabel).toBe('В эфире');
  });

  it('serves the login page and redirects unauthenticated admin access', async () => {
    const login = await app!.inject({ method: 'GET', url: '/login' });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('loginForm');

    const admin = await app!.inject({ method: 'GET', url: '/admin' });
    expect(admin.statusCode).toBe(302);
    expect(admin.headers.location).toBe('/login');

    const services = await app!.inject({ method: 'GET', url: '/api/admin/services' });
    expect(services.statusCode).toBe(401);

    const restartService = await app!.inject({
      method: 'POST',
      url: '/api/admin/services/liquidsoap/restart'
    });
    expect(restartService.statusCode).toBe(401);
  });

  it('serves role-protected DJ panel pages and rejects unknown page names', async () => {
    const { getRadioStore } = await import('../src/services/radioStore.service.js');
    const dj = await getRadioStore().createDj({
      username: 'panel-nav-dj',
      displayName: 'Panel Navigation DJ',
      password: 'secure-panel-nav-password'
    });
    const token = getRadioStore().createSession(dj.id, 60_000);
    const cookie = `imperialradio_session=${encodeURIComponent(token)}`;

    const playlists = await app!.inject({
      method: 'GET',
      url: '/dj/playlists',
      headers: { cookie }
    });
    const upload = await app!.inject({
      method: 'GET',
      url: '/dj/upload',
      headers: { cookie }
    });
    const unknownPage = await app!.inject({
      method: 'GET',
      url: '/dj/unknown',
      headers: { cookie }
    });
    const wrongRole = await app!.inject({
      method: 'GET',
      url: '/admin/music',
      headers: { cookie }
    });

    expect(playlists.statusCode).toBe(200);
    expect(playlists.body).toContain('data-page="playlists"');
    expect(upload.statusCode).toBe(200);
    expect(upload.body).toContain('data-page="upload"');
    expect(unknownPage.statusCode).toBe(404);
    expect(wrongRole.statusCode).toBe(302);
    expect(wrongRole.headers.location).toBe('/dj');
  });
});
