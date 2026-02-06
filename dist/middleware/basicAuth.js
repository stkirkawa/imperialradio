import { env } from '../config/env.js';
function decodeBasicAuth(header) {
    if (!header)
        return null;
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() !== 'basic' || !value)
        return null;
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1)
        return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}
export async function basicAuth(request, reply) {
    if (!env.ADMIN_USER || !env.ADMIN_PASS) {
        reply.code(403).send('Admin access disabled');
        return;
    }
    const creds = decodeBasicAuth(request.headers.authorization);
    if (!creds || creds.user !== env.ADMIN_USER || creds.pass !== env.ADMIN_PASS) {
        reply.header('WWW-Authenticate', 'Basic realm="IMPERIAL RADIO"');
        reply.code(401).send('Unauthorized');
        return;
    }
}
