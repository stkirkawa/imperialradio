import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.string().default('production'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(3000),

  ICECAST_BASE: z.string().url().default('http://127.0.0.1:8000'),
  ICECAST_MOUNT: z.string().default('/radio.mp3'),
  ICECAST_STATUS_PATH: z.string().default('/status-json.xsl'),
  ICECAST_STATUS_USER: z.string().optional().default(''),
  ICECAST_STATUS_PASS: z.string().optional().default(''),

  MUSIC_DIR: z.string().default('/radio/music'),
  JINGLES_DIR: z.string().default('/radio/jingles'),
  TMP_DIR: z.string().default('/radio/tmp'),

  ADMIN_USER: z.string().optional().default(''),
  ADMIN_PASS: z.string().optional().default(''),

  LIQUIDSOAP_HOST: z.string().default('127.0.0.1'),
  LIQUIDSOAP_PORT: z.coerce.number().default(1234),

  MAX_UPLOAD_MB: z.coerce.number().default(100),
  NOWPLAYING_CACHE_MS: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['silent', 'error', 'info', 'debug']).default('silent')
});

export const env = envSchema.parse(process.env);

export type Env = typeof env;
