import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { basicAuth } from '../middleware/basicAuth.js';
import { env } from '../config/env.js';
import { saveUpload } from '../services/upload.service.js';
import { ALLOWED_MUSIC_EXTS, listMusicFiles, pushMusicToLiquidsoap, safeMusicPath, updateMusicTags } from '../services/musicLibrary.service.js';
import { getRadioStore } from '../services/radioStore.service.js';
import { clearDjQueue, withDjQueueLock } from '../services/musicLibrary.service.js';
import { stopMediaRelay } from '../services/mediaGateway.service.js';
import { stopIcecastPublisher } from '../services/icecastIngest.service.js';
import { radioServices } from '../services/radioServices.service.js';
import { setLiquidsoapMicrophone, setLiquidsoapVolume } from '../services/liquidsoap.service.js';
import { z } from 'zod';
const createDjBody = z.object({
    username: z.string().regex(/^[A-Za-z0-9._-]{3,32}$/),
    displayName: z.string().trim().min(1).max(64),
    password: z.string().min(12).max(128)
});
const updateDjBody = z.object({
    displayName: z.string().trim().min(1).max(64).optional(),
    active: z.boolean().optional(),
    password: z.string().min(12).max(128).optional()
}).refine((body) => Object.keys(body).length > 0);
const radioServiceId = z.enum(['liquidsoap', 'icecast', 'mediamtx']);
const queueTrackBody = z.object({ file: z.string().min(1).max(255) });
const musicTagsBody = z.object({
    file: z.string().min(1).max(255),
    artist: z.string().trim().max(150).regex(/^[^\u0000-\u001f\u007f]*$/u),
    title: z.string().trim().max(150).regex(/^[^\u0000-\u001f\u007f]*$/u)
});
function isUniqueConstraint(error) {
    return typeof error === 'object' && error !== null && 'code' in error &&
        String(error.code).includes('SQLITE_CONSTRAINT');
}
export async function adminRoutes(app) {
    app.get('/api/admin/suggestions', { preHandler: basicAuth }, async (req, reply) => {
        const query = z.enum(['pending', 'approved', 'rejected', 'all']).safeParse(req.query.status ?? 'pending');
        if (!query.success)
            return reply.code(400).send({ ok: false, error: 'invalid_status' });
        const items = getRadioStore().listTrackSuggestions(query.data);
        return { items };
    });
    app.get('/api/admin/suggestions/:id/audio', { preHandler: basicAuth }, async (req, reply) => {
        const id = z.string().min(1).max(64).safeParse(req.params.id);
        if (!id.success)
            return reply.code(400).send({ ok: false, error: 'invalid_suggestion' });
        const suggestion = getRadioStore().getTrackSuggestion(id.data);
        if (!suggestion || suggestion.status !== 'pending')
            return reply.code(404).send({ ok: false, error: 'suggestion_not_found' });
        const extension = path.extname(suggestion.filename).toLowerCase();
        const contentType = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[extension];
        if (!contentType)
            return reply.code(415).send({ ok: false, error: 'unsupported_audio_type' });
        return reply.type(contentType).header('Cache-Control', 'private, no-store').send(fs.createReadStream(path.join(env.DATA_DIR, 'suggestions', path.basename(suggestion.filename))));
    });
    app.patch('/api/admin/suggestions/:id', { preHandler: basicAuth }, async (req, reply) => {
        const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
        const body = z.object({ decision: z.enum(['approved', 'rejected']) }).safeParse(req.body);
        if (!params.success || !body.success)
            return reply.code(400).send({ ok: false, error: 'invalid_decision' });
        const store = getRadioStore();
        const suggestion = store.getTrackSuggestion(params.data.id);
        if (!suggestion)
            return reply.code(404).send({ ok: false, error: 'suggestion_not_found' });
        if (suggestion.status !== 'pending')
            return reply.code(409).send({ ok: false, error: 'suggestion_already_reviewed' });
        const pendingFile = path.join(env.DATA_DIR, 'suggestions', path.basename(suggestion.filename));
        if (body.data.decision === 'rejected') {
            if (!store.resolveTrackSuggestion(suggestion.id, 'rejected'))
                return reply.code(409).send({ ok: false, error: 'suggestion_already_reviewed' });
            await fsp.unlink(pendingFile).catch((error) => {
                if (error.code !== 'ENOENT')
                    req.log.warn({ err: error }, 'Rejected suggestion file cleanup failed');
            });
            return { ok: true, status: 'rejected' };
        }
        const extension = path.extname(suggestion.filename).toLowerCase();
        const filenameBase = path.basename(suggestion.filename, extension).slice(0, 220);
        const approvedFilename = `${filenameBase}-${randomBytes(8).toString('hex')}${extension}`;
        const approvedFile = path.join(env.MUSIC_DIR, approvedFilename);
        try {
            await fsp.copyFile(pendingFile, approvedFile, fs.constants.COPYFILE_EXCL);
        }
        catch (error) {
            if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
                await fsp.unlink(approvedFile).catch(() => undefined);
            }
            req.log.error({ err: error, suggestionId: suggestion.id }, 'Failed to move approved suggestion into music library');
            return reply.code(500).send({ ok: false, error: 'suggestion_approval_failed' });
        }
        if (!store.resolveTrackSuggestion(suggestion.id, 'approved', approvedFilename)) {
            await fsp.unlink(approvedFile).catch(() => undefined);
            return reply.code(409).send({ ok: false, error: 'suggestion_already_reviewed' });
        }
        await fsp.unlink(pendingFile).catch((error) => {
            if (error.code !== 'ENOENT')
                req.log.warn({ err: error, suggestionId: suggestion.id }, 'Approved suggestion source cleanup failed');
        });
        return { ok: true, status: 'approved', file: approvedFilename };
    });
    app.get('/api/admin/services', { preHandler: basicAuth }, async () => ({
        items: await radioServices.list()
    }));
    app.post('/api/admin/services/:id/restart', { preHandler: basicAuth }, async (req, reply) => {
        const parsed = radioServiceId.safeParse(req.params.id);
        if (!parsed.success)
            return reply.code(400).send({ ok: false, error: 'invalid_service' });
        try {
            const service = await radioServices.restart(parsed.data);
            return { ok: true, service };
        }
        catch (error) {
            if (error instanceof Error && error.message === 'Radio service is already restarting') {
                return reply.code(409).send({ ok: false, error: 'service_restarting' });
            }
            req.log.error({ err: error, serviceId: parsed.data }, 'Failed to restart radio service');
            return reply.code(503).send({ ok: false, error: 'service_restart_failed' });
        }
    });
    app.get('/api/admin/music', { preHandler: basicAuth }, async (req) => {
        const q = req.query.q;
        const items = await listMusicFiles(q);
        return { items };
    });
    app.put('/api/admin/music/tags', { preHandler: basicAuth }, async (req, reply) => {
        const parsed = musicTagsBody.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ ok: false, error: 'invalid_music_tags' });
        try {
            await updateMusicTags(parsed.data.file, parsed.data.artist, parsed.data.title);
            return { ok: true, item: parsed.data };
        }
        catch (error) {
            if (error instanceof Error && error.message === 'unsupported_audio_type') {
                return reply.code(400).send({ ok: false, error: 'unsupported_audio_type' });
            }
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
                return reply.code(404).send({ ok: false, error: 'music_file_not_found' });
            }
            req.log.error({ err: error, file: parsed.data.file }, 'Failed to update music tags');
            return reply.code(422).send({ ok: false, error: 'tag_update_failed' });
        }
    });
    app.get('/api/admin/djs', { preHandler: basicAuth }, async () => ({ items: getRadioStore().listDjs() }));
    app.post('/api/admin/djs', { preHandler: basicAuth }, async (req, reply) => {
        const parsed = createDjBody.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ ok: false, error: 'invalid_dj' });
        try {
            const { password, ...userInput } = parsed.data;
            const user = await getRadioStore().createDj({ ...userInput, password });
            return reply.code(201).send({ ok: true, user });
        }
        catch (error) {
            if (isUniqueConstraint(error))
                return reply.code(409).send({ ok: false, error: 'username_exists' });
            throw error;
        }
    });
    app.patch('/api/admin/djs/:id', { preHandler: basicAuth }, async (req, reply) => {
        const parsed = updateDjBody.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ ok: false, error: 'invalid_dj_update' });
        const id = req.params.id;
        return withDjQueueLock(async () => {
            const onAir = getRadioStore().getOnAir();
            if (onAir?.djId === id && (parsed.data.active === false || parsed.data.password !== undefined)) {
                if (onAir.mediaPath) {
                    if (onAir.sourceMode === 'icecast')
                        await stopIcecastPublisher(onAir.mediaPath);
                    else
                        await stopMediaRelay(onAir.mediaPath);
                }
                if (onAir.microphonePath)
                    await stopMediaRelay(onAir.microphonePath);
                await setLiquidsoapMicrophone(false);
                await setLiquidsoapVolume(100);
                await clearDjQueue();
            }
            const user = await getRadioStore().updateDj(id, parsed.data);
            if (!user)
                return reply.code(404).send({ ok: false, error: 'dj_not_found' });
            return { ok: true, user };
        });
    });
    app.post('/api/admin/queue/next', { preHandler: basicAuth }, async (req, reply) => {
        const parsed = queueTrackBody.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ ok: false, error: 'file_required' });
        await pushMusicToLiquidsoap('next', parsed.data.file);
        return { ok: true };
    });
    app.post('/api/admin/queue/add', { preHandler: basicAuth }, async (req, reply) => {
        const parsed = queueTrackBody.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ ok: false, error: 'file_required' });
        await pushMusicToLiquidsoap('queue', parsed.data.file);
        return { ok: true };
    });
    app.delete('/api/admin/music', { preHandler: basicAuth }, async (req, reply) => {
        const parsed = queueTrackBody.safeParse(req.query);
        if (!parsed.success)
            return reply.code(400).send({ ok: false, error: 'file_required' });
        const file = parsed.data.file;
        const targetPath = safeMusicPath(file);
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
                    await saveUpload(part, env.MUSIC_DIR, ALLOWED_MUSIC_EXTS, { artist, title });
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
            reply.redirect(303, `/admin/uploads?err=${encodeURIComponent('upload_failed')}`);
            return;
        }
        if (!saved) {
            reply.redirect(303, '/admin/uploads?err=missing_file');
            return;
        }
        reply.redirect(303, '/admin/uploads?ok=1');
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
                    await saveUpload(part, env.JINGLES_DIR, ALLOWED_MUSIC_EXTS);
                    saved = true;
                }
            }
        }
        catch (err) {
            app.log.error({ err }, 'Upload failed');
            reply.redirect(303, `/admin/uploads?err=${encodeURIComponent('upload_failed')}`);
            return;
        }
        if (!saved) {
            reply.redirect(303, '/admin/uploads?err=missing_file');
            return;
        }
        reply.redirect(303, '/admin/uploads?ok=1');
    });
}
