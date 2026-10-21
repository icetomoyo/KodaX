import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { pinGenerationWorktree, restoreGenerationWorktree, releaseGenerationWorktree } from './worktree-generation.js';
import { sweepWorkflowRunWorktrees, pruneStaleWorkflowWorktrees } from './workflows/worktree-sweep.js';

it('retains a suspended worktree through both sweeps and restores its existing files without recreating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kodax-generation-worktree-'));
  const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
  try {
    git(['init']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
    git(['commit', '--allow-empty', '-m', 'base']);
    const worktreePath = join(root, 'runs', 'worktrees', 'child');
    git(['worktree', 'add', '--detach', worktreePath]);
    await writeFile(join(worktreePath, 'receipt.txt'), 'EDIT019 completed');
    const checkpoint = { version: 1 as const, sessionId: 'worker', activeEntryId: null, messagesDigest: 'a'.repeat(64) };
    const saved = await pinGenerationWorktree(worktreePath, root, checkpoint);
    // A clean/old worktree must be retained even when cleanliness would permit GC.
    const runGit = async (args: readonly string[], cwd: string) => args[0] === 'status' || args[0] === 'rev-list' ? '' : git([...args], cwd);
    expect((await sweepWorkflowRunWorktrees({ baseDir: join(root, 'runs', 'worktrees'), gitRoot: root }, { runGit })).removed).toEqual([]);
    expect((await pruneStaleWorkflowWorktrees({ workflowRunsRoot: join(root, 'runs'), gitRoot: root }, { runGit, mtimeMs: () => 0 })).removed).toEqual([]);
    expect(await restoreGenerationWorktree(saved, root)).toBe(worktreePath);
    expect(await readFile(join(worktreePath, 'receipt.txt'), 'utf8')).toBe('EDIT019 completed');
    await expect(restoreGenerationWorktree({ ...saved, sessionId: 'other' }, root)).rejects.toThrow(/checkpoint/);
    await expect(restoreGenerationWorktree(saved, worktreePath)).rejects.toThrow(/repository/);
    await releaseGenerationWorktree(worktreePath);
    await expect(restoreGenerationWorktree(saved, root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
