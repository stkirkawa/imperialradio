import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { MultipartFile } from '@fastify/multipart';
import { saveUpload } from '../src/services/upload.service.js';

const testDirs: string[] = [];
afterEach(async () => {
  await Promise.all(testDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('security regressions', () => {
  it('does not retain truncated uploads', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'imperial-upload-'));
    testDirs.push(dir);
    const file = Object.assign(Readable.from([Buffer.from('partial')]), { truncated: true });
    await expect(saveUpload({ filename: 'track.mp3', file } as unknown as MultipartFile, dir, ['.mp3']))
      .rejects.toThrow('maximum allowed size');
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not retain files from broken input streams', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'imperial-upload-'));
    testDirs.push(dir);
    const file = Readable.from((async function* () {
      yield Buffer.from('partial');
      throw new Error('Connection interrupted');
    })());
    await expect(saveUpload({ filename: 'track.mp3', file } as unknown as MultipartFile, dir, ['.mp3']))
      .rejects.toThrow('Connection interrupted');
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps untrusted titles and artist options out of HTML interpolation', async () => {
    const home = await readFile(path.join(process.cwd(), 'public/index.html'), 'utf8');
    const admin = await readFile(path.join(process.cwd(), 'public/admin.html'), 'utf8');
    expect(home).toContain('label.textContent = title');
    expect(home).not.toContain('${h.title}');
    expect(admin).toContain('option.value = artist');
    expect(admin).not.toContain('<option value="${a}">');
  });
});
