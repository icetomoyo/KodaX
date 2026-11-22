import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionRecoveryTracker, SESSION_RECOVERY_STALL_MS } from './session-recovery.js';

const UNKNOWN = { state: 'unknown', code: 'actor_settlement_not_persisted', message: 'Not saved.' } as const;

describe('Session recovery tracker', () => {
  beforeEach(() => { vi.useFakeTimers({ now: Date.parse('2026-11-21T00:00:00.000Z') }); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports a quarantined Session from the moment its Actor health becomes unknown until it is healthy again', () => {
    const changed = vi.fn();
    const tracker = createSessionRecoveryTracker(changed);
    tracker.observe('s1', { state: 'recovering', message: 'Retrying a save.' });
    expect(tracker.get('s1')).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();

    tracker.observe('s1', UNKNOWN);
    expect(tracker.get('s1')).toEqual({
      state: 'recovering', since: '2026-11-21T00:00:00.000Z', code: 'actor_settlement_not_persisted',
    });
    expect(changed).toHaveBeenCalledTimes(1);

    // A later unknown report keeps the moment the quarantine began.
    vi.advanceTimersByTime(1_000);
    tracker.observe('s1', { ...UNKNOWN, message: 'Still not saved.' });
    expect(tracker.get('s1')?.since).toBe('2026-11-21T00:00:00.000Z');
    expect(changed).toHaveBeenCalledTimes(1);

    tracker.observe('s1', { state: 'healthy' });
    expect(tracker.get('s1')).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith('s1');
  });

  it('turns stalled at the limit, counted from entering quarantine, and announces it once', () => {
    const changed = vi.fn();
    const tracker = createSessionRecoveryTracker(changed);
    tracker.observe('s1', UNKNOWN);
    changed.mockClear();

    vi.advanceTimersByTime(SESSION_RECOVERY_STALL_MS - 1);
    expect(tracker.get('s1')?.state).toBe('recovering');
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tracker.get('s1')).toMatchObject({ state: 'stalled', since: '2026-11-21T00:00:00.000Z' });
    expect(changed).toHaveBeenCalledTimes(1);

    // Repair keeps going past the limit; a repaired Session leaves quarantine as usual.
    tracker.observe('s1', { state: 'healthy' });
    expect(tracker.get('s1')).toBeUndefined();
    vi.advanceTimersByTime(SESSION_RECOVERY_STALL_MS);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('puts the current state on a Session as read and drops one left from an earlier read', () => {
    const tracker = createSessionRecoveryTracker(() => undefined);
    const stale = { id: 's1', title: 'T', recovery: { state: 'stalled', since: 'x', code: 'actor_settlement_not_persisted' } } as const;
    expect(tracker.attach(stale)).toEqual({ id: 's1', title: 'T' });
    tracker.observe('s1', UNKNOWN);
    expect(tracker.attach({ id: 's1', title: 'T' })).toEqual({
      id: 's1', title: 'T', recovery: { state: 'recovering', since: '2026-11-21T00:00:00.000Z', code: 'actor_settlement_not_persisted' },
    });
    const untouched = { id: 's2', title: 'U' };
    expect(tracker.attach(untouched)).toBe(untouched);
  });

  it('stops announcing once closed', () => {
    const changed = vi.fn();
    const tracker = createSessionRecoveryTracker(changed);
    tracker.observe('s1', UNKNOWN);
    changed.mockClear();
    tracker.close();
    vi.advanceTimersByTime(SESSION_RECOVERY_STALL_MS);
    expect(changed).not.toHaveBeenCalled();
  });
});
