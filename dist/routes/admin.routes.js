import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { basicAuth } from '../middleware/basicAuth.js';
import { env } from '../config/env.js';
import { saveUpload } from '../services/upload.service.js';
import { sendLiquidsoapCommand } from '../services/liquidsoap.service.js';
const ALLOWED_EXTS = ['.mp3', '.wav', '.ogg', '.flac'];
const TS_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
function displayTitleFromFilename(filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext).replace(TS_PREFIX, '');
    const pretty = base.replace(/_+/g, ' ').replace(/\s+-\s+/g, ' - ').trim();
    return pretty || filename;
}
function safeFilePath(dir, file) {
    const clean = path.basename(file);
    if (clean !== file) {
        throw new Error('Invalid file');
    }
    const target = path.resolve(dir, clean);
    const resolvedDir = path.resolve(dir) + path.sep;
    if (!target.startsWith(resolvedDir)) {
        throw new Error('Invalid path');
    }
    return target;
}
async function listMusicFiles(q) {
    const entries = await fsp.readdir(env.MUSIC_DIR, { withFileTypes: true });
    const items = await Promise.all(entries
        .filter((e) => e.isFile())
        .map(async (e) => {
        const full = path.join(env.MUSIC_DIR, e.name);
        const stat = await fsp.stat(full);
        return {
            file: e.name,
            title: displayTitleFromFilename(e.name),
            size: stat.size,
            mtime: stat.mtime.toISOString()
        };
    }));
    const query = (q || '').trim().toLowerCase();
    const filtered = query
        ? items.filter((i) => i.title.toLowerCase().includes(query) || i.file.toLowerCase().includes(query))
        : items;
    return filtered.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}
async function pushToQueue(queueId, file) {
    const targetPath = safeFilePath(env.MUSIC_DIR, file);
    await fsp.access(targetPath);
    const uri = pathToFileURL(targetPath).toString();
    const { ok, lines } = await sendLiquidsoapCommand(`${queueId}.push ${uri}`);
    if (!ok) {
        throw new Error(lines.join('\n') || 'Liquidsoap error');
    }
}
export async function adminRoutes(app) {
    app.get('/admin', { preHandler: basicAuth }, async (req, reply) => {
        return reply.sendFile('admin.html');
    });
    app.get('/api/admin/music', { preHandler: basicAuth }, async (req) => {
        const q = req.query.q;
        const items = await listMusicFiles(q);
        return { items };
    });
    app.post('/api/admin/queue/next', { preHandler: basicAuth }, async (req, reply) => {
        const body = req.body || {};
        if (!body.file)
            return reply.code(400).send({ ok: false, error: 'file_required' });
        await pushToQueue('next', body.file);
        return { ok: true };
    });
    app.post('/api/admin/queue/add', { preHandler: basicAuth }, async (req, reply) => {
        const body = req.body || {};
        if (!body.file)
            return reply.code(400).send({ ok: false, error: 'file_required' });
        await pushToQueue('queue', body.file);
        return { ok: true };
    });
    app.delete('/api/admin/music', { preHandler: basicAuth }, async (req, reply) => {
        const query = req.query;
        const file = query.file || '';
        if (!file)
            return reply.code(400).send({ ok: false, error: 'file_required' });
        const targetPath = safeFilePath(env.MUSIC_DIR, file);
        await fsp.unlink(targetPath);
        return { ok: true };
    });
    app.post('/api/admin/upload/music', { preHandler: basicAuth }, async (req, reply) => {
        const parts = req.parts();
        let artist = '';
        let title = '';
        let saved = false;
        try {
            for await (const part of parts) {
                if (part.type === 'file') {
                    if (saved) {
                        part.file.resume();
                        continue;
                    }
                    await saveUpload(part, env.MUSIC_DIR, ALLOWED_EXTS, { artist, title });
                    saved = true;
                }
                else if (part.fieldname === 'artist') {
                    artist = String(part.value || '').trim();
                }
                else if (part.fieldname === 'title') {
                    title = String(part.value || '').trim();
                }
            }
        }
        catch (err) {
            app.log.error({ err }, 'Upload failed');
            reply.redirect(303, `/admin?err=${encodeURIComponent('upload_failed')}`);
            return;
        }
        if (!saved) {
            reply.redirect(303, '/admin?err=missing_file');
            return;
        }
        reply.redirect(303, '/admin?ok=1');
    });
    app.post('/api/admin/upload/jingle', { preHandler: basicAuth }, async (req, reply) => {
        const parts = req.parts();
        let saved = false;
        try {
            for await (const part of parts) {
                if (part.type === 'file') {
                    if (saved) {
                        part.file.resume();
                        continue;
                    }
                    await saveUpload(part, env.JINGLES_DIR, ALLOWED_EXTS);
                    saved = true;
                }
            }
        }
        catch (err) {
            app.log.error({ err }, 'Upload failed');
            reply.redirect(303, `/admin?err=${encodeURIComponent('upload_failed')}`);
            return;
        }
        if (!saved) {
            reply.redirect(303, '/admin?err=missing_file');
            return;
        }
        reply.redirect(303, '/admin?ok=1');
    });
}
