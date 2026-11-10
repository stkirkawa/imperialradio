import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  authenticate,
  checkLoginRateLimit,
  clearLoginFailures,
  clearSessionCookie,
  login,
  recordLoginFailure,
  setSessionCookie,
  SESSION_COOKIE
} from '../middleware/radioAuth.js';
import { getRadioStore } from '../services/radioStore.service.js';
import { clearDjQueue, withDjQueueLock } from '../services/musicLibrary.service.js';
import { stopMediaRelay } from '../services/mediaGateway.service.js';
import { stopIcecastPublisher } from '../services/icecastIngest.service.js';
import { setLiquidsoapMicrophone, setLiquidsoapVolume } from '../services/liquidsoap.service.js';

const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256)
});

export async function authRoutes(app: FastifyInstance) {
  const sendAdminPage = async (request: FastifyRequest, reply: FastifyReply, page?: string) => {
    const user = await authenticate(request);
    if (!user) return reply.redirect('/login');
    if (user.role !== 'superadmin') return reply.redirect('/dj');
    if (page && !['djs', 'music', 'uploads', 'services'].includes(page)) {
      return reply.code(404).send({ ok: false, error: 'page_not_found' });
    }
    return reply.sendFile('admin.html');
  };
  const sendDjPage = async (request: FastifyRequest, reply: FastifyReply, page?: string) => {
    const user = await authenticate(request);
    if (!user) return reply.redirect('/login');
    if (user.role !== 'dj') return reply.redirect('/admin');
    if (page && !['studio', 'queue', 'playlists', 'library', 'upload'].includes(page)) {
      return reply.code(404).send({ ok: false, error: 'page_not_found' });
    }
    return reply.sendFile('dj.html');
  };
  app.get('/login', async (_request, reply) => reply.sendFile('login.html'));
  app.get('/admin', sendAdminPage);
  app.get('/admin/:page', async (request, reply) => sendAdminPage(request, reply, (request.params as { page: string }).page));
  app.get('/dj', sendDjPage);
  app.get('/dj/:page', async (request, reply) => sendDjPage(request, reply, (request.params as { page: string }).page));

  app.post('/api/auth/login', async (request, reply) => {
    if (!checkLoginRateLimit(request.ip)) {
      return reply.code(429).send({ ok: false, error: 'too_many_attempts' });
    }

    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      recordLoginFailure(request.ip);
      return reply.code(400).send({ ok: false, error: 'invalid_credentials' });
    }

    const result = await login(parsed.data.username, parsed.data.password);
    if (!result) {
      recordLoginFailure(request.ip);
      return reply.code(401).send({ ok: false, error: 'invalid_credentials' });
    }

    clearLoginFailures(request.ip);
    setSessionCookie(reply, result.token);
    return { ok: true, user: result.user, redirect: result.user.role === 'superadmin' ? '/admin' : '/dj' };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    return { ok: true, user };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const user = await authenticate(request);
    if (user?.role === 'dj') {
      await withDjQueueLock(async () => {
        const onAir = getRadioStore().getOnAir();
        if (onAir?.djId !== user.id) return;
        if (onAir.mediaPath) {
          if (onAir.sourceMode === 'icecast') await stopIcecastPublisher(onAir.mediaPath);
          else await stopMediaRelay(onAir.mediaPath);
        }
        if (onAir.microphonePath) await stopMediaRelay(onAir.microphonePath);
        await setLiquidsoapMicrophone(false);
        await setLiquidsoapVolume(100);
        await clearDjQueue();
        getRadioStore().revokeBroadcastToken(user.id);
        getRadioStore().releaseLive(user.id);
      });
    }

    const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    if (cookie) {
      const token = cookie.slice(SESSION_COOKIE.length + 1);
      try {
        getRadioStore().deleteSession(decodeURIComponent(token));
      } catch (error) {
        request.log.warn({ err: error }, 'Invalid session cookie during logout');
      }
    }
    clearSessionCookie(reply);
    return { ok: true };
  });
}
