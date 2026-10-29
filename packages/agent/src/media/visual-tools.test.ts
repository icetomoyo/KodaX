import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgent } from '../primitives/agent.js';
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

it('retains JPEG originals while refusing unsupported derivation and oversized full-image output', async () => {
  const f = await fixture();
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
    expect(f.reserveOutput.mock.results[0]!.value.cancel).toHaveBeenCalledOnce();
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
