import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { sendLiquidsoapCommand } from './liquidsoap.service.js';
import { fetchNowPlaying } from './icecast.service.js';
import { getRadioStore } from './radioStore.service.js';
import type { FastifyBaseLogger } from 'fastify';

export const ALLOWED_MUSIC_EXTS = ['.mp3', '.wav', '.ogg', '.flac'];
const TS_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
let djQueueOperation = Promise.resolve();

export function withDjQueueLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = djQueueOperation.then(operation, operation);
  djQueueOperation = result.then(() => undefined, () => undefined);
  return result;
}

export function displayTitleFromFilename(filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext).replace(TS_PREFIX, '');
  const pretty = base.replace(/_+/g, ' ').replace(/\s+-\s+/g, ' - ').trim();
  return pretty || filename;
}

export function safeMusicPath(file: string): string {
  const clean = path.basename(file);
  if (clean !== file) throw new Error('Invalid file');
  const target = path.resolve(env.MUSIC_DIR, clean);
  const resolvedDir = path.resolve(env.MUSIC_DIR) + path.sep;
  if (!target.startsWith(resolvedDir)) throw new Error('Invalid path');
  return target;
}

export async function listMusicFiles(query?: string) {
  const entries = await fsp.readdir(env.MUSIC_DIR, { withFileTypes: true });
  const items = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const stat = await fsp.stat(path.join(env.MUSIC_DIR, entry.name));
    return {
      file: entry.name,
      title: displayTitleFromFilename(entry.name),
      size: stat.size,
      mtime: stat.mtime.toISOString()
    };
  }));
  const normalizedQuery = (query || '').trim().toLowerCase();
  const filtered = normalizedQuery
    ? items.filter((item) => item.title.toLowerCase().includes(normalizedQuery) || item.file.toLowerCase().includes(normalizedQuery))
    : items;
  return filtered.sort((a, b) => a.mtime < b.mtime ? 1 : -1);
}

export async function pushMusicToLiquidsoap(queueId: 'next' | 'queue' | 'dj_queue', file: string): Promise<void> {
  const targetPath = safeMusicPath(file);
  await fsp.access(targetPath);
  const { ok, lines } = await sendLiquidsoapCommand(`${queueId}.push ${pathToFileURL(targetPath).toString()}`);
  if (!ok) throw new Error(lines.join('\n') || 'Liquidsoap error');
}

export async function clearDjQueue(): Promise<void> {
  const { ok, lines } = await sendLiquidsoapCommand('dj_queue.flush_and_skip');
  if (!ok) throw new Error(lines.join('\n') || 'Liquidsoap error');
}

export async function moveLiquidsoapQueueTrack(from: number, to: number): Promise<void> {
  const { ok, lines } = await sendLiquidsoapCommand(`dj_queue.move ${from} ${to}`);
  if (!ok) throw new Error(lines.join('\n') || 'Liquidsoap error');
}

export async function removeLiquidsoapQueueTrack(position: number): Promise<void> {
  const { ok, lines } = await sendLiquidsoapCommand(`dj_queue.remove ${position}`);
  if (!ok) throw new Error(lines.join('\n') || 'Liquidsoap error');
}

export async function reconcileDjQueue(): Promise<void> {
  const store = getRadioStore();
  const onAir = store.getOnAir();
  if (!onAir || onAir.sourceMode !== 'playlist') return;

  const nowPlaying = await fetchNowPlaying();
  const queue = store.listDjQueue(onAir.djId);
  const normalizeTitle = (title: string) => title.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const currentTitle = normalizeTitle(nowPlaying.title);
  const currentPosition = queue.findIndex((file) => {
    const queuedTitle = normalizeTitle(displayTitleFromFilename(file));
    return queuedTitle.length > 0 && currentTitle.length > 0 &&
      (queuedTitle === currentTitle || queuedTitle.endsWith(currentTitle) || currentTitle.endsWith(queuedTitle));
  });
  if (currentPosition >= 0) store.replaceDjQueue(onAir.djId, queue.slice(currentPosition + 1));
}

export function startDjQueueMonitor(logger: FastifyBaseLogger): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void withDjQueueLock(reconcileDjQueue)
      .catch((error) => logger.warn({ err: error }, 'Unable to synchronize the DJ queue with the current track'))
      .finally(() => { running = false; });
  }, 2000);
  timer.unref();
  return () => clearInterval(timer);
}
