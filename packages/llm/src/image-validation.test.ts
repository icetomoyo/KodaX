import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { validateImageBytes } from './image-validation.js';

const fixtures = new URL('../../../tests/fixtures/images/', import.meta.url);
it.each([
  ['valid.jpg', 'image/jpeg'], ['valid-png.png', 'image/png'],
  ['valid.gif', 'image/gif'], ['valid.webp', 'image/webp'],
  ['progressive.jpg', 'image/jpeg'], ['cmyk.jpg', 'image/jpeg'],
  ['oriented.jpg', 'image/jpeg'], ['alpha.png', 'image/png'],
  ['lossless.webp', 'image/webp'], ['animated.gif', 'image/gif'], ['wide.png', 'image/png'],
])('preserves valid %s bytes and reports their actual MIME', async (name, mediaType) => {
  const bytes = await readFile(new URL(name!, fixtures));
  const original = Buffer.from(bytes);
  await expect(validateImageBytes(bytes)).resolves.toEqual({ status: 'valid', mediaType });
  expect(bytes).toEqual(original);
});

it.each(['missing-sof.jpg', 'truncated-jpeg.jpg', 'png-header-only.png', 'empty.jpg'])(
  'rejects undecodable %s', async (name) => {
    await expect(validateImageBytes(await readFile(new URL(name, fixtures)))).resolves.toEqual({ status: 'invalid' });
  },
);

it('treats the local byte limit as unverified rather than corruption', async () => {
  await expect(validateImageBytes(Buffer.alloc(10 * 1024 * 1024 + 1))).resolves.toEqual({
    status: 'unverified', reason: 'processing_limit',
  });
});

it('snapshots caller-owned bytes before asynchronous inspection', async () => {
  const bytes = await readFile(new URL('valid-png.png', fixtures));
  // Unique PNG text after IEND keeps this case independent of the validated-fixture cache.
  const mutable = Buffer.concat([bytes, Buffer.from('snapshot-control')]);
  const validation = validateImageBytes(mutable);
  mutable.fill(0);
  await expect(validation).resolves.toMatchObject({ status: 'valid' });
});

it('does not decode images exceeding the local pixel budget', async () => {
  const header = await readFile(new URL('valid-png.png', fixtures));
  header.writeUInt32BE(1_000_000, 16);
  await expect(validateImageBytes(header)).resolves.toEqual({
    status: 'unverified', reason: 'processing_limit', mediaType: 'image/png',
  });
});

it('rejects zero-sized image metadata', async () => {
  const header = await readFile(new URL('valid-png.png', fixtures));
  header.writeUInt32BE(0, 16);
  await expect(validateImageBytes(header)).resolves.toEqual({ status: 'invalid' });
});

it('shares the verdict for repeated identical bytes', async () => {
  const bytes = await readFile(new URL('valid-png.png', fixtures));
  expect(await validateImageBytes(Buffer.from(bytes))).toEqual(await validateImageBytes(bytes));
});

it('does not confuse a format outside the inline decoder set with corruption', async () => {
  const bmp = await new Jimp({ width: 2, height: 2, color: 0x2266ccff }).getBuffer('image/bmp');
  await expect(validateImageBytes(Buffer.from(bmp))).resolves.toEqual({
    status: 'unverified', reason: 'unsupported_format',
  });
});
