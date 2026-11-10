import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { requireRoles } from '../middleware/radioAuth.js';
import {
  clearDjQueue,
  displayTitleFromFilename,
  listMusicFiles,
  moveLiquidsoapQueueTrack,
  pushMusicToLiquidsoap,
  reconcileDjQueue,
  removeLiquidsoapQueueTrack,
  safeMusicPath,
  withDjQueueLock
} from '../services/musicLibrary.service.js';
import { getRadioStore } from '../services/radioStore.service.js';
import fsp from 'node:fs/promises';
import { env } from '../config/env.js';
import { saveUpload } from '../services/upload.service.js';
import type { MultipartFile } from '@fastify/multipart';
import { ALLOWED_MUSIC_EXTS } from '../services/musicLibrary.service.js';
import { startMediaRelay, stopMediaRelay } from '../services/mediaGateway.service.js';
import { stopIcecastPublisher } from '../services/icecastIngest.service.js';
import { setLiquidsoapMicrophone, setLiquidsoapVolume } from '../services/liquidsoap.service.js';

const playlistBody = z.object({ name: z.string().trim().min(1).max(64) });
const filenameBody = z.object({ file: z.string().min(1).max(255) });
const queuePositionBody = z.object({ position: z.number().int().min(0) });
const volumeBody = z.object({ volume: z.number().int().min(0).max(100) });
const microphoneBody = z.object({ enabled: z.boolean() });
const startBody = z.object({
  playlistId: z.string().nullable().optional(),
  sourceMode: z.enum(['playlist', 'rtmp', 'icecast', 'microphone']).default('playlist')
});
const ingestAuthBody = z.object({
  user: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  action: z.string(),
  path: z.string(),
  protocol: z.string()
});
const ingestStateBody = z.object({
  action: z.enum(['ready', 'not-ready']),
  path: z.string().regex(/^dj-[A-Za-z0-9_-]{20,64}$/)
});

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    String(error.code).includes('SQLITE_CONSTRAINT');
}

export async function djRoutes(app: FastifyInstance) {
  app.post('/api/ingest/auth', async (request, reply) => {
    if (!['127.0.0.1', '::1'].includes(request.ip)) {
      return reply.code(403).send({ ok: false });
    }
    const parsed = ingestAuthBody.safeParse(request.body);
    if (!parsed.success || parsed.data.action !== 'publish') {
      return reply.code(401).send({ ok: false });
    }
    const user = getRadioStore().verifyBroadcastToken(parsed.data.user, parsed.data.password);
    const onAir = user ? getRadioStore().getOnAir() : null;
    const mediaPath = parsed.data.path.replace(/^\/+|\/+$/g, '');
    const isMicOverlay = onAir?.sourceMode === 'playlist' && onAir.microphonePath === mediaPath;
    const isLiveSource = onAir?.mediaPath === mediaPath && onAir.sourceMode !== 'playlist';
    const expectedProtocol = isMicOverlay || onAir?.sourceMode === 'microphone'
      ? 'webrtc'
      : onAir?.sourceMode === 'rtmp' ? 'rtmp' : '';
    if (!user || onAir?.djId !== user.id || (!isMicOverlay && !isLiveSource) ||
      parsed.data.protocol.toLowerCase() !== expectedProtocol) {
      return reply.code(401).send({ ok: false });
    }
    return reply.code(200).send({ ok: true });
  });
  app.post('/api/ingest/state', async (request, reply) => {
    if (!['127.0.0.1', '::1'].includes(request.ip)) return reply.code(403).send({ ok: false });
    const parsed = ingestStateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false });
    if (parsed.data.action === 'ready') {
      try {
        await startMediaRelay(parsed.data.path, request.log);
      } catch (error) {
        request.log.error({ err: error, mediaPath: parsed.data.path }, 'Failed to start media relay');
        return reply.code(409).send({ ok: false });
      }
    } else {
      await stopMediaRelay(parsed.data.path);
    }
    return { ok: true };
  });

  app.get('/api/dj/me', { preHandler: requireRoles('dj') }, async (request) => ({ user: request.radioUser }));
  app.get('/api/dj/on-air', { preHandler: requireRoles('dj') }, async (request) => {
    const onAir = getRadioStore().getOnAir();
    return { onAir, isOwner: onAir?.djId === request.radioUser!.id };
  });
  app.post('/api/dj/on-air/microphone', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const parsed = microphoneBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_request' });
    const user = request.radioUser!;
    const store = getRadioStore();
    return withDjQueueLock(async () => {
      const onAir = store.getOnAir();
      if (!onAir || onAir.djId !== user.id || onAir.sourceMode !== 'playlist') {
        return reply.code(409).send({ ok: false, error: 'playlist_live_session_required' });
      }
      if (!parsed.data.enabled) {
        await setLiquidsoapMicrophone(false);
        const mediaPath = onAir.microphonePath;
        if (mediaPath) await stopMediaRelay(mediaPath);
        store.clearMicrophone(user.id);
        store.revokeBroadcastToken(user.id);
        return { ok: true, enabled: false };
      }

      await setLiquidsoapMicrophone(false);
      if (onAir.microphonePath) await stopMediaRelay(onAir.microphonePath);
      store.clearMicrophone(user.id);

      const mediaPath = `dj-${randomBytes(18).toString('base64url')}`;
      const password = randomBytes(32).toString('base64url');
      if (!store.setMicrophonePath(user.id, mediaPath)) {
        return reply.code(409).send({ ok: false, error: 'microphone_already_active' });
      }
      store.setBroadcastToken(user.id, password);
      try {
        await setLiquidsoapMicrophone(true);
      } catch (error) {
        store.clearMicrophone(user.id);
        store.revokeBroadcastToken(user.id);
        try {
          await setLiquidsoapMicrophone(false);
        } catch (cleanupError) {
          request.log.error({ err: cleanupError, userId: user.id }, 'Failed to turn off Liquidsoap microphone after setup failure');
        }
        throw error;
      }
      return {
        ok: true,
        enabled: true,
        broadcast: {
          username: user.username,
          password,
          whipUrl: `${env.BROADCAST_WHIP_BASE_URL.replace(/\/+$/, '')}/${mediaPath}/whip`
        }
      };
    });
  });
  app.post('/api/dj/on-air/volume', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const parsed = volumeBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_volume' });
    const store = getRadioStore();
    const user = request.radioUser!;
    return withDjQueueLock(async () => {
      const onAir = store.getOnAir();
      if (!onAir || onAir.djId !== user.id) return reply.code(409).send({ ok: false, error: 'not_on_air' });
      await setLiquidsoapVolume(parsed.data.volume);
      if (!store.setLiveVolume(user.id, parsed.data.volume)) {
        return reply.code(409).send({ ok: false, error: 'not_on_air' });
      }
      return { ok: true, volume: parsed.data.volume };
    });
  });
  app.post('/api/dj/on-air/credentials', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const user = request.radioUser!;
    const onAir = getRadioStore().getOnAir();
    if (!onAir || onAir.djId !== user.id || onAir.sourceMode === 'playlist') {
      return reply.code(409).send({ ok: false, error: 'no_broadcast_session' });
    }
    const previousMediaPath = onAir.mediaPath;
    const mediaPath = `dj-${randomBytes(18).toString('base64url')}`;
    const password = randomBytes(32).toString('base64url');
    if (!getRadioStore().setLiveMediaPath(user.id, mediaPath)) {
      return reply.code(409).send({ ok: false, error: 'no_broadcast_session' });
    }
    getRadioStore().setBroadcastToken(user.id, password);
    if (previousMediaPath) {
      if (onAir.sourceMode === 'icecast') await stopIcecastPublisher(previousMediaPath);
      else await stopMediaRelay(previousMediaPath);
    }
    return {
      ok: true,
      broadcast: {
        username: user.username,
        password,
        rtmpUrl: `${env.BROADCAST_RTMP_BASE_URL.replace(/\/+$/, '')}/${mediaPath}`,
        whipUrl: `${env.BROADCAST_WHIP_BASE_URL.replace(/\/+$/, '')}/${mediaPath}/whip`,
        icecastUrl: `${env.BROADCAST_ICECAST_BASE_URL.replace(/\/+$/, '')}/${mediaPath}`
      }
    };
  });
  app.get('/api/dj/music', { preHandler: requireRoles('dj') }, async (request) => {
    const query = request.query as { q?: string };
    return { items: await listMusicFiles(query.q) };
  });
  app.get('/api/dj/playlists', { preHandler: requireRoles('dj') }, async (request) => ({
    items: getRadioStore().listPlaylists(request.radioUser!.id)
  }));
  app.post('/api/dj/playlists', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const parsed = playlistBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_playlist' });
    try {
      const playlist = getRadioStore().createPlaylist(request.radioUser!.id, parsed.data.name);
      return reply.code(201).send({ ok: true, playlist });
    } catch (error) {
      if (isUniqueConstraint(error)) return reply.code(409).send({ ok: false, error: 'playlist_exists' });
      throw error;
    }
  });
  app.delete('/api/dj/playlists/:id', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const deleted = getRadioStore().deletePlaylist(request.radioUser!.id, (request.params as { id: string }).id);
    if (!deleted) return reply.code(404).send({ ok: false, error: 'playlist_not_found' });
    return { ok: true };
  });
  app.post('/api/dj/playlists/:id/tracks', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const parsed = filenameBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'file_required' });
    const path = safeMusicPath(parsed.data.file);
    await fsp.access(path);
    const playlist = getRadioStore().addPlaylistTrack(
      request.radioUser!.id,
      (request.params as { id: string }).id,
      parsed.data.file
    );
    if (!playlist) return reply.code(404).send({ ok: false, error: 'playlist_not_found' });
    return { ok: true, playlist };
  });
  app.delete('/api/dj/playlists/:id/tracks/:position', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const position = Number((request.params as { position: string }).position);
    const playlist = getRadioStore().removePlaylistTrack(request.radioUser!.id, id, position);
    if (!playlist) return reply.code(404).send({ ok: false, error: 'track_not_found' });
    return { ok: true, playlist };
  });
  app.post('/api/dj/upload/music', { preHandler: requireRoles('dj') }, async (request, reply) => {
    let saved: { filename: string; size: number } | null = null;
    let artist = '';
    let title = '';
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (saved) {
          part.file.resume();
          continue;
        }
        saved = await saveUpload(part as MultipartFile, env.MUSIC_DIR, ALLOWED_MUSIC_EXTS, { artist, title });
      } else if (part.fieldname === 'artist') {
        artist = String(part.value || '').trim();
      } else if (part.fieldname === 'title') {
        title = String(part.value || '').trim();
      }
    }
    if (!saved) return reply.code(400).send({ ok: false, error: 'file_required' });
    return reply.code(201).send({ ok: true, file: saved.filename, size: saved.size });
  });
  app.post('/api/dj/queue', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const parsed = filenameBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'file_required' });
    return withDjQueueLock(async () => {
      const store = getRadioStore();
      const onAir = store.getOnAir();
      if (!onAir || onAir.djId !== request.radioUser!.id || onAir.sourceMode !== 'playlist') {
        return reply.code(409).send({ ok: false, error: 'not_on_air' });
      }
      await reconcileDjQueue();
      await pushMusicToLiquidsoap('dj_queue', parsed.data.file);
      return { ok: true, items: store.addDjQueueTrack(onAir.djId, parsed.data.file) };
    });
  });
  app.get('/api/dj/queue', { preHandler: requireRoles('dj') }, async (request, reply) => {
    return withDjQueueLock(async () => {
      const store = getRadioStore();
      const onAir = store.getOnAir();
      if (!onAir || onAir.djId !== request.radioUser!.id || onAir.sourceMode !== 'playlist') {
        return reply.code(409).send({ ok: false, error: 'not_on_air' });
      }
      await reconcileDjQueue();
      return {
        items: store.listDjQueue(onAir.djId).map((file) => ({ file, title: displayTitleFromFilename(file) }))
      };
    });
  });
  app.put('/api/dj/queue/:position', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const parsed = queuePositionBody.safeParse(request.body);
    const sourcePosition = Number((request.params as { position: string }).position);
    if (!parsed.success || !Number.isSafeInteger(sourcePosition) || sourcePosition < 0) {
      return reply.code(400).send({ ok: false, error: 'invalid_queue_position' });
    }
    return withDjQueueLock(async () => {
      const store = getRadioStore();
      const onAir = store.getOnAir();
      if (!onAir || onAir.djId !== request.radioUser!.id || onAir.sourceMode !== 'playlist') {
        return reply.code(409).send({ ok: false, error: 'not_on_air' });
      }
      await reconcileDjQueue();
      const previous = store.listDjQueue(onAir.djId);
      const moved = store.moveDjQueueTrack(onAir.djId, sourcePosition, parsed.data.position);
      if (!moved) return reply.code(404).send({ ok: false, error: 'track_not_found' });
      try {
        await moveLiquidsoapQueueTrack(sourcePosition, parsed.data.position);
      } catch (error) {
        store.replaceDjQueue(onAir.djId, previous);
        throw error;
      }
      return { ok: true, items: moved };
    });
  });
  app.delete('/api/dj/queue/:position', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const position = Number((request.params as { position: string }).position);
    if (!Number.isSafeInteger(position) || position < 0) return reply.code(400).send({ ok: false, error: 'invalid_queue_position' });
    return withDjQueueLock(async () => {
      const store = getRadioStore();
      const onAir = store.getOnAir();
      if (!onAir || onAir.djId !== request.radioUser!.id || onAir.sourceMode !== 'playlist') {
        return reply.code(409).send({ ok: false, error: 'not_on_air' });
      }
      await reconcileDjQueue();
      const previous = store.listDjQueue(onAir.djId);
      const remaining = store.removeDjQueueTrack(onAir.djId, position);
      if (!remaining) return reply.code(404).send({ ok: false, error: 'track_not_found' });
      try {
        await removeLiquidsoapQueueTrack(position);
      } catch (error) {
        store.replaceDjQueue(onAir.djId, previous);
        throw error;
      }
      return { ok: true, items: remaining };
    });
  });
  app.post('/api/dj/on-air/start', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const parsed = startBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_request' });
    const userId = request.radioUser!.id;
    const playlistId = parsed.data.playlistId ?? null;
    const sourceMode = parsed.data.sourceMode;
    const mediaPath = sourceMode === 'playlist' ? null : `dj-${randomBytes(18).toString('base64url')}`;
    const claim = getRadioStore().claimLive(userId, playlistId, sourceMode, mediaPath);
    if (!claim.ok) return reply.code(409).send({ ok: false, error: 'already_on_air', onAir: claim.onAir });
    const broadcastToken = sourceMode === 'playlist' ? null : randomBytes(32).toString('base64url');

    try {
      if (broadcastToken) getRadioStore().setBroadcastToken(userId, broadcastToken);
      await withDjQueueLock(async () => {
        const owner = getRadioStore().getOnAir();
        if (!owner || owner.djId !== userId) throw new Error('DJ live slot was released');
        await clearDjQueue();
        await setLiquidsoapMicrophone(false);
        await setLiquidsoapVolume(100);
        getRadioStore().replaceDjQueue(userId, []);
        if (sourceMode === 'playlist' && playlistId) {
          const playlist = getRadioStore().getPlaylist(userId, playlistId);
          if (!playlist) throw new Error('Playlist not found');
          getRadioStore().replaceDjQueue(userId, playlist.tracks);
          for (const file of playlist.tracks) await pushMusicToLiquidsoap('dj_queue', file);
        }
      });
    } catch (error) {
      app.log.error({ err: error, userId }, 'Failed to initialize DJ queue');
      await withDjQueueLock(async () => {
        try {
          await clearDjQueue();
        } catch (cleanupError) {
          app.log.error({ err: cleanupError, userId }, 'Failed to clear DJ queue after start failure');
        }
        getRadioStore().releaseLive(userId, claim.leaseId);
        getRadioStore().revokeBroadcastToken(userId);
      });
      throw error;
    }
    return {
      ok: true,
      onAir: claim.onAir,
      broadcast: broadcastToken ? {
        username: request.radioUser!.username,
        password: broadcastToken,
        rtmpUrl: `${env.BROADCAST_RTMP_BASE_URL.replace(/\/+$/, '')}/${mediaPath}`,
        whipUrl: `${env.BROADCAST_WHIP_BASE_URL.replace(/\/+$/, '')}/${mediaPath}/whip`,
        icecastUrl: `${env.BROADCAST_ICECAST_BASE_URL.replace(/\/+$/, '')}/${mediaPath}`
      } : null
    };
  });
  app.post('/api/dj/on-air/stop', { preHandler: requireRoles('dj') }, async (request, reply) => {
    const userId = request.radioUser!.id;
    return withDjQueueLock(async () => {
      const onAir = getRadioStore().getOnAir();
      if (!onAir || onAir.djId !== userId) {
        return reply.code(409).send({ ok: false, error: 'not_on_air' });
      }
      if (onAir.mediaPath) {
        if (onAir.sourceMode === 'icecast') await stopIcecastPublisher(onAir.mediaPath);
        else await stopMediaRelay(onAir.mediaPath);
      }
      if (onAir.microphonePath) await stopMediaRelay(onAir.microphonePath);
      await setLiquidsoapMicrophone(false);
      await setLiquidsoapVolume(100);
      await clearDjQueue();
      getRadioStore().revokeBroadcastToken(userId);
      getRadioStore().releaseLive(userId);
      return { ok: true };
    });
  });
}
