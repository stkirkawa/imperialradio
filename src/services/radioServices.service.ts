import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';

const serviceControlSocket = '/run/imperialradio-service-control.sock';

const serviceDefinitions = [
  {
    id: 'liquidsoap',
    name: 'AutoDJ (Liquidsoap)',
    description: 'Вещание плейлистов и очереди DJ.',
    unit: 'imperialradio-liquidsoap.service'
  },
  {
    id: 'icecast',
    name: 'Icecast',
    description: 'Сервер аудиопотока. Перезапуск прервёт соединения слушателей.',
    unit: 'icecast2.service'
  },
  {
    id: 'mediamtx',
    name: 'MediaMTX',
    description: 'Входы OBS и браузерного микрофона. Перезапуск отключит активные источники.',
    unit: 'mediamtx.service'
  }
] as const;

export type RadioServiceId = typeof serviceDefinitions[number]['id'];
export type RadioServiceStatus = typeof serviceDefinitions[number] & {
  status: string;
  restarting: boolean;
};

type CommandRunner = (command: string, args: string[], timeout: number) => Promise<string>;

function runCommand(command: string, args: string[], timeout: number): Promise<string> {
  if (command === serviceControlSocket) {
    return new Promise((resolve, reject) => {
      let output = '';
      const socket = createConnection(serviceControlSocket);
      socket.setEncoding('utf8');
      socket.setTimeout(timeout, () => socket.destroy(new Error('Service control request timed out')));
      socket.once('connect', () => socket.end(`${JSON.stringify({ service: args[0] })}\n`));
      socket.on('data', (chunk: string) => { output += chunk; });
      socket.once('error', reject);
      socket.once('end', () => {
        let response: { ok?: boolean; status?: string; error?: string };
        try {
          response = JSON.parse(output) as typeof response;
        } catch {
          reject(new Error('Invalid response from service control helper'));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error || 'Service restart failed'));
          return;
        }
        resolve(response.status || '');
      });
    });
  }

  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 16 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (stderr.trim()) error.message += `: ${stderr.trim()}`;
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export function createRadioServicesController(run: CommandRunner = runCommand) {
  const restarting = new Set<RadioServiceId>();

  async function getStatus(service: typeof serviceDefinitions[number]): Promise<RadioServiceStatus> {
    const status = await run('/usr/bin/systemctl', [
      'show',
      '--property=ActiveState',
      '--value',
      service.unit
    ], 5_000);
    return { ...service, status, restarting: restarting.has(service.id) };
  }

  return {
    async list(): Promise<RadioServiceStatus[]> {
      return Promise.all(serviceDefinitions.map(getStatus));
    },

    async restart(id: RadioServiceId): Promise<RadioServiceStatus> {
      const service = serviceDefinitions.find((item) => item.id === id);
      if (!service) throw new Error('Unknown radio service');
      if (restarting.has(id)) throw new Error('Radio service is already restarting');

      restarting.add(id);
      try {
        await run(serviceControlSocket, [id], 45_000);
        return await getStatus(service);
      } finally {
        restarting.delete(id);
      }
    }
  };
}

export const radioServices = createRadioServicesController();
