import net from 'node:net';
import { env } from '../config/env.js';
const END_RE = /\r?\nEND\r?\n/;
export async function sendLiquidsoapCommand(command, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: env.LIQUIDSOAP_HOST, port: env.LIQUIDSOAP_PORT });
        let buffer = '';
        let done = false;
        let idleTimer;
        const finish = (err) => {
            if (done)
                return;
            done = true;
            if (idleTimer)
                clearTimeout(idleTimer);
            socket.destroy();
            if (err)
                return reject(err);
            const lines = buffer.split(/\r?\n/).filter((l) => l.trim() && l.trim() !== 'END');
            const ok = !lines.some((l) => l.startsWith('ERROR'));
            resolve({ lines, ok });
        };
        socket.setEncoding('utf8');
        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => finish(new Error('Liquidsoap timeout')));
        socket.on('error', (err) => finish(err));
        socket.on('data', (chunk) => {
            buffer += chunk;
            if (END_RE.test(buffer))
                return finish();
            if (idleTimer)
                clearTimeout(idleTimer);
            idleTimer = setTimeout(() => finish(), 300);
        });
        socket.on('connect', () => {
            socket.write(`${command.trim()}\n`);
        });
    });
}
export async function setLiquidsoapVolume(percent) {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
        throw new Error('Volume must be an integer between 0 and 100');
    }
    const { ok, lines } = await sendLiquidsoapCommand(`imperial_radio.volume ${percent}`);
    if (!ok)
        throw new Error(lines.join('\n') || 'Liquidsoap volume command failed');
}
export async function setLiquidsoapMicrophone(enabled) {
    const { ok, lines } = await sendLiquidsoapCommand(`imperial_radio.mic ${enabled ? 'on' : 'off'}`);
    if (!ok)
        throw new Error(lines.join('\n') || 'Liquidsoap microphone command failed');
}
