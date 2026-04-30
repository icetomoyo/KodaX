/**
 * Unit tests for worktree-runner. Hits the real `git` binary against the
 * KodaX repo (these tests aren't hermetic — they need a checkout). Each
 * test creates and removes its own temp worktree.
 *
 * The harness already requires git on PATH (commit-history archaeology in
 * cases.ts depends on it), so this is consistent with the rest of the
 * test infra.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertPrimaryHeadUnchanged,
  cleanupWorktree,
  runInWorktree,
  scanAndCleanOrphanWorktrees,
  setupWorktree,
} from './worktree-runner.js';

const execFileAsync = promisify(execFile);

async function currentHead(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD']);
  return stdout.trim();
}

const repoRoot = process.cwd();

describe('worktree-runner', () => {
  const created: string[] = [];

  afterEach(async () => {
    // Best-effort cleanup if a test threw before its own cleanup.
    for (const p of created.splice(0)) {
      await execFileAsync('git', ['worktree', 'remove', '--force', p], {
        cwd: repoRoot,
      }).catch(() => undefined);
      await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
    }
    await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(
      () => undefined,
    );
  });

  it('setupWorktree creates a worktree at the given SHA, then cleanupWorktree removes it', async () => {
    const head = await currentHead();
    const handle = await setupWorktree({
      id: 'unit-setup',
      sha: head,
      repoRoot,
    });
    created.push(handle.path);

    expect(handle.sha).toBe(head);
    expect(handle.path.startsWith(tmpdir())).toBe(true);
    expect(path.basename(handle.path).startsWith('kodax-eval-unit-setup-')).toBe(
      true,
    );
    // package.json must exist at root of the worktree as a smoke check.
    await expect(fs.stat(path.join(handle.path, 'package.json'))).resolves
      .toBeDefined();

    await cleanupWorktree(handle, { repoRoot });
    created.pop();
    await expect(fs.stat(handle.path)).rejects.toBeDefined();
  });

  it('setupWorktree throws on unreachable SHA (case is skipped, not faked)', async () => {
    await expect(
      setupWorktree({
        id: 'unit-bad-sha',
        sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        repoRoot,
      }),
    ).rejects.toThrow(/not reachable/);
  });

  it('runInWorktree always cleans up even when fn throws', async () => {
    const head = await currentHead();
    let capturedPath = '';
    await expect(
      runInWorktree({ id: 'unit-throws', sha: head, repoRoot }, async (h) => {
        capturedPath = h.path;
        throw new Error('synthetic');
      }),
    ).rejects.toThrow('synthetic');

    await expect(fs.stat(capturedPath)).rejects.toBeDefined();
  });

  it('assertPrimaryHeadUnchanged returns ok when HEAD matches', async () => {
    const head = await currentHead();
    const result = await assertPrimaryHeadUnchanged({
      repoRoot,
      expectedHeadAtStart: head,
    });
    expect(result).toEqual({ ok: true });
  });

  it('assertPrimaryHeadUnchanged surfaces drift when expected HEAD differs', async () => {
    const result = await assertPrimaryHeadUnchanged({
      repoRoot,
      expectedHeadAtStart: '0000000000000000000000000000000000000000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HEAD changed/);
    }
  });

  it('scanAndCleanOrphanWorktrees only touches kodax-eval- prefixed dirs', async () => {
    // Plant a fake orphan AND an unrelated dir; ensure only the orphan goes.
    const fakeOrphan = path.join(tmpdir(), `kodax-eval-orphan-test-${Date.now()}`);
    const unrelated = path.join(tmpdir(), `unrelated-dir-test-${Date.now()}`);
    await fs.mkdir(fakeOrphan, { recursive: true });
    await fs.mkdir(unrelated, { recursive: true });

    try {
      const result = await scanAndCleanOrphanWorktrees({ repoRoot });
      expect(result.removed).toContain(fakeOrphan);
      expect(result.removed).not.toContain(unrelated);
      await expect(fs.stat(fakeOrphan)).rejects.toBeDefined();
      await expect(fs.stat(unrelated)).resolves.toBeDefined();
    } finally {
      await fs.rm(unrelated, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(fakeOrphan, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
