import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, compact: vi.fn() };
});

import {
  Runner,
  compact as mockedCompact,
  createAgent,
  type AgentMessage,
  type CompactionResult,
} from '@kodax-ai/agent';
import type {
  KodaXMessage,
  KodaXReasoningRequest,
  KodaXToolDefinition,
} from '@kodax-ai/llm';
import { resolveProvider } from '../../../providers/index.js';
import { estimateTokens } from '../../../tokenizer.js';
import type { KodaXContextTokenSnapshot, KodaXOptions } from '../../../types.js';
import {
  buildManagedTaskCompactionHook,
  type ContextTokenSnapshotRef,
  type resolveManagedTaskContextCapacity,
} from './compaction.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;

function makeMessages(): KodaXMessage[] {
  return [{
    role: 'user',
    content: `FULL_EVIDENCE_SENTINEL\n${'evidence '.repeat(12_000)}`,
  }];
}

function snapshot(currentTokens: number, messages: KodaXMessage[]): KodaXContextTokenSnapshot {
  return {
    currentTokens,
    baselineEstimatedTokens: estimateTokens(messages),
    source: 'api',
  };
}

function compactedResult(messages: KodaXMessage[]): CompactionResult {
  const compacted = [{
    role: 'user' as const,
    content: '[对话历史摘要]\n\nComplete semantic summary with preserved decisions.',
    _synthetic: true,
    _source: 'compaction-checkpoint',
  }];
  const tokensBefore = estimateTokens(messages);
  const tokensAfter = estimateTokens(compacted);
  return {
    compacted: true,
    messages: compacted,
    summary: 'Complete semantic summary with preserved decisions.',
    tokensBefore,
    tokensAfter,
    entriesRemoved: messages.length,
    report: {
      strategy: 'full_prefix',
      triggerSource: 'percentage',
      effectiveTriggerTokens: 75_000,
      protectedBudgetTokens: 15_000,
      fixedInputTokens: 0,
      eligibleTokens: tokensBefore,
      rawTailTokens: 0,
      summaryTokens: tokensAfter,
      queryLedgerTokens: 0,
    },
    anchor: {
      summary: 'Complete semantic summary with preserved decisions.',
      tokensBefore,
      tokensAfter,
      entriesRemoved: messages.length,
      reason: 'automatic',
    },
  };
}

function resolvedCapacity(
  triggerPercent: number,
  contextWindow = 100_000,
  reservedResponseTokens = 10_000,
): Awaited<ReturnType<typeof resolveManagedTaskContextCapacity>> {
  const provider = resolveProvider('anthropic');
  vi.spyOn(provider, 'getEffectiveMaxOutputTokens').mockReturnValue(
    reservedResponseTokens,
  );
  return {
    provider,
    activeModel: 'claude-test',
    compactionConfig: { enabled: true, triggerPercent },
    contextWindow,
  };
}

function options(events: KodaXOptions['events'] = {}): KodaXOptions {
  return { provider: 'anthropic', model: 'claude-test', events } as KodaXOptions;
}

beforeEach(() => {
  compactMock.mockReset();
});

describe('managed history compaction', () => {
  it('builds the automatic hook even when a legacy caller passes enabled false', async () => {
    const capacity = resolvedCapacity(75);
    capacity.compactionConfig.enabled = false;

    await expect(buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: capacity,
    })).resolves.toBeTypeOf('function');
  });

  it('does nothing while the complete request fits physical capacity', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(70_000, messages) };
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: ref,
    });

    await expect(hook?.(messages)).resolves.toBeUndefined();
    expect(compactMock).not.toHaveBeenCalled();
  });

  it('passes the complete evidence to semantic compaction at hard pressure', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(88_000, messages) };
    compactMock.mockResolvedValue(compactedResult(messages));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: ref,
    });

    const result = await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(compactMock.mock.calls[0]?.[0]).toBe(messages);
    expect(compactMock.mock.calls[0]?.[10]).toBe(true);
    expect(JSON.stringify(compactMock.mock.calls[0]?.[0])).toContain(
      'FULL_EVIDENCE_SENTINEL',
    );
    expect(result).toEqual(compactedResult(messages).messages);
  });

  it('does not resolve diagnostics-only model metadata when diagnostics are disabled', async () => {
    const messages = makeMessages();
    const capacity = {
      ...resolvedCapacity(100),
      activeModel: undefined,
    };
    const getModel = vi.spyOn(capacity.provider, 'getModel');
    compactMock.mockResolvedValue(compactedResult(messages));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: capacity,
      contextTokenSnapshotRef: { current: snapshot(88_000, messages) },
    });

    await hook?.(messages);
    expect(getModel).not.toHaveBeenCalled();
  });

  it('keeps Runner\'s immutable Worker system prompt outside semantic compaction', async () => {
    const immutableSystem: KodaXMessage = {
      role: 'system',
      content: 'IMMUTABLE_WORKER_SYSTEM_PROMPT_BYTE_SENTINEL',
    };
    const mutableMessages = makeMessages();
    const messages = [immutableSystem, ...mutableMessages];
    const ref: ContextTokenSnapshotRef = { current: snapshot(88_000, messages) };
    compactMock.mockResolvedValue(compactedResult(mutableMessages));
    const reasoning: KodaXReasoningRequest = { enabled: true, effort: 'high' };
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: ref,
      activeToolDefinitions: [],
      reasoning,
    });

    const result = await hook?.(messages);

    expect(compactMock.mock.calls[0]?.[0]).toEqual(mutableMessages);
    expect(compactMock.mock.calls[0]?.[5]).toBe(immutableSystem.content);
    expect(compactMock.mock.calls[0]?.[12]).toEqual({
      tools: [],
      reasoning,
    });
    expect(result?.[0]).toEqual(immutableSystem);
    expect(result?.[1]?.content).toContain('Complete semantic summary');
  });

  it('reinstalls canonical managed context before the compacted summary', async () => {
    const canonicalContext: KodaXMessage = {
      role: 'user',
      content: '=== Managed Run Context ===\nCANONICAL_CONTEXT_SENTINEL',
      _synthetic: true,
      _source: 'managed-run-context',
    };
    const mutableMessages = [canonicalContext, ...makeMessages()];
    compactMock.mockImplementation(async (messages: KodaXMessage[]) => (
      compactedResult(messages)
    ));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(20),
      contextTokenSnapshotRef: {
        current: snapshot(88_000, mutableMessages),
      },
      canonicalManagedContext: () => canonicalContext,
    });

    const result = await hook?.(mutableMessages) as readonly KodaXMessage[];

    expect(JSON.stringify(compactMock.mock.calls[0]?.[0]))
      .not.toContain('CANONICAL_CONTEXT_SENTINEL');
    expect(result.filter((message) =>
      message._source === 'managed-run-context')).toHaveLength(1);
    expect(result[0]).toEqual(canonicalContext);
    expect(result[1]?._source).toBe('compaction-checkpoint');
  });

  it('excludes stripped managed contexts from the semantic compactor token override', async () => {
    const staleContext: KodaXMessage = {
      role: 'user',
      content: `=== Managed Run Context ===\n${'stale context '.repeat(2_000)}`,
      _synthetic: true,
      _source: 'managed-run-context',
    };
    const runtimeDelta: KodaXMessage = {
      role: 'user',
      content: `=== Managed Run Context ===\n${'runtime delta '.repeat(1_000)}`,
      _synthetic: true,
      _source: 'managed-runtime-context',
    };
    const compactableMessages = makeMessages();
    const mutableMessages = [staleContext, ...compactableMessages, runtimeDelta];
    const fixedEnvelopeTokens = 12_345;
    const currentTokens = fixedEnvelopeTokens + estimateTokens(mutableMessages);
    compactMock.mockImplementation(async (messages: KodaXMessage[]) => (
      compactedResult(messages)
    ));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(20),
      contextTokenSnapshotRef: {
        current: snapshot(currentTokens, mutableMessages),
      },
      canonicalManagedContext: () => staleContext,
    });

    await hook?.(mutableMessages);

    expect(compactMock.mock.calls[0]?.[0]).toEqual(compactableMessages);
    expect(compactMock.mock.calls[0]?.[6]).toBe(
      fixedEnvelopeTokens + estimateTokens(compactableMessages),
    );
  });

  it('preserves the exact Runner system message for the next LLM turn while adding a summary', async () => {
    const systemText = 'IMMUTABLE_WORKER_SYSTEM_PROMPT_BYTE_SENTINEL';
    const agent = createAgent({
      name: 'managed-compaction-worker',
      instructions: systemText,
    });
    const originalMessages: KodaXMessage[] = [
      { role: 'system', content: systemText },
      { role: 'user', content: `start\n${'reducible history '.repeat(2_000)}` },
    ];
    const currentTokens = estimateTokens(originalMessages) + 20_000;
    const contextWindow = currentTokens
      + 10_000
      + Math.max(2_048, Math.ceil(currentTokens * 0.03))
      - 1;
    const ref: ContextTokenSnapshotRef = {
      current: snapshot(currentTokens, originalMessages),
    };
    compactMock.mockImplementation(async (mutable: KodaXMessage[]) => (
      compactedResult(mutable)
    ));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(100, contextWindow),
      contextTokenSnapshotRef: ref,
    });
    let nextLlmMessages: readonly AgentMessage[] = [];

    await Runner.run(agent, String(originalMessages[1]!.content), {
      compactionHook: hook,
      llm: async (messages) => {
        nextLlmMessages = messages;
        return 'done';
      },
      tracer: null,
    });

    expect(nextLlmMessages[0]).toEqual({ role: 'system', content: systemText });
    expect(nextLlmMessages.some((message, index) => (
      index > 0
      && message.role === 'user'
      && String(message.content).includes('Complete semantic summary')
    ))).toBe(true);
  });

  it('counts active tool schemas before the first provider usage snapshot exists', async () => {
    const messages: KodaXMessage[] = [
      { role: 'system', content: 'worker system' },
      { role: 'user', content: `RESTORED_HISTORY_SENTINEL\n${'history '.repeat(8_000)}` },
    ];
    const activeToolDefinitions: KodaXToolDefinition[] = [{
      name: 'large_schema_tool',
      description: 'schema '.repeat(20_000),
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'query '.repeat(4_000) } },
      },
    }];
    const transcriptTokens = estimateTokens(messages);
    const ref: ContextTokenSnapshotRef = { current: undefined };
    compactMock.mockResolvedValue(compactedResult(messages.slice(1)));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(
        100,
        60_000,
        2_000,
      ),
      contextTokenSnapshotRef: ref,
      activeToolDefinitions,
    });

    await hook?.(messages);

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(compactMock.mock.calls[0]?.[6]).toBeGreaterThan(transcriptTokens);
  });

  it('preserves fixed envelope overhead when rebasing the compacted snapshot', async () => {
    const messages = makeMessages();
    const beforeEstimate = estimateTokens(messages);
    const ref: ContextTokenSnapshotRef = {
      current: snapshot(beforeEstimate + 20_000, messages),
    };
    const compacted = compactedResult(messages);
    compactMock.mockResolvedValue(compacted);
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(20),
      contextTokenSnapshotRef: ref,
    });

    await hook?.(messages);
    expect(ref.current?.baselineEstimatedTokens).toBe(estimateTokens(compacted.messages));
    expect(ref.current?.currentTokens).toBe(
      20_000 + estimateTokens(compacted.messages),
    );
  });

  it('fails open and records a breaker failure when hard-pressure summary fails transiently', async () => {
    const messages = makeMessages();
    const original = structuredClone(messages);
    const ref: ContextTokenSnapshotRef = { current: snapshot(88_000, messages) };
    compactMock.mockRejectedValue(new Error('summary provider unavailable'));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: ref,
    });

    // FEATURE_296 (ADR-067): a transient summarizer failure no longer aborts
    // the run under hard pressure; the hook returns undefined (fail open),
    // canonical history is untouched, and the circuit breaker records the
    // failure so repeated outages are bounded.
    await expect(hook?.(messages)).resolves.toBeUndefined();
    expect(messages).toEqual(original);
  });

  it('commits the best-effort compacted transcript when the summary alone still exceeds capacity', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(88_000, messages) };
    // Summary so large that even the compacted transcript stays over the
    // physical next-request budget.
    const oversizedMessages = [{
      role: 'user' as const,
      content: `oversized summary\n${'summary '.repeat(40_000)}`,
      _synthetic: true,
      _source: 'compaction-checkpoint',
    }];
    const overSized: CompactionResult = {
      ...compactedResult(messages),
      messages: oversizedMessages,
    };
    compactMock.mockResolvedValue(overSized);
    const onCompactEnd = vi.fn();
    const hook = await buildManagedTaskCompactionHook(options({ onCompactEnd }), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: ref,
    });

    // FEATURE_296 (ADR-067): a still-over compaction is committed best-effort
    // instead of aborting the run; the ladder owns the next request.
    const compacted = await hook?.(messages);

    expect(compacted).toBeDefined();
    expect(compacted).toEqual(overSized.messages);
    expect(onCompactEnd).toHaveBeenCalledWith(undefined, expect.objectContaining({
      outcome: 'compacted',
      stillOverCapacity: true,
    }));
  });

  it('treats a reclaimable escalation reserve as relieved after compaction (FEATURE_296 T3)', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(88_000, messages) };
    compactMock.mockResolvedValue(compactedResult(messages));
    const onCompactEnd = vi.fn();
    const hook = await buildManagedTaskCompactionHook(options({ onCompactEnd }), {
      resolvedContextCapacity: resolvedCapacity(100, 100_000, 40_000),
      contextTokenSnapshotRef: ref,
    });

    // The compacted transcript is over capacity with the 40k escalation
    // reserve but legal with the floor-bounded shrunk reserve, so no debt.
    const compacted = await hook?.(messages);

    expect(compacted).toBeDefined();
    expect(onCompactEnd).toHaveBeenCalledWith(undefined, expect.objectContaining({
      outcome: 'compacted',
    }));
    const endResult = onCompactEnd.mock.calls.at(-1)?.[1];
    expect(endResult?.stillOverCapacity).toBeUndefined();
  });

  it('fails open for an explicit early policy while physical capacity remains', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(75_000, messages) };
    compactMock.mockRejectedValue(new Error('temporary summary failure'));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: ref,
    });

    await expect(hook?.(messages)).resolves.toBeUndefined();
    expect(messages[0]?.content).toContain('FULL_EVIDENCE_SENTINEL');
  });

  it('does not spend failure budget when only managed context crosses the threshold', async () => {
    const managedContext: KodaXMessage = {
      role: 'user',
      content: `=== Managed Run Context ===\n${'managed state '.repeat(2_000)}`,
      _synthetic: true,
      _source: 'managed-run-context',
    };
    const compactableMessages = makeMessages();
    const messages = [managedContext, ...compactableMessages];
    const triggerTokens = 256_000;
    const fixedEnvelopeTokens = triggerTokens - estimateTokens(compactableMessages) - 1_000;
    const ref: ContextTokenSnapshotRef = {
      current: snapshot(fixedEnvelopeTokens + estimateTokens(messages), messages),
    };
    const capacity = resolvedCapacity(90, 400_000);
    capacity.compactionConfig.triggerTokens = triggerTokens;
    const onCompactStart = vi.fn();
    const onContextCompactionSkipped = vi.fn();
    const onContextCompactionFinished = vi.fn();
    compactMock.mockResolvedValue({
      compacted: false,
      messages: compactableMessages,
      tokensBefore: triggerTokens - 1_000,
      tokensAfter: triggerTokens - 1_000,
      entriesRemoved: 0,
    });
    const hook = await buildManagedTaskCompactionHook(options({
      onCompactStart,
      onContextCompactionSkipped,
      onContextCompactionFinished,
    }), {
      resolvedContextCapacity: capacity,
      contextTokenSnapshotRef: ref,
      canonicalManagedContext: () => managedContext,
    });

    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);

    expect(compactMock).not.toHaveBeenCalled();
    expect(onCompactStart).not.toHaveBeenCalled();
    expect(onContextCompactionFinished).not.toHaveBeenCalled();
    expect(onContextCompactionSkipped).toHaveBeenCalledTimes(4);
    expect(onContextCompactionSkipped).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: 'compactable_below_threshold',
      currentTokens: fixedEnvelopeTokens + estimateTokens(messages),
      compactableTokens: triggerTokens - 1_000,
    }));

    const growth: KodaXMessage = {
      role: 'assistant',
      content: 'new compactable evidence '.repeat(4_000),
    };
    const expandedCompactable = [...compactableMessages, growth];
    const expandedMessages = [managedContext, ...expandedCompactable];
    expect(fixedEnvelopeTokens + estimateTokens(expandedCompactable))
      .toBeGreaterThan(triggerTokens);
    ref.current = snapshot(
      fixedEnvelopeTokens + estimateTokens(expandedMessages),
      expandedMessages,
    );
    compactMock.mockResolvedValueOnce(compactedResult(expandedCompactable));

    const result = await hook?.(expandedMessages);

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(compactMock.mock.calls[0]?.[0]).toEqual(expandedCompactable);
    expect(result).toBeDefined();
    expect(onContextCompactionFinished).toHaveBeenCalledTimes(1);
    expect(onContextCompactionFinished).toHaveBeenCalledWith(expect.objectContaining({
      committed: true,
    }));
  });

  it('does not count a no-compactable-prefix result as a breaker failure', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(75_000, messages) };
    const onContextCompactionSkipped = vi.fn();
    compactMock.mockResolvedValue({
      compacted: false,
      messages,
      tokensBefore: 75_000,
      tokensAfter: 75_000,
      entriesRemoved: 0,
    });
    const hook = await buildManagedTaskCompactionHook(options({
      onContextCompactionSkipped,
    }), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: ref,
    });

    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(4);
    expect(onContextCompactionSkipped).toHaveBeenCalledTimes(4);
    expect(onContextCompactionSkipped).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: 'no_compactable_prefix',
      consecutiveFailures: 0,
    }));

    compactMock.mockResolvedValueOnce(compactedResult(messages));
    await expect(hook?.(messages)).resolves.toBeDefined();
    expect(compactMock).toHaveBeenCalledTimes(5);
  });

  it('reports summary failures through the compaction end outcome', async () => {
    const messages = makeMessages();
    const onCompactEnd = vi.fn();
    compactMock.mockRejectedValue(new Error('provider unavailable'));
    const hook = await buildManagedTaskCompactionHook(options({ onCompactEnd }), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: { current: snapshot(75_000, messages) },
    });

    await hook?.(messages);

    expect(onCompactEnd).toHaveBeenCalledWith(undefined, expect.objectContaining({
      outcome: 'failed',
      reason: 'summary_generation_failed',
      failurePhase: 'summary_generation',
      consecutiveFailures: 1,
    }));
  });

  it('does not spend failure budget when canonical managed context capture fails', async () => {
    const messages = makeMessages();
    const onCompactEnd = vi.fn();
    const canonicalManagedContext = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('context capture failed');
      })
      .mockReturnValue(undefined);
    compactMock.mockResolvedValue(compactedResult(messages));
    const hook = await buildManagedTaskCompactionHook(options({ onCompactEnd }), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: { current: snapshot(75_000, messages) },
      canonicalManagedContext,
    });

    await expect(hook?.(messages)).resolves.toBeUndefined();
    expect(compactMock).not.toHaveBeenCalled();
    expect(onCompactEnd).toHaveBeenLastCalledWith(undefined, expect.objectContaining({
      outcome: 'failed',
      reason: 'post_processing_failed',
      consecutiveFailures: 0,
      circuitBreakerState: 'closed',
    }));

    await expect(hook?.(messages)).resolves.toBeDefined();
    expect(compactMock).toHaveBeenCalledTimes(1);
  });

  it('counts persistence rejection but emits no successful compaction facts', async () => {
    const messages = makeMessages();
    const onCompactStats = vi.fn();
    const onCompact = vi.fn();
    const onContextCompactionFinished = vi.fn();
    const onCompactEnd = vi.fn();
    compactMock.mockResolvedValue(compactedResult(messages));
    const hook = await buildManagedTaskCompactionHook(options({
      onCompactStats,
      onCompact,
      onCompactedMessages: vi.fn().mockRejectedValue(new Error('session write failed')),
      onContextCompactionFinished,
      onCompactEnd,
    }), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: { current: snapshot(75_000, messages) },
    });

    await hook?.(messages);

    expect(onCompactStats).not.toHaveBeenCalled();
    expect(onCompact).not.toHaveBeenCalled();
    expect(onContextCompactionFinished).not.toHaveBeenCalled();
    expect(onCompactEnd).toHaveBeenCalledWith(undefined, expect.objectContaining({
      outcome: 'failed',
      reason: 'persistence_failed',
      failurePhase: 'persistence',
      consecutiveFailures: 1,
    }));
  });

  it('retries after a bounded circuit-breaker cooldown before physical pressure', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(75_000, messages) };
    const onContextCompactionSkipped = vi.fn();
    const onCompactEnd = vi.fn();
    compactMock.mockRejectedValue(new Error('temporary summary failure'));
    const hook = await buildManagedTaskCompactionHook(options({
      onContextCompactionSkipped,
      onCompactEnd,
    }), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: ref,
    });

    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(3);
    expect(onContextCompactionSkipped).toHaveBeenCalledTimes(2);
    expect(onContextCompactionSkipped).toHaveBeenNthCalledWith(1, expect.objectContaining({
      reason: 'circuit_breaker_cooldown',
      consecutiveFailures: 3,
      cooldownTurnsRemaining: 1,
      circuitBreakerState: 'open',
    }));
    expect(onContextCompactionSkipped).toHaveBeenNthCalledWith(2, expect.objectContaining({
      reason: 'circuit_breaker_cooldown',
      consecutiveFailures: 3,
      cooldownTurnsRemaining: 0,
      circuitBreakerState: 'open',
    }));

    compactMock.mockResolvedValueOnce(compactedResult(messages));
    await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(4);

    compactMock.mockRejectedValueOnce(new Error('new summary failure'));
    await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(5);
    expect(onCompactEnd).toHaveBeenLastCalledWith(undefined, expect.objectContaining({
      outcome: 'failed',
      reason: 'summary_generation_failed',
      consecutiveFailures: 1,
      circuitBreakerState: 'closed',
    }));
  });

  it('reopens the cooldown when a half-open summary attempt fails', async () => {
    const messages = makeMessages();
    const onContextCompactionSkipped = vi.fn();
    compactMock.mockRejectedValue(new Error('provider still unavailable'));
    const hook = await buildManagedTaskCompactionHook(options({
      onContextCompactionSkipped,
    }), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: { current: snapshot(75_000, messages) },
    });

    for (let attempt = 0; attempt < 6; attempt += 1) await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(4);

    await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(4);
    expect(onContextCompactionSkipped).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: 'circuit_breaker_cooldown',
      consecutiveFailures: 4,
      cooldownTurnsRemaining: 1,
      circuitBreakerState: 'open',
    }));
  });

  it('bypasses an open breaker immediately under physical context pressure', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(75_000, messages) };
    compactMock.mockRejectedValue(new Error('temporary summary failure'));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: ref,
    });

    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(3);

    ref.current = snapshot(88_000, messages);
    compactMock.mockResolvedValueOnce(compactedResult(messages));
    await expect(hook?.(messages)).resolves.toBeDefined();
    expect(compactMock).toHaveBeenCalledTimes(4);
    expect(compactMock.mock.calls[3]?.[10]).toBe(true);
  });

  it('rearms the breaker early after meaningful compactable growth', async () => {
    const messages = makeMessages();
    const ref: ContextTokenSnapshotRef = { current: snapshot(75_000, messages) };
    compactMock.mockRejectedValue(new Error('temporary summary failure'));
    const hook = await buildManagedTaskCompactionHook(options(), {
      resolvedContextCapacity: resolvedCapacity(70),
      contextTokenSnapshotRef: ref,
    });

    await hook?.(messages);
    await hook?.(messages);
    await hook?.(messages);
    expect(compactMock).toHaveBeenCalledTimes(3);

    ref.current = snapshot(84_000, messages);
    compactMock.mockResolvedValueOnce(compactedResult(messages));
    await expect(hook?.(messages)).resolves.toBeDefined();
    expect(compactMock).toHaveBeenCalledTimes(4);
  });

  it('fires lifecycle events and post-compact invalidation only after a real rewrite', async () => {
    const messages = makeMessages();
    const onCompactStart = vi.fn();
    const onCompactEnd = vi.fn();
    const onCompactedMessages = vi.fn();
    const onCompact = vi.fn();
    const onContextCompactionFinished = vi.fn();
    const onPostCompact = vi.fn();
    compactMock.mockResolvedValue(compactedResult(messages));
    const hook = await buildManagedTaskCompactionHook(options({
      onCompactStart,
      onCompactEnd,
      onCompact,
      onCompactedMessages,
      onContextCompactionFinished,
    }), {
      resolvedContextCapacity: resolvedCapacity(100),
      contextTokenSnapshotRef: { current: snapshot(88_000, messages) },
      onPostCompact,
    });

    await hook?.(messages);
    expect(onCompactStart).toHaveBeenCalledTimes(1);
    expect(onCompactEnd).toHaveBeenCalledTimes(1);
    expect(onCompactEnd).toHaveBeenCalledWith(undefined, expect.objectContaining({
      outcome: 'compacted',
      consecutiveFailures: 0,
      circuitBreakerState: 'closed',
    }));
    expect(onCompactedMessages).toHaveBeenCalledTimes(1);
    const finalMessages = onCompactedMessages.mock.calls[0]?.[0] as KodaXMessage[];
    const finalTokens = 88_000 - estimateTokens(messages) + estimateTokens(finalMessages);
    expect(onCompact).toHaveBeenCalledWith(finalTokens);
    expect(onCompactedMessages.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      anchor: expect.objectContaining({ tokensAfter: finalTokens }),
      preCompactionMessages: messages,
      report: compactedResult(messages).report,
    }));
    expect(onContextCompactionFinished).toHaveBeenCalledWith(expect.objectContaining({
      source: 'physical_capacity',
      tokensBefore: 88_000,
      tokensAfter: finalTokens,
      committed: true,
      strategy: 'full_prefix',
    }));
    expect(onCompactedMessages.mock.invocationCallOrder[0]).toBeLessThan(
      onContextCompactionFinished.mock.invocationCallOrder[0]!,
    );
    expect(onPostCompact).toHaveBeenCalledTimes(1);
  });
});
