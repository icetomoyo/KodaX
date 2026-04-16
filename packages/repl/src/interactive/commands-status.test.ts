import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, getCommandRegistry, type CommandCallbacks, type CurrentConfig } from './commands.js';
import { createInteractiveContext, type InteractiveContext } from './context.js';

describe('status workspace output', () => {
  let context: InteractiveContext;
  let currentConfig: CurrentConfig;

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
});
