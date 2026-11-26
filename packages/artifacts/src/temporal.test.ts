import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, expect, it } from 'vitest';
import { executeArtifactRequest } from './runtime.js';
import type { ArtifactRuntimeOptions } from './runtime.js';
import { validateVisualEvidence } from './evidence.js';

// Fixtures: animated.gif is 8x8, red 0.5s (transparent 4x4 centre) → green 0.5s → blue 1s, looping forever.
// animated.webp is 16x16, red 0.4s → green 0.4s. clip.webm is 64x48 VP8 at 1 fps: red, green, blue.
const fixtures = path.resolve('tests/fixtures/artifacts');
const browserExecutable = process.env.KODAX_ARTIFACT_TEST_BROWSER;
const ffmpegExecutable = process.env.KODAX_ARTIFACT_TEST_FFMPEG;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function workspace(...files: string[]): Promise<string> {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact temporal 中文 ')); roots.push(root);
 for (const file of files) await fs.copyFile(path.join(fixtures, file), path.join(root, file));
 return root;
}
const missing = (root: string) => path.join(root, 'missing-executable');
const codes = (result: { diagnostics: readonly { code: string }[] }) => result.diagnostics.map(item => item.code);
function sample(file: string, x: number, y: number): number[] {
 const image = PNG.sync.read(readFileSync(file)), offset = (y * image.width + x) * 4;
 return [...image.data.subarray(offset, offset + 3)];
}
const near = (actual: number[], expected: number[]) => actual.every((value, index) => Math.abs(value - expected[index]!) <= 24);

it('identifies GIF and video sources and reports what stays unverified without their decoders', async () => {
 const root = await workspace('animated.gif', 'clip.webm');
 const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
 const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(8)]);
 await fs.writeFile(path.join(root, 'a.mp4'), mp4); await fs.writeFile(path.join(root, 'a.mov'), mov);
 const options: ArtifactRuntimeOptions = { workspaceRoot: root, browserExecutable: missing(root), ffmpegExecutable: missing(root) };
 for (const [file, format] of [['animated.gif', 'gif'], ['clip.webm', 'webm'], ['a.mp4', 'mp4'], ['a.mov', 'mov']] as const) {
  const opened = await executeArtifactRequest({ operation: 'open', input: { path: file } }, options);
  expect(opened.status).toBe('ready'); expect(opened.artifact?.format).toBe(format);
  expect(codes(opened)).toContain('timeline-unavailable');
 }
 const rendered = await executeArtifactRequest({ operation: 'render', input: { path: 'animated.gif' } }, options);
 expect(rendered.status).toBe('unverified'); expect(codes(rendered)).toContain('temporal-capture-required');
 const still = await executeArtifactRequest({ operation: 'capture', input: { kind: 'static', target: 'clip.webm', locators: [{ kind: 'static' }] } }, options);
 expect(codes(still)).toContain('temporal-capture-required');
 const video = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'clip.webm', locators: [{ kind: 'temporal', time: 0 }] } }, options);
 expect(video.status).toBe('unverified'); expect(codes(video)).toContain('ffmpeg-unavailable');
 const gif = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'animated.gif', locators: [{ kind: 'temporal', time: 0 }] } }, options);
 expect(gif.status).toBe('unverified'); expect(codes(gif)).toContain('missing-browser');
});

it('routes every animated WebP operation to temporal capture and keeps non-video ISO BMFF unsupported', async () => {
 const root = await workspace('animated.webp');
 const options: ArtifactRuntimeOptions = { workspaceRoot: root, browserExecutable: missing(root) };
 const rendered = await executeArtifactRequest({ operation: 'render', input: { path: 'animated.webp' } }, options);
 expect(rendered.status).toBe('unverified'); expect(codes(rendered)).toContain('temporal-capture-required');
 const still = await executeArtifactRequest({ operation: 'capture', input: { kind: 'static', target: 'animated.webp', locators: [{ kind: 'static' }] } }, options);
 expect(codes(still)).toContain('temporal-capture-required');
 const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypavif'), Buffer.alloc(12)]);
 await fs.writeFile(path.join(root, 'image.mp4'), avif);
 await expect(executeArtifactRequest({ operation: 'open', input: { path: 'image.mp4' } }, options)).rejects.toThrow(/unsupported|not supported/i);
});

it('hashes video above 32 MiB from disk and still rejects other large inputs', async () => {
 const root = await workspace('clip.webm', 'animated.gif');
 const large = path.join(root, 'large.webm');
 await fs.copyFile(path.join(root, 'clip.webm'), large); await fs.truncate(large, 33 * 1024 * 1024);
 const opened = await executeArtifactRequest({ operation: 'open', input: { path: 'large.webm' } }, { workspaceRoot: root });
 expect(opened.artifact?.format).toBe('webm');
 const again = await executeArtifactRequest({ operation: 'open', input: { path: 'large.webm', expectedSourceHash: opened.artifact!.sourceHash } }, { workspaceRoot: root });
 expect(again.artifact?.sourceHash).toBe(opened.artifact!.sourceHash);
 const gif = path.join(root, 'large.gif');
 await fs.copyFile(path.join(root, 'animated.gif'), gif); await fs.truncate(gif, 33 * 1024 * 1024);
 await expect(executeArtifactRequest({ operation: 'open', input: { path: 'large.gif' } }, { workspaceRoot: root })).rejects.toThrow(/32 MiB/);
 const huge = path.join(root, 'huge.webm');
 await fs.copyFile(path.join(root, 'clip.webm'), huge); await fs.truncate(huge, 1024 ** 3 + 1);
 await expect(executeArtifactRequest({ operation: 'open', input: { path: 'huge.webm' } }, { workspaceRoot: root })).rejects.toThrow(/1 GiB/);
});

it('declares temporal capture engines for GIF and video', async () => {
 const root = await workspace();
 const result = await executeArtifactRequest({ operation: 'capabilities', input: {} }, { workspaceRoot: root, browserExecutable: missing(root), ffmpegExecutable: missing(root) });
 for (const input of ['gif', 'mp4', 'mov', 'webm'] as const) {
  const capture = result.capabilities!.find(c => c.operation === 'capture' && c.input === input);
  expect(capture?.engine?.name).toBeTruthy(); expect(capture?.availability).toBe('not-prepared');
 }
});

it.skipIf(!browserExecutable)('samples the GIF frame shown at each second on the requested background', async () => {
 const root = await workspace('animated.gif', 'animated.webp');
 const options: ArtifactRuntimeOptions = { workspaceRoot: root, browserExecutable };
 const result = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'animated.gif', background: 'black',
  locators: [0, 0.6, 1.5].map(time => ({ kind: 'temporal' as const, time })) } }, options);
 expect(result.status).toBe('ready'); expect(codes(result)).toContain('timeline');
 const evidence = result.evidence!.evidence;
 expect(evidence.map(item => item.locator)).toEqual([{ kind: 'temporal', time: 0, frame: 0 }, { kind: 'temporal', time: 0.6, frame: 1 }, { kind: 'temporal', time: 1.5, frame: 2 }]);
 expect(sample(evidence[0]!.path, 0, 0)).toEqual([255, 0, 0]); expect(sample(evidence[0]!.path, 4, 4)).toEqual([0, 0, 0]);
 expect(sample(evidence[1]!.path, 4, 4)).toEqual([0, 255, 0]); expect(sample(evidence[2]!.path, 4, 4)).toEqual([0, 0, 255]);
 expect(result.evidence!.background).toBe('black');
 expect(validateVisualEvidence(result.evidence!, { kind: 'temporal', source: result.evidence!.source, times: [0, 1.5], temporal: { start: 0, end: 1.5, coverage: 'continuous' } }).missing).toContain('temporal-range');
 const read = await executeArtifactRequest({ operation: 'readEvidence', input: { source: result.evidence!.source, raster: evidence[2]! } }, options);
 expect(read.status).toBe('ready');

 const late = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'animated.gif', locators: [{ kind: 'temporal', time: 2 }] } }, options);
 expect(late.status).toBe('unverified'); expect(codes(late)).toContain('time-out-of-range');
 const mismatch = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'animated.gif', locators: [{ kind: 'temporal', time: 0.6, frame: 2 }] } }, options);
 expect(codes(mismatch)).toContain('frame-mismatch');

 const webp = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'animated.webp', locators: [{ kind: 'temporal', time: 0 }, { kind: 'temporal', time: 0.5 }] } }, options);
 expect(webp.status).toBe('ready');
 expect(near(sample(webp.evidence!.evidence[0]!.path, 8, 8), [255, 0, 0])).toBe(true);
 expect(near(sample(webp.evidence!.evidence[1]!.path, 8, 8), [0, 255, 0])).toBe(true);
 const opened = await executeArtifactRequest({ operation: 'open', input: { path: 'animated.gif' } }, options);
 expect(opened.diagnostics.find(item => item.code === 'timeline')?.message).toMatch(/3 frames over 2(\.0+)?s/);
});

it.skipIf(!ffmpegExecutable)('extracts video frames through the provided ffmpeg', async () => {
 const root = await workspace('clip.webm');
 const options: ArtifactRuntimeOptions = { workspaceRoot: root, ffmpegExecutable };
 const result = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'clip.webm',
  locators: [{ kind: 'temporal', time: 0 }, { kind: 'temporal', time: 1 }, { kind: 'temporal', time: 1.5 }] } }, options);
 expect(result.status).toBe('ready'); expect(codes(result)).toContain('timeline');
 const [first, second, third] = result.evidence!.evidence.map(item => sample(item.path, 32, 24));
 expect(near(first!, [255, 0, 0])).toBe(true); expect(near(second!, [0, 255, 0])).toBe(true); expect(near(third!, [0, 0, 255])).toBe(true);
 expect(result.evidence!.scope.temporal).toEqual({ start: 0, end: 1.5, coverage: 'sampled' });
 const tail = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'clip.webm', locators: [{ kind: 'temporal', time: 2.5 }] } }, options);
 expect(tail.status).toBe('unverified'); expect(codes(tail)).toContain('no-frame-at-time');
 const late = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'clip.webm', locators: [{ kind: 'temporal', time: 3 }] } }, options);
 expect(codes(late)).toContain('time-out-of-range');
 const opened = await executeArtifactRequest({ operation: 'open', input: { path: 'clip.webm' } }, options);
 expect(opened.diagnostics.find(item => item.code === 'timeline')?.message).toMatch(/3(\.0+)?s/);
 const large = path.join(root, 'large.webm');
 await fs.copyFile(path.join(root, 'clip.webm'), large); await fs.truncate(large, 33 * 1024 * 1024);
 const padded = await executeArtifactRequest({ operation: 'capture', input: { kind: 'temporal', target: 'large.webm', locators: [{ kind: 'temporal', time: 1 }] } }, options);
 expect(padded.status).toBe('ready'); expect(near(sample(padded.evidence!.evidence[0]!.path, 32, 24), [0, 255, 0])).toBe(true);
});
