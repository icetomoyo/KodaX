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

// All tests in this suite shell out to the real `git` binary (worktree
// add / remove / prune, rev-parse). Under heavy parallel test load
// (~4800 concurrent tests) these git operations consistently exceed
// vitest's default 5s per-test timeout, producing flaky failures even
// though the underlying logic is sound (single-test runs always pass).
// Bumped to 20s — same defensive pattern as v0.7.34 Issue 128 (10
// contract suites bumped to 15s). Global testTimeout untouched so
// unit-test perf regressions still surface fast.
const GIT_TEST_TIMEOUT = 20_000;

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

  it('setupWorktree creates a worktree at the given SHA, then cleanupWorktree removes it', { timeout: GIT_TEST_TIMEOUT }, async () => {
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

  it('setupWorktree throws on unreachable SHA (case is skipped, not faked)', { timeout: GIT_TEST_TIMEOUT }, async () => {
    await expect(
      setupWorktree({
        id: 'unit-bad-sha',
        sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        repoRoot,
      }),
    ).rejects.toThrow(/not reachable/);
  });

  it('runInWorktree always cleans up even when fn throws', { timeout: GIT_TEST_TIMEOUT }, async () => {
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

  it('assertPrimaryHeadUnchanged returns ok when HEAD matches', { timeout: GIT_TEST_TIMEOUT }, async () => {
    const head = await currentHead();
    const result = await assertPrimaryHeadUnchanged({
      repoRoot,
      expectedHeadAtStart: head,
    });
    expect(result).toEqual({ ok: true });
  });

  it('assertPrimaryHeadUnchanged surfaces drift when expected HEAD differs', { timeout: GIT_TEST_TIMEOUT }, async () => {
    const result = await assertPrimaryHeadUnchanged({
      repoRoot,
      expectedHeadAtStart: '0000000000000000000000000000000000000000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HEAD changed/);
    }
  });

  it('preserves eval dumps and unrelated prefixed directories while removing a registered worktree', { timeout: GIT_TEST_TIMEOUT }, async () => {
    const tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'kodax-orphan-scan-test-'));
    const dumps = path.join(tmpRoot, 'kodax-eval-dumps');
    const unrelated = path.join(tmpRoot, 'kodax-eval-unregistered');
    const orphan = await setupWorktree({ repoRoot, tmpRoot, id: 'orphan-test' });
    created.push(orphan.path);
    await fs.mkdir(dumps);
    await fs.writeFile(path.join(dumps, 'raw.json'), '{"evidence":"keep"}');
    await fs.mkdir(unrelated);
    try {
      const result = await scanAndCleanOrphanWorktrees({ repoRoot, tmpRoot });
      expect(result.removed).toEqual([orphan.path]);
      expect(result.failed).toEqual([]);
      await expect(fs.stat(orphan.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(dumps, 'raw.json'), 'utf8')).toBe('{"evidence":"keep"}');
      await expect(fs.stat(unrelated)).resolves.toBeDefined();
    } finally {
      await cleanupWorktree(orphan, { repoRoot });
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
