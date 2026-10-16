import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as setupConfig from '../common/setup-config.js';
import { BUILTIN_COMMANDS, executeCommand, getCommandRegistry, type CommandCallbacks } from './commands.js';
import { createInteractiveContext } from './context.js';
import * as providerSetup from './provider-setup.js';

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

  it('shows /repo-intel and hides deprecated /repointel in top-level help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'help');

    expect(helpCommand).toBeDefined();
    await helpCommand!.handler([], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('/repo-intel');
    expect(output).not.toContain('/repointel');
  });

  it('routes /<command> help through detailed help without executing the command', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const callbacks = {
      saveSession: vi.fn(async () => {}),
      exit: vi.fn(),
    } as unknown as CommandCallbacks;

    const result = await executeCommand(
      { command: 'exit', args: ['help'] },
      context,
      callbacks,
      {} as never,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(result).toBe(true);
    expect(callbacks.exit).not.toHaveBeenCalled();
    expect(output).toContain('/exit - Exit Interactive Mode');
  });

  it.each([
    { command: 'learn', args: ['help', 'promote'] },
    { command: 'help', args: ['learn', 'promote'] },
    { command: 'learn', args: ['promote', '--help'] },
  ])('routes learned Skill promotion help through the real dispatcher: /$command $args', async (parsed) => {
    const chunks: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    });

    try {
      const result = await executeCommand(
        parsed,
        await createInteractiveContext({}),
        {} as unknown as CommandCallbacks,
        {} as never,
      );
      expect(result).toBe(true);
      expect(chunks.join('\n')).toContain('/learn promote <name|slug|capability-id> [--scope user]');
      expect(chunks.join('\n')).toContain('Promote is an explicit ownership transfer');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('shows the shared onboarding guide for /setup --help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const callbacks = {
      saveSession: vi.fn(async () => {}),
      exit: vi.fn(),
    } as unknown as CommandCallbacks;

    const result = await executeCommand(
      { command: 'setup', args: ['--help'] },
      context,
      callbacks,
      {} as never,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(result).toBe(true);
    expect(output).toContain('KodaX setup guide');
    expect(output).toContain('kodax setup --custom');
    expect(output).toContain('/model');
    expect(output).toContain('mcp.json');
    expect(output).not.toContain('Alt+M');
  });

  it('shows refreshed sandbox diagnostics only when /sandbox is requested', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const inspectSandbox = vi.fn(async () => ({
      ready: true,
      platform: 'win32',
      version: '0.0.65',
      backend: 'windows-restricted-user',
      diagnostics: [] as string[],
      guidance: ['KodaX sandbox is active (win32, ASRT 0.0.65).'],
    }));

    const result = await executeCommand(
      { command: 'sandbox', args: [] },
      await createInteractiveContext({}),
      { inspectSandbox } as unknown as CommandCallbacks,
      {} as never,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(result).toBe(true);
    expect(inspectSandbox).toHaveBeenCalledOnce();
    expect(output).toContain('Sandbox');
    expect(output).toContain('ready');
    expect(output).toContain('windows-restricted-user');
    expect(output).toContain('0.0.65');
  });

  it('keeps /sandbox unavailable diagnostics explicit without triggering setup', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const inspectSandbox = vi.fn(async () => ({
      ready: false,
      platform: 'linux',
      version: '0.0.65',
      backend: 'bubblewrap',
      diagnostics: ['bubblewrap is unavailable'],
      guidance: ['Run: apt install bubblewrap socat ripgrep'],
    }));
    const prepareSetupSandbox = vi.fn();

    await executeCommand(
      { command: 'sandbox', args: [] },
      await createInteractiveContext({}),
      { inspectSandbox, prepareSetupSandbox } as unknown as CommandCallbacks,
      {} as never,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(inspectSandbox).toHaveBeenCalledOnce();
    expect(prepareSetupSandbox).not.toHaveBeenCalled();
    expect(output).toContain('unavailable');
    expect(output).toContain('bubblewrap is unavailable');
    expect(output).toContain('apt install bubblewrap socat ripgrep');
  });

  it('stops /setup before opening the provider UI when an active config is invalid', async () => {
    vi.spyOn(setupConfig, 'initializeSetupConfiguration').mockReturnValue({
      configHome: 'C:/Users/test/.kodax',
      files: [{
        domain: 'a2a',
        kind: 'active',
        status: 'invalid',
        path: 'C:/Users/test/.kodax/integrations/a2a.json',
        diagnostic: 'A2A config version must be 1 or 2.',
      }],
    });
    const wizard = vi.spyOn(providerSetup, 'runProviderSetupWizard');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prepareSetupSandbox = vi.fn(async () => ({
      status: 'unavailable' as const,
      lines: ['Install bubblewrap, socat, and ripgrep.'],
    }));

    const result = await executeCommand(
      { command: 'setup', args: [] },
      await createInteractiveContext({}),
      { prepareSetupSandbox } as unknown as CommandCallbacks,
      {} as never,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(result).toBe(true);
    expect(prepareSetupSandbox).toHaveBeenCalledOnce();
    expect(wizard).not.toHaveBeenCalled();
    expect(output).toContain('Sandbox');
    expect(output).toContain('bubblewrap');
    expect(output).toContain('invalid');
    expect(output).toContain('Setup stopped');
  });

  it('shows basic help for /<command> help when detailed help is absent', async () => {
    const registry = getCommandRegistry();
    const handler = vi.fn(async () => true);
    registry.register({
      name: 'deploy',
      description: 'Deploy the current project',
      usage: '/deploy [environment]',
      source: 'prompt',
      handler,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await executeCommand(
      { command: 'deploy', args: ['help'] },
      await createInteractiveContext({}),
      {} as unknown as CommandCallbacks,
      {} as never,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(result).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(output).toContain('/deploy');
    expect(output).toContain('Deploy the current project');
    expect(output).toContain('Usage: /deploy [environment]');
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

  it('FEATURE_218: /help <manual-topic> falls through to the self-knowledge manual', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'help');

    await helpCommand!.handler(['providers'], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Providers & models');
    expect(output).not.toContain('Unknown command');
  });

  it('FEATURE_218: /help <unknown> shows the manual index, not an error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'help');

    await helpCommand!.handler(['totally-unknown-xyz'], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('KodaX Manual — Index');
    expect(output).toContain('- troubleshooting: First run kodax doctor');
    expect(output).not.toContain('Unknown command');
  });

  it('rejects retired AMAW and documents explicit /workflow support in AMA', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const setAgentMode = vi.fn();
    const callbacks = {
      saveSession: vi.fn(async () => {}),
      exit: vi.fn(),
      setAgentMode,
    } as unknown as CommandCallbacks;
    const currentConfig = {
      provider: 'openai',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    } as const;

    const result = await executeCommand(
      { command: 'agent-mode', args: ['amaw'] },
      context,
      callbacks,
      currentConfig,
    );

    const agentModeCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'agent-mode');
    agentModeCommand?.detailedHelp?.();
    const output = logSpy.mock.calls.flat().join('\n');

    expect(result).toBe(true);
    expect(setAgentMode).not.toHaveBeenCalled();
    expect(output).toContain('AMAW was retired in v0.7.72');
    expect(output).toContain('/agent-mode ama');
    expect(output).toContain('/workflow');
  });

  it('explains retired SA and toggle commands without changing settings', async () => {
    const context = await createInteractiveContext({});
    const setAgentMode = vi.fn();
    const callbacks = {
      saveSession: vi.fn(async () => {}),
      exit: vi.fn(),
      setAgentMode,
    } as unknown as CommandCallbacks;
    const baseConfig = {
      provider: 'openai',
      thinking: false,
      reasoningMode: 'off',
      permissionMode: 'accept-edits',
    } as const;

    const retiredSA = await executeCommand(
      { command: 'agent-mode', args: ['sa'] },
      context,
      callbacks,
      { ...baseConfig, agentMode: 'ama' },
    );
    const retiredToggle = await executeCommand(
      { command: 'agent-mode', args: ['toggle'] },
      context,
      callbacks,
      { ...baseConfig, agentMode: 'sa' },
    );

    expect(setAgentMode).not.toHaveBeenCalled();
    for (const result of [retiredSA, retiredToggle]) {
      expect(result).toMatchObject({ success: false, message: expect.stringMatching(/retired.*AMA/i) });
    }
  });
});
