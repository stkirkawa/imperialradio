import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { env } from './config/env.js';
import { publicRoutes } from './routes/public.routes.js';
import { nowPlayingRoutes } from './routes/nowplaying.routes.js';
import { streamRoutes } from './routes/stream.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { ensureDir } from './services/upload.service.js';
export async function buildApp() {
    const app = Fastify({
        logger: { level: env.LOG_LEVEL },
        disableRequestLogging: true
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
    await app.register(publicRoutes);
    await app.register(nowPlayingRoutes);
    await app.register(streamRoutes);
    await app.register(adminRoutes);
    return app;
}
