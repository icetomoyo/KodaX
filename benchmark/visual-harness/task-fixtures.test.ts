import { expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { createTaskFixtures } from './task-fixtures.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

it('provides a recoverable wiring raster and keeps its independent answer outside public files', async () => {
  const fixtures = await createTaskFixtures(Buffer.from([2, 0, 1, 3]));
  const wiring = fixtures.A;
  expect(wiring.prompt).toContain('J2-3');
  expect(wiring.prompt).not.toMatch(/visual_|crop|inspect|裁剪|坐标/);
  expect(Object.keys(wiring.files)).toEqual(['wiring.png']);
  const image = await Jimp.read(wiring.files['wiring.png']!);
  expect([image.width, image.height]).toEqual([1600, 1000]);
  expect(wiring.oracle).toEqual({ actuator: 'Valve-C', port: 'P2', upper: 'connected', lower: 'crossing' });
  expect(image.getPixelColor(720, 350)).toBe(0x18212bff);
  expect(image.getPixelColor(990, 560)).toBe(0xffffffff);
});

it('delivers three distinct historical frames before revealing the diagnosis question', async () => {
  const { B } = await createTaskFixtures(Buffer.from([2, 0, 1, 3]));
  expect(B.images).toEqual(['before.png', 'after.png', 'latest.png']);
  expect(B.history).toHaveLength(3);
  expect(JSON.stringify(B.history)).not.toContain('为什么');
  expect(B.oracle).toEqual({ before: { time: '09:10', filter: 'All', visible: true },
    after: { time: '09:25', filter: 'Running', visible: false }, latest: { time: '10:40', filter: 'Queued', visible: true }, target: 'K23', status: 'Queued' });
  expect(new Set(Object.values(B.files).map(buffer => buffer.toString('base64'))).size).toBe(3);
});

it.each([0, 1])('shows only queued jobs after history variant %s', async variant => {
  const { B } = await createTaskFixtures(Buffer.from([2, 0, variant, 3]));
  const before = await Jimp.read(B.files['before.png']!);
  const after = await Jimp.read(B.files['after.png']!);
  const latest = await Jimp.read(B.files['latest.png']!);
  const strip = (image: typeof before, y: number, width: number) => Buffer.concat(Array.from({ length: 24 }, (_, offset) => {
    const start = ((y + offset) * image.width + 50) * 4;
    return image.bitmap.data.subarray(start, start + width * 4);
  }));
  // The independently checked before frame puts K23 on row two. A Queued
  // filter must show that same job as the first row and report one row.
  expect(strip(latest, 270, 900).equals(strip(before, 315, 900))).toBe(true);
  expect(strip(latest, 370, 250).equals(strip(after, 370, 250))).toBe(true);
});

it('ships a normal failing code task with runnable existing tests and no embedded answer', async () => {
  const { D } = await createTaskFixtures(Buffer.from([2, 0, 1, 3]));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-fixture-test-'));
  try {
    for (const [file, bytes] of Object.entries(D.files)) await writeFile(path.join(directory, file), bytes);
    expect(() => execFileSync(process.execPath, ['--test', 'config.test.mjs'], { cwd: directory, stdio: 'pipe' })).toThrow();
    const source = D.files['config.mjs']!.toString();
    await writeFile(path.join(directory, 'config.mjs'), source.replace('JSON.parse(text)', "JSON.parse(text.trim() || '{}')"));
    expect(() => execFileSync(process.execPath, ['--test', 'config.test.mjs'], { cwd: directory, stdio: 'pipe' })).not.toThrow();
    expect(D.images).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
