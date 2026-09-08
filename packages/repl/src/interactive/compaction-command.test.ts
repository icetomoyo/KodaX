import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
import { FileSessionStorage } from './storage.js';
import { saveClassicSession } from './repl.js';
import { COMPACTION_SUMMARY_PREFIX } from '@kodax-ai/agent';

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

  it('keeps the previous context and UI when the durable save fails', async () => {
    context.messages = [{ role: 'user', content: 'EXACT_HISTORY' }];
    const previous = context.messages;
    const snapshot = context.contextTokenSnapshot;
    mocks.compact.mockResolvedValue({ compacted: true, summary: 'Summary',
      messages: [{ role: 'user', _source: 'compaction-checkpoint', content: 'Summary' }],
      tokensBefore: 50000, tokensAfter: 100, entriesRemoved: 1 });
    context.title = 'Original title';
    callbacks.saveSession = vi.fn(async () => {
      context.title = 'Derived title';
      throw new Error('disk full');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await BUILTIN_COMMANDS.find(command => command.name === 'compact')!
        .handler([], context, callbacks, currentConfig);
      expect(context.messages).toBe(previous);
      expect(context.contextTokenSnapshot).toBe(snapshot);
      expect(context.title).toBe('Original title');
      expect(callbacks.clearHistory).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n')).toContain('disk full');
    } finally { log.mockRestore(); }
  });

  it('persists manual lineage and attachments through the real classic save callback', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kodax-classic-compact-'));
    const storage = new FileSessionStorage({ sessionsDir: directory });
    context.messages = [{ role: 'user', content: 'EXACT_PRE_COMPACT_QUERY' },
      { role: 'assistant', content: 'EXACT_PRE_COMPACT_RESPONSE' }];
    callbacks.saveSession = (lineage) => saveClassicSession(context, storage, 'partner', lineage);
    mocks.compact.mockResolvedValue({ compacted: true, summary: 'Summary',
      messages: [{ role: 'user', _source: 'compaction-checkpoint', _synthetic: true,
        content: `${COMPACTION_SUMMARY_PREFIX}Summary` }],
      tokensBefore: 50000, tokensAfter: 100, entriesRemoved: 2,
      anchor: { summary: 'Summary', reason: 'automatic_compaction' },
      artifactLedger: [{ id: 'read', kind: 'file_read', target: 'src/example.ts',
        action: 'read', timestamp: '2026-09-08T00:00:00.000Z' }],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await BUILTIN_COMMANDS.find(command => command.name === 'compact')!
        .handler([], context, callbacks, currentConfig);
      const loaded = await storage.load(context.sessionId);
      const entry = loaded?.lineage?.entries.find(item => item.type === 'compaction');
      expect(entry).toMatchObject({ type: 'compaction', reason: 'manual',
        tokensAfter: context.contextTokenSnapshot?.currentTokens });
      expect(loaded?.messages).toEqual(context.messages);
      expect(JSON.stringify(await storage.loadFullLineage(context.sessionId)))
        .toContain('EXACT_PRE_COMPACT_RESPONSE');
      expect(JSON.stringify(loaded?.messages)).toContain('src/example.ts');
      expect(loaded?.tag).toBe('partner');
      expect(callbacks.clearHistory).toHaveBeenCalledOnce();

      // Classic session switches can leave the previous session's lineage in memory.
      context.sessionId = 'different-session';
      context.messages = [{ role: 'user', content: 'SESSION_B_HISTORY' }];
      await saveClassicSession(context, storage);
      const other = await storage.load(context.sessionId);
      expect(other?.messages).toEqual(context.messages);
      expect(JSON.stringify(await storage.loadFullLineage(context.sessionId)))
        .not.toContain('EXACT_PRE_COMPACT_RESPONSE');
    } finally {
      log.mockRestore();
      if (path.dirname(directory) === path.resolve(tmpdir())) await rm(directory, { recursive: true });
    }
  });

  it('clears conversation state in /clear even when the host has no presentation history', async () => {
    context.messages = [{ role: 'user', content: 'clear this' }];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await BUILTIN_COMMANDS.find(command => command.name === 'clear')!
        .handler([], context, callbacks, currentConfig);
      expect(context.messages).toEqual([]);
      expect(context.contextTokenSnapshot).toBeUndefined();
    } finally { log.mockRestore(); }
  });

  it('uses the same explicit compaction policy as the automatic run options', async () => {
    callbacks.createKodaXOptions = () => ({
      compaction: { reasoning: { effort: 'low' }, triggerPercent: 60 },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await BUILTIN_COMMANDS.find(command => command.name === 'compact')!
        .handler([], context, callbacks, currentConfig);
      expect(mocks.compact.mock.lastCall?.[1]).toMatchObject({
        reasoning: { effort: 'low' }, triggerPercent: 60, enabled: true,
      });
    } finally { log.mockRestore(); }
  });
});
