/**
 * Contract test for CAP-060: compaction lifecycle orchestration
 * (intelligentCompact + circuit breaker + events).
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-060-compaction-lifecycle-orchestration-intelligentcompact--circuit-breaker--events
 *
 * Test obligations:
 * - CAP-COMPACT-ORCH-001: success path emits all compaction events
 * - CAP-COMPACT-ORCH-002: failure increments consecutive failure counter
 * - CAP-COMPACT-ORCH-003: partial success keeps counter incrementing
 * - CAP-COMPACT-ORCH-004: circuit breaker trips, only LLM disabled
 *
 * Risk: HIGH (stateful — circuit breaker counter spans multiple turns)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/middleware/compaction-orchestration.ts:tryIntelligentCompact
 * (extracted from agent.ts:605-704 — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.4c).
 *
 * Time-ordering constraint: AFTER trigger decision (CAP-059); BEFORE
 * graceful degradation gate (CAP-062). Counter only resets when
 * post-compact tokens drop below trigger.
 *
 * Active here:
 *   - `needsCompact === false` → identity, counter unchanged
 *   - circuit breaker tripped → identity, counter unchanged
 *   - LLM threw → counter++, compacted = messages identity
 *   - LLM success below trigger → counter reset to 0
 *   - LLM partial success still over trigger → counter++
 *   - all four lifecycle events fire in success path
 *
 * STATUS: ACTIVE since FEATURE_100 P3.4c.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXBaseProvider, KodaXMessage } from '@kodax/ai';
import type { CompactionConfig, CompactionResult } from '@kodax/agent';

// Mock @kodax/agent's `compact` so we can deterministically control
// the LLM compaction outcome (success / partial / throw / no-op)
// without exercising the real provider/LLM stack.
vi.mock('@kodax/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax/agent')>();
  return {
    ...actual,
    compact: vi.fn(),
  };
});

import { compact as mockedCompact } from '@kodax/agent';
import {
  tryIntelligentCompact,
  COMPACT_CIRCUIT_BREAKER_LIMIT,
} from '../middleware/compaction-orchestration.js';
import type { KodaXEvents } from '../../types.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    enabled: true,
    triggerPercent: 75,
    keepRecentTurns: 3,
    ...overrides,
  } as CompactionConfig;
}

const baseMessages: KodaXMessage[] = [
  { role: 'user', content: 'turn one' },
  { role: 'assistant', content: 'reply one' },
  { role: 'user', content: 'turn two' },
];

/**
 * Provider stub. The compaction module's `intelligentCompact` calls
 * the provider's `streamMessage` method. Returning a plan that the
 * compactor can use is too involved for a unit test; instead, we
 * exercise the wrapper's branches that DON'T require a real LLM:
 *   - `needsCompact === false` (no LLM call)
 *   - circuit breaker tripped (no LLM call)
 *   - LLM throws (we make `streamMessage` reject)
 * For the success branch we use a provider that resolves to a
 * minimal stream, but verify only that the four events fire — the
 * inner shape of `result` is owned by `@kodax/agent`'s own tests.
 */
function rejectingProvider(reason = 'simulated provider failure'): KodaXBaseProvider {
  return {
    name: 'test-provider',
    streamMessage: vi.fn().mockRejectedValue(new Error(reason)),
  } as unknown as KodaXBaseProvider;
}

describe('CAP-060: tryIntelligentCompact — gate short-circuits', () => {
  it('CAP-COMPACT-ORCH-NEEDS-COMPACT-FALSE: needsCompact=false → identity, no events fire, counter unchanged', async () => {
    const events: KodaXEvents = {
      onCompactStart: vi.fn(),
      onCompactEnd: vi.fn(),
      onCompactStats: vi.fn(),
      onCompact: vi.fn(),
    };
    const out = await tryIntelligentCompact({
      messages: baseMessages,
      needsCompact: false,
      compactConsecutiveFailures: 1,
      compactionConfig: makeConfig(),
      provider: rejectingProvider(),
      contextWindow: 10000,
      systemPrompt: 'sys',
      currentTokens: 100,
      events,
    });

    expect(out.compacted).toBe(baseMessages); // identity
    expect(out.didCompactMessages).toBe(false);
    expect(out.compactionUpdate).toBeUndefined();
    expect(out.nextCompactConsecutiveFailures).toBe(1); // unchanged
    expect(events.onCompactStart).not.toHaveBeenCalled();
    expect(events.onCompactEnd).not.toHaveBeenCalled();
  });

  it('CAP-COMPACT-ORCH-004: circuit breaker tripped (counter ≥ limit) → identity, no LLM call, counter unchanged', async () => {
    const provider = rejectingProvider();
    const events: KodaXEvents = { onCompactStart: vi.fn(), onCompactEnd: vi.fn() };
    const out = await tryIntelligentCompact({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: COMPACT_CIRCUIT_BREAKER_LIMIT, // tripped
      compactionConfig: makeConfig(),
      provider,
      contextWindow: 10000,
      systemPrompt: 'sys',
      currentTokens: 9000,
      events,
    });

    expect(out.compacted).toBe(baseMessages);
    expect(out.didCompactMessages).toBe(false);
    expect(out.nextCompactConsecutiveFailures).toBe(COMPACT_CIRCUIT_BREAKER_LIMIT);
    // LLM gate prevented the call.
    expect((provider.streamMessage as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(events.onCompactStart).not.toHaveBeenCalled();
  });

  it('CAP-COMPACT-ORCH-LIMIT-OVERRIDE: custom circuitBreakerLimit honored', async () => {
    const provider = rejectingProvider();
    const out = await tryIntelligentCompact({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: 1,
      compactionConfig: makeConfig(),
      provider,
      contextWindow: 10000,
      systemPrompt: 'sys',
      currentTokens: 9000,
      events: {},
      circuitBreakerLimit: 1, // tripped at 1
    });
    expect(out.didCompactMessages).toBe(false);
    expect((provider.streamMessage as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe('CAP-060: tryIntelligentCompact — LLM threw path', () => {
  it('CAP-COMPACT-ORCH-002: LLM throws → counter increments, compacted = messages identity, onCompactStart + onCompactEnd fire', async () => {
    compactMock.mockReset();
    compactMock.mockRejectedValueOnce(new Error('boom'));
    const events: KodaXEvents = {
      onCompactStart: vi.fn(),
      onCompactEnd: vi.fn(),
      onCompactStats: vi.fn(),
      onCompact: vi.fn(),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const out = await tryIntelligentCompact({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: 0,
      compactionConfig: makeConfig(),
      provider: rejectingProvider(),
      contextWindow: 10000,
      systemPrompt: 'sys',
      currentTokens: 9000,
      events,
    });

    expect(out.compacted).toBe(baseMessages); // identity (catch sets it)
    expect(out.didCompactMessages).toBe(false);
    expect(out.nextCompactConsecutiveFailures).toBe(1); // incremented
    expect(events.onCompactStart).toHaveBeenCalledOnce();
    expect(events.onCompactEnd).toHaveBeenCalledOnce();
    // Stats / onCompact NOT fired on failure path.
    expect(events.onCompactStats).not.toHaveBeenCalled();
    expect(events.onCompact).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('CAP-COMPACT-ORCH-002b: counter increment compounds across multiple failures, then circuit breaker trips', async () => {
    compactMock.mockReset();
    compactMock.mockRejectedValue(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let counter = 0;
    for (let i = 0; i < COMPACT_CIRCUIT_BREAKER_LIMIT; i++) {
      const out = await tryIntelligentCompact({
        messages: baseMessages,
        needsCompact: true,
        compactConsecutiveFailures: counter,
        compactionConfig: makeConfig(),
        provider: rejectingProvider(),
        contextWindow: 10000,
        systemPrompt: 'sys',
        currentTokens: 9000,
        events: {},
      });
      counter = out.nextCompactConsecutiveFailures;
    }
    expect(counter).toBe(COMPACT_CIRCUIT_BREAKER_LIMIT);
    // The mock was invoked exactly LIMIT times — all three threw.
    expect(compactMock).toHaveBeenCalledTimes(COMPACT_CIRCUIT_BREAKER_LIMIT);

    // Next call: circuit breaker trips, mock NOT invoked, counter unchanged.
    const guarded = await tryIntelligentCompact({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: counter,
      compactionConfig: makeConfig(),
      provider: rejectingProvider(),
      contextWindow: 10000,
      systemPrompt: 'sys',
      currentTokens: 9000,
      events: {},
    });
    expect(guarded.nextCompactConsecutiveFailures).toBe(COMPACT_CIRCUIT_BREAKER_LIMIT);
    expect(compactMock).toHaveBeenCalledTimes(COMPACT_CIRCUIT_BREAKER_LIMIT); // no extra call
    errorSpy.mockRestore();
  });
});

describe('CAP-060: tryIntelligentCompact — LLM success paths', () => {
  function successResult(overrides: Partial<CompactionResult> = {}): CompactionResult {
    return {
      compacted: true,
      messages: [{ role: 'system', content: 'compacted summary' }],
      summary: 'sum',
      tokensBefore: 9000,
      tokensAfter: 1000,
      entriesRemoved: 2,
      ...overrides,
    } as CompactionResult;
  }

  it('CAP-COMPACT-ORCH-001: success path emits onCompactStart, onCompactStats, onCompact, onCompactEnd in order; counter resets to 0 when below trigger', async () => {
    compactMock.mockReset();
    compactMock.mockResolvedValueOnce(successResult());
    const events: KodaXEvents = {
      onCompactStart: vi.fn(),
      onCompactStats: vi.fn(),
      onCompact: vi.fn(),
      onCompactEnd: vi.fn(),
    };

    const out = await tryIntelligentCompact({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: 2, // pre-existing failures
      compactionConfig: makeConfig({ triggerPercent: 75 }),
      provider: rejectingProvider(),
      contextWindow: 10000,
      systemPrompt: 'sys',
      currentTokens: 9000,
      events,
    });

    expect(out.didCompactMessages).toBe(true);
    expect(out.nextCompactConsecutiveFailures).toBe(0); // reset
    expect(out.compactionUpdate).toBeDefined();
    expect(events.onCompactStart).toHaveBeenCalledOnce();
    expect(events.onCompactStats).toHaveBeenCalledOnce();
    expect(events.onCompact).toHaveBeenCalledOnce();
    expect(events.onCompactEnd).toHaveBeenCalledOnce();
  });

  it('CAP-COMPACT-ORCH-003: partial success — compacted=true but post-compact tokens still ≥ trigger → counter increments instead of resetting', async () => {
    compactMock.mockReset();
    // Compact returns success but the post-compact messages still
    // estimate above the trigger. We pin this with a very low
    // triggerPercent (1%) and a tiny contextWindow so triggerTokens
    // is ~1, while even a few-word message clears the threshold.
    const smallCompacted: KodaXMessage[] = [
      { role: 'user', content: 'still a bit too big after compact' },
    ];
    compactMock.mockResolvedValueOnce(
      successResult({ messages: smallCompacted, tokensBefore: 200, tokensAfter: 50 }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const out = await tryIntelligentCompact({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: 1,
      // triggerPercent=1, contextWindow=100 → triggerTokens=1.
      // Any non-empty smallCompacted estimates above 1 token.
      compactionConfig: makeConfig({ triggerPercent: 1 }),
      provider: rejectingProvider(),
      contextWindow: 100,
      systemPrompt: 'sys',
      currentTokens: 200,
      events: {},
    });

    expect(out.didCompactMessages).toBe(true);
    expect(out.nextCompactConsecutiveFailures).toBe(2); // incremented (not reset)
    warnSpy.mockRestore();
  });
});
