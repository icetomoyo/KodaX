import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXEvents } from '@kodax-ai/coding';

import { HostProtocolError } from './host-protocol/codec.js';
import type { HostCallResult } from './host-protocol/host-client.js';
import { exitCodeForOneShotResult, projectOneShotOutcome, resolveOneShotSession, runOneShotClientTask } from './one-shot-task.js';
import { createRequestId } from './host-protocol/host-client.js';
import { disposeReplHosts, LONG_REPLY, MODEL, replHost } from '../tests/repl-v2-host.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await disposeReplHosts();
});

/** The CLI works in its directory; the Host's own home keeps the test out of this repository. */
async function oneShotHost(mode: Parameters<typeof replHost>[0]) {
  const host = await replHost(mode);
  vi.spyOn(process, 'cwd').mockReturnValue(host.homeDir);
  return host;
}

type HostRun = HostCallResult<'run.get', 'local'>['run'];

function recorder() {
  const seen: string[] = [];
  let text = '';
  const events: KodaXEvents = {
    onSessionStart: () => { seen.push('session'); },
    onTextDelta: (delta) => { text += delta; },
    onStreamEnd: () => { seen.push('stream-end'); },
    onComplete: () => { seen.push('complete'); },
    onError: (error) => { seen.push(`error:${error.message}`); },
  };
  return { events, seen, text: () => text };
}

it('runs a prompt in a temporary Session, streams the whole reply and leaves nothing behind', async () => {
  const { client } = await oneShotHost('answer');
  const output = recorder();
  const result = await runOneShotClientTask({
    client, leases: async () => undefined, options: { provider: MODEL, events: output.events }, prompt: 'Say something long.',
  });
  expect(result).toMatchObject({ success: true, lastText: LONG_REPLY });
  // The view carries only the end of the reply; the rest is read before it.
  expect(output.text()).toBe(LONG_REPLY);
  expect(output.seen).toEqual(['session', 'stream-end', 'complete']);
  await expect(client.call('session.get', { sessionId: result.sessionId }))
    .rejects.toSatisfy(error => error instanceof HostProtocolError && error.kodaxCode === 'not_found');
}, 60_000);

it('gives a kept Session back its settings, and -c continues it', async () => {
  const { client } = await oneShotHost('answer');
  const first = await runOneShotClientTask({
    client, leases: async () => undefined, options: { provider: MODEL, session: {} }, prompt: 'Keep this one.',
  });
  const before = await client.call('session.settings.get', { sessionId: first.sessionId });
  let during: unknown;
  const again = await runOneShotClientTask({
    client, leases: async () => undefined, prompt: 'Continue.',
    options: { provider: MODEL, session: { resume: true }, maxIter: 7, reasoningMode: 'deep', events: {
      onSessionStart: () => { void client.call('session.settings.get', { sessionId: first.sessionId }).then(read => { during = read.settings; }); },
    } },
  });
  expect(again.sessionId).toBe(first.sessionId);
  // The old reasoning flag reaches the Run as the effort it stands for.
  await expect.poll(() => during).toMatchObject({ maxIter: 7, effort: 'high' });
  const after = await client.call('session.settings.get', { sessionId: first.sessionId });
  expect(after.settings.maxIter).toBe(before.settings.maxIter);
  expect(after.settings.effort).toBe(before.settings.effort);
}, 60_000);

it('answers a question nobody can answer as skipped, and the Run goes on', async () => {
  const { client } = await oneShotHost('ask');
  const result = await runOneShotClientTask({
    client, leases: async () => undefined, options: { provider: MODEL }, prompt: 'Ask me.',
  });
  expect(result).toMatchObject({ success: true, lastText: LONG_REPLY });
}, 60_000);

it('stops the Run when aborted, and reports it interrupted', async () => {
  const { client } = await oneShotHost('hold');
  const controller = new AbortController();
  const result = await runOneShotClientTask({
    client,
    leases: async () => { controller.abort(); return undefined; },
    options: { provider: MODEL }, prompt: 'Wait.', abortSignal: controller.signal,
  });
  expect(result).toMatchObject({ success: false, interrupted: true, signal: 'BLOCKED' });
  expect(exitCodeForOneShotResult(result)).toBe(130);
}, 60_000);

it('refuses to resume an archived Session or one the Host does not have', async () => {
  const { client, sessionId } = await oneShotHost('answer');
  await client.call('session.archive', { requestId: createRequestId(), sessionId });
  await expect(resolveOneShotSession(client, { provider: MODEL, session: { id: sessionId } }, 'resume')).rejects.toThrow('archived');
  await expect(resolveOneShotSession(client, { provider: MODEL, session: { id: 'missing' } }, 'resume')).rejects.toThrow('Session not found: missing');
}, 60_000);

function run(outcome: HostRun['outcome']): HostRun {
  return { id: 'run-1', sessionId: 'session-1', phase: 'completed', ...(outcome !== undefined ? { outcome } : {}) } as HostRun;
}

it('reads the result from the Run outcome', () => {
  expect(projectOneShotOutcome(run({ status: 'completed', effects: 'none', code: 'ok', finalText: 'done', signal: 'complete' })))
    .toMatchObject({ success: true, lastText: 'done', signal: 'COMPLETE', sessionId: 'session-1' });
  expect(projectOneShotOutcome(run({ status: 'cancelled', effects: 'none', code: 'cancelled' })))
    .toMatchObject({ success: false, interrupted: true, signal: 'BLOCKED' });
  expect(projectOneShotOutcome(run({ status: 'failed', effects: 'none', code: 'failed', limitReached: true, finalText: 'partial' })))
    .toMatchObject({ success: false, limitReached: true, lastText: 'partial' });
  expect(() => projectOneShotOutcome(run({ status: 'failed', effects: 'none', code: 'failed',
    failure: { kind: 'provider', stage: 'model', code: 'auth', safeMessage: 'The provider refused the key.' } })))
    .toThrow('The provider refused the key.');
  expect(() => projectOneShotOutcome(run({ status: 'unknown', effects: 'unknown', code: 'unknown' })))
    .toThrow('Run run-1 ended without a known outcome.');
});

it('maps results to exit codes', () => {
  expect(exitCodeForOneShotResult({ success: true, lastText: 'ok', messages: [], sessionId: 's' })).toBe(0);
  expect(exitCodeForOneShotResult({ success: false, lastText: '', messages: [], sessionId: 's', limitReached: true })).toBe(1);
  expect(exitCodeForOneShotResult({ success: false, lastText: 'err', messages: [], sessionId: 's' })).toBe(1);
});
