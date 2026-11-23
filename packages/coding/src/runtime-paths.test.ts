import path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspaceTargetPath } from './runtime-paths.js';

describe('resolveWorkspaceTargetPath', () => {
  const gitRoot = path.resolve('repo');
  const executionCwd = path.join(gitRoot, 'packages', 'app');

  it('defaults to the execution directory', () => {
    expect(resolveWorkspaceTargetPath(undefined, { executionCwd, gitRoot })).toBe(executionCwd);
  });

  it('accepts paths anywhere inside the Git root', () => {
    expect(resolveWorkspaceTargetPath('../../docs', { executionCwd, gitRoot })).toBe(path.join(gitRoot, 'docs'));
    expect(resolveWorkspaceTargetPath('src/index.ts', { executionCwd, gitRoot })).toBe(path.join(executionCwd, 'src', 'index.ts'));
  });

  it('rejects paths that leave the workspace', () => {
    expect(() => resolveWorkspaceTargetPath('../../..', { executionCwd, gitRoot })).toThrow('target_path must stay inside the workspace');
    expect(() => resolveWorkspaceTargetPath(path.resolve('elsewhere'), { executionCwd, gitRoot })).toThrow('target_path must stay inside the workspace');
    expect(() => resolveWorkspaceTargetPath('..', { executionCwd: gitRoot })).toThrow('target_path must stay inside the workspace');
  });
});
