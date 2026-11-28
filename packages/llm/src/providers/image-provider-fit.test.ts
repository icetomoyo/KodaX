import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { imageSize } from 'image-size';
import { Jimp } from 'jimp';
import { afterEach, expect, it, vi } from 'vitest';
import * as validation from '../image-validation.js';
import { markPreparedImagesAccepted, prepareImageBlock, prepareImageFile, prepareValidatedImageBlock, reducePreparedImages,
  unacceptedPreparedImages, withPreparedImageHistory } from './image-serialization.js';

// Issue 449: DeepSeek rejects any side over 8192 px and Anthropic over 8000 px. A full-page
// screenshot read once stayed in history and failed every later request of the session.
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});

async function imageFile(width: number, height: number, mime: 'image/png' | 'image/jpeg'): Promise<{ file: string; bytes: Buffer }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-fit-'));
  directories.push(directory);
  const bytes = Buffer.from(await new Jimp({ width, height, color: 0x3366ccff }).getBuffer(mime));
  const file = path.join(directory, mime === 'image/png' ? 'shot.png' : 'shot.jpg');
  await writeFile(file, bytes);
  return { file, bytes };
}

function sentSize(image: Awaited<ReturnType<typeof prepareImageFile>>) {
  if ('placeholder' in image) throw new Error(image.placeholder);
  const { width, height } = imageSize(Buffer.from(image.data, 'base64'));
  return { width, height, mediaType: image.mediaType, notice: image.notice };
}

it('reports the pixel size of a valid image', async () => {
  const { bytes } = await imageFile(520, 300, 'image/png');
  await expect(validation.validateImageBytes(bytes)).resolves.toEqual({ status: 'valid', mediaType: 'image/png', width: 520, height: 300 });
});

it('scales a tall screenshot under the provider side limit and tells the model the original size', async () => {
  const { file, bytes } = await imageFile(520, 9800, 'image/png');
  const sent = sentSize(await prepareImageFile(file, 'image/png'));
  expect(sent).toMatchObject({ width: 424, height: 8000, mediaType: 'image/png' });
  expect(sent.notice).toContain('520x9800');
  expect(sent.notice).toContain('424x8000');
  expect(await readFile(file)).toEqual(bytes);
});

it('keeps JPEG sources as JPEG', async () => {
  const { file } = await imageFile(9000, 200, 'image/jpeg');
  expect(sentSize(await prepareImageFile(file))).toMatchObject({ width: 8000, height: 178, mediaType: 'image/jpeg' });
});

it('sends images at the limit unchanged', async () => {
  const { file, bytes } = await imageFile(300, 8000, 'image/png');
  const image = await prepareImageFile(file);
  expect(image).toEqual({ data: bytes.toString('base64'), mediaType: 'image/png' });
});

it('scales oversized tool images that were admitted with their validation', async () => {
  const { file, bytes } = await imageFile(520, 9800, 'image/png');
  const block = { type: 'image' as const, path: file, mediaType: 'image/png' };
  await withPreparedImageHistory(async () => {
    prepareValidatedImageBlock(block, bytes, await validation.validateImageBytes(bytes));
    expect(sentSize(await prepareImageBlock(block))).toMatchObject({ width: 424, height: 8000 });
  });
});

const block = (file: string) => ({ type: 'image' as const, path: file, mediaType: 'image/png' });
const request = (...content: ReturnType<typeof block>[]) => [{ role: 'user' as const, content }];
let targetSeq = 0;
const freshTarget = (): string => `test-provider\0model-${++targetSeq}`;

it('reduces to 2000 px only the images this provider has not accepted, whatever the rejection says', async () => {
  const target = freshTarget();
  const accepted = block((await imageFile(3000, 600, 'image/png')).file);
  const tall = block((await imageFile(520, 9800, 'image/png')).file);
  const small = block((await imageFile(1200, 800, 'image/png')).file);
  await withPreparedImageHistory(async () => {
    await prepareImageBlock(accepted);
    markPreparedImagesAccepted(request(accepted), target);
    expect(await reducePreparedImages(request(accepted, small), target, false)).toBe(false);
    expect(sentSize(await prepareImageBlock(tall))).toMatchObject({ width: 424, height: 8000 });
    expect(await reducePreparedImages(request(accepted, small, tall), target, false)).toBe(true);
    const reduced = sentSize(await prepareImageBlock(tall));
    expect(reduced).toMatchObject({ width: 106, height: 2000 });
    expect(reduced.notice).toContain('520x9800');
    // Accepted bytes stay byte-identical, so the cached prefix survives.
    expect(sentSize(await prepareImageBlock(accepted))).toMatchObject({ width: 3000, height: 600, notice: undefined });
    expect(sentSize(await prepareImageBlock(small))).toMatchObject({ width: 1200, height: 800, notice: undefined });
    // A later image is judged on its own.
    const later = block((await imageFile(3000, 100, 'image/png')).file);
    expect(sentSize(await prepareImageBlock(later))).toMatchObject({ width: 3000, height: 100 });
    expect(await reducePreparedImages(request(accepted, tall), target, false)).toBe(false);
  });
});

it('reduces every image when all were accepted but the rejection mentions images', async () => {
  const target = freshTarget();
  const accepted = block((await imageFile(3000, 600, 'image/png')).file);
  const later = block((await imageFile(3000, 100, 'image/png')).file);
  await withPreparedImageHistory(async () => {
    await prepareImageBlock(accepted);
    markPreparedImagesAccepted(request(accepted), target);
    expect(await reducePreparedImages(request(accepted), target, true)).toBe(true);
    expect(sentSize(await prepareImageBlock(accepted))).toMatchObject({ width: 2000, height: 400 });
    expect(sentSize(await prepareImageBlock(later))).toMatchObject({ width: 2000, height: 67 });
    expect(await reducePreparedImages(request(accepted, later), target, true)).toBe(false);
  });
});

it('tracks acceptance per provider and model by the bytes sent', async () => {
  const target = freshTarget();
  const tall = block((await imageFile(520, 9800, 'image/png')).file);
  const other = block((await imageFile(400, 300, 'image/png')).file);
  await withPreparedImageHistory(async () => {
    await prepareImageBlock(tall);
    await prepareImageBlock(other);
    expect(unacceptedPreparedImages(request(tall, other), target)).toEqual([tall, other]);
    markPreparedImagesAccepted(request(tall), target);
    expect(unacceptedPreparedImages(request(tall, other), target)).toEqual([other]);
    expect(unacceptedPreparedImages(request(tall, other), freshTarget())).toEqual([tall, other]);
  });
  // A later run sends the same bytes, so the image stays accepted.
  await withPreparedImageHistory(async () => {
    await prepareImageBlock(tall);
    expect(unacceptedPreparedImages(request(tall), target)).toEqual([]);
    expect(await reducePreparedImages(request(tall), target, false)).toBe(false);
  });
});

it('does not retry the same image when the codec cannot scale it', async () => {
  const target = freshTarget();
  const tall = block((await imageFile(520, 9800, 'image/png')).file);
  await withPreparedImageHistory(async () => {
    await prepareImageBlock(tall);
    vi.spyOn(validation, 'scaleImageBytes').mockResolvedValue(undefined);
    expect(await reducePreparedImages(request(tall), target, false)).toBe(true);
    expect(await reducePreparedImages(request(tall), target, false)).toBe(false);
  });
});

it('does not reduce or report images outside a run', async () => {
  const { file } = await imageFile(520, 9800, 'image/png');
  expect(await reducePreparedImages(request(block(file)), freshTarget(), true)).toBe(false);
  expect(unacceptedPreparedImages(request(block(file)), freshTarget())).toEqual([]);
});

it('keeps the original bytes when the local codec cannot scale them', async () => {
  const { file, bytes } = await imageFile(520, 9800, 'image/png');
  vi.spyOn(validation, 'scaleImageBytes').mockResolvedValue(undefined);
  expect(await prepareImageFile(file)).toEqual({ data: bytes.toString('base64'), mediaType: 'image/png' });
});
