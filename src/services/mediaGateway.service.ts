import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import { getRadioStore } from './radioStore.service.js';

const relays = new Map<string, ChildProcess>();
const stopping = new Set<string>();

export async function startMediaRelay(mediaPath: string, logger: FastifyBaseLogger): Promise<void> {
  if (!/^dj-[A-Za-z0-9_-]{20,64}$/.test(mediaPath)) throw new Error('Invalid media path');
  const onAir = getRadioStore().getOnAir();
  const isLiveSource = onAir?.mediaPath === mediaPath && ['rtmp', 'microphone'].includes(onAir.sourceMode);
  const isMicOverlay = onAir?.microphonePath === mediaPath && onAir.sourceMode === 'playlist';
  if (!onAir || (!isLiveSource && !isMicOverlay)) {
    throw new Error('No matching live DJ session');
  }
  if (relays.has(mediaPath)) return;

  const sourceUrl = `rtsp://127.0.0.1:8554/${mediaPath}`;
  const targetMount = isMicOverlay ? 'dj-mic' : 'dj-live';
  const targetUrl = `icecast://source:${encodeURIComponent(env.LIVE_INGRESS_PASSWORD)}@127.0.0.1:8005/${targetMount}`;
  const child = spawn(env.FFMPEG_PATH, [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    '-i', sourceUrl,
    '-vn',
    '-ac', '2',
    '-ar', '44100',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-content_type', 'audio/mpeg',
    '-f', 'mp3',
    targetUrl
  ], { stdio: 'ignore', windowsHide: true });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      child.removeListener('spawn', onSpawn);
      relays.delete(mediaPath);
      reject(new Error(`Unable to start FFmpeg live relay: ${error.message}`));
    };
    const onSpawn = () => {
      child.removeListener('error', onError);
      relays.set(mediaPath, child);
      resolve();
    };
    child.once('error', onError);
    child.on('error', (error) => logger.error({ err: error, mediaPath }, 'FFmpeg live relay failed'));
    child.once('spawn', onSpawn);
  });

  child.once('exit', (code, signal) => {
    if (relays.get(mediaPath) === child) relays.delete(mediaPath);
    if (!stopping.has(mediaPath) && code !== 0) {
      logger.error({ mediaPath, exitCode: code, signal }, 'FFmpeg live relay exited unexpectedly');
    }
    stopping.delete(mediaPath);
  });
}

export async function stopMediaRelay(mediaPath: string): Promise<void> {
  const child = relays.get(mediaPath);
  if (!child) return;
  relays.delete(mediaPath);
  if (child.exitCode !== null) return;
  stopping.add(mediaPath);
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, 2000);
    child.once('exit', finish);
    if (!child.kill()) finish();
  });
}

export async function stopAllMediaRelays(): Promise<void> {
  await Promise.all([...relays.keys()].map((mediaPath) => stopMediaRelay(mediaPath)));
}
