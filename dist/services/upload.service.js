import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sanitizeFilename, withTimestampPrefix } from '../utils/sanitizeFilename.js';
export async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}
export function isAllowedExtension(filename, allowed) {
    const ext = path.extname(filename).toLowerCase();
    return allowed.includes(ext);
}
export async function saveUpload(part, destDir, allowedExts, meta) {
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
    await pipeline(part.file, writeStream);
    const stats = await fsp.stat(targetPath);
    return { filename: finalName, size: stats.size };
}
