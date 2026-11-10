import { describe, expect, it, vi } from 'vitest';
import { createRadioServicesController } from '../src/services/radioServices.service.js';

describe('radio service controls', () => {
  it('only reads status for the configured radio service units', async () => {
    const run = vi.fn(async () => 'active');
    const controller = createRadioServicesController(run);

    const services = await controller.list();

    expect(services.map(({ id, status }) => [id, status])).toEqual([
      ['liquidsoap', 'active'],
      ['icecast', 'active'],
      ['mediamtx', 'active']
    ]);
    expect(run).toHaveBeenCalledTimes(3);
    for (const [command, args] of run.mock.calls) {
      expect(command).toBe('/usr/bin/systemctl');
      expect(args).toEqual(['show', '--property=ActiveState', '--value', expect.stringMatching(/\.service$/)]);
    }
  });

  it('requests a restart only for the selected allowlisted service', async () => {
    const run = vi.fn(async () => 'active');
    const controller = createRadioServicesController(run);

    await expect(controller.restart('liquidsoap')).resolves.toMatchObject({
      id: 'liquidsoap',
      status: 'active',
      restarting: true
    });

    expect(run).toHaveBeenNthCalledWith(1, '/run/imperialradio-service-control.sock', [
      'liquidsoap'
    ], 45_000);
    expect(run).toHaveBeenNthCalledWith(2, '/usr/bin/systemctl', [
      'show',
      '--property=ActiveState',
      '--value',
      'imperialradio-liquidsoap.service'
    ], 5_000);
  });

  it('rejects concurrent restarts of the same service', async () => {
    let finishRestart!: (result: string) => void;
    const run = vi.fn((command: string) => command === '/run/imperialradio-service-control.sock'
      ? new Promise<string>((resolve) => { finishRestart = resolve; })
      : Promise.resolve('active'));
    const controller = createRadioServicesController(run);
    const firstRestart = controller.restart('icecast');

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await expect(controller.restart('icecast')).rejects.toThrow('already restarting');
    finishRestart('');
    await expect(firstRestart).resolves.toMatchObject({ id: 'icecast', status: 'active' });
  });
});
