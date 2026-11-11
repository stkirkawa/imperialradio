import path from 'node:path';
import fsp from 'node:fs/promises';
import { env } from '../config/env.js';
import { getRadioStore } from '../services/radioStore.service.js';
import { saveUpload } from '../services/upload.service.js';
import { ALLOWED_MUSIC_EXTS } from '../services/musicLibrary.service.js';
const suggestionCooldown = new Map();
export async function publicRoutes(app) {
    app.get('/suggestions', async (_request, reply) => reply.redirect('/'));
    app.get('/', async (req, reply) => {
        return reply.sendFile('index.html');
    });
    app.get('/policy', async (req, reply) => {
        return reply.sendFile('policy.html');
    });
    app.get('/api/health', async () => ({ ok: true }));
    app.post('/api/suggestions', async (request, reply) => {
        const now = Date.now();
        const lastUpload = suggestionCooldown.get(request.ip) ?? 0;
        if (now - lastUpload < 5 * 60_000)
            return reply.code(429).send({ ok: false, error: 'suggestion_rate_limited' });
        if (!suggestionCooldown.has(request.ip) && suggestionCooldown.size >= 5000) {
            for (const [ip, timestamp] of suggestionCooldown)
                if (now - timestamp > 5 * 60_000)
                    suggestionCooldown.delete(ip);
            if (suggestionCooldown.size >= 5000)
                return reply.code(429).send({ ok: false, error: 'suggestion_rate_limited' });
        }
        suggestionCooldown.set(request.ip, now);
        let artist = '';
        let title = '';
        let nickname = '';
        let saved = null;
        const suggestionDir = path.join(env.DATA_DIR, 'suggestions');
        try {
            for await (const part of request.parts()) {
                if (part.type === 'file') {
                    if (saved) {
                        part.file.resume();
                        throw new Error('multiple_files');
                    }
                    saved = await saveUpload(part, suggestionDir, ALLOWED_MUSIC_EXTS, { artist, title });
                }
                else if (part.fieldname === 'nickname' || part.fieldname === 'artist' || part.fieldname === 'title') {
                    const candidate = String(part.value || '').trim();
                    if (part.fieldname === 'nickname' && (candidate.length < 2 || candidate.length > 32))
                        throw new Error('invalid_nickname');
                    if (part.fieldname !== 'nickname' && candidate.length > 100)
                        throw new Error('invalid_metadata');
                    if (part.fieldname === 'nickname')
                        nickname = candidate;
                    else if (part.fieldname === 'artist')
                        artist = candidate;
                    else
                        title = candidate;
                }
            }
            if (!saved)
                return reply.code(400).send({ ok: false, error: 'file_required' });
            if (!nickname)
                throw new Error('invalid_nickname');
            const suggestion = getRadioStore().createTrackSuggestion({ nickname, artist, title, filename: saved.filename });
            if (suggestionCooldown.size > 1000) {
                for (const [ip, timestamp] of suggestionCooldown)
                    if (now - timestamp > 5 * 60_000)
                        suggestionCooldown.delete(ip);
            }
            return reply.code(201).send({ ok: true, suggestion: { id: suggestion.id, status: suggestion.status } });
        }
        catch (error) {
            if (saved)
                await fsp.unlink(path.join(suggestionDir, saved.filename)).catch(() => undefined);
            if (error instanceof Error && ['multiple_files', 'invalid_metadata', 'invalid_nickname', 'Invalid file extension', 'Upload exceeds the maximum allowed size'].includes(error.message)) {
                return reply.code(400).send({ ok: false, error: error.message === 'multiple_files' ? 'one_file_only' : error.message === 'invalid_nickname' ? 'nickname_required' : 'invalid_suggestion' });
            }
            request.log.error({ err: error }, 'Track suggestion upload failed');
            return reply.code(500).send({ ok: false, error: 'suggestion_upload_failed' });
        }
    });
}
