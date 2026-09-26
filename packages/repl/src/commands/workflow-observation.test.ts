import { describe, expect, it, vi } from 'vitest';
import type { WorkflowHostControl, CommandCallbacks } from './types.js';
import { createWorkflowProcessTracker, type WorkflowProcessEvent, type WorkflowProcessSnapshot } from '@kodax-ai/agent';
import { createWorkflowLiveUpdateEmitter, observeHostWorkflowDone } from './workflow-command-live.js';

function observationFixture(get: WorkflowHostControl['get']) {
  let listener!: (event: WorkflowProcessEvent) => void;
  let fail: ((error: unknown) => void) | undefined;
  const host: WorkflowHostControl = { get,
    subscribe(_filter, onEvent, onError) {
      listener = onEvent; fail = onError;
      return { ready: Promise.resolve(), close() {} };
    },
    start: async () => ({ kind: 'declined', reason: 'unused' }),
    list: async () => [], pause: async () => false, resume: async () => false, stop: async () => false };
  const updates: Parameters<NonNullable<CommandCallbacks['onWorkflowRunUpdate']>>[0][] = [];
  const live = createWorkflowLiveUpdateEmitter({ onWorkflowRunUpdate: (update) => updates.push(update) },
    'run-one', { name: 'test', description: 'test', readOnly: true, maxAgents: 1, maxConcurrency: 1 });
  observeHostWorkflowDone(host, { onWorkflowRunMessage() {} }, 'run-one', live);
  return { updates, emit: (event: WorkflowProcessEvent) => listener(event), fail: () => fail?.(new Error('lost')) };
}

describe('Host workflow observation', () => {
  it('keeps events received during snapshot loading instead of applying an older reply', async () => {
    vi.useFakeTimers();
    try {
      const tracker = createWorkflowProcessTracker({ runId: 'run-one', workflowName: 'test' });
      const staleSnapshot = tracker.getSnapshot();
      let resolveSnapshot!: (snapshot: WorkflowProcessSnapshot) => void;
      const get = vi.fn(async () => tracker.getSnapshot())
        .mockImplementationOnce(() => new Promise<WorkflowProcessSnapshot>((resolve) => { resolveSnapshot = resolve; }));
      const observation = observationFixture(get);
      await vi.advanceTimersByTimeAsync(0);
      observation.emit(tracker.setStatus('paused', 'New approval request'));
      resolveSnapshot(staleSnapshot);
      await vi.advanceTimersByTimeAsync(0);
      expect(observation.updates.at(-1)).toMatchObject({ message: 'New approval request' });
      expect(get).toHaveBeenCalledTimes(2);
      observation.emit(tracker.setStatus('cancelled'));
    } finally { vi.useRealTimers(); }
  });
  it('restores a paused workflow snapshot after reconnect without waiting for another event', async () => {
    vi.useFakeTimers();
    try {
      const tracker = createWorkflowProcessTracker({ runId: 'run-one', workflowName: 'test' });
      const get = vi.fn(async () => tracker.getSnapshot());
      const observation = observationFixture(get);
      await vi.advanceTimersByTimeAsync(0);
      observation.fail();
      tracker.setStatus('paused', 'Waiting for approval');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(get).toHaveBeenCalledTimes(2);
      expect(observation.updates.at(-1)).toMatchObject({ message: 'Waiting for approval' });
      observation.emit(tracker.setStatus('cancelled'));
    } finally { vi.useRealTimers(); }
  });
  it('reads a snapshot after registration and rebuilds observation after a failure', async () => {
    vi.useFakeTimers();
    try {
      let register!: () => void;
      let fail: ((error: unknown) => void) | undefined;
      const ready = new Promise<void>((resolve) => { register = resolve; });
      const get = vi.fn(async () => undefined);
      const subscribe = vi.fn<WorkflowHostControl['subscribe']>((_filter, _listener, onError) => {
        fail = onError;
        return { ready, close() {} };
      });
      const host: WorkflowHostControl = { subscribe, get, start: async () => ({ kind: 'declined', reason: 'unused' }),
        list: async () => [], pause: async () => false, resume: async () => false, stop: async () => false };
      const messages: Parameters<NonNullable<CommandCallbacks['onWorkflowRunMessage']>>[0][] = [];
      observeHostWorkflowDone(host, { onWorkflowRunMessage: (message) => { messages.push(message); } }, 'run-one');
      await Promise.resolve();
      expect(get).not.toHaveBeenCalled();
      register();
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(1);
      fail?.(new Error('connection lost'));
      expect(messages.some((message) => message.text.includes('connection lost'))).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(get).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
