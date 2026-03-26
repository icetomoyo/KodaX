import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS, type CommandCallbacks, type CurrentConfig } from './commands.js';
import { createInteractiveContext, type InteractiveContext } from './context.js';

describe('session tree commands', () => {
  let context: InteractiveContext;
  let currentConfig: CurrentConfig;
  let callbacks: CommandCallbacks;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    context = await createInteractiveContext({});
    currentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: true,
      reasoningMode: 'auto',
      parallel: true,
      permissionMode: 'accept-edits',
    };
    callbacks = {
      exit: () => undefined,
      saveSession: async () => undefined,
      loadSession: async () => 'loaded',
      listSessions: async () => undefined,
      clearHistory: () => undefined,
      printHistory: () => undefined,
      printSessionTree: vi.fn(async () => undefined),
      switchSessionBranch: vi.fn(
        async (): Promise<'switched'> => 'switched',
      ) as CommandCallbacks['switchSessionBranch'],
      labelSessionBranch: vi.fn(async () => true),
      forkSession: vi.fn(
        async (): Promise<'forked'> => 'forked',
      ) as CommandCallbacks['forkSession'],
      ui: {} as never,
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints the current session tree when /tree has no args', async () => {
    const treeCommand = BUILTIN_COMMANDS.find((command) => command.name === 'tree');
    await treeCommand?.handler([], context, callbacks, currentConfig);
    expect(callbacks.printSessionTree).toHaveBeenCalledOnce();
  });

  it('delegates /tree label to checkpoint labeling', async () => {
    const treeCommand = BUILTIN_COMMANDS.find((command) => command.name === 'tree');
    await treeCommand?.handler(['label', 'entry_1', 'checkpoint-a'], context, callbacks, currentConfig);
    expect(callbacks.labelSessionBranch).toHaveBeenCalledWith('entry_1', 'checkpoint-a');
  });

  it('delegates /fork to session forking', async () => {
    const forkCommand = BUILTIN_COMMANDS.find((command) => command.name === 'fork');
    await forkCommand?.handler(['entry_1'], context, callbacks, currentConfig);
    expect(callbacks.forkSession).toHaveBeenCalledWith('entry_1');
  });
});
