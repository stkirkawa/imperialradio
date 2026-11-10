import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { env } from './config/env.js';
import { publicRoutes } from './routes/public.routes.js';
import { nowPlayingRoutes } from './routes/nowplaying.routes.js';
import { streamRoutes } from './routes/stream.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { djRoutes } from './routes/dj.routes.js';
import { ensureDir } from './services/upload.service.js';
import { initializeRadioStore } from './services/radioStore.service.js';
import { clearDjQueue, startDjQueueMonitor } from './services/musicLibrary.service.js';
import { stopAllMediaRelays } from './services/mediaGateway.service.js';
import { closeIcecastIngest } from './services/icecastIngest.service.js';
export async function buildApp() {
    const app = Fastify({
        logger: { level: env.LOG_LEVEL },
        disableRequestLogging: true,
        trustProxy: ['127.0.0.1', '::1']
    });
    await app.register(multipart, {
        limits: {
            fileSize: env.MAX_UPLOAD_MB * 1024 * 1024
        }
    });
    await app.register(fastifyStatic, {
        root: path.resolve(process.cwd(), 'public'),
        prefix: '/',
        list: false
    });
    await ensureDir(env.MUSIC_DIR);
    await ensureDir(env.JINGLES_DIR);
    await ensureDir(env.TMP_DIR);
    await ensureDir(env.DATA_DIR);
    await initializeRadioStore();
    try {
        await clearDjQueue();
    }
    catch (error) {
        app.log.warn({ err: error }, 'DJ queue could not be cleared during startup');
    }
    await app.register(publicRoutes);
    await app.register(authRoutes);
    await app.register(djRoutes);
    await app.register(nowPlayingRoutes);
    await app.register(streamRoutes);
    await app.register(adminRoutes);
    const stopDjQueueMonitor = startDjQueueMonitor(app.log);
    app.addHook('onClose', async () => {
        stopDjQueueMonitor();
        await stopAllMediaRelays();
        await closeIcecastIngest();
    });
    return app;
}
