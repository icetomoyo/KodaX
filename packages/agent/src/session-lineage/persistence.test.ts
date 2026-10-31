import os from 'os';
import path from 'path';
import fs, { mkdtemp, rm } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExtensionStore, createExtensionStore } from './persistence.js';

describe('FileExtensionStore (FEATURE_034 manual persistence)', () => {
  let tempDir: string;
  let nsCounter = 0;

  const uniqueNs = () => `test-ns-${++nsCounter}-${Date.now()}`;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-persist-'));
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    vi.stubEnv('KODAX_HOME', path.join(tempDir, '.kodax'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('round-trips a single key through put and get', async () => {
    const store = createExtensionStore(uniqueNs());
    const entry = await store.put('counter', 42);
    expect(entry).not.toBe(false);
    if (entry === false) {
      throw new Error('expected put() to succeed');
    }
    expect(entry).toEqual({
      key: 'counter',
      value: 42,
      version: expect.any(String),
      updatedAt: expect.any(Number),
    });
    expect(entry.version).toHaveLength(16);

    const loaded = await store.get('counter');
    expect(loaded).toEqual(entry);
  });

  it('returns undefined for a missing key', async () => {
    const store = createExtensionStore(uniqueNs());
    const loaded = await store.get('nope');
    expect(loaded).toBeUndefined();
  });

  it('overwrites an existing key and assigns a new version', async () => {
    const store = createExtensionStore(uniqueNs());
    const first = await store.put('score', 10);
    const second = await store.put('score', 20);
    expect(first).not.toBe(false);
    expect(second).not.toBe(false);
    if (first === false || second === false) {
      throw new Error('expected put() to succeed');
    }

    expect(second.version).not.toBe(first.version);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);

    const loaded = await store.get('score');
    expect(loaded).toEqual(second);
  });

  it('uses a unique temp file for atomic rewrites', async () => {
    const writeFileSpy = vi.spyOn(fs, 'writeFile');
    try {
      const store = createExtensionStore(uniqueNs());
      await store.put('key', 'value');

      const tempPath = writeFileSpy.mock.calls
        .map(([file]) => file)
        .find((file): file is string => typeof file === 'string' && file.endsWith('.tmp'));

      expect(tempPath).toEqual(expect.any(String));
      if (typeof tempPath !== 'string') {
        throw new Error('expected writeFile to receive a temp path');
      }

      const tempBase = path.basename(tempPath);
      expect(tempBase).not.toBe('store.jsonl.tmp');
      expect(tempBase).toMatch(
        new RegExp(`^\\.store\\.jsonl\\.${process.pid}\\.[a-z0-9]+-[0-9a-f]{8}\\.tmp$`),
      );
    } finally {
      writeFileSpy.mockRestore();
    }
  });

  it('supports optimistic concurrency via expectedVersion', async () => {
    const store = createExtensionStore(uniqueNs());
    const first = await store.put('lock', 'v1');
    expect(first).not.toBe(false);
    if (first === false) {
      throw new Error('expected initial put() to succeed');
    }

    // Stale version should fail.
    const conflict = await store.put('lock', 'v2-stale', { expectedVersion: 'wrong-version' });
    expect(conflict).toBe(false);

    // Current version should succeed.
    const updated = await store.put('lock', 'v2', { expectedVersion: first.version });
    expect(updated).not.toBe(false);
    if (updated === false) {
      throw new Error('expected optimistic put() to succeed');
    }
    expect(updated.version).not.toBe(first.version);

    // The old version should no longer match.
    const stale = await store.put('lock', 'v3', { expectedVersion: first.version });
    expect(stale).toBe(false);
  });

  it('deletes a key and returns true only when it existed', async () => {
    const store = createExtensionStore(uniqueNs());
    await store.put('temp', 'gone');

    expect(await store.delete('temp')).toBe(true);
    expect(await store.get('temp')).toBeUndefined();

    expect(await store.delete('temp')).toBe(false);
    expect(await store.delete('never-existed')).toBe(false);
  });

  it('lists keys with optional prefix filter', async () => {
    const store = createExtensionStore(uniqueNs());
    await store.put('user:alice', { name: 'Alice' });
    await store.put('user:bob', { name: 'Bob' });
    await store.put('config:theme', 'dark');

    const allKeys = await store.list();
    expect(allKeys).toEqual(['config:theme', 'user:alice', 'user:bob']);

    const userKeys = await store.list({ prefix: 'user:' });
    expect(userKeys).toEqual(['user:alice', 'user:bob']);

    const configKeys = await store.list({ prefix: 'config:' });
    expect(configKeys).toEqual(['config:theme']);

    const noKeys = await store.list({ prefix: 'system:' });
    expect(noKeys).toEqual([]);
  });

  it('clears keys with optional prefix filter and returns removed count', async () => {
    const store = createExtensionStore(uniqueNs());
    await store.put('cache:a', 1);
    await store.put('cache:b', 2);
    await store.put('keep', 3);

    expect(await store.clear({ prefix: 'cache:' })).toBe(2);
    expect(await store.list()).toEqual(['keep']);
    expect(await store.get('cache:a')).toBeUndefined();

    expect(await store.clear()).toBe(1);
    expect(await store.list()).toEqual([]);
  });

  it('persists data across store instances for the same namespace', async () => {
    const ns = uniqueNs();
    const store1 = createExtensionStore(ns);
    await store1.put('shared', { across: 'instances' });
    await store1.put('counter', 7);

    // Create a new store instance with the same namespace.
    const store2 = new FileExtensionStore(ns);
    expect(await store2.get('shared')).toEqual({
      key: 'shared',
      value: { across: 'instances' },
      version: expect.any(String),
      updatedAt: expect.any(Number),
    });
    const counterEntry = await store2.get('counter');
    expect(counterEntry!.value).toBe(7);
  });

  it('isolates data between different namespaces', async () => {
    const storeA = createExtensionStore(uniqueNs());
    const storeB = createExtensionStore(uniqueNs());

    await storeA.put('key', 'alpha-value');
    await storeB.put('key', 'beta-value');

    expect((await storeA.get('key'))!.value).toBe('alpha-value');
    expect((await storeB.get('key'))!.value).toBe('beta-value');
  });

  it('supports complex JSON values', async () => {
    const store = createExtensionStore(uniqueNs());
    const complex = {
      nested: { arrays: [1, 2, 3], objects: { a: null, b: true } },
      string: 'hello',
      number: 3.14,
      bool: false,
    };

    const entry = await store.put('complex', complex);
    expect(entry).not.toBe(false);
    if (entry === false) {
      throw new Error('expected put() to succeed');
    }
    const loaded = await store.get('complex');
    expect(loaded!.value).toEqual(complex);
  });

  it('rejects empty keys', async () => {
    const store = createExtensionStore(uniqueNs());
    await expect(store.put('  ', 'val')).rejects.toThrow('non-empty string');
  });

  it('survives empty file gracefully', async () => {
    const store = createExtensionStore(uniqueNs());
    // Reading from a store that has never been written to.
    expect(await store.list()).toEqual([]);
    expect(await store.clear()).toBe(0);
  });
});
