import dotenv from 'dotenv';
import { z } from 'zod';
dotenv.config();
const envSchema = z.object({
    NODE_ENV: z.string().default('production'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    ICECAST_BASE: z.string().url().default('http://127.0.0.1:8000'),
    ICECAST_MOUNT: z.string().default('/radio.mp3'),
    ICECAST_STATUS_PATH: z.string().default('/status-json.xsl'),
    ICECAST_STATUS_USER: z.string().optional().default(''),
    ICECAST_STATUS_PASS: z.string().optional().default(''),
    MUSIC_DIR: z.string().default('/radio/music'),
    JINGLES_DIR: z.string().default('/radio/jingles'),
    TMP_DIR: z.string().default('/radio/tmp'),
    DATA_DIR: z.string().default('data'),
    ADMIN_USER: z.string().optional().default(''),
    ADMIN_PASS: z.string().optional().default(''),
    LIQUIDSOAP_HOST: z.string().default('127.0.0.1'),
    LIQUIDSOAP_PORT: z.coerce.number().int().min(1).max(65535).default(1234),
    BROADCAST_RTMP_BASE_URL: z.string().default('rtmp://127.0.0.1:1935'),
    BROADCAST_WHIP_BASE_URL: z.string().default('http://127.0.0.1:8889'),
    BROADCAST_ICECAST_BASE_URL: z.string().default('http://127.0.0.1:8007'),
    ICECAST_INGEST_HOST: z.string().default('127.0.0.1'),
    ICECAST_INGEST_PORT: z.coerce.number().int().min(1).max(65535).default(8006),
    ICECAST_RAW_INGEST_HOST: z.string().default('127.0.0.1'),
    ICECAST_RAW_INGEST_PORT: z.coerce.number().int().min(1).max(65535).default(8007),
    LIVE_INGRESS_PASSWORD: z.string().default('CHANGE_ME_LOCAL_INGRESS_PASSWORD'),
    FFMPEG_PATH: z.string().default('ffmpeg'),
    FFPROBE_PATH: z.string().default('ffprobe'),
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(1024).default(100),
    NOWPLAYING_CACHE_MS: z.coerce.number().int().min(0).max(60_000).default(3000),
    LOG_LEVEL: z.enum(['silent', 'error', 'info', 'debug']).default('silent')
});
export const env = envSchema.parse(process.env);
