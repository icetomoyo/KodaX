import { afterEach, expect, it, vi } from 'vitest';
import { startRuntimeDaemonHostMaintenance, startRuntimeDaemonMaintenanceScheduler } from './maintenance-scheduler.js';
import * as daemonMaintenance from './maintenance.js';
import * as homeRetention from './home-retention.js';
import { resolveRuntimeDaemonPaths } from './state.js';
import type { RuntimeDaemonPreflight } from '../sdk-runtime.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('runs after ready and at a low frequency without retaining the process', async () => {
  vi.useFakeTimers();
  const timeouts = vi.spyOn(globalThis, 'setTimeout');
  const sweep = vi.fn().mockResolvedValue(undefined);
  const scheduler = startRuntimeDaemonMaintenanceScheduler({
    canSweep: async () => true, sweep, onError: vi.fn(),
  });
  expect(sweep).not.toHaveBeenCalled();
  expect(timeouts.mock.results[0]?.value.hasRef()).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(sweep).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(sweep).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(sweep).toHaveBeenCalledTimes(2);
  await scheduler.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('skips busy rounds and resumes only when a later idle check succeeds', async () => {
  vi.useFakeTimers();
  const canSweep = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const sweep = vi.fn().mockResolvedValue(undefined);
  const scheduler = startRuntimeDaemonMaintenanceScheduler({ canSweep, sweep, onError: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  expect(sweep).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(sweep).toHaveBeenCalledTimes(1);
  await scheduler.close();
});

it('joins and aborts an in-flight sweep before shutdown without scheduling another round', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  let sweepingSignal: AbortSignal | undefined;
  const sweep = vi.fn((signal: AbortSignal) => {
    sweepingSignal = signal;
    return new Promise<void>((resolve) => { finish = resolve; });
  });
  const scheduler = startRuntimeDaemonMaintenanceScheduler({
    canSweep: async () => true, sweep, onError: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(900_000);
  expect(sweep).toHaveBeenCalledTimes(1);
  let closed = false;
  const closing = scheduler.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(sweepingSignal?.aborted).toBe(true);
  expect(closed).toBe(false);
  finish();
  await closing;
  expect(closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not sweep after shutdown interrupts a pending idle check', async () => {
  vi.useFakeTimers();
  let finish!: (idle: boolean) => void;
  const sweep = vi.fn().mockResolvedValue(undefined);
  const scheduler = startRuntimeDaemonMaintenanceScheduler({
    canSweep: () => new Promise<boolean>((resolve) => { finish = resolve; }),
    sweep, onError: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(0);
  let closed = false;
  const closing = scheduler.close().then(() => { closed = true; });
  await vi.advanceTimersByTimeAsync(0);
  const closedBeforeLateObservation = closed;
  finish(true);
  await closing;
  expect(closedBeforeLateObservation).toBe(true);
  expect(sweep).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('reports a failed round and allows a later round to retry', async () => {
  vi.useFakeTimers();
  const failure = new Error('directory could not be read');
  const sweep = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const onError = vi.fn();
  const scheduler = startRuntimeDaemonMaintenanceScheduler({ canSweep: async () => true, sweep, onError });
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledWith(failure);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(sweep).toHaveBeenCalledTimes(2);
  await scheduler.close();
});

it('reports a real filesystem failure that arrives after shutdown aborts the sweep', async () => {
  vi.useFakeTimers();
  let fail!: (error: Error) => void;
  const onError = vi.fn();
  const scheduler = startRuntimeDaemonMaintenanceScheduler({
    canSweep: async () => true,
    sweep: () => new Promise<void>((_resolve, reject) => { fail = reject; }),
    onError,
  });
  await vi.advanceTimersByTimeAsync(0);
  const closing = scheduler.close();
  const failure = Object.assign(new Error('filesystem read failed'), { code: 'EIO' });
  fail(failure);
  await closing;
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
});

it.each([
  { name: 'idle attached clients', blockers: ['connected_clients'], background: 0, expected: 1 },
  { name: 'active Runs', blockers: ['active_runs'], background: 0, expected: 0 },
  { name: 'queued Runs', blockers: ['queued_runs'], background: 0, expected: 0 },
  { name: 'Workflows', blockers: ['active_workflows'], background: 0, expected: 0 },
  { name: 'Actor turns', blockers: ['active_agent_turns'], background: 0, expected: 0 },
  { name: 'pending interactions', blockers: ['pending_interactions'], background: 0, expected: 0 },
  { name: 'background maintenance', blockers: [], background: 1, expected: 0 },
] as const)('checks preflight once per round for $name', async ({ blockers, background, expected }) => {
  vi.useFakeTimers();
  const runOnce = vi.fn().mockResolvedValue({ scanned: 0, removed: 0 });
  const close = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(daemonMaintenance, 'createRuntimeDaemonMaintenance').mockReturnValue({ runOnce, close });
  const retain = vi.fn().mockResolvedValue({ examined: 0, removed: 0, retained: 0, passComplete: true });
  vi.spyOn(homeRetention, 'createHomeRetention').mockReturnValue({ runOnce: retain });
  const preflight = vi.fn(async (): Promise<RuntimeDaemonPreflight> => ({
    runtimeId: 'Host', clientCount: 2, activeRuns: [], queuedRuns: [], activeWorkflows: [],
    activeAgentTurns: [], activeAgentTasks: [], pendingPermissions: [], pendingUserInputs: [],
    blockers, canStop: false, pendingBackgroundWork: background,
  }));
  const maintenance = startRuntimeDaemonHostMaintenance(resolveRuntimeDaemonPaths('/fixture', 'coder'),
    { runtimeId: 'Host', pid: process.pid, createdAt: '2026-11-06T00:00:00Z' }, { preflight }, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(preflight).toHaveBeenCalledTimes(1);
  expect(runOnce).toHaveBeenCalledTimes(expected);
  expect(retain).toHaveBeenCalledTimes(expected);
  await maintenance.close();
  expect(close).toHaveBeenCalledTimes(1);
});
