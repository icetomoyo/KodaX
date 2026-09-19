import { expect, it } from 'vitest';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner } from './session-view.js';

it('projects current thinking and tool input progress without retaining partial arguments', async () => {
  const saved: unknown[] = [];
  const owner = new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Streaming' },
    settings: {}, items: [], queue: [], interactions: [], runs: [{ runId: 'run', phase: 'running', provider: 'test' }] }),
  async (_session, _runs, items) => { saved.push(items); });
  const events = owner.events('session', 'run');
  const views: ClientSessionView[] = [];
  const observation = await owner.observe('session', view => views.push(view));
  try {
    events.onOutputSegmentStart?.({ responseId: 'response', providerRequestId: 'request', mode: 'append' });
    events.onThinkingDelta?.('Plan', { providerRequestId: 'request' });
    events.onThinkingDelta?.(' now', { providerRequestId: 'request' });
    await expect.poll(() => views.at(-1)?.activity?.streaming).toEqual({
      kind: 'thinking', providerRequestId: 'request', itemId: 'run:request:thinking', charCount: 8,
    });
    events.onToolInputDelta?.('read', '{"partial-secret":', { providerRequestId: 'request', toolId: 'call' });
    await expect.poll(() => views.at(-1)?.activity?.streaming).toEqual({
      kind: 'tool-input', providerRequestId: 'request', toolName: 'read', callId: 'call', charCount: 18,
    });
    owner.checkpoint('session');
    await owner.flush('session');
    expect(JSON.stringify(saved)).not.toContain('partial-secret');
    expect(JSON.stringify(views)).not.toContain('partial-secret');
  } finally { observation.close(); await owner.close(); }
});

it('isolates interleaved calls and retires streaming on replace, end, tool start, cancellation and reset', async () => {
  let phase = 'running';
  let runId = 'first-run';
  const owner = new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Lifecycle' },
    settings: {}, items: [], queue: [], interactions: [], runs: [{ runId, phase, provider: 'test' }] }), async () => undefined);
  const events = owner.events('session', runId);
  const current = async () => {
    let result: ClientSessionView | undefined;
    const observation = await owner.observe('session', view => { result = view; });
    observation.close();
    return result?.activity?.streaming;
  };
  const start = (request: string) => events.onOutputSegmentStart?.({ responseId: 'response', providerRequestId: request, mode: 'replace' });
  const input = (text: string, callId?: string, request = 'first') =>
    events.onToolInputDelta?.('read', text, { providerRequestId: request, toolId: callId });
  try {
    start('first');
    input('12', 'one'); input('1234567', 'two'); input('345', 'one');
    expect(await current()).toMatchObject({ callId: 'one', charCount: 5 });
    input('same-name-without-id');
    expect(await current()).toEqual({ kind: 'tool-input', toolName: 'read', providerRequestId: 'first' });
    start('second');
    expect(await current()).toBeUndefined();
    input('stale', 'one');
    events.onThinkingDelta?.('old', { providerRequestId: 'first' });
    input('123', 'two', 'second');
    events.onToolInputDelta?.('read', 'child', { providerRequestId: 'second', toolId: 'two', childAgentId: 'child' });
    events.onStreamEnd?.({ providerRequestId: 'first' });
    expect(await current()).toMatchObject({ providerRequestId: 'second', charCount: 3 });
    events.onToolUseStart?.({ id: 'two', name: 'read', input: {} }, { providerRequestId: 'first' });
    expect(await current()).toMatchObject({ providerRequestId: 'second', charCount: 3 });
    events.onToolUseStart?.({ id: 'two', name: 'read', input: {} }, { providerRequestId: 'second' });
    input('late', 'two', 'second');
    expect(await current()).toBeUndefined();
    events.onThinkingDelta?.('Thinking', { providerRequestId: 'second' });
    events.onThinkingEnd?.('Thinking', { providerRequestId: 'second' });
    expect(await current()).toBeUndefined();
    input('end me', 'three', 'second');
    events.onStreamEnd?.({ providerRequestId: 'second' });
    input('late end', 'three', 'second');
    expect(await current()).toBeUndefined();
    start('third'); input('cancel me', 'four', 'third');
    phase = 'cancelled';
    expect(await current()).toBeUndefined();
    input('late cancel', 'four', 'third');
    expect(await current()).toBeUndefined();
    runId = 'next-run'; phase = 'running';
    const next = owner.events('session', runId);
    next.onOutputSegmentStart?.({ responseId: 'next', providerRequestId: 'next-request', mode: 'append' });
    next.onThinkingDelta?.('new', { providerRequestId: 'next-request' });
    start('old run revived'); input('old run', 'old', 'old run revived');
    expect(await current()).toMatchObject({ providerRequestId: 'next-request', charCount: 3 });
    owner.resetHistory('session');
    next.onThinkingDelta?.('after reset', { providerRequestId: 'next-request' });
    expect(await current()).toBeUndefined();
  } finally { await owner.close(); }
});
