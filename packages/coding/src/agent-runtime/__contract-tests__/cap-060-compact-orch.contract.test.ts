import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, compact: vi.fn() };
});

import {
  ContextCapacityError,
  compact as mockedCompact,
  type CompactionResult,
} from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';
import { estimateTokens } from '../../tokenizer.js';
import type { KodaXEvents } from '../../types.js';
import { tryIntelligentCompact } from '../middleware/compaction-orchestration.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;

function messages(): KodaXMessage[] {
  return [{ role: 'user', content: `FULL_HISTORY\n${'evidence '.repeat(12_000)}` }];
}

function result(input: KodaXMessage[]): CompactionResult {
  const compacted = [{ role: 'system' as const, content: 'semantic summary' }];
  return {
    compacted: true,
    messages: compacted,
    summary: 'semantic summary',
    tokensBefore: estimateTokens(input),
    tokensAfter: estimateTokens(compacted),
    entriesRemoved: input.length,
  };
}

function events(): KodaXEvents {
  return {
    onCompactStart: vi.fn(),
    onCompactEnd: vi.fn(),
    onCompactStats: vi.fn(),
    onCompact: vi.fn(),
  };
}

function input(
  currentTokens: number,
  triggerPercent: number,
  compactConsecutiveFailures = 0,
) {
  return {
    messages: messages(),
    needsCompact: true,
    compactConsecutiveFailures,
    compactionConfig: { enabled: true, triggerPercent },
    provider: { name: 'test-provider' },
    contextWindow: 100_000,
    systemPrompt: 'system',
    currentTokens,
    reservedResponseTokens: 10_000,
    events: events(),
  } as unknown as Parameters<typeof tryIntelligentCompact>[0];
}

beforeEach(() => {
  compactMock.mockReset();
});

describe('CAP-060 capacity-driven semantic compaction', () => {
  it('short-circuits when compaction is not needed', async () => {
    const value = input(75_000, 100);
    const output = await tryIntelligentCompact({ ...value, needsCompact: false });
    expect(output.compacted).toBe(value.messages);
    expect(compactMock).not.toHaveBeenCalled();
  });

  it('honors the circuit breaker for an explicit early policy', async () => {
    const value = input(75_000, 70, 3);
    const output = await tryIntelligentCompact(value);
    expect(output.compacted).toBe(value.messages);
    expect(output.nextCompactConsecutiveFailures).toBe(3);
    expect(compactMock).not.toHaveBeenCalled();
  });

  it('terminates with typed capacity after the hard-pressure breaker limit', async () => {
    const value = input(88_000, 100, 3);
    compactMock.mockResolvedValue(result(value.messages));
    await expect(tryIntelligentCompact(value)).rejects.toBeInstanceOf(ContextCapacityError);
    expect(compactMock).not.toHaveBeenCalled();
  });

  it('rethrows typed capacity failures instead of converting them to lossy fallback', async () => {
    const value = input(88_000, 100);
    compactMock.mockRejectedValue(new ContextCapacityError({
      contextWindow: 100_000,
      currentTokens: 88_000,
      reservedResponseTokens: 10_000,
    }, 'Compaction summary request'));
    await expect(tryIntelligentCompact(value)).rejects.toBeInstanceOf(
      ContextCapacityError,
    );
  });

  it('does not spend or trip the breaker when a fresh user input is itself irreducible', async () => {
    const irreducibleMessages: KodaXMessage[] = [{
      role: 'user',
      content: `FRESH_IRREDUCIBLE_INPUT\n${'payload '.repeat(120_000)}`,
    }];
    compactMock.mockRejectedValue(new ContextCapacityError({
      contextWindow: 100_000,
      currentTokens: estimateTokens(irreducibleMessages),
      reservedResponseTokens: 10_000,
    }, 'Compaction summary request'));
    let failures = 0;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const value = {
        ...input(estimateTokens(irreducibleMessages), 100, failures),
        messages: irreducibleMessages,
      };
      const output = await tryIntelligentCompact(value);
      failures = output.nextCompactConsecutiveFailures;
      expect(output.compacted).toBe(irreducibleMessages);
    }

    expect(failures).toBe(0);
    expect(compactMock).toHaveBeenCalledTimes(5);
  });

  it('fails open and increments the breaker on an early-policy provider error', async () => {
    const value = input(75_000, 70);
    compactMock.mockRejectedValue(new Error('temporary provider error'));
    const output = await tryIntelligentCompact(value);
    expect(output.compacted).toBe(value.messages);
    expect(output.nextCompactConsecutiveFailures).toBe(1);
    expect(value.events.onCompactStart).toHaveBeenCalledOnce();
    expect(value.events.onCompactEnd).toHaveBeenCalledOnce();
  });

  it.each([
    ['capacity error', 'string'], ['partial success', 'string'],
    ['capacity error', 'mixed'], ['partial success', 'mixed'],
  ] as const)(
    'preserves the breaker across an irreducible-input %s (%s) and stops later ordinary retries',
    async (outcome, encoding) => {
      const text = 'payload '.repeat(120_000);
      const irreducibleMessages: KodaXMessage[] = [{
        role: 'user', content: encoding === 'string' ? text : [
          { type: 'text', text }, { type: 'image', path: '/proof.png' },
        ],
      }];
      const currentTokens = estimateTokens(irreducibleMessages);
      if (outcome === 'capacity error') {
        compactMock.mockRejectedValueOnce(new ContextCapacityError({
          contextWindow: 100_000, currentTokens, reservedResponseTokens: 10_000,
        }, 'Compaction summary request'));
      } else {
        compactMock.mockResolvedValueOnce({
          ...result(irreducibleMessages),
          messages: [...irreducibleMessages], tokensAfter: currentTokens,
        });
      }

      const oversized = await tryIntelligentCompact({
        ...input(currentTokens, 100, 2), messages: irreducibleMessages,
      });
      expect(oversized.nextCompactConsecutiveFailures).toBe(2);

      compactMock.mockRejectedValueOnce(new Error('summary service still unavailable'));
      const ordinary = await tryIntelligentCompact(input(
        88_000, 100, oversized.nextCompactConsecutiveFailures,
      ));
      expect(ordinary.nextCompactConsecutiveFailures).toBe(3);
      await expect(tryIntelligentCompact(input(
        88_000, 100, ordinary.nextCompactConsecutiveFailures,
      ))).rejects.toBeInstanceOf(ContextCapacityError);
      expect(compactMock).toHaveBeenCalledTimes(2);
    },
  );

  it('permits irreducible input recovery without closing an already open breaker', async () => {
    const messages: KodaXMessage[] = [{ role: 'user', content: 'payload '.repeat(120_000) }];
    const currentTokens = estimateTokens(messages);
    compactMock.mockRejectedValueOnce(new ContextCapacityError({
      contextWindow: 100_000, currentTokens, reservedResponseTokens: 10_000,
    }, 'Compaction summary request'));
    const output = await tryIntelligentCompact({
      ...input(currentTokens, 100, 3), messages,
    });
    expect(output.compacted).toBe(messages);
    expect(output.nextCompactConsecutiveFailures).toBe(3);
    await expect(tryIntelligentCompact(input(
      88_000, 100, output.nextCompactConsecutiveFailures,
    ))).rejects.toBeInstanceOf(ContextCapacityError);
    expect(compactMock).toHaveBeenCalledOnce();
  });

  it('accounts for fixed envelope overhead and resets after sufficient relief', async () => {
    const value = input(88_000, 100, 2);
    compactMock.mockResolvedValue(result(value.messages));
    const output = await tryIntelligentCompact(value);
    expect(output.nextCompactConsecutiveFailures).toBe(0);
    expect(value.events.onCompactStats).toHaveBeenCalledWith(expect.objectContaining({
      tokensBefore: 88_000,
      tokensAfter: expect.any(Number),
    }));
  });

  it('keeps the failure counter when a claimed rewrite leaves physical pressure', async () => {
    const tiny = [{ role: 'user' as const, content: 'tiny transcript' }];
    const value = { ...input(88_000, 100), messages: tiny };
    compactMock.mockResolvedValue(result(tiny));
    const output = await tryIntelligentCompact(value);
    expect(output.didCompactMessages).toBe(true);
    expect(output.nextCompactConsecutiveFailures).toBe(1);
  });
});
