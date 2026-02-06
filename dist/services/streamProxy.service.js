import { request } from 'undici';
import { env } from '../config/env.js';
export async function proxyStream(reply) {
    const url = new URL(env.ICECAST_MOUNT, env.ICECAST_BASE).toString();
    const { body, headers, statusCode } = await request(url, {
        method: 'GET',
        headersTimeout: 10_000,
        bodyTimeout: 60 * 60 * 1000
    });
    const contentType = headers['content-type']?.toString() || 'audio/mpeg';
    reply.raw.writeHead(statusCode, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
    });
    reply.hijack();
    const upstream = body;
    const closeUpstream = () => {
        try {
            upstream.destroy();
        }
        catch {
            // ignore
        }
    };
    reply.raw.on('close', closeUpstream);
    reply.raw.on('error', closeUpstream);
    upstream.on('error', (err) => {
        reply.log.error({ err }, 'Upstream stream error');
        closeUpstream();
    });
    upstream.pipe(reply.raw);
}
