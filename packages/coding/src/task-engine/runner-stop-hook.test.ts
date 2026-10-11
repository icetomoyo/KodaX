import { afterEach, expect, it, vi } from 'vitest';
import { KodaXExtensionRuntime, setActiveExtensionRuntime } from '../extensions/runtime.js';
import { buildRunnerStopHook } from './runner-stop-hook.js';

afterEach(() => setActiveExtensionRuntime(null));

it.each([{ activeDescendantTurns: 1, hasPendingRootTaskNotifications: false },
  { activeDescendantTurns: 0, hasPendingRootTaskNotifications: true }])('waits for child work and mailbox delivery before extension Stop: %j', async state => {
  const runtime = new KodaXExtensionRuntime();
  const complete = vi.fn(() => ({ abort: true, reason: 'Extension blocked.' }));
  runtime.registerHook('turn:complete', complete);
  setActiveExtensionRuntime(runtime);
  const hook = buildRunnerStopHook({ getSessionId: () => 'session', getCollaborationState: () => state });
  expect(await hook({ transcript: [], lastAssistantText: 'Candidate.', signal: new AbortController().signal,
    reanimateCount: 0, reanimateBudget: 2 })).toBeUndefined();
  expect(complete).not.toHaveBeenCalled();
  await runtime.dispose();
});

it('retains extension Stop when no collaboration work remains', async () => {
  const runtime = new KodaXExtensionRuntime();
  runtime.registerHook('turn:complete', () => ({ abort: true, reason: 'Extension blocked.' }));
  setActiveExtensionRuntime(runtime);
  const hook = buildRunnerStopHook({ getSessionId: () => 'session', getCollaborationState: () => ({
    activeDescendantTurns: 0, hasPendingRootTaskNotifications: false,
  }) });
  expect(await hook({ transcript: [], lastAssistantText: 'Candidate.', signal: new AbortController().signal,
    reanimateCount: 0, reanimateBudget: 2 })).toMatchObject({ abort: true, reason: 'Extension blocked.' });
  await runtime.dispose();
});
