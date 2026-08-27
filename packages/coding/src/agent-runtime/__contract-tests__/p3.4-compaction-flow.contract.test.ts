import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return {
    ...actual,
    compact: vi.fn(),
    gracefulCompactDegradation: vi.fn(),
  };
});

import {
  compact as mockedCompact,
  gracefulCompactDegradation as mockedDegrade,
  type CompactionResult,
} from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';
import { estimateTokens } from '../../tokenizer.js';
import type { KodaXEvents } from '../../types.js';
import { runCompactionLifecycle } from '../middleware/compaction-orchestration.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;
const degradeMock = mockedDegrade as unknown as ReturnType<typeof vi.fn>;

function history(): KodaXMessage[] {
  return [{ role: 'user', content: `CANONICAL_HISTORY\n${'evidence '.repeat(12_000)}` }];
}

function successfulResult(messages: KodaXMessage[]): CompactionResult {
  const compacted = [{ role: 'system' as const, content: 'semantic summary' }];
  return {
    compacted: true,
    messages: compacted,
    summary: 'semantic summary',
    tokensBefore: 88_000,
    tokensAfter: estimateTokens(compacted),
    entriesRemoved: messages.length,
    anchor: {
      summary: 'semantic summary',
      tokensBefore: 88_000,
      tokensAfter: estimateTokens(compacted),
      entriesRemoved: messages.length,
      reason: 'automatic_compaction',
    },
  };
}

function lifecycleInput(
  messages: KodaXMessage[],
  currentTokens: number,
  triggerPercent: number,
  events: KodaXEvents = {},
) {
  return {
    messages,
    needsCompact: true,
    compactConsecutiveFailures: 0,
    compactionConfig: { enabled: true, triggerPercent },
    provider: { name: 'test-provider' },
    contextWindow: 100_000,
    systemPrompt: 'system',
    currentTokens,
    reservedResponseTokens: 10_000,
    events,
  } as unknown as Parameters<typeof runCompactionLifecycle>[0];
}

beforeEach(() => {
  compactMock.mockReset();
  degradeMock.mockReset();
});

describe('P3.4 physical-capacity compaction lifecycle', () => {
  it('keeps all phases idle when compaction is unnecessary', async () => {
    const messages = history();
    const output = await runCompactionLifecycle({
      ...lifecycleInput(messages, 70_000, 100),
      needsCompact: false,
    });
    expect(output.messages).toEqual(messages);
    expect(output.contextTokenSnapshot).toBeUndefined();
    expect(compactMock).not.toHaveBeenCalled();
    expect(degradeMock).not.toHaveBeenCalled();
  });

  it('commits a semantic rewrite with a physical snapshot baseline', async () => {
    const messages = history();
    const onCompactedMessages = vi.fn();
    compactMock.mockResolvedValue(successfulResult(messages));
    const output = await runCompactionLifecycle(lifecycleInput(
      messages,
      88_000,
      100,
      { onCompactedMessages },
    ));
    const fixedOverhead = 88_000 - estimateTokens(messages);
    expect(output.didCompactMessages).toBe(true);
    expect(output.contextTokenSnapshot?.currentTokens).toBe(
      fixedOverhead + estimateTokens(output.messages),
    );
    expect(output.contextTokenSnapshot?.baselineEstimatedTokens).toBe(
      estimateTokens(output.messages),
    );
    expect(onCompactedMessages).toHaveBeenCalledOnce();
    expect(onCompactedMessages.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      preCompactionMessages: messages,
    }));
  });

  it('preserves canonical history and records capacity debt after hard-pressure summary failure', async () => {
    const messages = history();
    const original = structuredClone(messages);
    compactMock.mockRejectedValue(new Error('summary unavailable'));
    const output = await runCompactionLifecycle(
      lifecycleInput(messages, 88_000, 100),
    );
    // FEATURE_296 (ADR-067): the summary failure no longer converts a
    // physically over-capacity transcript into an abort; with the shrunk
    // reserve (T3) the unchanged history is legal, so no debt is recorded.
    expect(messages).toEqual(original);
    expect(output.messages).toEqual(original);
    expect(output.didCompactMessages).toBe(false);
    expect(output.stillOverCapacity).toBeUndefined();
    expect(degradeMock).not.toHaveBeenCalled();
  });

  it('commits a still-over compaction best-effort with stillOverCapacity instead of throwing', async () => {
    const messages = history();
    const oversized = [{ role: 'system' as const, content: `summary\n${'detail '.repeat(40_000)}` }];
    compactMock.mockResolvedValue({
      ...successfulResult(messages),
      messages: oversized,
    });
    const output = await runCompactionLifecycle(lifecycleInput(messages, 88_000, 100));

    // FEATURE_296 (ADR-067): an over-capacity compacted transcript commits
    // best-effort; the recovery ladder owns the next request.
    expect(output.messages).toEqual(oversized);
    expect(output.didCompactMessages).toBe(true);
    expect(output.stillOverCapacity).toBe(true);
  });

  it('treats a reclaimable escalation reserve as relieved instead of still-over (FEATURE_296 T3)', async () => {
    const messages = history();
    compactMock.mockResolvedValue(successfulResult(messages));
    // 40k escalated reserve: the compacted transcript is over capacity with
    // the base reserve but legal with the floor-bounded shrunk reserve, so
    // the run continues without recording debt.
    const output = await runCompactionLifecycle({
      ...lifecycleInput(messages, 88_000, 100),
      reservedResponseTokens: 40_000,
    });

    expect(output.didCompactMessages).toBe(true);
    expect(output.stillOverCapacity).toBeUndefined();
  });

  it('fails open after an early-policy summary failure while capacity remains', async () => {
    const messages = history();
    compactMock.mockRejectedValue(new Error('summary unavailable'));
    const output = await runCompactionLifecycle(
      lifecycleInput(messages, 75_000, 70),
    );
    expect(output.messages).toEqual(messages);
    expect(output.didCompactMessages).toBe(false);
    expect(output.contextTokenSnapshot).toBeUndefined();
  });

  it('runs deterministic degradation only when explicitly configured', async () => {
    const messages = history();
    const pruned = [{ role: 'user' as const, content: 'explicit legacy fallback' }];
    compactMock.mockResolvedValue({
      compacted: false,
      messages,
      tokensBefore: 88_000,
      tokensAfter: 88_000,
      entriesRemoved: 0,
    });
    degradeMock.mockReturnValue(pruned);
    const base = lifecycleInput(messages, 88_000, 100);
    const value = {
      ...base,
      compactionConfig: {
        ...base.compactionConfig,
        pruningThresholdTokens: 500,
      },
    };
    const output = await runCompactionLifecycle(value);
    expect(degradeMock).toHaveBeenCalledOnce();
    expect(output.messages).toEqual(pruned);
    expect(output.didCompactMessages).toBe(true);
  });
});
