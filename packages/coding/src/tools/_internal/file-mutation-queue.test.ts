import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _peekFileMutationQueueSizeForTests,
  _resetFileMutationQueueForTests,
  normalizePathForKey,
  withFileMutation,
} from './file-mutation-queue.js';

afterEach(() => {
  _resetFileMutationQueueForTests();
  delete process.env.KODAX_PATH_KEY_PLATFORM;
  setAgentConfigHome(undefined);
});

describe('normalizePathForKey', () => {
  it('normalizes Windows path aliases to one key', () => {
    process.env.KODAX_PATH_KEY_PLATFORM = 'win32';
    expect(normalizePathForKey('C:\\Foo\\Bar.txt'))
      .toBe(normalizePathForKey('c:/foo/Bar.txt'));
  });

  it('preserves POSIX component case and a leading UNC pair', () => {
    process.env.KODAX_PATH_KEY_PLATFORM = 'posix';
    expect(normalizePathForKey('/Foo//Bar/')).toBe('/Foo/Bar');
    expect(normalizePathForKey('//server/share/file')).toBe('//server/share/file');
  });
});

describe('withFileMutation', () => {
  it('serializes same-path mutations in arrival order', async () => {
    const order: string[] = [];
    const first = withFileMutation('/tmp/file.txt', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      order.push('first');
    });
    const second = withFileMutation('/tmp/file.txt', async () => {
      order.push('second');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(_peekFileMutationQueueSizeForTests()).toBe(0);
  });

  it('runs different paths concurrently', async () => {
    const started = performance.now();
    await Promise.all(['a', 'b', 'c'].map((name) => (
      withFileMutation(`/tmp/${name}.txt`, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      })
    )));
    expect(performance.now() - started).toBeLessThan(120);
  });

  it('continues after a failed prior mutation', async () => {
    await expect(withFileMutation('/tmp/file.txt', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    await expect(withFileMutation('/tmp/file.txt', async () => 'next')).resolves.toBe('next');
  });

  it('keeps the Agent Home runtime boundary', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-file-queue-'));
    setAgentConfigHome(home);
    try {
      await expect(withFileMutation(path.join(home, 'runtime', 'state.json'), async () => 'write'))
        .rejects.toThrow('protected KodaX state');
      await expect(withFileMutation(path.join(home, 'config.json'), async () => 'write'))
        .resolves.toBe('write');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
