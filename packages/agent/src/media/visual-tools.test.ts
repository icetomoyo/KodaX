import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgent } from '../primitives/agent.js';
import { withPreparedImageHistory, getPreparedImageDiagnostic, prepareHistoryImages } from '@kodax-ai/llm';
import { createFileVisualObservationOwner, type VisualObservation } from './visual-observations.js';
import { createVisualTools } from './visual-tools.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-tools-')); roots.push(directory);
  const records: VisualObservation[] = [];
  const owner = createFileVisualObservationOwner({ ownerId: 'owner', directory, list: async () => records });
  const image = new Jimp({ width: 3, height: 2 });
  image.bitmap.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    0, 255, 255, 128, 255, 0, 255, 0, 255, 255, 255, 255]);
  const bytes = await image.getBuffer('image/png');
  const admit = async (sourceKey = 'user') => {
    const observation = await owner.pin(bytes, { sourceKey, mediaType: 'image/png', originEntryId: 'entry' });
    records.push(observation); return observation;
  };
  const reserveOutput = vi.fn(() => ({ cancel: vi.fn() }));
  const tools = createVisualTools({ owner, reserveOutput });
  const call = (name: string, input: Record<string, unknown>, signal?: AbortSignal) => tools.find(tool => tool.name === name)!
    .execute(input, { agent: createAgent({ name: 'visual fixture', instructions: '' }), abortSignal: signal });
  return { owner, records, bytes, admit, call, reserveOutput };
}

it('scopes restored-image integrity to owned paths, including Windows path casing', async () => {
  const f = await fixture(); const observation = await f.admit();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'kodax-unowned-hash-image-')); roots.push(outside);
  const replacement = await new Jimp({ width: 2, height: 2, color: 0x0000ffff }).getBuffer('image/png');
  const unowned = { type: 'image' as const, path: path.join(outside, observation.sha256) };
  await writeFile(unowned.path, replacement);
  const ownedPath = f.owner.imagePath(observation);
  const owned = { type: 'image' as const, path: process.platform === 'win32' ? ownedPath.toUpperCase() : ownedPath };
  const messages = [{ role: 'user' as const, content: [owned, unowned] }];
  const integrity = f.owner.expectedImageHash?.bind(f.owner);
  await withPreparedImageHistory(async () => {
    await prepareHistoryImages(messages);
    expect(getPreparedImageDiagnostic(owned)).toMatchObject({ dataHash: observation.sha256 });
    expect(getPreparedImageDiagnostic(unowned)).toMatchObject({ dataHash: createHash('sha256').update(replacement).digest('hex') });
  }, undefined, undefined, integrity);
  await writeFile(ownedPath, replacement);
  await withPreparedImageHistory(async () => {
    await prepareHistoryImages(messages);
    expect(getPreparedImageDiagnostic(owned)).toMatchObject({ placeholder: expect.stringMatching(/integrity/i) });
    expect(getPreparedImageDiagnostic(unowned)).toMatchObject({ dataHash: createHash('sha256').update(replacement).digest('hex') });
  }, undefined, undefined, integrity);
});

it('pages a fixed recent frontier without reading images; a new query sees subsequent events', async () => {
  const f = await fixture();
  const first = await f.admit(); const second = await f.admit(); const third = await f.admit();
  const read = vi.spyOn(f.owner, 'read');
  const page = JSON.parse((await f.call('visual_history', { limit: 1 })).content as string) as {
    observations: VisualObservation[]; nextCursor: string;
  };
  expect(page.observations.map(item => item.observationId)).toEqual([third.observationId]);
  await f.admit();
  const remaining = JSON.parse((await f.call('visual_history', { limit: 2, cursor: page.nextCursor })).content as string) as { observations: VisualObservation[] };
  expect(remaining.observations.map(item => item.observationId)).toEqual([second.observationId, first.observationId]);
  expect((await f.call('visual_history', { cursor: page.nextCursor, sourceKey: 'different' })).isError).toBe(true);
  expect((await f.call('visual_history', { cursor: 'broken' })).isError).toBe(true);
  expect((await f.call('visual_history', { limit: 0 })).isError).toBe(true);
  expect(read).not.toHaveBeenCalled(); expect(f.reserveOutput).not.toHaveBeenCalled();
});

it('crops original raster coordinates and enlarges with nearest-neighbor RGBA while preserving identity', async () => {
  const f = await fixture(); const observation = await f.admit();
  const result = await f.call('visual_inspect', { question: 'Check the right two columns.',
    views: [{ label: 'detail', observationId: observation.observationId, region: { x: 1, y: 0, width: 2, height: 2 }, displayLongEdge: 4 }] });
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result.content)).toContain(observation.observationId);
  expect(JSON.stringify(result.content)).toContain('nearest');
  expect(Array.isArray(result.content)).toBe(true);
  if (!Array.isArray(result.content)) throw new Error('Expected actual image.');
  const output = result.content.find(item => item.type === 'image');
  if (!output || output.type !== 'image') throw new Error('Expected actual image.');
  const raster = await Jimp.read(output.path);
  expect([raster.bitmap.width, raster.bitmap.height]).toEqual([4, 4]);
  expect([...raster.bitmap.data.subarray(0, 16)]).toEqual([0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
  expect([...raster.bitmap.data.subarray(32, 36)]).toEqual([255, 0, 255, 0]);
  expect(f.records).toHaveLength(1);
});

it('returns ordered regions and repeated observations while decoding an original only once', async () => {
  const f = await fixture(); const first = await f.admit(); const second = await f.admit('later');
  const decode = vi.spyOn(Jimp, 'read');
  let result: Awaited<ReturnType<typeof f.call>>;
  try {
    result = await f.call('visual_inspect', { question: 'Compare the old and later regions.', views: [
      { label: 'right', observationId: first.observationId, region: { x: 2, y: 0, width: 1, height: 1 } },
      { label: 'later', observationId: second.observationId, region: { x: 0, y: 1, width: 1, height: 1 } },
      { label: 'right again', observationId: first.observationId, region: { x: 2, y: 0, width: 1, height: 1 } },
    ] });
    expect(result.isError).not.toBe(true);
    expect(decode).toHaveBeenCalledOnce();
  } finally { decode.mockRestore(); }
  if (!Array.isArray(result.content)) throw new Error('Expected ordered image content.');
  const images = result.content.filter(item => item.type === 'image');
  expect(images).toHaveLength(3);
  const pixels = await Promise.all(images.map(async item => [...(await Jimp.read(item.path)).bitmap.data]));
  expect(pixels).toEqual([[0, 0, 255, 255], [0, 255, 255, 128], [0, 0, 255, 255]]);
  const labels = result.content.filter(item => item.type === 'text').map(item => item.text);
  expect(labels[0]).toContain('View right:'); expect(labels[0]).toContain(first.observationId);
  expect(labels[1]).toContain('View later:'); expect(labels[1]).toContain(second.observationId);
  expect(labels[2]).toContain('View right again:');
  expect(f.records).toHaveLength(2);
  expect(f.reserveOutput).toHaveBeenCalledOnce();
  expect(f.reserveOutput.mock.results[0]!.value.cancel).not.toHaveBeenCalled();
});

it('retains successful view reservations when another derived output fails', async () => {
  const f = await fixture(); const observation = await f.admit();
  const write = f.owner.writeDerived.bind(f.owner);
  vi.spyOn(f.owner, 'writeDerived').mockImplementationOnce(write).mockRejectedValueOnce(new Error('Derived write failed.'));
  const result = await f.call('visual_inspect', { question: 'Compare.', views: ['first', 'failed', 'last'].map(label =>
    ({ label, observationId: observation.observationId, region: { x: 0, y: 0, width: 1, height: 1 } })) });
  expect(result.isError).toBe(true);
  if (!Array.isArray(result.content)) throw new Error('Expected partial image content.');
  expect(result.content.filter(item => item.type === 'image')).toHaveLength(2);
  const summary = result.content.at(-1);
  if (summary?.type !== 'text') throw new Error('Expected partial status.');
  expect(JSON.parse(summary.text)).toEqual({ status: 'partial', failedViews: [1] });
  expect(JSON.stringify(result.content)).toContain('Derived write failed.');
  expect(f.reserveOutput.mock.results[0]!.value.cancel).not.toHaveBeenCalled();
});

it('keeps a small view when a later PNG encoding exceeds the display byte limit', async () => {
  const f = await fixture(); const noise = new Jimp({ width: 1100, height: 1100 });
  let seed = 123456789;
  for (let offset = 0; offset < noise.bitmap.data.length; offset += 4) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    noise.bitmap.data.writeUInt32BE(seed >>> 0, offset);
  }
  const observation = await f.owner.pin(await noise.getBuffer('image/png'),
    { sourceKey: 'noise', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(observation);
  const result = await f.call('visual_inspect', { question: 'Inspect only what fits.', views: [
    { label: 'small', observationId: observation.observationId, region: { x: 0, y: 0, width: 1, height: 1 } },
    { label: 'oversized', observationId: observation.observationId, region: { x: 0, y: 0, width: 1100, height: 1100 } },
  ] });
  expect(result.isError).toBe(true);
  expect(Array.isArray(result.content)).toBe(true);
  if (!Array.isArray(result.content)) throw new Error('Expected retained partial output.');
  expect(result.content.filter(item => item.type === 'image')).toHaveLength(1);
  expect(JSON.stringify(result.content)).toContain('byte limit');
  expect(f.reserveOutput.mock.results[0]!.value.cancel).not.toHaveBeenCalled();
});

it('rejects a late invalid region before reading any source or reserving output', async () => {
  const f = await fixture(); const observation = await f.admit(); const read = vi.spyOn(f.owner, 'read');
  const decode = vi.spyOn(Jimp, 'read');
  try {
    const result = await f.call('visual_inspect', { question: 'Compare.', views: [
      { label: 'valid', observationId: observation.observationId, displayLongEdge: 6 },
      { label: 'outside', observationId: observation.observationId, region: { x: 2, y: 0, width: 2, height: 1 } },
    ] });
    expect(result.isError).toBe(true); expect(result.content).toContain('outside the original raster');
    expect(read).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(f.reserveOutput).not.toHaveBeenCalled();
  } finally { decode.mockRestore(); }
});

it('keeps missing-source errors in their requested slot without refunding retained sibling images', async () => {
  const f = await fixture(); const first = await f.admit();
  const missing = await f.owner.pin(await new Jimp({ width: 2, height: 1 }).getBuffer('image/png'),
    { sourceKey: 'missing', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(missing); await unlink(f.owner.imagePath(missing));
  const result = await f.call('visual_inspect', { question: 'Compare.', views: [
    { label: 'before', observationId: first.observationId }, { label: 'missing', observationId: missing.observationId },
    { label: 'after', observationId: first.observationId },
  ] });
  expect(result.isError).toBe(true);
  if (!Array.isArray(result.content)) throw new Error('Expected ordered partial results.');
  expect(result.content.map(item => item.type)).toEqual(['text', 'image', 'text', 'text', 'image', 'text']);
  const failed = result.content[2];
  expect(failed?.type === 'text' && failed.text).toContain('View missing:');
  expect(failed?.type === 'text' && failed.text).toContain('Visual observation missing.');
  expect(f.reserveOutput.mock.results[0]!.value.cancel).not.toHaveBeenCalled();
  expect(f.records).toHaveLength(2);
});

it('retains ordered error slots and their text capacity when every source fails', async () => {
  const f = await fixture(); const first = await f.admit();
  const second = await f.owner.pin(await new Jimp({ width: 1, height: 1 }).getBuffer('image/png'),
    { sourceKey: 'other', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(second);
  await unlink(f.owner.imagePath(first)); await unlink(f.owner.imagePath(second));
  const result = await f.call('visual_inspect', { question: 'Compare.', views: [
    { label: 'A0', observationId: first.observationId }, { label: 'B1', observationId: second.observationId },
    { label: 'A2', observationId: first.observationId },
  ] });
  expect(result.isError).toBe(true);
  if (!Array.isArray(result.content)) throw new Error('Expected ordered per-view errors.');
  const texts = result.content.filter(item => item.type === 'text').map(item => item.text);
  expect(texts[0]).toContain('View A0:'); expect(texts[1]).toContain('View B1:'); expect(texts[2]).toContain('View A2:');
  expect(JSON.parse(texts[3]!)).toEqual({ status: 'error', failedViews: [0, 1, 2] });
  expect(f.reserveOutput.mock.results[0]!.value.cancel).toHaveBeenCalledOnce();
  expect(f.reserveOutput).toHaveBeenCalledTimes(2);
  expect(f.reserveOutput.mock.results[1]!.value.cancel).not.toHaveBeenCalled();
});

it('keeps an encoded first view if the same-source second encoding is cancelled', async () => {
  const f = await fixture(); const observation = await f.admit();
  const controller = new AbortController();
  let entered!: () => void; let release!: () => void; let encodes = 0;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = Jimp.prototype.getBuffer;
  const encode = vi.spyOn(Jimp.prototype, 'getBuffer').mockImplementation(async function (mime, options) {
    if (++encodes === 2) { entered(); await gate; }
    return Reflect.apply(original, this, [mime, options]);
  });
  try {
    const call = withPreparedImageHistory(async () => {
      const result = await f.call('visual_inspect', { question: 'Compare.', views: ['complete', 'cancelled'].map(label =>
        ({ label, observationId: observation.observationId, region: { x: 0, y: 0, width: 1, height: 1 } })) }, controller.signal);
      const image = Array.isArray(result.content) ? result.content.find(item => item.type === 'image') : undefined;
      expect(image && getPreparedImageDiagnostic(image)).toMatchObject({ mediaType: 'image/png' });
      return result;
    }, controller.signal);
    await pending; controller.abort(new Error('Cancelled second encoding.')); release();
    const result = await call;
    expect(result.isError).toBe(true);
    if (!Array.isArray(result.content)) throw new Error('Expected retained completed view.');
    expect(result.content.filter(item => item.type === 'image')).toHaveLength(1);
    expect(JSON.stringify(result.content)).toContain('Cancelled second encoding');
    expect(f.reserveOutput.mock.results[0]!.value.cancel).not.toHaveBeenCalled();
  } finally { release(); encode.mockRestore(); }
});

it('keeps identical bytes as distinct events and inspection does not append or reorder them', async () => {
  const f = await fixture(); const first = await f.admit(); const second = await f.admit();
  expect(first.sha256).toBe(second.sha256); expect(first.observationId).not.toBe(second.observationId);
  const input = { question: 'What was shown?', views: [{ label: 'old', observationId: first.observationId }] };
  const result = await f.call('visual_inspect', input);
  expect(result.isError).not.toBe(true); expect(JSON.stringify(result.content)).toContain(first.observationId);
  expect(f.records.map(item => item.observationId)).toEqual([first.observationId, second.observationId]);
  expect((await f.call('visual_inspect', { ...input, views: [{ label: 'foreign', observationId: 'obs_foreign' }] })).isError).toBe(true);
});

it('reports missing or corrupt immutable originals, releases failed output and honors cancellation', async () => {
  const f = await fixture(); const observation = await f.admit();
  const input = { question: 'Verify.', views: [{ label: 'original', observationId: observation.observationId }] };
  await writeFile(f.owner.imagePath(observation), 'corrupt');
  expect((await f.call('visual_inspect', input)).content).toContain('hash mismatch');
  expect(f.reserveOutput.mock.results[0]!.value.cancel).toHaveBeenCalledOnce();
  await unlink(f.owner.imagePath(observation));
  expect((await f.call('visual_inspect', input)).content).toContain('missing');
  expect((await f.call('visual_inspect', input, AbortSignal.abort(new Error('Cancelled inspection.')))).content).toContain('Cancelled inspection');
  expect(() => f.owner.imagePath({ ...observation, ownerId: 'foreign' })).toThrow('access denied');
  expect(() => f.owner.imagePath({ ...observation, sha256: '../outside' })).toThrow('access denied');
});

it('does not interpret filenames or invented labels as accepted observation IDs', async () => {
  const f = await fixture(); const observation = await f.admit();
  const read = vi.spyOn(f.owner, 'read');
  for (const observationId of ['sheet03', f.owner.imagePath(observation)]) {
    const result = await f.call('visual_inspect', { question: 'Check the reference.', views: [{ label: 'alias', observationId }] });
    expect(result.content).toContain('unavailable or access denied');
  }
  expect(read).not.toHaveBeenCalled();
  expect(f.records).toEqual([observation]);
  expect(f.reserveOutput).not.toHaveBeenCalled();
});

it('retains JPEG originals while refusing unsupported derivation and oversized full-image output', async () => {
  const f = await fixture();
  const smallJpeg = await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/jpeg');
  const small = await f.owner.pin(smallJpeg, { sourceKey: 'small-jpeg', originEntryId: 'entry', mediaType: 'image/jpeg' });
  f.records.push(small);
  const full = await f.call('visual_inspect', { question: 'Read the accepted JPEG.', views: [{ label: 'original', observationId: small.observationId }] });
  expect(full.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', mediaType: 'image/jpeg' })]));
  expect(await f.owner.read(small)).toEqual(smallJpeg);
  expect((await f.call('visual_read_pixels', { question: 'Do not silently derive JPEG pixels.', views: [{ label: 'unsupported',
    observationId: small.observationId, region: { x: 0, y: 0, width: 1, height: 1 }, rows: 1, columns: 1 }] })).content).toContain('unsupported');
  const jpeg = await new Jimp({ width: 2001, height: 1, color: 0xff0000ff }).getBuffer('image/jpeg');
  const observation = await f.owner.pin(jpeg, { sourceKey: 'jpeg', originEntryId: 'entry', mediaType: 'image/jpeg' });
  f.records.push(observation);
  const input = { question: 'Check.', views: [{ label: 'jpeg', observationId: observation.observationId }] };
  expect((await f.call('visual_inspect', input)).content).toContain('display limit');
  expect((await f.call('visual_inspect', { ...input, views: [{ ...input.views[0], region: { x: 0, y: 0, width: 1, height: 1 } }] })).content).toContain('unsupported');
  expect(await f.owner.read(observation)).toEqual(jpeg);
});

it('retains an EXIF-oriented PNG and rejects derived work before silently rotating its raster', async () => {
  const f = await fixture();
  // Valid 2x3 RGBA PNG with a CRC-checked TIFF Orientation=6 eXIf chunk.
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAGmVYSWZJSSoACAAAAAEAEgEDAAEAAAAGAAAAAAAAALdIESkAAAAWSURBVHgBY2T4z/CfAQiYGKCAiQEKADA8AgSs6/gbAAAAAElFTkSuQmCC', 'base64');
  const observation = await f.owner.pin(bytes, { sourceKey: 'oriented-png', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(observation);
  const decode = vi.spyOn(Jimp, 'read');
  try {
    const result = await f.call('visual_inspect', { question: 'Check the raster.',
      views: [{ label: 'unsupported direction', observationId: observation.observationId, displayLongEdge: 6 }] });
    expect(result.content).toContain('unsupported: PNG eXIf');
    expect(decode).not.toHaveBeenCalled();
    expect(await f.owner.read(observation)).toEqual(bytes);
    expect([observation.width, observation.height]).toEqual([2, 3]);
  } finally { decode.mockRestore(); }
});

it.each(['identical', '16-bit', 'different dimensions'] as const)('rejects a second IHDR before decoding: %s', async variant => {
  const f = await fixture();
  // A CRC-valid 3x2 RGBA16 PNG; its samples include low bits that an 8-bit decode loses.
  const png16 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACEAYAAADN5LpZAAAAF0lEQVR4AWNsYGxgbGBsYGRAA0wMOAAAXUoCCCyzKzsAAAAASUVORK5CYII=', 'base64');
  const second = variant === 'identical' ? f.bytes : variant === '16-bit' ? png16
    : await new Jimp({ width: 6, height: 1 }).getBuffer('image/png');
  const bytes = Buffer.concat([f.bytes.subarray(0, 33), second.subarray(8)]);
  const observation = await f.owner.pin(bytes, { sourceKey: 'duplicate-header', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(observation);
  const decode = vi.spyOn(Jimp, 'read');
  try {
    const result = await f.call('visual_inspect', { question: 'Check the original raster.',
      views: [{ label: 'invalid headers', observationId: observation.observationId, displayLongEdge: 6 }] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('IHDR');
    expect(decode).not.toHaveBeenCalled();
    expect(f.reserveOutput.mock.results[0]!.value.cancel).toHaveBeenCalledOnce();
    expect(await f.owner.read(observation)).toEqual(bytes);
  } finally { decode.mockRestore(); }
});

it.each(['checksum', 'wrong first chunk', 'short header', 'long header'] as const)('rejects an invalid IHDR before decoding: %s', async variant => {
  const f = await fixture(); const bytes = Buffer.from(f.bytes);
  if (variant === 'checksum') bytes[32] = bytes[32]! ^ 1;
  else if (variant === 'wrong first chunk') bytes.write('IDAT', 12, 'ascii');
  else bytes.writeUInt32BE(variant === 'short header' ? 12 : 14, 8);
  const observation = await f.owner.pin(bytes, { sourceKey: 'invalid-header', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(observation);
  const decode = vi.spyOn(Jimp, 'read');
  try {
    const result = await f.call('visual_inspect', { question: 'Check the original raster.',
      views: [{ label: 'invalid checksum', observationId: observation.observationId, displayLongEdge: 6 }] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(variant === 'checksum' ? 'IHDR checksum' : 'IHDR');
    expect(decode).not.toHaveBeenCalled();
    expect(f.reserveOutput.mock.results[0]!.value.cancel).toHaveBeenCalledOnce();
  } finally { decode.mockRestore(); }
});

it.each([
  { name: '16-bit', header: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACEAYAAADN5LpZ', error: 'requires 8-bit' },
  { name: 'zero width', header: 'iVBORw0KGgoAAAANSUhEUgAAAAAAAAACCAYAAAB2Q90Z', error: '40 MP' },
  { name: 'zero height', header: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAACAYAAADQvMcR', error: '40 MP' },
  { name: 'over 40 MP', header: 'iVBORw0KGgoAAAANSUhEUgAAJxAAAA+hCAYAAACXitUM', error: '40 MP' },
])('rejects unsupported or over-limit IHDR values before decoding: $name', async ({ header, error }) => {
  const f = await fixture();
  // CRC-valid headers exercise profile/size validation rather than checksum rejection.
  const bytes = Buffer.concat([Buffer.from(header, 'base64'), f.bytes.subarray(33)]);
  const observation = await f.owner.pin(bytes, { sourceKey: 'unsupported-header', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(observation);
  const decode = vi.spyOn(Jimp, 'read');
  try {
    const result = await f.call('visual_inspect', { question: 'Check the original raster.',
      views: [{ label: 'unsupported raster', observationId: observation.observationId, displayLongEdge: 6 }] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(error);
    expect(decode).not.toHaveBeenCalled();
    expect(f.reserveOutput.mock.results[0]!.value.cancel).toHaveBeenCalledOnce();
    expect(await f.owner.read(observation)).toEqual(bytes);
  } finally { decode.mockRestore(); }
});

it.each([
  { region: { x: -1, y: 0, width: 1, height: 1 } },
  { region: { x: 0, y: 0, width: 0, height: 1 } },
  { region: { x: 2, y: 0, width: 2, height: 1 } },
  { region: { x: 0.5, y: 0, width: 1, height: 1 } },
  { displayLongEdge: 2001 }, { displayLongEdge: 0 },
])('rejects invalid spatial work before decoding: %j', async view => {
  const f = await fixture(); const observation = await f.admit();
  const decode = vi.spyOn(Jimp, 'read');
  try {
    expect((await f.call('visual_inspect', { question: 'Check.', views: [{ label: 'bad', observationId: observation.observationId, ...view }] })).isError).toBe(true);
    expect(decode).not.toHaveBeenCalled();
    expect(f.reserveOutput).not.toHaveBeenCalled();
  } finally { decode.mockRestore(); }
});

it('holds the decoder slot until a cancelled decode settles, then allows the sibling view', async () => {
  const f = await fixture(); const observation = await f.admit();
  let started!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const read = Jimp.read.bind(Jimp);
  const decode = vi.spyOn(Jimp, 'read').mockImplementationOnce(async input => { started(); await gate; return read(input); });
  const controller = new AbortController();
  const input = { question: 'Check.', views: [{ label: 'detail', observationId: observation.observationId, displayLongEdge: 6 }] };
  try {
    const first = f.call('visual_inspect', input, controller.signal);
    await entered;
    controller.abort(new Error('Cancelled decoder.'));
    const second = f.call('visual_inspect', input);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(decode).toHaveBeenCalledOnce();
    release();
    expect((await first).isError).toBe(true);
    expect((await second).isError).not.toBe(true);
    expect(decode).toHaveBeenCalledTimes(2);
  } finally { release(); decode.mockRestore(); }
});
