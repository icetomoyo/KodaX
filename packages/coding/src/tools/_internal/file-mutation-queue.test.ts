import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _peekFileMutationQueueSizeForTests,
  _resetFileMutationQueueForTests,
  acquireExclusiveFileSystemEffectLease,
  acquireFileSystemMutationLease,
  finishAndReleaseFileSystemEffectLease,
  normalizePathForKey,
  withFileMutation,
  withHostFileSystemMutation,
  withHostFileSystemNamespaceMutation,
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

describe('filesystem effect compatibility APIs', () => {
  it('does not make a host mutation wait for an active shell compatibility lease', async () => {
    const releaseShell = await acquireFileSystemMutationLease('policy-a');
    const mutation = withFileMutation('/tmp/unrelated-host-write.txt', async () => 'written');
    try {
      await expect(Promise.race([
        mutation,
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ])).resolves.toBe('written');
    } finally {
      await releaseShell();
    }
  });

  it('keeps old lease calls non-blocking and idempotent', async () => {
    const lease = await acquireExclusiveFileSystemEffectLease('policy-a');
    await lease.bindEffectProcess(process.pid, false);
    await finishAndReleaseFileSystemEffectLease(lease);
    await expect(lease()).resolves.toBeUndefined();
    await expect(lease.released).resolves.toBeUndefined();
  });

  it('runs host and namespace operations without cross-process coordination', async () => {
    await expect(withHostFileSystemMutation(async () => 'host')).resolves.toBe('host');
    await expect(withHostFileSystemNamespaceMutation(async (bind, finish) => {
      await bind(process.pid, false);
      await finish();
      return 'namespace';
    })).resolves.toBe('namespace');
  });
});
