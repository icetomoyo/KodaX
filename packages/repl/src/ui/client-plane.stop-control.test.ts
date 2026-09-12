import { expect, it, vi } from 'vitest';
import { bindClientPlaneSessionStop, followClientPlaneRun, runClientPlaneRound, type ClientRoundOutcome, type InkClientPlane } from './client-plane.js';
import type { RuntimeStopControl } from '../interactive/runtime-stop.js';

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
