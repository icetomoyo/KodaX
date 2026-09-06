import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  loadCompactionConfig: vi.fn(),
  resolveProvider: vi.fn(),
}));

vi.mock('@kodax-ai/agent', async () => {
  // Partial mock: only override `compact`. Keep all other exports real.
  // (v0.7.35.1 FEATURE_142 Batch B: compact() moved from @kodax-ai/agent to
  // @kodax-ai/agent; mock the new home — see ADR-021.)
  const actual = await vi.importActual<typeof import('@kodax-ai/agent')>('@kodax-ai/agent');
  return {
    ...actual,
    compact: mocks.compact,
  };
});

vi.mock('../common/compaction-config.js', () => ({
  loadCompactionConfig: mocks.loadCompactionConfig,
}));

vi.mock('@kodax-ai/coding', async () => {
  const actual = await vi.importActual<typeof import('@kodax-ai/coding')>('@kodax-ai/coding');
  return {
    ...actual,
    resolveProvider: mocks.resolveProvider,
  };
});

import { BUILTIN_COMMANDS, type CommandCallbacks, type CurrentConfig } from './commands.js';
import { createInteractiveContext, type InteractiveContext } from './context.js';

describe('/compact command', () => {
  let context: InteractiveContext;
  let callbacks: CommandCallbacks;
  let currentConfig: CurrentConfig;

  beforeEach(async () => {
    context = await createInteractiveContext({});
    context.contextTokenSnapshot = {
      currentTokens: 50000,
      baselineEstimatedTokens: 50000,
      source: 'estimate',
    };

    callbacks = {
      exit: vi.fn(),
      saveSession: vi.fn(async () => {}),
      loadSession: vi.fn(async (): Promise<'loaded'> => 'loaded') as CommandCallbacks['loadSession'],
      listSessions: vi.fn(async () => {}),
      clearHistory: vi.fn(),
      printHistory: vi.fn(),
      startCompacting: vi.fn(),
      stopCompacting: vi.fn(),
      ui: {} as CommandCallbacks['ui'],
    };

    currentConfig = {
      provider: 'zhipu-coding',
      thinking: true,
      reasoningMode: 'auto',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };

    mocks.resolveProvider.mockReturnValue({
      getContextWindow: () => 200000,
      getEffectiveMaxOutputTokens: () => 32_000,
    });
    mocks.loadCompactionConfig.mockResolvedValue({
      enabled: false,
      triggerPercent: 75,
    });
    mocks.compact.mockResolvedValue({
      compacted: false,
      messages: context.messages,
      tokensBefore: 50000,
      tokensAfter: 50000,
      entriesRemoved: 0,
    });
  });

  it('keeps manual /compact available for a legacy enabled false config', async () => {
    const compactCommand = BUILTIN_COMMANDS.find(command => command.name === 'compact');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(compactCommand).toBeDefined();
    await compactCommand!.handler([], context, callbacks, currentConfig);

    expect(mocks.compact).toHaveBeenCalledTimes(1);
    const compactionConfig = mocks.compact.mock.calls[0]?.[1];
    expect(compactionConfig).toMatchObject({
      enabled: true,
      triggerPercent: 75,
    });
    expect(mocks.compact.mock.calls[0]?.[6]).toBe(50000);
    expect(mocks.compact.mock.calls[0]?.[10]).toBe(true);
    expect(mocks.compact.mock.calls[0]?.[11]).toBe(32_000);
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Compaction is disabled in config');
    expect(callbacks.startCompacting).toHaveBeenCalledTimes(1);
    expect(callbacks.stopCompacting).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it('documents the always-on bounded trigger contract', () => {
    const compactCommand = BUILTIN_COMMANDS.find(command => command.name === 'compact');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(compactCommand?.detailedHelp).toBeDefined();
    compactCommand!.detailedHelp!();

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Automatic large compaction is always enabled');
    expect(output).toContain('15-90, default 75');
    expect(output).toContain('compaction.triggerTokens');
    expect(output).toContain('deprecated and ignored');

    logSpy.mockRestore();
  });
});

/** FEATURE_298 T34 — manual /compact delegates to the Host when bound. */
describe('/compact Host binding (T34)', () => {
  let context: InteractiveContext;
  let callbacks: CommandCallbacks;
  let currentConfig: CurrentConfig;

  beforeEach(async () => {
    context = await createInteractiveContext({});
    context.contextTokenSnapshot = {
      currentTokens: 50000,
      baselineEstimatedTokens: 50000,
      source: 'estimate',
    };
    callbacks = {
      exit: vi.fn(),
      saveSession: vi.fn(async () => {}),
      loadSession: vi.fn(async (): Promise<'loaded'> => 'loaded') as CommandCallbacks['loadSession'],
      listSessions: vi.fn(async () => {}),
      clearHistory: vi.fn(),
      printHistory: vi.fn(),
      startCompacting: vi.fn(),
      stopCompacting: vi.fn(),
      ui: {} as CommandCallbacks['ui'],
    };
    currentConfig = {
      provider: 'zhipu-coding',
      thinking: true,
      reasoningMode: 'auto',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };
    mocks.resolveProvider.mockReturnValue({
      getContextWindow: () => 200000,
      getEffectiveMaxOutputTokens: () => 32_000,
    });
    // Module-level mocks accumulate across describes; isolate this one.
    mocks.compact.mockClear();
    mocks.loadCompactionConfig.mockReset();
  });

  it('compacts through the binding without a provider or a local save', async () => {
    const compactCommand = BUILTIN_COMMANDS.find(command => command.name === 'compact');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const compact = vi.fn(async () => ({
      compacted: true,
      tokensBefore: 50000,
      tokensAfter: 12000,
      messages: [
        { role: 'system' as const, content: 'compacted checkpoint' },
        { role: 'user' as const, content: 'recent' },
      ],
    }));

    try {
      await compactCommand!.handler(
        ['focus on auth'],
        context,
        { ...callbacks, compactSession: { compact } },
        currentConfig,
      );

      expect(compact).toHaveBeenCalledWith({
        sessionId: context.sessionId,
        customInstructions: 'focus on auth',
      });
      // The Host owns the provider, the compaction, and the persisted
      // result; the local writer is never invoked.
      expect(mocks.compact).not.toHaveBeenCalled();
      expect(callbacks.saveSession).not.toHaveBeenCalled();
      expect(context.messages).toHaveLength(2);
      expect(context.messages[0]?.content).toBe('compacted checkpoint');
      expect(context.contextTokenSnapshot?.currentTokens).toBe(12000);
      expect(callbacks.startCompacting).toHaveBeenCalled();
      expect(callbacks.stopCompacting).toHaveBeenCalled();
      expect(logSpy.mock.calls.flat().join(' ')).toMatch(/Compaction complete/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reports a no-op through the binding result', async () => {
    const compactCommand = BUILTIN_COMMANDS.find(command => command.name === 'compact');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const compact = vi.fn(async () => ({
      compacted: false,
      tokensBefore: 40000,
      tokensAfter: 40000,
      messages: context.messages,
      reason: 'below-threshold',
    }));

    try {
      await compactCommand!.handler(
        [],
        context,
        { ...callbacks, compactSession: { compact } },
        currentConfig,
      );
      expect(compact).toHaveBeenCalledWith({ sessionId: context.sessionId });
      expect(logSpy.mock.calls.flat().join(' ')).toMatch(/No compaction needed/);
      expect(callbacks.saveSession).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
