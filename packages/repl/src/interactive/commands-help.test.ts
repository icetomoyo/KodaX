import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, getCommandRegistry, type CommandCallbacks } from './commands.js';
import { createInteractiveContext } from './context.js';

describe('help command output', () => {
  beforeEach(() => {
    const registry = getCommandRegistry();
    registry.clear();
    getCommandRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const registry = getCommandRegistry();
    registry.clear();
    getCommandRegistry();
  });

  it('shows dynamically registered commands in top-level help', async () => {
    const registry = getCommandRegistry();
    registry.register({
      name: 'deploy',
      aliases: ['dep'],
      description: 'Deploy the current project',
      source: 'extension',
      handler: async () => {},
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'help');

    expect(helpCommand).toBeDefined();
    await helpCommand!.handler([], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Extensions:');
    expect(output).toContain('/deploy');
    expect(output).not.toContain('/project');
  });

  it('hides non-user-invocable commands from top-level help', async () => {
    const registry = getCommandRegistry();
    registry.register({
      name: 'internal-sync',
      description: 'Internal sync command',
      source: 'extension',
      userInvocable: false,
      handler: async () => {},
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'help');

    expect(helpCommand).toBeDefined();
    await helpCommand!.handler([], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('/internal-sync');
  });

  it('documents workspace-aware session semantics for save/load/sessions/delete', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const saveCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'save');
    const loadCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'load');
    const sessionsCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'sessions');
    const deleteCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'delete');

    saveCommand?.detailedHelp?.();
    loadCommand?.detailedHelp?.();
    sessionsCommand?.detailedHelp?.();
    deleteCommand?.detailedHelp?.();

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Saving updates session storage only');
    expect(output).toContain('sibling workspaces in the same canonical repo');
    expect(output).toContain('workspace truth');
    expect(output).toContain('Current workspaces and checkouts remain untouched');
  });

  it('keeps workspace unchanged when saving, exiting, or deleting sessions', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({
      gitRoot: 'C:/repo/worktrees/runtime-docs',
      runtimeInfo: {
        canonicalRepoRoot: 'C:/repo',
        workspaceRoot: 'C:/repo/worktrees/runtime-docs',
        executionCwd: 'C:/repo/worktrees/runtime-docs/packages/repl',
        branch: 'feature/runtime-docs',
        workspaceKind: 'managed',
      },
    });
    const callbacks = {
      saveSession: vi.fn(async () => {}),
      exit: vi.fn(),
      deleteSession: vi.fn(async () => {}),
    } as unknown as CommandCallbacks;

    await BUILTIN_COMMANDS.find((cmd) => cmd.name === 'save')!.handler([], context, callbacks, {} as never);
    await BUILTIN_COMMANDS.find((cmd) => cmd.name === 'delete')!.handler(['session-1'], context, callbacks, {} as never);
    await BUILTIN_COMMANDS.find((cmd) => cmd.name === 'exit')!.handler([], context, callbacks, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Workspace unchanged');
    expect(output).toContain('feature/runtime-docs');
  });
});
