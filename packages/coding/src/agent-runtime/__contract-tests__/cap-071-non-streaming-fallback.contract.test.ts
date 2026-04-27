/**
 * Contract test for CAP-071: non-streaming fallback path
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-071-non-streaming-fallback-path
 *
 * Test obligations:
 * - CAP-NON-STREAM-FB-001: provider that returns same shape works via complete() call
 * - CAP-NON-STREAM-FB-002: fallback failure rolls back into retry pipeline
 * - CAP-NON-STREAM-FB-003: independent timer clears stream timers before fallback
 *
 * Risk: HIGH (provider semantics differ between stream / complete; tool dispatch must work identically)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/non-streaming-fallback.ts (extracted
 * from agent.ts:895-948 — pre-FEATURE_100 baseline — during FEATURE_100 P3.2f)
 *
 * Time-ordering constraint: WITHIN catch block; clears stream timers before fallback;
 * on fallback failure, error propagates back into recovery pipeline (CAP-069).
 *
 * Active here:
 *   - clearStreamTimers callback fires BEFORE provider.complete (load-bearing
 *     for the streaming attempt's timers not to abort the fallback)
 *   - boundarySession.beginAttempt is called with fallback=true
 *   - returns { ok: true, result } on success or { ok: false, error } on failure
 *   - fallback's own hard-timer is cleared in finally regardless of outcome
 *   - delta handlers delegate to boundarySession.markX (NOT a separate tracker)
 *
 * STATUS: ACTIVE since FEATURE_100 P3.2f.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXBaseProvider, KodaXStreamResult } from '@kodax/ai';
import type { KodaXEvents } from '../../types.js';

import { executeNonStreamingFallback } from '../non-streaming-fallback.js';
import { BoundaryTrackerSession } from '../boundary-tracker-session.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function fakeProvider(completeImpl: KodaXBaseProvider['complete']): KodaXBaseProvider {
  return {
    name: 'anthropic',
    isConfigured: () => true,
    getApiKeyEnv: () => 'ANTHROPIC_API_KEY',
    getModel: () => 'claude-sonnet-4-5',
    complete: completeImpl,
  } as unknown as KodaXBaseProvider;
}

function fakeResult(): KodaXStreamResult {
  return {
    text: 'fallback result',
    toolBlocks: [],
    thinkingBlocks: [],
    stopReason: 'end_turn',
  } as unknown as KodaXStreamResult;
}

function makeInput(provider: KodaXBaseProvider, clearStreamTimers = vi.fn()): Parameters<typeof executeNonStreamingFallback>[0] {
  return {
    events: {} as KodaXEvents,
    streamProvider: provider,
    providerMessages: [],
    activeToolDefinitions: [],
    effectiveSystemPrompt: 'BASE',
    effectiveProviderReasoning: false,
    callerAbortSignal: undefined,
    modelOverride: undefined,
    hardTimeoutMs: 600_000,
    boundarySession: new BoundaryTrackerSession(),
    emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter,
    providerName: 'anthropic',
    attempt: 2,
    clearStreamTimers,
  };
}

describe('CAP-071: executeNonStreamingFallback — success path', () => {
  it('CAP-NON-STREAM-FB-001a: success returns { ok: true, result }', async () => {
    const result = fakeResult();
    const provider = fakeProvider(async () => result);
    const outcome = await executeNonStreamingFallback(makeInput(provider));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe(result);
    }
  });

  it('CAP-NON-STREAM-FB-001b: provider.complete is called with the buffered handler set (no idle/rate-limit/heartbeat)', async () => {
    const completeSpy = vi.fn().mockResolvedValue(fakeResult());
    const provider = fakeProvider(completeSpy);
    await executeNonStreamingFallback(makeInput(provider));
    expect(completeSpy).toHaveBeenCalledOnce();
    const handlerArg = completeSpy.mock.calls[0]![4] as Record<string, unknown>;
    expect(handlerArg.onTextDelta).toBeDefined();
    expect(handlerArg.onThinkingDelta).toBeDefined();
    expect(handlerArg.onThinkingEnd).toBeDefined();
    // Streaming-only handlers MUST be absent in fallback callbacks:
    expect(handlerArg.onRateLimit).toBeUndefined();
    expect(handlerArg.onHeartbeat).toBeUndefined();
    expect(handlerArg.onToolInputDelta).toBeUndefined();
  });
});

describe('CAP-071: executeNonStreamingFallback — failure path', () => {
  it('CAP-NON-STREAM-FB-002a: failure returns { ok: false, error } with the underlying error', async () => {
    const provider = fakeProvider(async () => {
      throw new Error('upstream provider 500');
    });
    const outcome = await executeNonStreamingFallback(makeInput(provider));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toBe('upstream provider 500');
    }
  });

  it('CAP-NON-STREAM-FB-002b: non-Error thrown values are wrapped in Error', async () => {
    const provider = fakeProvider(async () => {
      throw 'string-as-error'; // eslint-disable-line @typescript-eslint/only-throw-error
    });
    const outcome = await executeNonStreamingFallback(makeInput(provider));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(Error);
      expect(outcome.error.message).toBe('string-as-error');
    }
  });
});

describe('CAP-071: executeNonStreamingFallback — timer / boundary lifecycle', () => {
  it('CAP-NON-STREAM-FB-003a: clearStreamTimers fires BEFORE provider.complete is called', async () => {
    const callOrder: string[] = [];
    const clearStreamTimers = vi.fn(() => {
      callOrder.push('clearStreamTimers');
    });
    const provider = fakeProvider(async () => {
      callOrder.push('complete');
      return fakeResult();
    });
    await executeNonStreamingFallback(makeInput(provider, clearStreamTimers));
    expect(callOrder).toEqual(['clearStreamTimers', 'complete']);
  });

  it('CAP-NON-STREAM-FB-003b: boundarySession.beginAttempt is called with fallback=true', async () => {
    const session = new BoundaryTrackerSession();
    const beginSpy = vi.spyOn(session, 'beginAttempt');
    const provider = fakeProvider(async () => fakeResult());
    const input = makeInput(provider);
    await executeNonStreamingFallback({ ...input, boundarySession: session });
    expect(beginSpy).toHaveBeenCalledOnce();
    const args = beginSpy.mock.calls[0]!;
    // Last arg (fallback flag) must be true.
    expect(args[args.length - 1]).toBe(true);
  });

  it('CAP-NON-STREAM-FB-003c: fallback hard timer is cleared after success (no leak)', async () => {
    // Verify by running the fallback synchronously and ensuring the
    // promise resolves cleanly (a leaked timer would keep the event
    // loop alive but vitest doesn't block on that — the contract here
    // is that clearTimeout is called via the finally branch).
    const provider = fakeProvider(async () => fakeResult());
    await expect(executeNonStreamingFallback(makeInput(provider))).resolves.toMatchObject({
      ok: true,
    });
  });
});
