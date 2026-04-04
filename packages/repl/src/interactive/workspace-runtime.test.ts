import { describe, expect, it } from 'vitest';
import { formatWorkspaceTruth, isSameCanonicalRepo, resolveSessionRuntimeInfo } from './workspace-runtime.js';

describe('workspace-runtime helpers', () => {
  it('resolves runtime info from persisted legacy gitRoot data', () => {
    expect(resolveSessionRuntimeInfo({
      gitRoot: 'C:/repo/worktrees/feature-runtime',
      runtimeInfo: undefined,
    })).toEqual({
      canonicalRepoRoot: 'C:/repo/worktrees/feature-runtime',
      workspaceRoot: 'C:/repo/worktrees/feature-runtime',
      executionCwd: 'C:/repo/worktrees/feature-runtime',
      branch: undefined,
      workspaceKind: 'detected',
    });
  });

  it('formats lightweight current-workspace truth', () => {
    expect(formatWorkspaceTruth({
      canonicalRepoRoot: 'C:/repo',
      workspaceRoot: 'C:/repo/worktrees/feature-runtime',
      executionCwd: 'C:/repo/worktrees/feature-runtime/packages/repl',
      branch: 'feature/runtime-truth',
      workspaceKind: 'managed',
    })).toBe('C:/repo/worktrees/feature-runtime @ feature/runtime-truth [managed]');
  });

  it('compares canonical repo identity independently from workspace root', () => {
    expect(isSameCanonicalRepo(
      {
        canonicalRepoRoot: 'C:/repo',
        workspaceRoot: 'C:/repo/worktrees/main',
      },
      {
        canonicalRepoRoot: 'C:/repo',
        workspaceRoot: 'C:/repo/worktrees/feature-runtime',
      },
    )).toBe(true);
  });
});
