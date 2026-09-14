import { expect, it, vi } from 'vitest';
import { bindClientPlaneSessionStop, followClientPlaneRun, runClientPlaneRound, type ClientRoundOutcome, type InkClientPlane } from './client-plane.js';
import type { RuntimeStopControl } from '../interactive/runtime-stop.js';

it('reports failed withdrawal when cancellation arrives before a queued input starts', async () => {
  const controller = new AbortController();
  const withdraw = vi.fn(async () => { throw new Error('Host rejected withdrawal; input remains queued'); });
  const stop = vi.fn();
  const plane = { submit: async () => {
    controller.abort();
    return { state: 'queued' };
  }, withdraw, stop, activeRun: async () => undefined } as unknown as InkClientPlane;
  await expect(runClientPlaneRound({ plane, sessionId: 'session', prompt: 'later', abortSignal: controller.signal }))
    .rejects.toThrow('Host rejected withdrawal; input remains queued');
  expect(withdraw).toHaveBeenCalledWith('session', expect.stringMatching(/^ink-/));
  expect(stop).not.toHaveBeenCalled();
});

it('does not confirm cancellation when withdrawal returns no input', async () => {
  const controller = new AbortController();
  const withdraw = vi.fn(async () => undefined);
  const stop = vi.fn();
  const plane = { submit: async () => {
    controller.abort();
    return { state: 'queued' };
  }, withdraw, stop, activeRun: async () => undefined } as unknown as InkClientPlane;
  await expect(runClientPlaneRound({ plane, sessionId: 'session', prompt: 'later', abortSignal: controller.signal }))
    .rejects.toThrow('Input withdrawal was not confirmed; it may still run.');
  expect(withdraw).toHaveBeenCalledWith('session', expect.stringMatching(/^ink-/));
  expect(stop).not.toHaveBeenCalled();
});

it.each(['cancelled', 'completed', 'unknown'] as const)('waits for the Host %s outcome when cancellation arrives during input acceptance', async phase => {
  const controller = new AbortController();
  let finish!: (outcome: ClientRoundOutcome) => void;
  const outcome = new Promise<ClientRoundOutcome>(resolve => { finish = resolve; });
  const stop = vi.fn().mockResolvedValue({ accepted: true, state: 'unknown', outcome: 'unknown' });
  const awaitRun = vi.fn(() => outcome);
  const plane = { submit: async () => {
    controller.abort();
    return { state: 'submitted', runId: 'accepted-run' };
  }, stop, awaitRun, activeRun: async () => undefined } as unknown as InkClientPlane;
  let settled = false;
  const pending = runClientPlaneRound({ plane, sessionId: 'session', prompt: 'work', abortSignal: controller.signal,
    getDisplayedRunId: () => 'older-displayed-run' });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('accepted-run'));
  expect(settled).toBe(false);
  expect(awaitRun).toHaveBeenCalledWith('session', 'accepted-run');
  const result = { success: true, lastText: 'finished before cancellation', messages: [], sessionId: 'session' };
  finish({ phase, ...(phase === 'completed' ? { result } : {}),
    ...(phase === 'unknown' ? { error: 'shell_cleanup_unconfirmed' } : {}) });
  if (phase === 'unknown') await expect(pending).rejects.toThrow('shell_cleanup_unconfirmed');
  else if (phase === 'completed') await expect(pending).resolves.toEqual(result);
  else await expect(pending).resolves.toMatchObject({ interrupted: true });
  expect(stop).toHaveBeenCalledOnce();
});

it.each(['round', 'started'] as const)('keeps rejected Session Stop retryable in a %s Run', async mode => {
  let finish!: (outcome: ClientRoundOutcome) => void;
  const result = new Promise<ClientRoundOutcome>(resolve => { finish = resolve; });
  const cancelSession = vi.fn().mockRejectedValueOnce(new Error('wrong owner')).mockResolvedValue({ receipts: [{ state: 'unknown' }] });
  const plane = { submit: async () => ({ runId: 'run' }), awaitRun: () => result,
    activeRun: async () => undefined, cancelSession } as unknown as InkClientPlane;
  let control: RuntimeStopControl | undefined;
  const onStopState = vi.fn();
  const input = { plane, sessionId: 'session', onStopControl: (next: RuntimeStopControl | undefined) => { control = next; }, onStopState };
  const pending = mode === 'round' ? runClientPlaneRound({ ...input, prompt: 'work' })
    : followClientPlaneRun({ ...input, runId: 'run' });
  let settled = false;
  void pending.then(() => { settled = true; });
  await vi.waitFor(() => expect(control).toBeDefined());
  await expect(control!.request()).rejects.toThrow('wrong owner');
  expect(onStopState).toHaveBeenLastCalledWith('rejected', 'wrong owner');
  expect(settled).toBe(false);
  await expect(control!.request()).resolves.toEqual({ state: 'unknown' });
  expect(cancelSession.mock.calls[1]![0]).toEqual(cancelSession.mock.calls[0]![0]);
  expect(onStopState).toHaveBeenLastCalledWith('accepted');
  finish({ phase: 'interrupted' });
  await expect(pending).resolves.toMatchObject({ interrupted: true });
  expect(onStopState).toHaveBeenLastCalledWith('confirmed', 'interrupted');
  expect(control).toBeUndefined();
});

it('reports natural completion confirmed when Session Stop loses the race', async () => {
  let finish!: (outcome: ClientRoundOutcome) => void;
  const result = new Promise<ClientRoundOutcome>(resolve => { finish = resolve; });
  const plane = { awaitRun: () => result, activeRun: async () => undefined,
    cancelSession: async () => ({ receipts: [{ runId: 'run', state: 'confirmed', outcome: 'completed', accepted: false }] }),
  } as unknown as InkClientPlane;
  let control: RuntimeStopControl | undefined;
  const onStopState = vi.fn();
  const pending = followClientPlaneRun({ plane, sessionId: 'session', runId: 'run', onStopState,
    onStopControl: next => { control = next; } });
  await vi.waitFor(() => expect(control).toBeDefined());
  await expect(control!.request()).resolves.toEqual({ state: 'confirmed' });
  finish({ phase: 'completed', result: { success: true, lastText: 'done', messages: [], sessionId: 'session' } });
  await pending;
  expect(onStopState).toHaveBeenLastCalledWith('confirmed', 'completed');
  expect(control).toBeUndefined();
});

it('retains terminal facts received before the Stop acknowledgement, scoped to the requested Run', async () => {
  let acknowledge!: (receipt: { receipts: { runId: string; state: string }[] }) => void;
  const response = new Promise<{ receipts: { runId: string; state: string }[] }>(resolve => { acknowledge = resolve; });
  let control: RuntimeStopControl | undefined;
  const onStopState = vi.fn();
  const binding = bindClientPlaneSessionStop({ sessionId: 'session',
    plane: { cancelSession: () => response } as unknown as InkClientPlane,
    onStopControl: next => { control = next; }, onStopState,
  }, () => 'current');
  const pending = control!.request();
  binding.settled({ phase: 'completed' }, 'previous');
  binding.settled({ phase: 'interrupted' }, 'current');
  acknowledge({ receipts: [{ runId: 'current', state: 'unknown' }] });
  await pending;
  expect(onStopState).toHaveBeenLastCalledWith('confirmed', 'interrupted');
  binding.close();
});
