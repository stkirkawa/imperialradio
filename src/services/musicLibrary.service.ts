import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { sendLiquidsoapCommand } from './liquidsoap.service.js';
import { fetchNowPlaying } from './icecast.service.js';
import { getRadioStore } from './radioStore.service.js';
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities.js';
import type { FastifyBaseLogger } from 'fastify';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const ALLOWED_MUSIC_EXTS = ['.mp3', '.wav', '.ogg', '.flac'];
const TS_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
let djQueueOperation = Promise.resolve();
const audioTagCache = new Map<string, { signature: string; artist: string; title: string }>();

function runFileCommand(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function fallbackTags(filename: string): { artist: string; title: string } {
  const label = displayTitleFromFilename(filename);
  const separator = label.indexOf(' - ');
  return separator > 0
    ? { artist: label.slice(0, separator).trim(), title: label.slice(separator + 3).trim() }
    : { artist: '', title: label };
}

async function readAudioTags(filename: string, filePath: string, signature: string) {
  const cached = audioTagCache.get(filePath);
  if (cached?.signature === signature) return { artist: cached.artist, title: cached.title };
  const fallback = fallbackTags(filename);
  try {
    const output = await runFileCommand(env.FFPROBE_PATH, [
      '-v', 'error', '-show_entries', 'format_tags=artist,title', '-of', 'json', filePath
    ]);
    const tags = JSON.parse(output)?.format?.tags ?? {};
    const lookup = (name: string) => {
      const key = Object.keys(tags).find((candidate) => candidate.toLowerCase() === name);
      return key ? decodeHtmlEntities(String(tags[key] || '').trim()) : '';
    };
    const artist = lookup('artist') || fallback.artist;
    const title = lookup('title') || fallback.title;
    audioTagCache.set(filePath, { signature, artist, title });
    if (audioTagCache.size > 2000) audioTagCache.delete(audioTagCache.keys().next().value!);
    return { artist, title };
  } catch {
    return fallback;
  }
}

export function withDjQueueLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = djQueueOperation.then(operation, operation);
  djQueueOperation = result.then(() => undefined, () => undefined);
  return result;
}

export function displayTitleFromFilename(filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext).replace(TS_PREFIX, '');
  const pretty = base.replace(/_+/g, ' ').replace(/\s+-\s+/g, ' - ').trim();
  return decodeHtmlEntities(pretty || filename);
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
  const files = entries.filter((entry) => entry.isFile());
  const items = new Array<{
    file: string; artist: string; title: string; size: number; mtime: string;
  }>(files.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (nextIndex < files.length) {
      const index = nextIndex++;
      const entry = files[index];
      const filePath = path.join(env.MUSIC_DIR, entry.name);
      const stat = await fsp.stat(filePath);
      const tags = await readAudioTags(entry.name, filePath, `${stat.size}:${stat.mtimeMs}`);
      items[index] = { file: entry.name, ...tags, size: stat.size, mtime: stat.mtime.toISOString() };
    }
  }));
  const normalizedQuery = (query || '').trim().toLowerCase();
  const filtered = normalizedQuery
    ? items.filter((item) => item.title.toLowerCase().includes(normalizedQuery) || item.artist.toLowerCase().includes(normalizedQuery) || item.file.toLowerCase().includes(normalizedQuery))
    : items;
  return filtered.sort((a, b) => a.mtime < b.mtime ? 1 : -1);
}

export async function updateMusicTags(file: string, artist: string, title: string): Promise<void> {
  const targetPath = safeMusicPath(file);
  const extension = path.extname(file).toLowerCase();
  if (!ALLOWED_MUSIC_EXTS.includes(extension)) throw new Error('unsupported_audio_type');
  const stat = await fsp.stat(targetPath);
  if (!stat.isFile()) throw new Error('music_file_not_found');
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(file, extension)}.tags-${randomBytes(8).toString('hex')}${extension}`);
  try {
    await runFileCommand(env.FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', targetPath,
      '-map', '0', '-map_metadata', '0', '-c', 'copy',
      '-metadata', `artist=${artist}`, '-metadata', `title=${title}`, tempPath
    ]);
    const result = await fsp.stat(tempPath);
    if (!result.isFile() || result.size === 0) throw new Error('tag_update_failed');
    await fsp.rename(tempPath, targetPath);
    audioTagCache.delete(targetPath);
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => undefined);
    throw error;
  }
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
