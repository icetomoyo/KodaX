/**
 * Tests for KodaX Worktree Isolation Tools
 */

import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import {
  containWindowsEffectProcess,
  killChildProcessTree,
  setAgentConfigHome,
  terminateWindowsEffectJob,
} from '@kodax-ai/agent';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createWorkflowWorktree,
  removeWorkflowWorktree,
  toolWorktreeCreate,
  toolWorktreeRemove,
} from './worktree.js';
import {
  _resetFileSystemEffectLeasesForTests,
  acquireFileSystemMutationLease,
  withFileMutation,
} from './_internal/file-mutation-queue.js';
import type { KodaXToolExecutionContext } from '../types.js';

vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kodax-ai/agent')>()),
  containWindowsEffectProcess: vi.fn(async (pid: number) => ({
    drained: Promise.resolve(),
    supervisorPid: pid,
    jobName: 'Global\\KodaXEffect-00000000-0000-4000-8000-000000000001',
    unref: () => undefined,
  })),
  killChildProcessTree: vi.fn(async () => ({ status: 'already-exited' as const })),
  terminateWindowsEffectJob: vi.fn(async () => undefined),
}));

// `toolWorktreeCreate` mkdirs an explicit base_dir; stub it so tests touch no fs.
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    mkdirSync: vi.fn((target: import('fs').PathLike, options?: import('fs').MakeDirectoryOptions) => {
    if (String(target).replace(/\\/g, '/').includes('/runtime/processes/children')) {
      return original.mkdirSync(target, options);
    }
    return undefined;
    }),
  };
});

// Mock the gated child process with default git behavior.
let mockExecFileImpl: Function | null = null;
let mockStdinEndError: Error | undefined;

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    spawn: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
      const hardenedArgs = JSON.parse(
        String((opts.env as NodeJS.ProcessEnv | undefined)?.KODAX_GIT_ARGS_JSON ?? '[]'),
      ) as string[];
      const effectiveArgs = hardenedArgs.slice(8);
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        stdin: { end(value?: string): void };
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.pid = 2_147_483_647;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        end: () => {
          if (mockStdinEndError !== undefined) throw mockStdinEndError;
          queueMicrotask(() => {
          const complete = (error: Error | null, stdout: string, stderr: string): void => {
            if (stdout) child.stdout.emit('data', stdout);
            if (stderr) child.stderr.emit('data', stderr);
            if (error) child.emit('error', error);
            child.exitCode = error ? 1 : 0;
            child.emit('exit', child.exitCode, null);
            child.emit('close', child.exitCode, null);
          };
          if (mockExecFileImpl) {
            mockExecFileImpl('git', effectiveArgs, opts, complete);
          } else if (effectiveArgs.includes('status') && effectiveArgs.includes('--porcelain')) {
            complete(null, '', '');
          } else if (effectiveArgs.includes('rev-list')) {
            complete(null, '0\n', '');
          } else if (effectiveArgs.includes('rev-parse')) {
            complete(null, 'kodax-wt-test\n', '');
          } else {
            complete(null, '', '');
          }
          });
        },
      };
      return child;
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

const TEST_AGENT_HOME = path.join(os.tmpdir(), `kodax-worktree-agent-home-${process.pid}`);

afterEach(async () => {
  vi.unstubAllEnvs();
  setMockExecFileImpl(null);
  mockStdinEndError = undefined;
  vi.mocked(containWindowsEffectProcess).mockClear();
  vi.mocked(killChildProcessTree).mockClear();
  vi.mocked(terminateWindowsEffectJob).mockClear();
  vi.mocked(containWindowsEffectProcess).mockImplementation(async (pid: number) => ({
    drained: Promise.resolve(),
    supervisorPid: pid,
    jobName: 'Global\\KodaXEffect-00000000-0000-4000-8000-000000000001',
    unref: () => undefined,
  }));
  vi.mocked(killChildProcessTree).mockResolvedValue({ status: 'already-exited' });
  vi.mocked(terminateWindowsEffectJob).mockResolvedValue(undefined);
  await _resetFileSystemEffectLeasesForTests();
  setAgentConfigHome(undefined);
});

describe('toolWorktreeCreate', () => {
  it('preserves the host global and system Git configuration', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', 'C:\\host\\.gitconfig');
    vi.stubEnv('GIT_CONFIG_SYSTEM', 'C:\\host\\gitconfig');
    let gitEnvironment: NodeJS.ProcessEnv | undefined;
    setMockExecFileImpl((_cmd: string, _args: string[], opts: unknown, cb: Function) => {
      gitEnvironment = (opts as { readonly env?: NodeJS.ProcessEnv }).env;
      cb(null, '', '');
    });

    await toolWorktreeCreate({ branch_name: 'global-git-config' }, mockContext);

    expect(gitEnvironment?.GIT_CONFIG_GLOBAL).toBe('C:\\host\\.gitconfig');
    expect(gitEnvironment?.GIT_CONFIG_SYSTEM).toBe('C:\\host\\gitconfig');
  });

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

  it('defaults the worktree to a sibling of the git root', async () => {
    let addPath: string | undefined;
    setMockExecFileImpl((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree' && args[1] === 'add') addPath = args[args.length - 1];
      cb(null, '', '');
    });
    const result = await toolWorktreeCreate({ branch_name: 'sibling-wt' }, mockContext);
    setMockExecFileImpl(null);

    const parsed = JSON.parse(result);
    // cwd '/test/repo' → parent '/test' → '/test/.kodax-worktree-sibling-wt'
    // (drive-letter agnostic: path.resolve prepends a drive on win32).
    expect(parsed.path.replace(/\\/g, '/')).toMatch(/\/test\/\.kodax-worktree-sibling-wt$/);
    expect(addPath?.replace(/\\/g, '/')).toMatch(/\/test\/\.kodax-worktree-sibling-wt$/);
  });

  it('registers the exact worktree root before returning it to the model', async () => {
    const register = vi.fn(async () => undefined);
    const result = await toolWorktreeCreate(
      { branch_name: 'registered-root' },
      {
        ...mockContext,
        workspaceSandboxRoots: {
          list: () => [],
          register,
          unregister: async () => undefined,
        },
      },
    );
    const parsed = JSON.parse(result) as { path: string };

    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(parsed.path);
  });

  it('rolls back the git worktree when its sandbox root cannot be persisted', async () => {
    const gitCalls: string[][] = [];
    setMockExecFileImpl((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      gitCalls.push(args);
      cb(null, '', '');
    });

    await expect(toolWorktreeCreate(
      { branch_name: 'registration-failure' },
      {
        ...mockContext,
        workspaceSandboxRoots: {
          list: () => [],
          register: async () => {
            throw new Error('session root persistence failed');
          },
          unregister: async () => undefined,
        },
      },
    )).rejects.toThrow(/failed to create worktree/i);

    expect(gitCalls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['worktree', 'add']),
      expect.arrayContaining(['worktree', 'remove']),
      ['branch', '-D', 'registration-failure'],
    ]));
  });

  it('nests the worktree under the trusted workflow context base', async () => {
    let addPath: string | undefined;
    setMockExecFileImpl((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree' && args[1] === 'add') addPath = args[args.length - 1];
      cb(null, '', '');
    });
    const result = await createWorkflowWorktree(
      { branch_name: 'wf-child-1' },
      { ...mockContext, workflowWorktreeBaseDir: '/runs/proj/r1/worktrees' },
    );
    setMockExecFileImpl(null);

    const parsed = JSON.parse(result);
    expect(parsed.path.replace(/\\/g, '/')).toMatch(/\/runs\/proj\/r1\/worktrees\/\.kodax-worktree-wf-child-1$/);
    expect(addPath?.replace(/\\/g, '/')).toMatch(/\/runs\/proj\/r1\/worktrees\/\.kodax-worktree-wf-child-1$/);
  });

  it('refuses repository-configured filter processes before checkout', async () => {
    setMockExecFileImpl((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'config') {
        cb(null, 'filter.danger.process node filter.js\n', '');
      } else {
        cb(null, '', '');
      }
    });
    await expect(toolWorktreeCreate({ branch_name: 'filtered' }, mockContext))
      .rejects.toThrow('content filter processes are not allowed');
    setMockExecFileImpl(null);
  });

  it('ignores a model-supplied hidden base_dir', async () => {
    const hidden = await toolWorktreeCreate(
      { branch_name: 'hidden-base', base_dir: '/agent-home/runtime' },
      mockContext,
    );
    expect(JSON.parse(hidden).path.replace(/\\/g, '/'))
      .toMatch(/\/test\/\.kodax-worktree-hidden-base$/);

  });

  it('allows the controller-owned workflow base inside Runtime', async () => {
    const agentHome = TEST_AGENT_HOME;
    setAgentConfigHome(agentHome);
    const result = await createWorkflowWorktree(
      { branch_name: 'trusted-protected-base' },
      { ...mockContext, workflowWorktreeBaseDir: path.join(agentHome, 'runtime', 'worktrees') },
    );
    expect(JSON.parse(result).path)
      .toBe(path.join(agentHome, 'runtime', 'worktrees', '.kodax-worktree-trusted-protected-base'));
  });

  it('rejects a model worktree whose default path lands in Runtime', async () => {
    const agentHome = TEST_AGENT_HOME;
    setAgentConfigHome(agentHome);
    await expect(toolWorktreeCreate(
      { branch_name: 'model-runtime-base' },
      { ...mockContext, executionCwd: path.join(agentHome, 'runtime', 'repo') },
    )).rejects.toThrow('protected KodaX state');
  });

  it('does not wait for a model-started shell compatibility lease', async () => {
    const releaseShell = await acquireFileSystemMutationLease();
    try {
      await expect(toolWorktreeCreate(
        { branch_name: 'lease-conflict' },
        mockContext,
      )).resolves.toContain('lease-conflict');
    } finally {
      await releaseShell();
    }
  });

  it('does not wait for an unrelated direct file mutation', async () => {
    let enteredMutation: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredMutation = resolve; });
    let finishMutation: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => { finishMutation = resolve; });
    const mutation = withFileMutation('/tmp/ordinary.txt', async () => {
      enteredMutation?.();
      await finished;
    });
    await entered;
    await expect(toolWorktreeCreate(
      { branch_name: 'direct-lease-conflict' },
      mockContext,
    )).resolves.toContain('direct-lease-conflict');
    finishMutation?.();
    await mutation;
  });

  it('serializes operations that target the same worktree path', async () => {
    vi.mocked(killChildProcessTree)
      .mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValue({ status: 'already-exited' });
    let releaseFirstAdd: (() => void) | undefined;
    let reportFirstAdd: (() => void) | undefined;
    const firstAddStarted = new Promise<void>((resolve) => { reportFirstAdd = resolve; });
    let addCalls = 0;
    setMockExecFileImpl((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        addCalls += 1;
        if (addCalls === 1) {
          reportFirstAdd?.();
          releaseFirstAdd = () => cb(null, '', '');
          return;
        }
      }
      cb(null, '', '');
    });

    const first = toolWorktreeCreate({ branch_name: 'same-target' }, mockContext);
    await firstAddStarted;
    const second = toolWorktreeCreate({ branch_name: 'same-target' }, mockContext);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(addCalls).toBe(1);
    releaseFirstAdd?.();
    await Promise.all([first, second]);
    expect(addCalls).toBe(2);
  });

  it('rejects instead of waiting forever when process-tree drain remains unknown', async () => {
    vi.mocked(containWindowsEffectProcess).mockResolvedValue(undefined as never);
    vi.mocked(killChildProcessTree)
      .mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValueOnce({ status: 'unknown' })
      .mockResolvedValue({ status: 'already-exited' });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('worktree drain remained pending')), 5_000);
      });
      await expect(Promise.race([
        toolWorktreeCreate({ branch_name: 'unknown-process-tree' }, mockContext),
        deadline,
      ])).rejects.toThrow(/process tree has not been proven drained/i);
      await vi.waitFor(async () => {
        await expect(withFileMutation(
          path.join(os.tmpdir(), 'after-delayed-worktree-drain.txt'),
          async () => 'recovered',
        )).resolves.toBe('recovered');
      }, { timeout: 3_000 });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  });

  it.runIf(process.platform === 'win32')(
    'rejects instead of hanging when the Windows Job drain proof fails',
    async () => {
      const drained = Promise.reject(new Error('job drain failed'));
      void drained.catch(() => undefined);
      vi.mocked(containWindowsEffectProcess).mockResolvedValueOnce({
        drained,
        supervisorPid: 2_147_483_647,
        jobName: 'Global\\KodaXEffect-00000000-0000-4000-8000-000000000003',
        unref: () => undefined,
      });
      vi.mocked(killChildProcessTree).mockResolvedValueOnce({ status: 'already-exited' });

      await expect(toolWorktreeCreate(
        { branch_name: 'failed-job-drain' },
        mockContext,
      )).rejects.toThrow(/job drain failed|process tree has not been proven drained/i);
      expect(killChildProcessTree).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === 'win32')(
    'uses bounded Job termination when the Git launch gate fails after containment',
    async () => {
      const drained = new Promise<void>(() => undefined);
      const jobName = 'Global\\KodaXEffect-00000000-0000-4000-8000-000000000002';
      vi.mocked(containWindowsEffectProcess).mockResolvedValueOnce({
        drained,
        supervisorPid: 2_147_483_647,
        jobName,
        unref: () => undefined,
      });
      vi.mocked(killChildProcessTree).mockResolvedValueOnce({ status: 'unknown' });
      mockStdinEndError = new Error('injected Git gate stdin failure');

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('worktree gate cleanup remained pending')), 2_000);
        });
        await expect(Promise.race([
          toolWorktreeCreate({ branch_name: 'failed-git-gate' }, mockContext),
          deadline,
        ])).rejects.toThrow(/injected Git gate stdin failure/i);
        expect(terminateWindowsEffectJob).toHaveBeenCalledWith(jobName);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps recovering a Git tree when Windows Job binding fails and root drain is unknown',
    async () => {
      vi.mocked(containWindowsEffectProcess).mockRejectedValueOnce(
        new Error('injected Windows Job binding failure'),
      );
      vi.mocked(killChildProcessTree)
        .mockResolvedValueOnce({ status: 'unknown' })
        .mockResolvedValueOnce({ status: 'already-exited' });

      await expect(toolWorktreeCreate(
        { branch_name: 'failed-job-binding' },
        mockContext,
      )).rejects.toThrow(/Job binding failure|process-tree cleanup/i);
      await vi.waitFor(() => {
        expect(killChildProcessTree).toHaveBeenCalledTimes(2);
      }, { timeout: 2_000 });
    },
  );
});

describe('toolWorktreeRemove', () => {
  it('hard-denies removing an ancestor that contains the Agent Home root', async () => {
    const ancestor = mkdtempSync(path.join(os.tmpdir(), 'kodax-worktree-outer-'));
    setAgentConfigHome(path.join(ancestor, 'agent-home'));

    try {
      await expect(toolWorktreeRemove({
        action: 'remove',
        worktree_path: ancestor,
        discard_changes: true,
      }, mockContext)).rejects.toThrow(/protected KodaX state/);
    } finally {
      rmSync(ancestor, { recursive: true, force: true });
    }
  });

  it('refuses to remove the Runtime tree even with discard_changes', async () => {
    const agentHome = TEST_AGENT_HOME;
    setAgentConfigHome(agentHome);
    await expect(toolWorktreeRemove({
      action: 'remove',
      worktree_path: path.join(agentHome, 'runtime'),
      discard_changes: true,
    }, mockContext)).rejects.toThrow('protected KodaX state');
  });

  it('allows the controller to reclaim its own Runtime worktree', async () => {
    const agentHome = TEST_AGENT_HOME;
    const workflowBase = path.join(agentHome, 'runtime', 'worktrees');
    setAgentConfigHome(agentHome);
    const result = await removeWorkflowWorktree(
      path.join(workflowBase, '.kodax-worktree-child'),
      { ...mockContext, workflowWorktreeBaseDir: workflowBase },
    );
    expect(JSON.parse(result).restored).toBe(true);
  });

  it('allows removing a model worktree from an ordinary Agent Home descendant', async () => {
    const agentHome = TEST_AGENT_HOME;
    setAgentConfigHome(agentHome);
    const result = await toolWorktreeRemove({
      action: 'remove',
      worktree_path: path.join(agentHome, 'sessions', '.kodax-worktree-child'),
      discard_changes: true,
    }, mockContext);
    expect(JSON.parse(result).restored).toBe(true);
  });

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

  it('revokes the registered worktree root after git removes it', async () => {
    const unregister = vi.fn(async () => undefined);
    await toolWorktreeRemove(
      { action: 'remove', worktree_path: '/test/worktree', discard_changes: true },
      {
        ...mockContext,
        workspaceSandboxRoots: {
          list: () => ['/test/worktree'],
          register: async () => undefined,
          unregister,
        },
      },
    );

    expect(unregister).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledWith('/test/worktree');
  });

  it('captures an alias canonical root before git removes the alias', async () => {
    const target = mkdtempSync(path.join(os.tmpdir(), 'kodax-worktree-canonical-'));
    const alias = `${target}-alias`;
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonical = realpathSync.native(target);
    const unregister = vi.fn(async () => undefined);
    setMockExecFileImpl((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        rmSync(alias, { recursive: true, force: true });
      }
      cb(null, '', '');
    });
    try {
      await toolWorktreeRemove(
        { action: 'remove', worktree_path: alias, discard_changes: true },
        {
          ...mockContext,
          workspaceSandboxRoots: {
            list: () => [canonical],
            register: async () => undefined,
            unregister,
          },
        },
      );
      expect(unregister).toHaveBeenCalledOnce();
      expect(unregister).toHaveBeenCalledWith(canonical);
    } finally {
      setMockExecFileImpl(null);
      rmSync(alias, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('removes an unregistered pre-correction worktree without inventing a revocation', async () => {
    const unregister = vi.fn(async () => undefined);
    await expect(toolWorktreeRemove(
      { action: 'remove', worktree_path: '/test/legacy-worktree', discard_changes: true },
      {
        ...mockContext,
        workspaceSandboxRoots: {
          list: () => [],
          register: async () => undefined,
          unregister,
        },
      },
    )).resolves.toContain('removed');
    expect(unregister).not.toHaveBeenCalled();
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

  it('does not wait for a model-started shell compatibility lease', async () => {
    const releaseShell = await acquireFileSystemMutationLease();
    try {
      await expect(toolWorktreeRemove({
        action: 'remove',
        worktree_path: '/test/worktree',
        discard_changes: true,
      }, mockContext)).resolves.toContain('removed');
    } finally {
      await releaseShell();
    }
  });
});

describe('toolWorktreeRemove with changes detection', () => {
  it('fails when worktree has uncommitted files', async () => {
    setMockExecFileImpl((cmd: string, args: string[], opts: Record<string, unknown>, cb: Function) => {
      if (args?.includes('status')) {
        cb(null, 'M file.ts\nA new.ts\n', '');
      } else if (args?.includes('rev-list')) {
        cb(null, '0\n', '');
      } else {
        cb(null, '', '');
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
        cb(null, '', '');
      } else if (args?.includes('rev-list')) {
        cb(null, '3\n', '');
      } else {
        cb(null, '', '');
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
