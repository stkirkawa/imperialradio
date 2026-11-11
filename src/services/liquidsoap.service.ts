import net from 'node:net';
import { env } from '../config/env.js';

export type LiquidsoapResponse = {
  lines: string[];
  ok: boolean;
};

const END_RE = /(?:^|\r?\n)END\r?\n/;

export async function sendLiquidsoapCommand(command: string, timeoutMs = 4000): Promise<LiquidsoapResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: env.LIQUIDSOAP_HOST, port: env.LIQUIDSOAP_PORT });
    let buffer = '';
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) return reject(err);
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
      if (buffer.length > 64 * 1024) return finish(new Error('Liquidsoap response too large'));
      if (END_RE.test(buffer)) return finish();
    });

    socket.on('connect', () => {
      socket.write(`${command.trim()}\n`);
    });
  });
}

export async function setLiquidsoapVolume(percent: number): Promise<void> {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error('Volume must be an integer between 0 and 100');
  }
  const { ok, lines } = await sendLiquidsoapCommand(`imperial_radio.volume ${percent}`);
  if (!ok) throw new Error(lines.join('\n') || 'Liquidsoap volume command failed');
}

export async function setLiquidsoapMicrophone(enabled: boolean): Promise<void> {
  const { ok, lines } = await sendLiquidsoapCommand(`imperial_radio.mic ${enabled ? 'on' : 'off'}`);
  if (!ok) throw new Error(lines.join('\n') || 'Liquidsoap microphone command failed');
}
