/**
 * Tests for KodaX Worktree Isolation Tools
 */

import { describe, it, expect, vi } from 'vitest';
import { toolWorktreeCreate, toolWorktreeRemove } from './worktree.js';
import type { KodaXToolExecutionContext } from '../types.js';

// Mock child_process.execFile with default behavior
let mockExecFileImpl: Function | null = null;

vi.mock('child_process', () => {
  return {
    execFile: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>, cb: Function) => {
      if (mockExecFileImpl) {
        mockExecFileImpl(cmd, args, opts, cb);
      } else {
        // Default behavior: success for all commands
        if (args?.includes('status') && args?.includes('--porcelain')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (args?.includes('rev-list')) {
          cb(null, { stdout: '0\n', stderr: '' });
        } else if (args?.includes('rev-parse')) {
          cb(null, { stdout: 'kodax-wt-test\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      }
    }),
  };
});

function setMockExecFileImpl(impl: Function | null): void {
  mockExecFileImpl = impl;
}

const mockContext: KodaXToolExecutionContext = {
  backups: new Map(),
  executionCwd: '/test/repo',
  gitRoot: '/test/repo',
};

describe('toolWorktreeCreate', () => {
  it('generates valid branch name from description', async () => {
    const result = await toolWorktreeCreate(
      { description: 'Add new feature' },
      mockContext,
    );
    const parsed = JSON.parse(result);
    expect(parsed.branch).toMatch(/^kodax-wt-/);
    expect(parsed.branch).toContain('add-new-feature');
    expect(parsed.path).toBeTruthy();
  });

  it('uses provided branch_name over description', async () => {
    const result = await toolWorktreeCreate(
      { branch_name: 'custom-branch', description: 'ignored' },
      mockContext,
    );
    const parsed = JSON.parse(result);
    expect(parsed.branch).toBe('custom-branch');
  });

  it('generates timestamp-based branch name when no description provided', async () => {
    const result = await toolWorktreeCreate({}, mockContext);
    const parsed = JSON.parse(result);
    expect(parsed.branch).toMatch(/^kodax-wt-\d+$/);
  });

  it('rejects invalid branch names', async () => {
    await expect(
      toolWorktreeCreate({ branch_name: '-invalid' }, mockContext),
    ).rejects.toThrow('Invalid branch name');

    await expect(
      toolWorktreeCreate({ branch_name: 'invalid-' }, mockContext),
    ).rejects.toThrow('Invalid branch name');
  });

  it('accepts valid branch names', async () => {
    const validNames = ['feature-123', 'fix.bug', 'release/v1', 'wt-abc123'];
    for (const name of validNames) {
      const result = await toolWorktreeCreate({ branch_name: name }, mockContext);
      const parsed = JSON.parse(result);
      expect(parsed.branch).toBe(name);
    }
  });
});

describe('toolWorktreeRemove', () => {
  it('returns kept message for action=keep', async () => {
    const result = await toolWorktreeRemove(
      { action: 'keep', worktree_path: '/test/worktree' },
      mockContext,
    );
    const parsed = JSON.parse(result);
    expect(parsed.restored).toBe(true);
    expect(parsed.message).toContain('kept');
  });

  it('requires action parameter', async () => {
    await expect(
      toolWorktreeRemove({ worktree_path: '/test/worktree' }, mockContext),
    ).rejects.toThrow('action must be');
  });

  it('requires worktree_path parameter', async () => {
    await expect(
      toolWorktreeRemove({ action: 'remove' }, mockContext),
    ).rejects.toThrow('worktree_path is required');
  });

  it('rejects invalid action values', async () => {
    await expect(
      toolWorktreeRemove(
        { action: 'invalid', worktree_path: '/test/worktree' },
        mockContext,
      ),
    ).rejects.toThrow('action must be');
  });

  it('removes worktree successfully with no changes', async () => {
    const result = await toolWorktreeRemove(
      { action: 'remove', worktree_path: '/test/worktree', discard_changes: false },
      mockContext,
    );
    const parsed = JSON.parse(result);
    expect(parsed.restored).toBe(true);
    expect(parsed.message).toContain('removed');
  });

  it('bypasses safety check with discard_changes=true', async () => {
    // With discard_changes=true, safety checks should be skipped
    // so the tool should succeed even without checking git status
    const result = await toolWorktreeRemove(
      { action: 'remove', worktree_path: '/test/worktree', discard_changes: true },
      mockContext,
    );
    const parsed = JSON.parse(result);
    expect(parsed.restored).toBe(true);
  });
});

describe('toolWorktreeRemove with changes detection', () => {
  it('fails when worktree has uncommitted files', async () => {
    setMockExecFileImpl((cmd: string, args: string[], opts: Record<string, unknown>, cb: Function) => {
      if (args?.includes('status')) {
        cb(null, { stdout: 'M file.ts\nA new.ts\n', stderr: '' });
      } else if (args?.includes('rev-list')) {
        cb(null, { stdout: '0\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    await expect(
      toolWorktreeRemove(
        { action: 'remove', worktree_path: '/test/worktree', discard_changes: false },
        mockContext,
      ),
    ).rejects.toThrow('uncommitted');

    // Clean up
    setMockExecFileImpl(null);
  });

  it('fails when worktree has local commits', async () => {
    setMockExecFileImpl((cmd: string, args: string[], opts: Record<string, unknown>, cb: Function) => {
      if (args?.includes('status')) {
        cb(null, { stdout: '', stderr: '' });
      } else if (args?.includes('rev-list')) {
        cb(null, { stdout: '3\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    await expect(
      toolWorktreeRemove(
        { action: 'remove', worktree_path: '/test/worktree', discard_changes: false },
        mockContext,
      ),
    ).rejects.toThrow('local');

    // Clean up
    setMockExecFileImpl(null);
  });
});
