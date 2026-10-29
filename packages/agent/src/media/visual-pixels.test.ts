import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgent } from '../primitives/agent.js';
import { createFileVisualObservationOwner, type VisualObservation } from './visual-observations.js';
import { createVisualTools } from './visual-tools.js';
import { countTokens } from '../tokenizer.js';

interface PixelResult {
  status: string; profile: string; palette: number[][];
  views: { label: string; observationId: string; status: string; error?: string; sampleX?: number[]; sampleY?: number[]; indices?: number[][] }[];
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-pixels-')); roots.push(directory);
  const records: VisualObservation[] = [];
  const owner = createFileVisualObservationOwner({ ownerId: 'pixels', directory, list: async () => records });
  const image = new Jimp({ width: 3, height: 2 });
  image.bitmap.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    0, 255, 255, 128, 255, 0, 255, 0, 255, 255, 255, 255]);
  const bytes = await image.getBuffer('image/png');
  const observation = await owner.pin(bytes, { sourceKey: 'known', originEntryId: 'entry', mediaType: 'image/png' });
  records.push(observation);
  const reserveOutput = vi.fn((_tokens: number, _textBytes?: number) => ({ cancel: vi.fn() }));
  const tools = createVisualTools({ owner, reserveOutput });
  const call = (input: Record<string, unknown>, signal?: AbortSignal) => tools.find(tool => tool.name === 'visual_read_pixels')!
    .execute(input, { agent: createAgent({ name: 'pixel fixture', instructions: '' }), abortSignal: signal });
  return { owner, records, observation, bytes, reserveOutput, call };
}

it('samples original grid centers with exact RGBA, ordered views and a shared per-call palette', async () => {
  const f = await fixture(); const id = f.observation.observationId; const decode = vi.spyOn(Jimp, 'read');
  try {
    const result = await f.call({ question: 'Compare exact colors.', views: [
      { label: 'all', observationId: id, region: { x: 0, y: 0, width: 3, height: 2 }, rows: 2, columns: 3 },
      { label: 'center', observationId: id, region: { x: 1, y: 0, width: 2, height: 2 }, rows: 1, columns: 1 },
      { label: 'repeat', observationId: id, region: { x: 0, y: 0, width: 1, height: 1 }, rows: 1, columns: 1 },
    ] });
    expect(result.isError).not.toBe(true); expect(typeof result.content).toBe('string');
    const output = JSON.parse(result.content as string) as PixelResult;
    expect(output).toMatchObject({ status: 'complete', profile: 'png8-rgba-unoriented-no-color-transform',
      palette: [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 255, 255, 128], [255, 0, 255, 0], [255, 255, 255, 255]],
      views: [
        { label: 'all', observationId: id, sampleX: [0, 1, 2], sampleY: [0, 1], indices: [[0, 1, 2], [3, 4, 5]] },
        { label: 'center', observationId: id, sampleX: [2], sampleY: [1], indices: [[5]] },
        { label: 'repeat', observationId: id, sampleX: [0], sampleY: [0], indices: [[0]] },
      ] });
    expect(decode).toHaveBeenCalledOnce(); expect(f.records).toHaveLength(1);
    expect(f.reserveOutput).toHaveBeenCalledOnce(); expect(f.reserveOutput.mock.results[0]!.value.cancel).not.toHaveBeenCalled();
    expect(f.reserveOutput.mock.calls[0]![0]).toBeGreaterThanOrEqual(countTokens(result.content as string));
    expect(f.reserveOutput.mock.calls[0]![1]).toBeGreaterThanOrEqual(Buffer.byteLength(result.content as string));
    expect(JSON.stringify(output)).not.toContain('"type":"image"');
  } finally { decode.mockRestore(); }
});

it('preserves more than 64 exact colors and transparent RGBA without implicit quantization', async () => {
  const f = await fixture(); const image = new Jimp({ width: 65, height: 1 });
  for (let x = 0; x < 65; x++) image.bitmap.data.set([x, 255 - x, 3, x === 64 ? 0 : 128], x * 4);
  const observation = await f.owner.pin(await image.getBuffer('image/png'), { sourceKey: '65-colors', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(observation);
  const result = await f.call({ question: 'Count exact colors.', views: [{ label: 'all 65', observationId: observation.observationId,
    region: { x: 0, y: 0, width: 65, height: 1 }, rows: 1, columns: 65 }] });
  expect(result.isError).not.toBe(true);
  const output = JSON.parse(result.content as string) as PixelResult;
  expect(output.palette).toHaveLength(65); expect(output.palette[0]).toEqual([0, 255, 3, 128]); expect(output.palette[64]).toEqual([64, 191, 3, 0]);
  expect(output.views[0]!.indices).toEqual([Array.from({ length: 65 }, (_, index) => index)]);
  expect(output.views[0]!.sampleX?.at(-1)).toBe(64);
});

it.each([{ rows: 0, columns: 1 }, { rows: 1, columns: 0 }, { rows: 1.5, columns: 1 },
  { rows: 3, columns: 1 }, { rows: 1, columns: 4 }])('rejects invalid grid dimensions before reading or decoding: %j', async grid => {
  const f = await fixture(); const read = vi.spyOn(f.owner, 'read'); const decode = vi.spyOn(Jimp, 'read');
  try {
    const result = await f.call({ question: 'Check.', views: [{ label: 'invalid', observationId: f.observation.observationId,
      region: { x: 0, y: 0, width: 3, height: 2 }, ...grid }] });
    expect(result.isError).toBe(true); expect(result.content).toContain('rows/columns');
    expect(read).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(f.reserveOutput).not.toHaveBeenCalled();
  } finally { decode.mockRestore(); }
});

it('rejects unrecognized region fields before reading any original', async () => {
  const f = await fixture(); const read = vi.spyOn(f.owner, 'read');
  const result = await f.call({ question: 'Check.', views: [{ label: 'invalid', observationId: f.observation.observationId,
    region: { x: 0, y: 0, width: 1, height: 1, rotate: 90 }, rows: 1, columns: 1 }] });
  expect(result.isError).toBe(true); expect(result.content).toContain('region');
  expect(read).not.toHaveBeenCalled(); expect(f.reserveOutput).not.toHaveBeenCalled();
});

it('enforces 4096 samples across all views before reading any source', async () => {
  const f = await fixture(); const observation = await f.owner.pin(await new Jimp({ width: 64, height: 33 }).getBuffer('image/png'),
    { sourceKey: 'grid', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(observation); const read = vi.spyOn(f.owner, 'read');
  const result = await f.call({ question: 'Both grids.', views: ['first', 'second'].map(label => ({ label, observationId: observation.observationId,
    region: { x: 0, y: 0, width: 64, height: 33 }, rows: 33, columns: 64 })) });
  expect(result.isError).toBe(true); expect(result.content).toContain('4096 total-sample');
  expect(read).not.toHaveBeenCalled(); expect(f.reserveOutput).not.toHaveBeenCalled();
});

it('accepts exactly 4096 total samples in a standalone owner with enough reserved text capacity', async () => {
  const f = await fixture(); const observation = await f.owner.pin(await new Jimp({ width: 64, height: 32 }).getBuffer('image/png'),
    { sourceKey: 'full-grid', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(observation);
  const result = await f.call({ question: 'Sample both grids.', views: ['first', 'second'].map(label => ({ label, observationId: observation.observationId,
    region: { x: 0, y: 0, width: 64, height: 32 }, rows: 32, columns: 64 })) });
  expect(result.isError).not.toBe(true);
  const output = JSON.parse(result.content as string) as PixelResult;
  expect(output.palette).toEqual([[0, 0, 0, 0]]);
  expect(output.views.map(view => view.indices?.flat().length)).toEqual([2048, 2048]);
  expect(f.reserveOutput.mock.calls[0]![0]).toBeGreaterThanOrEqual(countTokens(result.content as string));
});

it('reserves the actual numeric text bound before reading or decoding', async () => {
  const f = await fixture(); const read = vi.spyOn(f.owner, 'read'); const decode = vi.spyOn(Jimp, 'read');
  f.reserveOutput.mockImplementation(() => { throw new Error('Numeric capacity exhausted.'); });
  try {
    const result = await f.call({ question: 'Check.', views: [{ label: 'bounded', observationId: f.observation.observationId,
      region: { x: 0, y: 0, width: 3, height: 2 }, rows: 2, columns: 3 }] });
    expect(result.isError).toBe(true); expect(result.content).toContain('Numeric capacity exhausted');
    expect(read).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
    expect(f.reserveOutput.mock.calls[0]![1]).toBeGreaterThan(0);
  } finally { decode.mockRestore(); }
});

it.each(['duplicate IHDR', 'CRC', '16-bit'] as const)('shares the strict predecode PNG profile: %s', async variant => {
  const f = await fixture();
  const png16 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACEAYAAADN5LpZAAAAF0lEQVR4AWNsYGxgbGBsYGRAA0wMOAAAXUoCCCyzKzsAAAAASUVORK5CYII=', 'base64');
  const bytes = variant === '16-bit' ? png16 : variant === 'duplicate IHDR' ? Buffer.concat([f.bytes.subarray(0, 33), png16.subarray(8)]) : Buffer.from(f.bytes);
  if (variant === 'CRC') bytes[32] = bytes[32]! ^ 1;
  const observation = await f.owner.pin(bytes, { sourceKey: 'unsupported', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(observation); const decode = vi.spyOn(Jimp, 'read');
  try {
    const result = await f.call({ question: 'Check.', views: [{ label: 'invalid', observationId: observation.observationId,
      region: { x: 0, y: 0, width: 1, height: 1 }, rows: 1, columns: 1 }] });
    expect(result.isError).toBe(true);
    const output = JSON.parse(result.content as string) as PixelResult;
    expect(output.status).toBe('error'); expect(output.views[0]!.error).toContain(variant === '16-bit' ? '8-bit' : 'IHDR');
    expect(decode).not.toHaveBeenCalled(); expect(await f.owner.read(observation)).toEqual(bytes);
    expect(f.reserveOutput.mock.results[0]!.value.cancel).toHaveBeenCalledOnce();
  } finally { decode.mockRestore(); }
});

it('keeps partial numeric views and palette indices in request order after source corruption', async () => {
  const f = await fixture(); const corrupt = await f.owner.pin(await new Jimp({ width: 1, height: 1 }).getBuffer('image/png'),
    { sourceKey: 'corrupt', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(corrupt); await writeFile(f.owner.imagePath(corrupt), 'corrupt');
  const result = await f.call({ question: 'Compare.', views: [f.observation, corrupt, f.observation].map((item, index) =>
    ({ label: `view ${index}`, observationId: item.observationId, region: { x: 0, y: 0, width: 1, height: 1 }, rows: 1, columns: 1 })) });
  const output = JSON.parse(result.content as string) as PixelResult;
  expect(result.isError).toBe(true); expect(output.status).toBe('partial');
  expect(output.views.map(view => view.status)).toEqual(['complete', 'error', 'complete']);
  expect(output.views[1]!.error).toContain('hash mismatch'); expect(output.palette).toEqual([[255, 0, 0, 255]]);
  expect(output.views[0]!.indices).toEqual([[0]]); expect(output.views[2]!.indices).toEqual([[0]]);
  expect(f.reserveOutput.mock.results[0]!.value.cancel).not.toHaveBeenCalled();
});

it('retains completed numeric evidence when cancellation stops the next source', async () => {
  const f = await fixture(); const second = await f.owner.pin(await new Jimp({ width: 1, height: 1 }).getBuffer('image/png'),
    { sourceKey: 'later', originEntryId: 'entry', mediaType: 'image/png' });
  f.records.push(second);
  const controller = new AbortController(); const read = f.owner.read.bind(f.owner); let reads = 0;
  vi.spyOn(f.owner, 'read').mockImplementation(async (...args) => {
    if (++reads === 2) controller.abort(new Error('Cancelled next source.'));
    return read(...args);
  });
  const decode = vi.spyOn(Jimp, 'read');
  try {
    const result = await f.call({ question: 'Compare.', views: [f.observation, second].map((item, index) =>
      ({ label: `view ${index}`, observationId: item.observationId, region: { x: 0, y: 0, width: 1, height: 1 }, rows: 1, columns: 1 })) }, controller.signal);
    const output = JSON.parse(result.content as string) as PixelResult;
    expect(result.isError).toBe(true); expect(output.status).toBe('partial');
    expect(output.views.map(view => view.status)).toEqual(['complete', 'error']);
    expect(output.views[0]!.indices).toEqual([[0]]); expect(output.views[1]!.error).toContain('Cancelled next source');
    expect(decode).toHaveBeenCalledOnce(); expect(f.reserveOutput.mock.results[0]!.value.cancel).not.toHaveBeenCalled();
  } finally { decode.mockRestore(); }
});
