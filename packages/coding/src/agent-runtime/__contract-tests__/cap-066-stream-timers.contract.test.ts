/**
 * Contract test for CAP-066: stream timer infrastructure (hard + idle + stream-max-duration + abort signal composition)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-066-stream-timer-infrastructure-hard--idle--stream-max-duration--abort-signal-composition
 *
 * Test obligations:
 * - CAP-STREAM-TIMERS-001: hard timer fires at 10 min cap
 * - CAP-STREAM-TIMERS-002: idle timer reset by content events but not by heartbeat-pause
 * - CAP-STREAM-TIMERS-003: stream-max-duration aborts before provider kill window
 *
 * Risk: HIGH (timing-sensitive, interacts with provider stream contracts)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/stream-timers.ts (extracted from
 * agent.ts:830-876 — pre-FEATURE_100 baseline — during FEATURE_100 P3.2a)
 *
 * Time-ordering constraint: armed BEFORE stream call; cleared in finally/break paths to avoid
 * stale aborts.
 *
 * Active here:
 *   - hard timer always armed; aborts retryTimeoutController on fire
 *   - idle timer fires only when idleTimeoutMs > 0; reset by resetIdleTimer
 *   - clearIdleTimer clears WITHOUT restart (heartbeat-pause path)
 *   - stream-max-duration timer armed only when streamMaxDurationMs > 0
 *   - retrySignal merges callerAbortSignal with retryTimeoutController.signal
 *     via AbortSignal.any when caller signal is present
 *   - clearAll is idempotent (safe to call from multiple exit paths)
 *
 * STATUS: ACTIVE since FEATURE_100 P3.2a.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { buildStreamTimers } from '../stream-timers.js';

describe('CAP-066: buildStreamTimers — timer lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CAP-STREAM-TIMERS-001a: hard timer fires after hardTimeoutMs and aborts retryTimeoutController', () => {
    const timers = buildStreamTimers({
      hardTimeoutMs: 100,
      idleTimeoutMs: 0,
      streamMaxDurationMs: 0,
      callerAbortSignal: undefined,
    });
    expect(timers.retryTimeoutController.signal.aborted).toBe(false);
    vi.advanceTimersByTime(101);
    expect(timers.retryTimeoutController.signal.aborted).toBe(true);
    expect(timers.retryTimeoutController.signal.reason).toBeInstanceOf(Error);
    expect((timers.retryTimeoutController.signal.reason as Error).message).toMatch(/Hard Timeout/);
    timers.clearAll();
  });

  it('CAP-STREAM-TIMERS-002a: idle timer fires after idleTimeoutMs of inactivity', () => {
    const timers = buildStreamTimers({
      hardTimeoutMs: 60_000,
      idleTimeoutMs: 50,
      streamMaxDurationMs: 0,
      callerAbortSignal: undefined,
    });
    vi.advanceTimersByTime(51);
    expect(timers.retryTimeoutController.signal.aborted).toBe(true);
    expect((timers.retryTimeoutController.signal.reason as Error).message).toMatch(/idle/);
    timers.clearAll();
  });

  it('CAP-STREAM-TIMERS-002b: resetIdleTimer keeps the idle timer alive while data flows', () => {
    const timers = buildStreamTimers({
      hardTimeoutMs: 60_000,
      idleTimeoutMs: 50,
      streamMaxDurationMs: 0,
      callerAbortSignal: undefined,
    });
    vi.advanceTimersByTime(40);
    timers.resetIdleTimer(); // before fire
    vi.advanceTimersByTime(40);
    timers.resetIdleTimer(); // before fire
    vi.advanceTimersByTime(40);
    expect(timers.retryTimeoutController.signal.aborted).toBe(false);
    timers.clearAll();
  });

  it('CAP-STREAM-TIMERS-002c: clearIdleTimer cancels idle WITHOUT restart (heartbeat-pause path)', () => {
    const timers = buildStreamTimers({
      hardTimeoutMs: 60_000,
      idleTimeoutMs: 50,
      streamMaxDurationMs: 0,
      callerAbortSignal: undefined,
    });
    timers.clearIdleTimer();
    vi.advanceTimersByTime(200);
    expect(timers.retryTimeoutController.signal.aborted).toBe(false);
    timers.clearAll();
  });

  it('CAP-STREAM-TIMERS-002d: idle timer disabled when idleTimeoutMs = 0 (resetIdleTimer is no-op)', () => {
    const timers = buildStreamTimers({
      hardTimeoutMs: 60_000,
      idleTimeoutMs: 0,
      streamMaxDurationMs: 0,
      callerAbortSignal: undefined,
    });
    timers.resetIdleTimer(); // no-op
    timers.clearIdleTimer(); // no-op
    vi.advanceTimersByTime(10_000);
    expect(timers.retryTimeoutController.signal.aborted).toBe(false);
    timers.clearAll();
  });

  it('CAP-STREAM-TIMERS-003a: stream-max-duration aborts at the configured cap', () => {
    const timers = buildStreamTimers({
      hardTimeoutMs: 60_000,
      idleTimeoutMs: 0,
      streamMaxDurationMs: 200,
      callerAbortSignal: undefined,
    });
    vi.advanceTimersByTime(201);
    expect(timers.retryTimeoutController.signal.aborted).toBe(true);
    expect((timers.retryTimeoutController.signal.reason as Error).message).toMatch(/max duration/);
    timers.clearAll();
  });

  it('CAP-STREAM-TIMERS-003b: stream-max-duration disabled when streamMaxDurationMs = 0', () => {
    const timers = buildStreamTimers({
      hardTimeoutMs: 60_000,
      idleTimeoutMs: 0,
      streamMaxDurationMs: 0,
      callerAbortSignal: undefined,
    });
    vi.advanceTimersByTime(30_000);
    expect(timers.retryTimeoutController.signal.aborted).toBe(false);
    timers.clearAll();
  });
});

describe('CAP-066: buildStreamTimers — abort signal composition', () => {
  it('CAP-STREAM-TIMERS-COMPOSE-001: retrySignal merges callerAbortSignal via AbortSignal.any', () => {
    const callerCtrl = new AbortController();
    const timers = buildStreamTimers({
      hardTimeoutMs: 60_000,
      idleTimeoutMs: 0,
      streamMaxDurationMs: 0,
      callerAbortSignal: callerCtrl.signal,
    });
    expect(timers.retrySignal.aborted).toBe(false);
    callerCtrl.abort(new Error('user Ctrl+C'));
    expect(timers.retrySignal.aborted).toBe(true);
    timers.clearAll();
  });

  it('CAP-STREAM-TIMERS-COMPOSE-002: retrySignal === retryTimeoutController.signal when caller signal is undefined', () => {
    const timers = buildStreamTimers({
      hardTimeoutMs: 60_000,
      idleTimeoutMs: 0,
      streamMaxDurationMs: 0,
      callerAbortSignal: undefined,
    });
    expect(timers.retrySignal).toBe(timers.retryTimeoutController.signal);
    timers.clearAll();
  });
});

describe('CAP-066: buildStreamTimers — clearAll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CAP-STREAM-TIMERS-CLEAR-001: clearAll prevents all 3 timers from firing afterwards', () => {
    const timers = buildStreamTimers({
      hardTimeoutMs: 100,
      idleTimeoutMs: 100,
      streamMaxDurationMs: 100,
      callerAbortSignal: undefined,
    });
    timers.clearAll();
    vi.advanceTimersByTime(500);
    expect(timers.retryTimeoutController.signal.aborted).toBe(false);
  });

  it('CAP-STREAM-TIMERS-CLEAR-002: clearAll is idempotent — multiple calls do not throw', () => {
    const timers = buildStreamTimers({
      hardTimeoutMs: 60_000,
      idleTimeoutMs: 50,
      streamMaxDurationMs: 200,
      callerAbortSignal: undefined,
    });
    expect(() => {
      timers.clearAll();
      timers.clearAll();
      timers.clearAll();
    }).not.toThrow();
  });
});
