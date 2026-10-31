import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { generateImages } from '@kodax-ai/llm';
import { publishGeneratedImages } from './sdk-media.js';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import type { KodaXGeneratedImage } from '@kodax-ai/llm';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('publishes complete model bytes in the Host-selected directory and registers real artifacts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-generated-images-'));
  const bytes = await readFile('tests/fixtures/images/valid-png.png');
  vi.stubEnv('IMAGE_KEY', 'fixture');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ b64_json: bytes.toString('base64'), media_type: 'image/png', filename: '../untrusted.exe' }] })));
  const runtime = await createKodaXRuntime({ homeDir: directory });
  try {
    const result = await generateImages({ name: 'images', api: 'openrouter-images', dialect: 'images', model: 'fixture', baseUrl: 'https://image.example/v1', apiKeyEnv: 'IMAGE_KEY' }, { prompt: 'A tree' });
    const artifacts = await publishGeneratedImages({ images: result.images, directory, artifacts: runtime.artifacts });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ kind: 'image', mediaType: 'image/png', sizeBytes: bytes.length });
    expect(path.dirname(artifacts[0]!.path)).toBe(directory);
    expect(path.basename(artifacts[0]!.path)).toMatch(/^generated-[a-f0-9-]+\.png$/);
    expect(await readFile(artifacts[0]!.path)).toEqual(bytes);
    expect(await runtime.artifacts.get(artifacts[0]!.id)).toEqual(artifacts[0]);
    expect((await readdir(directory)).includes('untrusted.exe')).toBe(false);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);

it('revalidates restored image results and removes files and registrations after a publication failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-image-rollback-'));
  const bytes = await readFile('tests/fixtures/images/valid-png.png');
  const image: KodaXGeneratedImage = { data: bytes.toString('base64'), mediaType: 'image/png', validation: { status: 'valid', mediaType: 'image/png' } };
  const runtime = await createKodaXRuntime({ homeDir: directory });
  try {
    let firstId: string | undefined, count = 0;
    await expect(publishGeneratedImages({ images: [image, image], directory, artifacts: {
      delete: id => runtime.artifacts.delete(id), create: async input => {
        if (++count === 2) throw new Error('Registration unavailable');
        const artifact = await runtime.artifacts.create(input); firstId = artifact.id; return artifact;
      },
    } })).rejects.toThrow('Registration unavailable');
    expect((await readdir(directory)).filter(name => name.startsWith('generated-'))).toEqual([]);
    expect(await runtime.artifacts.get(firstId!)).toBeUndefined();
    await expect(publishGeneratedImages({ images: [{ ...image, data: Buffer.from('invalid').toString('base64') }], directory, artifacts: runtime.artifacts })).rejects.toThrow(/decoded/);
    await expect(publishGeneratedImages({ images: [{ ...image, mediaType: 'image/jpeg' }], directory, artifacts: runtime.artifacts })).rejects.toThrow(/matching MIME/);
    const signal = AbortSignal.abort();
    await expect(publishGeneratedImages({ images: [image], directory, artifacts: runtime.artifacts, signal })).rejects.toThrow();
    expect((await readdir(directory)).filter(name => name.startsWith('generated-'))).toEqual([]);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);
