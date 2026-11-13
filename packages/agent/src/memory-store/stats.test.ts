import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { addMemoryStats, readMemoryStats, STATS_FILE } from './stats.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-stats-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it('adds to running totals and remembers when counting started', async () => {
  await addMemoryStats(dir, { reads: 2 }, new Date('2026-11-01T00:00:00Z'));
  await addMemoryStats(dir, { reads: 1, dispute: 1 }, new Date('2026-11-02T00:00:00Z'));
  expect(await readMemoryStats(dir)).toEqual({ since: '2026-11-01T00:00:00.000Z', reads: 3, dispute: 1 });
});

it('writes nothing for zero deltas', async () => {
  await addMemoryStats(dir, { reads: 0 });
  await expect(fs.stat(path.join(dir, STATS_FILE))).rejects.toThrow();
});

it('starts over from a corrupt file', async () => {
  await fs.writeFile(path.join(dir, STATS_FILE), '{oops');
  await addMemoryStats(dir, { reads: 1 }, new Date('2026-11-03T00:00:00Z'));
  expect(await readMemoryStats(dir)).toEqual({ since: '2026-11-03T00:00:00.000Z', reads: 1 });
});
