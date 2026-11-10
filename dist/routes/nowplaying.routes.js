import { env } from '../config/env.js';
import { TtlCache } from '../services/cache.service.js';
import { fetchNowPlaying } from '../services/icecast.service.js';
import { getRadioStore } from '../services/radioStore.service.js';
const cache = new TtlCache();
function fallbackNowPlaying() {
    return {
        station: 'IMPERIAL RADIO',
        title: '—',
        listeners: 0,
        mount: env.ICECAST_MOUNT,
        updatedAt: new Date().toISOString()
    };
}
function addOnAirLabel(data) {
    const onAir = getRadioStore().getOnAir();
    return {
        ...data,
        onAirLabel: onAir ? `В эфире - DJ (${onAir.djDisplayName})` : 'В эфире'
    };
}
export async function nowPlayingRoutes(app) {
    app.get('/api/nowplaying', async (req, reply) => {
        const cached = cache.get();
        if (cached)
            return addOnAirLabel(cached);
        try {
            const data = await fetchNowPlaying();
            cache.set(data, env.NOWPLAYING_CACHE_MS);
            return addOnAirLabel(data);
        }
        catch (err) {
            app.log.error({ err }, 'Failed to fetch Icecast status');
            const data = fallbackNowPlaying();
            cache.set(data, env.NOWPLAYING_CACHE_MS);
            return addOnAirLabel(data);
        }
    });
}
