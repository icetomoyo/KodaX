import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { validateImageBytes } from './image-validation.js';
import { prepareImageFile } from './providers/image-serialization.js';
import { fileURLToPath } from 'node:url';

const state = vi.hoisted(() => ({ unavailable: true, hang: false }));
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (state.unavailable) throw new Error('Simulated host without a decoder worker');
      super(state.hang ? 'setInterval(() => {}, 1000)' : args[0], args[1]);
    }
  } };
});
afterEach(() => { state.unavailable = true; state.hang = false; vi.unstubAllEnvs(); });

it('retains valid bytes when the decoder cannot start and validates after it recovers', async () => {
  const file = new URL('../../../tests/fixtures/images/valid.webp', import.meta.url);
  const bytes = await readFile(file);
  await expect(validateImageBytes(bytes)).resolves.toEqual({
    status: 'unverified', reason: 'decoder_unavailable', mediaType: 'image/webp',
  });
  await expect(prepareImageFile(fileURLToPath(file), 'image/jpeg')).resolves.toEqual({
    data: bytes.toString('base64'), mediaType: 'image/webp',
    notice: '[Local image validation unavailable (decoder_unavailable); original image bytes retained.]',
  });
  state.unavailable = false;
  await expect(validateImageBytes(bytes)).resolves.toEqual({ status: 'valid', mediaType: 'image/webp' });
});

it('missing standalone assets do not classify a normal PNG as corrupt', async () => {
  const bytes = await readFile(new URL('../../../tests/fixtures/images/valid-png.png', import.meta.url));
  vi.stubEnv('KODAX_BUNDLED', 'true');
  await expect(validateImageBytes(bytes)).resolves.toEqual({
    status: 'unverified', reason: 'decoder_unavailable', mediaType: 'image/png',
  });
  vi.unstubAllEnvs();
  state.unavailable = false;
  await expect(validateImageBytes(bytes)).resolves.toEqual({ status: 'valid', mediaType: 'image/png' });
});

it('includes queue wait in the decoder deadline and releases its slot for later validation', async () => {
  const png = await readFile(new URL('../../../tests/fixtures/images/valid-png.png', import.meta.url));
  const bytes = Buffer.concat([png, Buffer.from('worker-timeout-control')]);
  state.unavailable = false;
  state.hang = true;
  const started = performance.now();
  const queuedBytes = Buffer.concat([png, Buffer.from('queued-worker-timeout-control')]);
  const [first, queued] = await Promise.all([validateImageBytes(bytes), validateImageBytes(queuedBytes)]);
  expect(first).toEqual({
    status: 'unverified', reason: 'decoder_unavailable', mediaType: 'image/png',
  });
  expect(queued.status).toBe('unverified');
  expect(performance.now() - started).toBeLessThan(15_000);
  state.hang = false;
  await expect(validateImageBytes(bytes)).resolves.toEqual({ status: 'valid', mediaType: 'image/png' });
}, 30_000);
