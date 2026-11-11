import { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { TtlCache } from '../services/cache.service.js';
import { fetchNowPlaying, NowPlaying } from '../services/icecast.service.js';
import { getRadioStore } from '../services/radioStore.service.js';

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

function addOnAirLabel(data: NowPlaying) {
  const onAir = getRadioStore().getOnAir();
  return {
    ...data,
    onAirLabel: onAir ? `В эфире - DJ (${onAir.djDisplayName})` : 'В эфире'
  };
}

export async function nowPlayingRoutes(app: FastifyInstance) {
  app.get('/api/history', async () => ({ history: getRadioStore().listTrackHistory() }));

  app.get('/api/nowplaying', async (req, reply) => {
    const cached = cache.get();
    if (cached) return addOnAirLabel(cached);

    try {
      const data = await fetchNowPlaying();
      getRadioStore().recordPlayedTrack(data.title);
      cache.set(data, env.NOWPLAYING_CACHE_MS);
      return addOnAirLabel(data);
    } catch (err) {
      app.log.error({ err }, 'Failed to fetch Icecast status');
      const data = fallbackNowPlaying();
      cache.set(data, env.NOWPLAYING_CACHE_MS);
      return addOnAirLabel(data);
    }
  });
}
