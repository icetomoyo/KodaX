import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, compact: vi.fn() };
});

import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import type {
  KodaXEphemeralSuffix,
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { compact as mockedCompact } from '@kodax-ai/agent';

import { MEMORY_EVIDENCE_PREFIX } from '../memory/rendering.js';
import type { RuntimeContextBudgetSnapshot } from './context-budget.js';
import { shouldInstallProductionLearningReviewer } from './run-substrate.js';
import { runTestSubstrate as runSubstrate } from './test-leaf.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;
const PROVIDER_NAME = 'memory-intervention-runtime-test';
const API_KEY_ENV = 'MEMORY_INTERVENTION_RUNTIME_TEST_API_KEY';

class MemoryInterventionProvider extends KodaXBaseProvider {
  static suffixes: Array<KodaXEphemeralSuffix | undefined> = [];
  static requestCount = 0;

  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'memory-intervention-model',
    supportsThinking: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 1_000,
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _systemPrompt: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    options?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    MemoryInterventionProvider.suffixes.push(options?.ephemeralSuffix);
    MemoryInterventionProvider.requestCount += 1;
    if (MemoryInterventionProvider.requestCount === 1) {
      return {
        textBlocks: [],
        thinkingBlocks: [],
        toolBlocks: [{
          type: 'tool_use',
          id: 'failed-read',
          name: 'read',
          input: { path: 'missing-fixture.txt' },
        }],
      };
    }
    return {
      textBlocks: [{ type: 'text', text: 'done after failure evidence' }],
      thinkingBlocks: [],
      toolBlocks: [],
    };
  }
}

describe('runSubstrate memory intervention ordering', { timeout: 30_000 }, () => {
  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    MemoryInterventionProvider.suffixes = [];
    MemoryInterventionProvider.requestCount = 0;
    compactMock.mockReset();
    registerModelProvider(PROVIDER_NAME, () => new MemoryInterventionProvider());
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
  });

  it('preserves an explicitly configured legacy Memory reviewer', () => {
    expect(shouldInstallProductionLearningReviewer({
      memoryReviewer: async (input) => ({
        trigger: input.trigger,
        createdAt: input.createdAt,
        task: input.task,
        sourceRefs: input.sourceRefs,
        candidateRefs: input.candidates.map((candidate) => candidate.ref),
        actions: [],
        warnings: [],
      }),
    })).toBe(false);
    expect(shouldInstallProductionLearningReviewer({})).toBe(true);
  });

  it('injects one failed-tool reminder into the next Action request without a selector runner', async () => {
    const snapshots: RuntimeContextBudgetSnapshot[] = [];
    await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'memory-intervention-model',
      maxIter: 2,
      reasoningMode: 'off',
      context: {
        systemPromptOverride: 'MEMORY INTERVENTION TEST',
        contextDiagnostics: true,
      },
      events: {
        beforeToolExecute: async () => '[Tool Error] fixture read failed',
        onContextBudgetSnapshot: (snapshot) => snapshots.push(snapshot),
      },
    }, 'inspect the fixture');

    expect(MemoryInterventionProvider.suffixes).toHaveLength(2);
    expect(MemoryInterventionProvider.suffixes[0]).toBeUndefined();
    expect(MemoryInterventionProvider.suffixes[1]?.content).toContain(MEMORY_EVIDENCE_PREFIX);
    expect(MemoryInterventionProvider.suffixes[1]?.content).toContain('fixture read failed');
    expect(snapshots[1]?.tokenBreakdown.pendingInput).toBeGreaterThan(0);
    expect(snapshots[1]?.usedTokens).toBeLessThan(snapshots[1]!.contextWindow);
  });

  it('cancels a foreground selector before a second Action request is sent', async () => {
    const abort = new AbortController();
    let selectorStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      selectorStarted = resolve;
    });
    const run = runSubstrate({
      provider: PROVIDER_NAME,
      model: 'memory-intervention-model',
      maxIter: 2,
      reasoningMode: 'off',
      abortSignal: abort.signal,
      context: { systemPromptOverride: 'MEMORY INTERVENTION TEST' },
      memoryRecallRunner: async (input) => {
        selectorStarted?.();
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { selectedRefIds: [] };
      },
      events: {
        beforeToolExecute: async () => '[Tool Error] fixture read failed',
      },
    }, 'inspect the fixture');

    await started;
    abort.abort('user cancelled selector');
    const result = await run;

    expect(result.interrupted).toBe(true);
    expect(MemoryInterventionProvider.requestCount).toBe(1);
    expect(MemoryInterventionProvider.suffixes).toEqual([undefined]);
  });

  it('does not reach the Action request when the durable compaction commit rejects', async () => {
    compactMock.mockResolvedValue({
      compacted: true,
      messages: [{ role: 'system', content: 'compacted history' }],
      summary: 'compacted history',
      tokensBefore: 100_000,
      tokensAfter: 10,
      entriesRemoved: 1,
    });
    const initialMessages: KodaXMessage[] = [{
      role: 'user',
      content: `oversized history ${'context '.repeat(20_000)}`,
    }];
    const commitFailure = new Error('durable compaction commit failed');

    const result = await runSubstrate({
      provider: PROVIDER_NAME,
      model: 'memory-intervention-model',
      maxIter: 1,
      reasoningMode: 'off',
      compaction: { contextWindow: 32_000, triggerPercent: 100 },
      session: { initialMessages },
      events: {
        onCompactedMessages: async () => {
          throw commitFailure;
        },
      },
    }, 'continue after compaction');

    expect(result).toMatchObject({
      success: false,
      errorMetadata: { lastError: commitFailure.message },
    });
    expect(compactMock).toHaveBeenCalledOnce();
    expect(MemoryInterventionProvider.suffixes).toHaveLength(0);
  });
});
