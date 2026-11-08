import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTextFilePage } from './read-text-page.js';

describe('readTextFilePage file changes', () => {
  let directory = '';
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-reader-')); });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['append', 'replace', 'truncate'] as const)('reports %s during a read without publishing a mixed page', async change => {
    const filePath = path.join(directory, 'changing.txt');
    await fs.writeFile(filePath, 'x'.repeat(128 * 1024) + '\nlast');
    const handle = await fs.open(filePath, 'r');
    const read = handle.read.bind(handle);
    let reads = 0;
    // Change the real file after the first bounded I/O, before the next read.
    vi.spyOn(handle, 'read').mockImplementation(async options => {
      const result = await read(options);
      if (++reads === 1) {
        if (change === 'append') await fs.appendFile(filePath, '\nappended'.repeat(50_000));
        else if (change === 'truncate') await fs.writeFile(filePath, 'short');
        else {
          await fs.rename(filePath, path.join(directory, 'original.txt'));
          await fs.writeFile(filePath, 'replacement');
        }
      }
      return result;
    });
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
    const page = await readTextFilePage({ filePath, offset: 2, lineOffset: 0, limit: 1, maxBytes: 50 * 1024 });
    expect(page.error).toContain('File changed while reading');
    expect(page.lines).toEqual([]);
    // Appended bytes must not increase this call's original three-block scan.
    expect(reads).toBeLessThanOrEqual(3);
    expect(handle.fd).toBe(-1);
  });
});
