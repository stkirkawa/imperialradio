import path from 'node:path';
const SAFE_CHARS = /[^a-zA-Z0-9._-]+/g;
export function sanitizeFilename(input) {
    const base = path.basename(input).trim();
    if (!base)
        return 'file';
    const replaced = base.replace(SAFE_CHARS, '_');
    const collapsed = replaced.replace(/_+/g, '_');
    const noEdge = collapsed.replace(/^_+|_+$/g, '');
    return noEdge || 'file';
}
export function withTimestampPrefix(name) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return `${ts}_${name}`;
}
