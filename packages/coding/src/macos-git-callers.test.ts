import * as childProcess from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXSessionStorage } from '@kodax-ai/agent';

const { preflight, preflightSync } = vi.hoisted(() => ({
  preflight: vi.fn(async () => { throw new Error('macOS developer tools unavailable'); }),
  preflightSync: vi.fn(() => { throw new Error('macOS developer tools unavailable'); }),
}));
vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(),
  assertNoGitInstallPrompt: preflight,
  assertNoGitInstallPromptSync: preflightSync,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const unexpectedLaunch = (): never => { throw new Error('Unexpected Git launch'); };
  return {
    ...original,
    exec: vi.fn<typeof original.exec>(unexpectedLaunch),
    execFile: vi.fn<typeof original.execFile>(unexpectedLaunch),
    execFileSync: vi.fn<typeof original.execFileSync>(unexpectedLaunch),
    spawn: vi.fn<typeof original.spawn>(unexpectedLaunch),
  };
});

import { saveSessionSnapshot } from './agent-runtime/middleware/session-snapshot.js';
import { getGitHeadCommit } from './task-engine/_internal/managed-task/checkpoint.js';
import { buildCapabilityContextSections } from './prompts/capability-sections.js';
import { resolveEvidenceRef } from './child-executor.js';
import { toolChangedDiff } from './tools/changed-diff.js';
import { sweepWorkflowRunWorktrees } from './workflows/worktree-sweep.js';
import { toolWorktreeCreate, toolWorktreeRemove } from './tools/worktree.js';
import { createCodingWorkflowBackend } from './workflows/agent-adapter.js';
import { CodingActorSession } from './agent-runtime/actor-runtime.js';
import type { KodaXToolExecutionContext } from './types.js';

describe('SDK callers when macOS Git would request developer tools', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'kodax-git-callers-'));
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('saves the session without a Git root and preserves its execution directory', async () => {
    const save = vi.fn<KodaXSessionStorage['save']>().mockResolvedValue(undefined);
    await saveSessionSnapshot({
      provider: 'anthropic',
      session: { id: 'git-unavailable', storage: { save } as KodaXSessionStorage },
      context: { executionCwd: cwd },
    }, 'git-unavailable', { messages: [], title: 'saved' });
    expect(save).toHaveBeenCalledWith('git-unavailable', expect.objectContaining({
      gitRoot: '',
      runtimeInfo: expect.objectContaining({ executionCwd: cwd.replace(/\\/g, '/') }),
    }));
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  it('keeps an explicitly supplied session root without probing Git', async () => {
    const save = vi.fn<KodaXSessionStorage['save']>().mockResolvedValue(undefined);
    await saveSessionSnapshot({
      provider: 'anthropic',
      session: { id: 'known-root', storage: { save } as KodaXSessionStorage },
      context: { executionCwd: cwd, gitRoot: cwd },
    }, 'known-root', { messages: [], title: 'saved' });
    expect(save).toHaveBeenCalledWith('known-root', expect.objectContaining({ gitRoot: cwd }));
    expect(preflight).not.toHaveBeenCalled();
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  it('leaves optional checkpoint HEAD unknown without launching Git', async () => {
    expect(await getGitHeadCommit(cwd)).toBeUndefined();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('builds the prompt while omitting unavailable Git context', async () => {
    const sections = await buildCapabilityContextSections({
      provider: 'anthropic', context: { executionCwd: cwd },
    }, true);
    expect(sections.some((section) => section.id === 'working-directory')).toBe(true);
    expect(sections.some((section) => section.id === 'git-context')).toBe(false);
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  it('reports unavailable diff evidence instead of claiming no changes', async () => {
    const evidence = await resolveEvidenceRef('diff:example.ts', {
      executionCwd: cwd, backups: new Map(),
    });
    expect(evidence).toBe('- diff:example.ts (could not get diff)');
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it('reports the prerequisite error for an explicit diff request', async () => {
    await expect(toolChangedDiff({ path: 'example.ts' }, {
      executionCwd: cwd, backups: new Map(),
    })).resolves.toContain('macOS developer tools unavailable');
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('retains worktrees and reports a sweep warning when Git cannot run', async () => {
    const result = await sweepWorkflowRunWorktrees({ gitRoot: cwd, baseDir: path.join(cwd, 'run') });
    expect(result.removed).toEqual([]);
    expect(result.warnings.join(' ')).toContain('macOS developer tools unavailable');
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('blocks worktree creation before launching or registering a Git process', async () => {
    await expect(toolWorktreeCreate({
      branch_name: 'blocked-git', base_dir: path.join(cwd, 'worktrees'),
    }, { executionCwd: cwd, backups: new Map() })).rejects.toThrow('macOS developer tools unavailable');
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({
      cwd,
      executable: expect.stringMatching(/git(?:\.exe)?$/),
    }));
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('does not claim worktree removal succeeded when Git is blocked', async () => {
    await expect(toolWorktreeRemove({
      worktree_path: path.join(cwd, 'worktree'), action: 'remove',
    }, { executionCwd: cwd, backups: new Map() })).rejects.toThrow('macOS developer tools unavailable');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('keeps failed Git change capture visible in workflow verification', async () => {
    const ctx: KodaXToolExecutionContext = { executionCwd: cwd, backups: new Map() };
    const session = new CodingActorSession({ maxConcurrentThreadsPerSession: 4 });
    ctx.actorHost = session;
    ctx.actorControl = session.attach(ctx, { provider: 'anthropic' });
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions: {
        maxIterationsPerChild: 50, parentRole: 'worker', parentHarness: 'workflow', parentOptions: {},
      },
      runChild: async () => ({
        results: [{
          childId: 'writer', fanoutClass: 'evidence-scan', status: 'completed', disposition: 'valid',
          summary: 'Completed requested work.', evidenceRefs: [], contradictions: [],
        }],
        mergedFindings: [], mergedArtifacts: [], totalTokensUsed: 0, cancelledChildren: [],
      }),
    });
    const handle = await backend.spawn({ name: 'writer', prompt: 'write files', readOnly: false });
    const result = await backend.wait(handle.taskId);
    expect(result.verification?.reasons.join(' ')).toContain('macOS developer tools unavailable');
    expect(result.verification?.ok).toBe(false);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});
