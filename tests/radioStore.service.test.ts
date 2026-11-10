import { afterEach, describe, expect, it } from 'vitest';
import { RadioStore } from '../src/services/radioStore.service.js';

describe('RadioStore DJ isolation and on-air slot', () => {
  let store: RadioStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('keeps playlists private to their owner', async () => {
    store = new RadioStore(':memory:');
    await store.initialize();
    const first = await store.createDj({ username: 'first-dj', displayName: 'First', password: 'secure-password-1' });
    const second = await store.createDj({ username: 'second-dj', displayName: 'Second', password: 'secure-password-2' });
    const privatePlaylist = store.createPlaylist(first.id, 'Private set');

    expect(store.listPlaylists(first.id)).toHaveLength(1);
    expect(store.listPlaylists(second.id)).toEqual([]);
    expect(store.getPlaylist(second.id, privatePlaylist.id)).toBeNull();
  });

  it('allows only one DJ to claim the live slot at a time', async () => {
    store = new RadioStore(':memory:');
    await store.initialize();
    const first = await store.createDj({ username: 'first-dj', displayName: 'First', password: 'secure-password-1' });
    const second = await store.createDj({ username: 'second-dj', displayName: 'Second', password: 'secure-password-2' });

    const firstClaim = store.claimLive(first.id, null);
    const secondClaim = store.claimLive(second.id, null);

    expect(firstClaim.ok).toBe(true);
    expect(secondClaim.ok).toBe(false);
    if (firstClaim.ok) expect(store.releaseLive(first.id, firstClaim.leaseId)).toBe(true);
    expect(store.claimLive(second.id, null).ok).toBe(true);
  });

  it('keeps the live queue private and supports reordering and removal', async () => {
    store = new RadioStore(':memory:');
    await store.initialize();
    const first = await store.createDj({ username: 'queue-dj', displayName: 'Queue DJ', password: 'secure-password-4' });
    const second = await store.createDj({ username: 'other-queue-dj', displayName: 'Other DJ', password: 'secure-password-5' });

    store.replaceDjQueue(first.id, ['first.mp3', 'second.mp3', 'third.mp3']);
    expect(store.listDjQueue(second.id)).toEqual([]);
    expect(store.moveDjQueueTrack(first.id, 2, 0)).toEqual(['third.mp3', 'first.mp3', 'second.mp3']);
    expect(store.removeDjQueueTrack(first.id, 1)).toEqual(['third.mp3', 'second.mp3']);
    expect(store.removeDjQueueTrack(first.id, 4)).toBeNull();
    store.consumeDjQueueThrough(first.id, 'third.mp3');
    expect(store.listDjQueue(first.id)).toEqual(['second.mp3']);
  });

  it('stores microphone and volume controls only for the DJ holding the live slot', async () => {
    store = new RadioStore(':memory:');
    await store.initialize();
    const first = await store.createDj({ username: 'mix-dj', displayName: 'Mix DJ', password: 'secure-password-6' });
    const second = await store.createDj({ username: 'other-mix-dj', displayName: 'Other Mix DJ', password: 'secure-password-7' });

    expect(store.claimLive(first.id, null).ok).toBe(true);
    expect(store.setMicrophonePath(second.id, 'dj-microphone-path-123456')).toBe(false);
    expect(store.setMicrophonePath(first.id, 'dj-microphone-path-123456')).toBe(true);
    expect(store.getOnAir()?.microphoneEnabled).toBe(true);
    expect(store.setLiveVolume(first.id, 65)).toBe(true);
    expect(store.getOnAir()?.volume).toBe(65);
    expect(store.clearMicrophone(first.id)).toBe('dj-microphone-path-123456');
    expect(store.getOnAir()?.microphoneEnabled).toBe(false);
  });

  it('invalidates a DJ session when the account is disabled', async () => {
    store = new RadioStore(':memory:');
    await store.initialize();
    const dj = await store.createDj({ username: 'session-dj', displayName: 'Session DJ', password: 'secure-password-3' });
    const token = store.createSession(dj.id, 60_000);

    expect(store.getSessionUser(token)?.id).toBe(dj.id);
    await store.updateDj(dj.id, { active: false });
    expect(store.getSessionUser(token)).toBeNull();
  });

  it('invalidates the previous broadcast credentials when the media path is rotated', async () => {
    store = new RadioStore(':memory:');
    await store.initialize();
    const dj = await store.createDj({ username: 'broadcast-dj', displayName: 'Broadcast DJ', password: 'secure-password-8' });
    expect(store.claimLive(dj.id, null, 'icecast', 'dj-old-media-path-123456').ok).toBe(true);
    store.setBroadcastToken(dj.id, 'old-token');

    expect(store.verifyLiveBroadcastToken('old-token')?.id).toBe(dj.id);
    expect(store.setLiveMediaPath(dj.id, 'dj-new-media-path-123456')).toBe(true);
    store.setBroadcastToken(dj.id, 'new-token');

    expect(store.verifyLiveBroadcastToken('old-token')).toBeNull();
    expect(store.verifyLiveBroadcastToken('new-token')?.id).toBe(dj.id);
  });
});
