/**
 * FEATURE_217 (v0.7.49) — workflow worktree sweep / GC tests.
 *
 * git access + mtime are injected, so these run without a real repository.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  workflowWorktreeBaseDir,
  sweepWorkflowRunWorktrees,
  pruneStaleWorkflowWorktrees,
  DEFAULT_STALE_WORKTREE_MS,
} from './worktree-sweep.js';

let testRoot: string;
const oid = 'a'.repeat(40);
beforeEach(() => { testRoot = mkdtempSync(join(tmpdir(), 'workflow-sweep-')); });
afterEach(() => {
  if (dirname(testRoot) !== resolve(tmpdir())) throw new Error('Unsafe Workflow fixture cleanup.');
  rmSync(testRoot, { recursive: true, force: true });
});
const testPath = (path: string): string => join(testRoot, path);
const execFileAsync = promisify(execFile);

/** Build a fake `runGit` over an in-memory worktree set; records calls. */
function fakeGit(initial: Array<{ path: string; branch?: string }>) {
  const worktrees = new Map(initial.map((w) => [w.path, w.branch]));
  const calls: string[][] = [];
  const runGit = async (args: readonly string[], _cwd: string): Promise<string> => {
    calls.push([...args]);
    if (args[0] === 'worktree' && args[1] === 'list') {
      const lines: string[] = [];
      for (const [path, branch] of worktrees) {
        lines.push(`worktree ${path}`, `HEAD ${oid}`);
        if (branch) lines.push(`branch refs/heads/${branch}`);
        lines.push('');
      }
      return lines.join('\n');
    }
    if (args[0] === 'rev-parse') return oid;
    if (args[0] === 'worktree' && args[1] === 'remove') {
      const path = args[2];
      if (!worktrees.has(path)) throw new Error(`not a worktree: ${path}`);
      worktrees.delete(path);
      return '';
    }
    return '';
  };
  return { runGit, calls, worktrees };
}

describe('workflowWorktreeBaseDir', () => {
  it('nests worktrees under the run dir', () => {
    expect(workflowWorktreeBaseDir(testPath('/runs/p/r1'))).toBe(testPath('/runs/p/r1/worktrees'));
  });
});

describe('sweepWorkflowRunWorktrees (Layer 2)', () => {
  it('leaves unknown files in the private receipt directory untouched across repeated cleanup', async () => {
    const baseDir = testPath('/runs/project/run/worktrees');
    const receipts = join(baseDir, '.branch-cleanups');
    mkdirSync(receipts, { recursive: true });
    const unknown = join(receipts, 'unknown-owner.data');
    writeFileSync(unknown, 'Retain these original bytes.');
    const git = fakeGit([{ path: testPath('/repo') }]);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await sweepWorkflowRunWorktrees({ baseDir, gitRoot: testPath('/repo') }, { runGit: git.runGit }))
        .toEqual({ removed: [], warnings: [] });
      expect(readFileSync(unknown, 'utf8')).toBe('Retain these original bytes.');
    }
  });

  it.each(['retry', 'changed', 'occupied'] as const)('settles a pending branch safely when it is %s after its original worktree was removed', async state => {
    const gitRoot = testPath('/repo');
    const baseDir = testPath('/runs/project/run/worktrees');
    const tree = join(baseDir, 'scratch');
    mkdirSync(gitRoot, { recursive: true });
    const git = (args: readonly string[]) => execFileAsync('git', [...args], { cwd: gitRoot, windowsHide: true }).then(result => result.stdout);
    await git(['init', '--quiet']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
    await git(['worktree', 'add', '-b', 'workflow-scratch', tree, 'HEAD']);
    const oldOid = (await git(['rev-parse', 'refs/heads/workflow-scratch'])).trim();
    const deletes: string[][] = [];
    let failDeletion = true;
    const runGit = async (args: readonly string[], cwd: string): Promise<string> => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        expect(readdirSync(join(baseDir, '.branch-cleanups'))).toHaveLength(1);
      }
      if (args[0] === 'update-ref') {
        deletes.push([...args]);
        expect(readdirSync(join(baseDir, '.branch-cleanups'))).toHaveLength(1);
        if (failDeletion) throw new Error('temporary branch ref failure');
      }
      return execFileAsync('git', [...args], { cwd, windowsHide: true }).then(result => result.stdout);
    };
    const first = await sweepWorkflowRunWorktrees({ baseDir, gitRoot }, { runGit });
    expect(first.removed.map(path => resolve(path))).toEqual([tree]);
    expect(first.warnings.join(' ')).toContain('temporary branch ref failure');
    expect(deletes).toEqual([['update-ref', '-d', 'refs/heads/workflow-scratch', oldOid]]);
    if (state === 'changed') {
      await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'new owner']);
      await git(['branch', '-f', 'workflow-scratch', 'HEAD']);
    } else if (state === 'occupied') await git(['worktree', 'add', testPath('/adopted'), 'workflow-scratch']);
    const retainedOid = (await git(['rev-parse', 'refs/heads/workflow-scratch'])).trim();
    failDeletion = false;
    const recovered = await sweepWorkflowRunWorktrees({ baseDir, gitRoot }, { runGit });
    expect(recovered.removed).toEqual([]);
    if (state === 'retry') {
      expect(recovered.warnings).toEqual([]);
      await expect(git(['rev-parse', '--verify', '--quiet', 'refs/heads/workflow-scratch'])).rejects.toMatchObject({ code: 1 });
      expect(deletes).toHaveLength(2);
    } else {
      expect(recovered.warnings.join(' ')).toContain(state === 'changed' ? 'branch revision changed' : 'protected by a current worktree');
      expect((await git(['rev-parse', 'refs/heads/workflow-scratch'])).trim()).toBe(retainedOid);
      expect(deletes).toHaveLength(1);
    }
    expect(existsSync(join(baseDir, '.branch-cleanups'))).toBe(false);
    const repeated = await sweepWorkflowRunWorktrees({ baseDir, gitRoot }, { runGit });
    expect(repeated).toEqual({ removed: [], warnings: [] });
    expect(existsSync(join(baseDir, '.branch-cleanups'))).toBe(false);
  }, 15_000);

  it('retains a project-pinned tree and its branch as a durable reference', async () => {
    const tree = testPath('/runs/project/run/worktrees/pinned');
    const baseDir = dirname(tree);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(`${tree}.project-reference.json`, 'unreadable pins remain protected');
    const git = fakeGit([{ path: tree, branch: 'workflow-pinned' }]);
    const result = await sweepWorkflowRunWorktrees({ baseDir, gitRoot: testPath('/repo') }, { runGit: git.runGit });
    expect(result.removed).toEqual([]);
    expect(result.warnings).toEqual([`retain ${tree}: referenced by durable Workflow evidence`]);
    expect(git.calls.some(args => args[1] === 'remove' || args[0] === 'update-ref')).toBe(false);
  });

  it('reclaims a clean local-only checkout whose commits are already preserved in the project', async () => {
    const target = testPath('/runs/local/worktrees/scratch');
    const git = fakeGit([{ path: testPath('/repo'), branch: 'main' }, { path: target }]);
    const result = await sweepWorkflowRunWorktrees({ baseDir: testPath('/runs/local/worktrees'), gitRoot: testPath('/repo') }, {
      runGit: async (args, cwd) => {
        if (args[0] === 'rev-parse') return 'abc123';
        if (args[0] === 'rev-list') return args.includes('abc123') ? '0' : '1';
        return git.runGit(args, cwd);
      },
    });
    expect(result.removed).toEqual([target]);
  });
  it('removes only worktrees under the run base dir and deletes their branches', async () => {
    const git = fakeGit([
      { path: testPath('/repo'), branch: 'main' },
      { path: testPath('/runs/p/r1/worktrees/.kodax-worktree-kodax-wt-workflow-wf-child-1'), branch: 'kodax-wt-workflow-wf-child-1' },
      { path: testPath('/runs/p/r1/worktrees/.kodax-worktree-kodax-wt-workflow-wf-child-2'), branch: 'kodax-wt-workflow-wf-child-2' },
      { path: testPath('/runs/p/r2/worktrees/.kodax-worktree-other'), branch: 'other' },
    ]);

    const result = await sweepWorkflowRunWorktrees(
      { baseDir: testPath('/runs/p/r1/worktrees'), gitRoot: testPath('/repo') },
      { runGit: git.runGit },
    );

    expect(result.removed).toHaveLength(2);
    expect(git.worktrees.has(testPath('/repo'))).toBe(true);
    expect(git.worktrees.has(testPath('/runs/p/r2/worktrees/.kodax-worktree-other'))).toBe(true);
    // Branch deletion attempted for each removed worktree.
    expect(git.calls).toContainEqual(['update-ref', '-d', 'refs/heads/kodax-wt-workflow-wf-child-1', oid]);
    // Reclaiming this run must not prune unrelated repository registrations.
    expect(git.calls).not.toContainEqual(['worktree', 'prune']);
  });

  it('is a no-op without a gitRoot', async () => {
    const result = await sweepWorkflowRunWorktrees({ baseDir: testPath('/runs/p/r1/worktrees') });
    expect(result.removed).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('does not prune when nothing matched', async () => {
    const git = fakeGit([{ path: testPath('/repo'), branch: 'main' }]);
    await sweepWorkflowRunWorktrees(
      { baseDir: testPath('/runs/p/r1/worktrees'), gitRoot: testPath('/repo') },
      { runGit: git.runGit },
    );
    expect(git.calls).not.toContainEqual(['worktree', 'prune']);
  });

  it('collects a warning and keeps going when one remove fails', async () => {
    const git = fakeGit([
      { path: testPath('/runs/p/r1/worktrees/a'), branch: 'a' },
      { path: testPath('/runs/p/r1/worktrees/b'), branch: 'b' },
    ]);
    const runGit = async (args: readonly string[], cwd: string): Promise<string> => {
      if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === testPath('/runs/p/r1/worktrees/a')) {
        throw new Error('locked');
      }
      return git.runGit(args, cwd);
    };
    const result = await sweepWorkflowRunWorktrees(
      { baseDir: testPath('/runs/p/r1/worktrees'), gitRoot: testPath('/repo') },
      { runGit },
    );
    expect(result.removed).toEqual([testPath('/runs/p/r1/worktrees/b')]);
    expect(result.warnings.some((w) => w.includes('locked'))).toBe(true);
  });

  it('retains dirty worktrees instead of force-removing unmerged changes', async () => {
    const dirtyPath = testPath('/runs/p/r1/worktrees/dirty');
    const cleanPath = testPath('/runs/p/r1/worktrees/clean');
    const git = fakeGit([
      { path: dirtyPath, branch: 'dirty' },
      { path: cleanPath, branch: 'clean' },
    ]);
    const runGit = async (args: readonly string[], cwd: string): Promise<string> => {
      if (cwd === dirtyPath && args[0] === 'status') return ' M docs/features/v0.1.16.md\n';
      return git.runGit(args, cwd);
    };

    const result = await sweepWorkflowRunWorktrees(
      { baseDir: testPath('/runs/p/r1/worktrees'), gitRoot: testPath('/repo') },
      { runGit },
    );

    expect(result.removed).toEqual([cleanPath]);
    expect(git.worktrees.has(dirtyPath)).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('unmerged changes'))).toBe(true);
    expect(git.calls).not.toContainEqual(['worktree', 'remove', dirtyPath, '--force']);
  });
});

describe('pruneStaleWorkflowWorktrees (Layer 3)', () => {
  const baseDeps = (git: ReturnType<typeof fakeGit>, ages: Record<string, number>, nowMs: number) => ({
    runGit: git.runGit,
    now: () => nowMs,
    mtimeMs: (path: string) => nowMs - (ages[path] ?? 0),
  });

  it('retains stale worktrees whose owner settlement has not been confirmed', async () => {
    const now = 1_000_000_000_000;
    const git = fakeGit([
      { path: testPath('/repo'), branch: 'main' },
      { path: testPath('/runs/p/r-old/worktrees/stale'), branch: 'stale' },
      { path: testPath('/runs/p/r-new/worktrees/fresh'), branch: 'fresh' },
    ]);
    const result = await pruneStaleWorkflowWorktrees(
      { workflowRunsRoot: testPath('/runs/p'), gitRoot: testPath('/repo') },
      baseDeps(git, {
        [testPath('/runs/p/r-old/worktrees/stale')]: DEFAULT_STALE_WORKTREE_MS + 1,
        [testPath('/runs/p/r-new/worktrees/fresh')]: 1000,
      }, now),
    );

    expect(result.removed).toEqual([]);
    expect(git.worktrees.has(testPath('/runs/p/r-old/worktrees/stale'))).toBe(true);
    expect(result.warnings.join(' ')).toContain('owner settlement');
    expect(git.worktrees.has(testPath('/runs/p/r-new/worktrees/fresh'))).toBe(true);
    expect(git.worktrees.has(testPath('/repo'))).toBe(true);
  });

  it('ignores worktrees outside the workflow-runs root', async () => {
    const now = 1_000_000_000_000;
    const git = fakeGit([
      { path: testPath('/other/place/worktrees/old'), branch: 'old' },
    ]);
    const result = await pruneStaleWorkflowWorktrees(
      { workflowRunsRoot: testPath('/runs/p'), gitRoot: testPath('/repo') },
      baseDeps(git, { [testPath('/other/place/worktrees/old')]: DEFAULT_STALE_WORKTREE_MS * 10 }, now),
    );
    expect(result.removed).toHaveLength(0);
    expect(git.worktrees.has(testPath('/other/place/worktrees/old'))).toBe(true);
  });

  it('does not prune unrelated repository worktrees', async () => {
    const git = fakeGit([{ path: testPath('/repo'), branch: 'main' }]);
    await pruneStaleWorkflowWorktrees(
      { workflowRunsRoot: testPath('/runs/p'), gitRoot: testPath('/repo') },
      baseDeps(git, {}, 1_000_000_000_000),
    );
    expect(git.calls).not.toContainEqual(['worktree', 'prune']);
  });

  it('is a no-op without a gitRoot', async () => {
    const result = await pruneStaleWorkflowWorktrees({ workflowRunsRoot: testPath('/runs/p') });
    expect(result.removed).toHaveLength(0);
  });
});
