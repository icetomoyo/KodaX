/**
 * Contract test for CAP-067: stream call event handler wiring
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-067-stream-call-event-handler-wiring
 *
 * Test obligations:
 * - CAP-STREAM-HANDLERS-001: text-delta fans to all 3 sinks (consumer events, extension events, boundary tracker)
 * - CAP-STREAM-HANDLERS-002: heartbeat-pause clears idle without reset
 *
 * Risk: HIGH (wide event surface; consumers and extensions both depend on these events)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/stream-handler-wiring.ts (extracted
 * from agent.ts:852-893 — pre-FEATURE_100 baseline — during FEATURE_100 P3.2c)
 *
 * Time-ordering constraint: per-event during stream.
 *
 * Active here:
 *   - all 5 delta handlers (text/thinking/thinking-end/tool-input/rate-limit)
 *     call streamTimers.resetIdleTimer() FIRST before any other side effect
 *   - text/thinking/tool-input mark the boundary tracker
 *   - text/thinking/thinking-end/rate-limit dispatch corresponding extension events
 *   - all handlers call the consumer-supplied events.onXyz (when defined)
 *   - onHeartbeat(pause=true) calls clearIdleTimer (NOT resetIdleTimer)
 *   - onHeartbeat(pause=false) calls resetIdleTimer
 *
 * STATUS: ACTIVE since FEATURE_100 P3.2c.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents } from '../../types.js';
import type { StableBoundaryTracker } from '../../resilience/stable-boundary.js';
import type { StreamTimers } from '../stream-timers.js';

import { buildStreamHandlers, type ExtensionEventEmitter } from '../stream-handler-wiring.js';

function fakeBoundaryTracker(): {
  tracker: StableBoundaryTracker;
  markTextDelta: ReturnType<typeof vi.fn>;
  markThinkingDelta: ReturnType<typeof vi.fn>;
  markToolInputStart: ReturnType<typeof vi.fn>;
} {
  const markTextDelta = vi.fn();
  const markThinkingDelta = vi.fn();
  const markToolInputStart = vi.fn();
  const tracker = {
    markTextDelta,
    markThinkingDelta,
    markToolInputStart,
  } as unknown as StableBoundaryTracker;
  return { tracker, markTextDelta, markThinkingDelta, markToolInputStart };
}

function fakeTimers(): {
  timers: StreamTimers;
  resetIdleTimer: ReturnType<typeof vi.fn>;
  clearIdleTimer: ReturnType<typeof vi.fn>;
} {
  const resetIdleTimer = vi.fn();
  const clearIdleTimer = vi.fn();
  const timers = {
    resetIdleTimer,
    clearIdleTimer,
    retryTimeoutController: new AbortController(),
    retrySignal: new AbortController().signal,
    clearAll: vi.fn(),
  } as StreamTimers;
  return { timers, resetIdleTimer, clearIdleTimer };
}

describe('CAP-067: buildStreamHandlers — fan-out semantics', () => {
  it('CAP-STREAM-HANDLERS-001a: onTextDelta fans to resetIdleTimer + markTextDelta + text:delta extension + onTextDelta consumer', () => {
    const { tracker, markTextDelta } = fakeBoundaryTracker();
    const { timers, resetIdleTimer } = fakeTimers();
    const onTextDelta = vi.fn();
    const emit = vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;

    const handlers = buildStreamHandlers({
      events: { onTextDelta } as unknown as KodaXEvents,
      boundaryTracker: tracker,
      streamTimers: timers,
      emitActiveExtensionEvent: emit,
      providerName: 'anthropic',
    });

    handlers.onTextDelta!('hello');

    expect(resetIdleTimer).toHaveBeenCalledOnce();
    expect(markTextDelta).toHaveBeenCalledExactlyOnceWith('hello');
    expect(emit).toHaveBeenCalledExactlyOnceWith('text:delta', { text: 'hello' });
    expect(onTextDelta).toHaveBeenCalledExactlyOnceWith('hello');
  });

  it('CAP-STREAM-HANDLERS-001b: resetIdleTimer is called BEFORE other sinks (load-bearing order)', () => {
    const callOrder: string[] = [];
    const { tracker } = (() => {
      const markTextDelta = vi.fn(() => callOrder.push('markTextDelta'));
      return {
        tracker: { markTextDelta } as unknown as StableBoundaryTracker,
      };
    })();
    const timers = {
      resetIdleTimer: vi.fn(() => callOrder.push('resetIdleTimer')),
      clearIdleTimer: vi.fn(),
      retryTimeoutController: new AbortController(),
      retrySignal: new AbortController().signal,
      clearAll: vi.fn(),
    } as StreamTimers;
    const emit = vi.fn(async () => {
      callOrder.push('emit');
    }) as unknown as ExtensionEventEmitter;
    const onTextDelta = vi.fn(() => callOrder.push('onTextDelta'));

    const handlers = buildStreamHandlers({
      events: { onTextDelta } as unknown as KodaXEvents,
      boundaryTracker: tracker,
      streamTimers: timers,
      emitActiveExtensionEvent: emit,
      providerName: 'anthropic',
    });

    handlers.onTextDelta!('hi');
    expect(callOrder[0]).toBe('resetIdleTimer');
  });

  it('CAP-STREAM-HANDLERS-001c: onToolInputDelta uses meta.toolId when present, falls back to pending:{name}', () => {
    const { tracker, markToolInputStart } = fakeBoundaryTracker();
    const { timers } = fakeTimers();
    const handlers = buildStreamHandlers({
      events: {} as KodaXEvents,
      boundaryTracker: tracker,
      streamTimers: timers,
      emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter,
      providerName: 'anthropic',
    });
    handlers.onToolInputDelta!('Read', '{', { toolId: 'tool-123' });
    expect(markToolInputStart).toHaveBeenLastCalledWith('tool-123');
    handlers.onToolInputDelta!('Read', '{', undefined);
    expect(markToolInputStart).toHaveBeenLastCalledWith('pending:Read');
  });

  it('CAP-STREAM-HANDLERS-001d: onRateLimit emits provider:rate-limit with the providerName from input', () => {
    const { tracker } = fakeBoundaryTracker();
    const { timers } = fakeTimers();
    const onProviderRateLimit = vi.fn();
    const emit = vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;

    const handlers = buildStreamHandlers({
      events: { onProviderRateLimit } as unknown as KodaXEvents,
      boundaryTracker: tracker,
      streamTimers: timers,
      emitActiveExtensionEvent: emit,
      providerName: 'kimi',
    });
    handlers.onRateLimit!(2, 5, 1500);
    expect(emit).toHaveBeenCalledWith('provider:rate-limit', {
      provider: 'kimi',
      attempt: 2,
      maxRetries: 5,
      delayMs: 1500,
    });
    expect(onProviderRateLimit).toHaveBeenCalledExactlyOnceWith(2, 5, 1500);
  });
});

describe('CAP-067: buildStreamHandlers — heartbeat semantics', () => {
  it('CAP-STREAM-HANDLERS-002a: onHeartbeat(true) calls clearIdleTimer (not resetIdleTimer)', () => {
    const { tracker } = fakeBoundaryTracker();
    const { timers, resetIdleTimer, clearIdleTimer } = fakeTimers();
    const handlers = buildStreamHandlers({
      events: {} as KodaXEvents,
      boundaryTracker: tracker,
      streamTimers: timers,
      emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter,
      providerName: 'anthropic',
    });
    handlers.onHeartbeat!(true);
    expect(clearIdleTimer).toHaveBeenCalledOnce();
    expect(resetIdleTimer).not.toHaveBeenCalled();
  });

  it('CAP-STREAM-HANDLERS-002b: onHeartbeat(false) calls resetIdleTimer (not clearIdleTimer)', () => {
    const { tracker } = fakeBoundaryTracker();
    const { timers, resetIdleTimer, clearIdleTimer } = fakeTimers();
    const handlers = buildStreamHandlers({
      events: {} as KodaXEvents,
      boundaryTracker: tracker,
      streamTimers: timers,
      emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter,
      providerName: 'anthropic',
    });
    handlers.onHeartbeat!(false);
    expect(resetIdleTimer).toHaveBeenCalledOnce();
    expect(clearIdleTimer).not.toHaveBeenCalled();
  });
});

describe('CAP-067: buildStreamHandlers — missing consumer hooks', () => {
  it('CAP-STREAM-HANDLERS-MISSING-001: handlers do not throw when events.onXyz hooks are undefined', () => {
    const { tracker } = fakeBoundaryTracker();
    const { timers } = fakeTimers();
    const handlers = buildStreamHandlers({
      events: {} as KodaXEvents,
      boundaryTracker: tracker,
      streamTimers: timers,
      emitActiveExtensionEvent: vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter,
      providerName: 'anthropic',
    });
    expect(() => {
      handlers.onTextDelta!('x');
      handlers.onThinkingDelta!('y');
      handlers.onThinkingEnd!('z');
      handlers.onToolInputDelta!('Read', '{', undefined);
      handlers.onRateLimit!(1, 3, 100);
      handlers.onHeartbeat!(false);
    }).not.toThrow();
  });
});
