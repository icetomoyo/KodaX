import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  KodaXToolExecutionContext,
  KodaXTrustedTextMutationHost,
} from '../../types.js';
import {
  withTextFileMutation,
  writeTextFileForMutation,
} from './text-file-mutation.js';
import { acquireFileSystemMutationLease } from './file-mutation-queue.js';

describe('trusted text file mutation boundary', () => {
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-text-mutation-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads and writes directly in the trusted host', async () => {
    const filePath = path.join(root, 'target.txt');
    await fs.writeFile(filePath, 'before', 'utf8');
    const ctx: KodaXToolExecutionContext = { backups: new Map() };

    await withTextFileMutation(filePath, 'edit', { path: filePath }, ctx, async (snapshot) => {
      expect(snapshot.execution).toBe('host');
      expect(snapshot.content).toBe('before');
      await writeTextFileForMutation(snapshot, 'after', false, ctx, 'before');
    });

    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('after');
    expect(ctx.backups.get(filePath)).toBe('before');
  });

  it('does not wait for a live shell filesystem-effect lease', async () => {
    const filePath = path.join(root, 'parallel.txt');
    const releaseShell = await acquireFileSystemMutationLease();
    const ctx: KodaXToolExecutionContext = { backups: new Map() };
    try {
      await expect(withTextFileMutation(
        filePath,
        'write',
        { path: filePath },
        ctx,
        async (snapshot) => writeTextFileForMutation(snapshot, 'hello', true, ctx),
      )).resolves.toBeUndefined();
    } finally {
      await releaseShell();
    }

    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('hello');
  });

  it('rejects a commit after another writer changed the snapshot', async () => {
    const filePath = path.join(root, 'conflict.txt');
    await fs.writeFile(filePath, 'before', 'utf8');
    const ctx: KodaXToolExecutionContext = { backups: new Map() };

    await expect(withTextFileMutation(
      filePath,
      'edit',
      { path: filePath },
      ctx,
      async (snapshot) => {
        await fs.writeFile(filePath, 'peer-change', 'utf8');
        await writeTextFileForMutation(snapshot, 'after', false, ctx);
      },
    )).rejects.toThrow('File changed during mutation');
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('peer-change');
  });

  it('rejects a hard link added after the snapshot was read', async () => {
    const filePath = path.join(root, 'hard-link-source.txt');
    const aliasPath = path.join(root, 'hard-link-alias.txt');
    await fs.writeFile(filePath, 'before', 'utf8');
    const ctx: KodaXToolExecutionContext = { backups: new Map() };

    await expect(withTextFileMutation(
      filePath,
      'edit',
      { path: filePath },
      ctx,
      async (snapshot) => {
        await fs.link(filePath, aliasPath);
        await writeTextFileForMutation(snapshot, 'must-not-write', false, ctx);
      },
    )).rejects.toThrow(/hard link|File changed during mutation/);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('before');
  });

  it('uses the Runtime trusted host and records the locked preimage receipt', async () => {
    const filePath = path.join(root, 'native.txt');
    const snapshot = {
      state: 'present' as const,
      content: 'preflight',
      revision: 'present:r1',
      slot: 'slot:native',
      canonicalPath: filePath,
    };
    const commit = vi.fn<KodaXTrustedTextMutationHost['commit']>(async (input) => ({
      status: 'written',
      before: { ...snapshot, content: 'locked-before' },
      after: {
        ...snapshot,
        content: input.content,
        revision: 'present:r2',
      },
      recoveredAbandonedLock: false,
    }));
    const trustedTextMutationHost: KodaXTrustedTextMutationHost = {
      snapshot: vi.fn(async () => snapshot),
      commit,
    };
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: root,
      trustedTextMutationHost,
    };

    await withTextFileMutation(filePath, 'edit', { path: filePath }, ctx, async (opened) => {
      await writeTextFileForMutation(opened, 'after', false, ctx, opened.content);
    });

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      path: filePath,
      expectedRevision: 'present:r1',
      content: 'after',
    }));
    expect(ctx.backups.get(filePath)).toBe('locked-before');
  });

  it('keeps the commit receipt and forbids blind retry when durability is uncertain', async () => {
    const filePath = path.join(root, 'uncertain.txt');
    const snapshot = {
      state: 'present' as const,
      content: 'before',
      revision: 'present:r1',
      slot: 'slot:uncertain',
      canonicalPath: filePath,
    };
    const trustedTextMutationHost: KodaXTrustedTextMutationHost = {
      snapshot: vi.fn(async () => snapshot),
      commit: vi.fn(async (input) => ({
        status: 'committed_uncertain',
        before: snapshot,
        after: {
          ...snapshot,
          content: input.content,
          revision: 'present:r2',
        },
        recoveredAbandonedLock: false,
        reason: 'the atomic replacement completed but directory durability could not be proven',
      })),
    };
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: root,
      trustedTextMutationHost,
    };

    await expect(withTextFileMutation(
      filePath,
      'write',
      { path: filePath },
      ctx,
      async (opened) => writeTextFileForMutation(opened, 'after', false, ctx, opened.content),
    )).rejects.toMatchObject({
      name: 'KodaXTrustedTextMutationError',
      code: 'text_mutation_commit_uncertain',
      expectedRevision: 'present:r1',
      actualRevision: 'present:r2',
    });
    expect(ctx.backups.get(filePath)).toBe('before');
  });

  it('exposes the full receipt when a new-file commit is uncertain', async () => {
    const filePath = path.join(root, 'new-uncertain.txt');
    const before = {
      state: 'missing' as const,
      content: '',
      revision: 'missing:r1',
      slot: 'slot:new-uncertain',
      canonicalPath: filePath,
    };
    const after = {
      state: 'present' as const,
      content: 'created',
      revision: 'present:r2',
      slot: before.slot,
      canonicalPath: filePath,
    };
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: root,
      trustedTextMutationHost: {
        snapshot: vi.fn(async () => before),
        commit: vi.fn(async () => ({
          status: 'committed_uncertain',
          before,
          after,
          recoveredAbandonedLock: false,
          reason: 'directory durability could not be proven',
        })),
      },
    };

    await expect(withTextFileMutation(
      filePath,
      'write',
      { path: filePath },
      ctx,
      async (opened) => writeTextFileForMutation(opened, 'created', true, ctx),
    )).rejects.toMatchObject({
      code: 'text_mutation_commit_uncertain',
      commitReceipt: { before, after },
    });
    expect(ctx.backups.size).toBe(0);
  });

  it('surfaces a cross-Runtime native CAS miss as a structured stale conflict', async () => {
    const filePath = path.join(root, 'native-conflict.txt');
    const trustedTextMutationHost: KodaXTrustedTextMutationHost = {
      snapshot: vi.fn(async () => ({
        state: 'present',
        content: 'before',
        revision: 'present:r1',
        slot: 'slot:native',
        canonicalPath: filePath,
      })),
      commit: vi.fn(async () => ({
        status: 'stale',
        currentRevision: 'present:r2',
      })),
    };
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: root,
      trustedTextMutationHost,
    };

    await expect(withTextFileMutation(
      filePath,
      'write',
      { path: filePath },
      ctx,
      async (opened) => writeTextFileForMutation(opened, 'after', false, ctx),
    )).rejects.toMatchObject({
      name: 'KodaXTrustedTextMutationError',
      code: 'text_mutation_stale',
      expectedRevision: 'present:r1',
      actualRevision: 'present:r2',
    });
  });

  it('rejects protected repository metadata before invoking the trusted host', async () => {
    const filePath = path.join(root, '.git', 'config');
    const snapshot = vi.fn<KodaXTrustedTextMutationHost['snapshot']>();
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: root,
      trustedTextMutationHost: {
        snapshot,
        commit: vi.fn<KodaXTrustedTextMutationHost['commit']>(),
      },
    };

    await expect(Promise.resolve().then(() => withTextFileMutation(
      filePath,
      'write',
      { path: filePath },
      ctx,
      async () => undefined,
    ))).rejects.toMatchObject({ code: 'text_mutation_policy_denied' });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('rechecks protected policy against the final canonical target', async () => {
    const requested = path.join(root, 'ordinary.txt');
    const canonical = path.join(root, '.git', 'config');
    const commit = vi.fn<KodaXTrustedTextMutationHost['commit']>();
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: root,
      trustedTextMutationHost: {
        snapshot: vi.fn(async () => ({
          state: 'present',
          content: 'before',
          revision: 'present:r1',
          slot: 'slot:protected',
          canonicalPath: canonical,
        })),
        commit,
      },
    };

    await expect(withTextFileMutation(
      requested,
      'edit',
      { path: requested },
      ctx,
      async () => undefined,
    )).rejects.toMatchObject({ code: 'text_mutation_policy_denied' });
    expect(commit).not.toHaveBeenCalled();
  });
});
