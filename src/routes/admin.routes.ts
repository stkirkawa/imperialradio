import { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import type { MultipartFile } from '@fastify/multipart';
import { basicAuth } from '../middleware/basicAuth.js';
import { env } from '../config/env.js';
import { saveUpload } from '../services/upload.service.js';
import { ALLOWED_MUSIC_EXTS, listMusicFiles, pushMusicToLiquidsoap, safeMusicPath } from '../services/musicLibrary.service.js';
import { getRadioStore } from '../services/radioStore.service.js';
import { clearDjQueue, withDjQueueLock } from '../services/musicLibrary.service.js';
import { stopMediaRelay } from '../services/mediaGateway.service.js';
import { stopIcecastPublisher } from '../services/icecastIngest.service.js';
import { radioServices, type RadioServiceId } from '../services/radioServices.service.js';
import { setLiquidsoapMicrophone, setLiquidsoapVolume } from '../services/liquidsoap.service.js';
import { z } from 'zod';

const createDjBody = z.object({
  username: z.string().regex(/^[A-Za-z0-9._-]{3,32}$/),
  displayName: z.string().trim().min(1).max(64),
  password: z.string().min(12).max(128)
});

const updateDjBody = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  active: z.boolean().optional(),
  password: z.string().min(12).max(128).optional()
}).refine((body) => Object.keys(body).length > 0);

const radioServiceId = z.enum(['liquidsoap', 'icecast', 'mediamtx']);
const queueTrackBody = z.object({ file: z.string().min(1).max(255) });

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    String(error.code).includes('SQLITE_CONSTRAINT');
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/services', { preHandler: basicAuth }, async () => ({
    items: await radioServices.list()
  }));

  app.post('/api/admin/services/:id/restart', { preHandler: basicAuth }, async (req, reply) => {
    const parsed = radioServiceId.safeParse((req.params as { id: string }).id);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_service' });
    try {
      const service = await radioServices.restart(parsed.data as RadioServiceId);
      return { ok: true, service };
    } catch (error) {
      if (error instanceof Error && error.message === 'Radio service is already restarting') {
        return reply.code(409).send({ ok: false, error: 'service_restarting' });
      }
      req.log.error({ err: error, serviceId: parsed.data }, 'Failed to restart radio service');
      return reply.code(503).send({ ok: false, error: 'service_restart_failed' });
    }
  });

  app.get('/api/admin/music', { preHandler: basicAuth }, async (req) => {
    const q = (req.query as { q?: string }).q;
    const items = await listMusicFiles(q);
    return { items };
  });

  app.get('/api/admin/djs', { preHandler: basicAuth }, async () => ({ items: getRadioStore().listDjs() }));

  app.post('/api/admin/djs', { preHandler: basicAuth }, async (req, reply) => {
    const parsed = createDjBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_dj' });
    try {
      const { password, ...userInput } = parsed.data;
      const user = await getRadioStore().createDj({ ...userInput, password });
      return reply.code(201).send({ ok: true, user });
    } catch (error) {
      if (isUniqueConstraint(error)) return reply.code(409).send({ ok: false, error: 'username_exists' });
      throw error;
    }
  });

  app.patch('/api/admin/djs/:id', { preHandler: basicAuth }, async (req, reply) => {
    const parsed = updateDjBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_dj_update' });
    const id = (req.params as { id: string }).id;
    return withDjQueueLock(async () => {
      const onAir = getRadioStore().getOnAir();
      if (onAir?.djId === id && (parsed.data.active === false || parsed.data.password !== undefined)) {
        if (onAir.mediaPath) {
          if (onAir.sourceMode === 'icecast') await stopIcecastPublisher(onAir.mediaPath);
          else await stopMediaRelay(onAir.mediaPath);
        }
        if (onAir.microphonePath) await stopMediaRelay(onAir.microphonePath);
        await setLiquidsoapMicrophone(false);
        await setLiquidsoapVolume(100);
        await clearDjQueue();
      }
      const user = await getRadioStore().updateDj(id, parsed.data);
      if (!user) return reply.code(404).send({ ok: false, error: 'dj_not_found' });
      return { ok: true, user };
    });
  });

  app.post('/api/admin/queue/next', { preHandler: basicAuth }, async (req, reply) => {
    const parsed = queueTrackBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'file_required' });
    await pushMusicToLiquidsoap('next', parsed.data.file);
    return { ok: true };
  });

  app.post('/api/admin/queue/add', { preHandler: basicAuth }, async (req, reply) => {
    const parsed = queueTrackBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'file_required' });
    await pushMusicToLiquidsoap('queue', parsed.data.file);
    return { ok: true };
  });

  app.delete('/api/admin/music', { preHandler: basicAuth }, async (req, reply) => {
    const parsed = queueTrackBody.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'file_required' });
    const file = parsed.data.file;
    const targetPath = safeMusicPath(file);
    await fsp.unlink(targetPath);
    return { ok: true };
  });

  app.post('/api/admin/upload/music', { preHandler: basicAuth }, async (req, reply) => {
    const parts = req.parts();
    let artist = '';
    let title = '';
    let saved = false;

    try {
      for await (const part of parts) {
        if (part.type === 'file') {
          if (saved) {
            part.file.resume();
            continue;
          }
          await saveUpload(part as MultipartFile, env.MUSIC_DIR, ALLOWED_MUSIC_EXTS, { artist, title });
          saved = true;
        } else if (part.fieldname === 'artist') {
          artist = String((part as { value?: unknown }).value || '').trim();
        } else if (part.fieldname === 'title') {
          title = String((part as { value?: unknown }).value || '').trim();
        }
      }
    } catch (err) {
      app.log.error({ err }, 'Upload failed');
      reply.redirect(303, `/admin/uploads?err=${encodeURIComponent('upload_failed')}`);
      return;
    }

    if (!saved) {
      reply.redirect(303, '/admin/uploads?err=missing_file');
      return;
    }

    reply.redirect(303, '/admin/uploads?ok=1');
  });

  app.post('/api/admin/upload/jingle', { preHandler: basicAuth }, async (req, reply) => {
    const parts = req.parts();
    let saved = false;

    try {
      for await (const part of parts) {
        if (part.type === 'file') {
          if (saved) {
            part.file.resume();
            continue;
          }
          await saveUpload(part as MultipartFile, env.JINGLES_DIR, ALLOWED_MUSIC_EXTS);
          saved = true;
        }
      }
    } catch (err) {
      app.log.error({ err }, 'Upload failed');
      reply.redirect(303, `/admin/uploads?err=${encodeURIComponent('upload_failed')}`);
      return;
    }

    if (!saved) {
      reply.redirect(303, '/admin/uploads?err=missing_file');
      return;
    }

    reply.redirect(303, '/admin/uploads?ok=1');
  });
}
