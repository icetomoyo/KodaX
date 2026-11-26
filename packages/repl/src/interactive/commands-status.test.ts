import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, getCommandRegistry, type CommandCallbacks, type CurrentConfig } from './commands.js';
import { createInteractiveContext, type InteractiveContext } from './context.js';

describe('status workspace output', () => {
  let context: InteractiveContext;
  let currentConfig: CurrentConfig;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    const registry = getCommandRegistry();
    registry.clear();
    getCommandRegistry();

    context = await createInteractiveContext({
      gitRoot: 'C:/repo/worktrees/feature-runtime',
      runtimeInfo: {
        canonicalRepoRoot: 'C:/repo',
        workspaceRoot: 'C:/repo/worktrees/feature-runtime',
        executionCwd: 'C:/repo/worktrees/feature-runtime/packages/repl',
        branch: 'feature/runtime-truth',
        workspaceKind: 'managed',
      },
      existingMessages: [{ role: 'user', content: 'status please' }],
    });

    currentConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      thinking: true,
      reasoningMode: 'balanced',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
      repoIntelligenceMode: 'off',
      repoIntelligenceTrace: false,
    };
  });

  it('shows deeper workspace/runtime truth when requested', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const statusCommand = BUILTIN_COMMANDS.find((command) => command.name === 'status');

    expect(statusCommand).toBeDefined();
    await statusCommand!.handler(['workspace'], context, {} as CommandCallbacks, currentConfig);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Session Status');
    expect(output).toContain('Workspace:');
    expect(output).toContain('feature/runtime-truth');
    expect(output).toContain('[managed]');
    expect(output).toContain('Canonical:');
    expect(output).toContain('C:/repo');
    expect(output).toContain('Exec CWD:');
    expect(output).toContain('packages/repl');
    expect(output).toContain('Kind:');
    expect(output).toContain('managed');
  });

  it.each(['effort', 'reasoning', 'mode', 'agent-mode'])('reports Host default in /%s after a peer clears the override', async name => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    currentConfig.hostSettings = {};
    const command = BUILTIN_COMMANDS.find(candidate => candidate.name === name)!;
    const result = await command.handler([], context, {} as CommandCallbacks, currentConfig);
    const output = result && typeof result === 'object' && 'message' in result
      ? String(result.message) : logSpy.mock.calls.flat().join('\n');
    expect(output).toContain(name === 'mode' ? 'Current mode: Host default'
      : name === 'agent-mode' ? 'Agent mode: Host default' : 'Reasoning effort: Host default');
  });

  it('shows SDK runtime identity and daemon counters for runtime detail status', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const statusCommand = BUILTIN_COMMANDS.find((command) => command.name === 'status');
    const getRuntimeStatus = vi.fn(async () => ({
      mode: 'daemon' as const,
      profile: 'space',
      runtimeId: 'rt_status_test',
      startedAt: '2026-07-09T00:00:00.000Z',
      endpoint: '\\\\.\\pipe\\kodax-runtime-status-test',
      health: 'ready',
      sessions: 2,
      runs: 4,
      activeRuns: 1,
      queuedRuns: 2,
      pendingPermissions: 1,
      workflows: 3,
    }));

    expect(statusCommand).toBeDefined();
    await statusCommand!.handler(
      ['runtime'],
      context,
      { getRuntimeStatus } as unknown as CommandCallbacks,
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(output).toContain('SDK Runtime:');
    expect(output).toContain('daemon');
    expect(output).toContain('space');
    expect(output).toContain('rt_status_test');
    expect(output).toMatch(/Health:\s+ready/);
    expect(output).toContain('kodax-runtime-status-test');
    expect(output).toContain('active=1');
    expect(output).toContain('queued=2');
    expect(output).toContain('pending permissions=1');
    expect(output).toContain('workflows=3');
  });

  it('does not expose the removed auto-mode diagnostic commands', () => {
    // auto-denials printed reviewer counters nobody acted on; an Auto refusal
    // already says why and what to do instead.
    expect(BUILTIN_COMMANDS.some((candidate) => candidate.name === 'auto-engine' || candidate.name === 'auto-denials')).toBe(false);
  });

  it('does not publish a mode change before Runtime settings synchronize', async () => {
    const command = BUILTIN_COMMANDS.find((candidate) => candidate.name === 'mode');
    const setPermissionMode = vi.fn(async () => {
      throw new Error('runtime sync failed');
    });

    await expect(command!.handler(
      ['auto'],
      context,
      { setPermissionMode } as unknown as CommandCallbacks,
      currentConfig,
    )).rejects.toThrow('runtime sync failed');

    expect(setPermissionMode).toHaveBeenCalledWith('auto');
    expect(currentConfig.permissionMode).toBe('accept-edits');
  });

  it('shows built-in repo-intel status without external endpoint/bin controls', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const repoIntelCommand = BUILTIN_COMMANDS.find((command) => command.name === 'repo-intel');

    expect(repoIntelCommand).toBeDefined();
    await repoIntelCommand!.handler(
      ['status'],
      context,
      {} as CommandCallbacks,
      {
        ...currentConfig,
        repoIntelligenceMode: 'full',
        repoIntelligenceTrace: true,
      },
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Repo Intelligence');
    expect(output).toContain('Mode:');
    expect(output).toContain('full');
    expect(output).toContain('Trace:');
    expect(output).toContain('on');
    expect(output).not.toContain('Endpoint:');
    expect(output).not.toContain('Bin:');
  });
});
