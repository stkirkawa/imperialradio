import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { MultipartFile } from '@fastify/multipart';
import { sanitizeFilename, withTimestampPrefix } from '../utils/sanitizeFilename.js';

export type UploadResult = {
  filename: string;
  size: number;
};

export type UploadMeta = {
  artist?: string;
  title?: string;
};

export async function ensureDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

export function isAllowedExtension(filename: string, allowed: string[]): boolean {
  const ext = path.extname(filename).toLowerCase();
  return allowed.includes(ext);
}

export async function saveUpload(
  part: MultipartFile,
  destDir: string,
  allowedExts: string[],
  meta?: UploadMeta
): Promise<UploadResult> {
  const originalName = part.filename || 'file';
  const ext = path.extname(originalName).toLowerCase();
  if (!ext || !allowedExts.includes(ext)) {
    part.file.resume();
    throw new Error('Invalid file extension');
  }

  const artist = (meta?.artist || '').trim();
  const title = (meta?.title || '').trim();
  const displayBase = [artist, title].filter(Boolean).join(' - ');

  const baseFromOriginal = path.basename(originalName, ext);
  const base = displayBase || baseFromOriginal || 'file';
  const safeBase = sanitizeFilename(base);
  const finalName = withTimestampPrefix(`${safeBase}${ext}`);
  const targetPath = path.resolve(destDir, finalName);
  const resolvedDir = path.resolve(destDir);

  if (!targetPath.startsWith(resolvedDir + path.sep)) {
    throw new Error('Invalid path');
  }

  await ensureDir(destDir);

  const writeStream = fs.createWriteStream(targetPath, { flags: 'wx' });
  try {
    await pipeline(part.file, writeStream);
    // Multipart streams can finish successfully after the configured size limit.
    // Never publish a truncated audio file as a valid upload.
    if (part.file.truncated) throw new Error('Upload exceeds the maximum allowed size');
    const stats = await fsp.stat(targetPath);
    return { filename: finalName, size: stats.size };
  } catch (error) {
    await fsp.unlink(targetPath).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}
