import { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { TtlCache } from '../services/cache.service.js';
import { fetchNowPlaying, NowPlaying } from '../services/icecast.service.js';

const cache = new TtlCache<NowPlaying>();

function fallbackNowPlaying(): NowPlaying {
  return {
    station: 'IMPERIAL RADIO',
    title: '—',
    listeners: 0,
    mount: env.ICECAST_MOUNT,
    updatedAt: new Date().toISOString()
  };
}

export async function nowPlayingRoutes(app: FastifyInstance) {
  app.get('/api/nowplaying', async (req, reply) => {
    const cached = cache.get();
    if (cached) return cached;

    try {
      const data = await fetchNowPlaying();
      cache.set(data, env.NOWPLAYING_CACHE_MS);
      return data;
    } catch (err) {
      app.log.error({ err }, 'Failed to fetch Icecast status');
      const data = fallbackNowPlaying();
      cache.set(data, env.NOWPLAYING_CACHE_MS);
      return data;
    }
  });
}
