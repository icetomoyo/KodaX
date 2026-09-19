import { expect, it, vi } from 'vitest';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { attachClassicPlaneDisplay, createClassicPlaneDisplayDiffer } from './classic-plane-display.js';

it('ignores a late first observation and its questions after the session has changed', async () => {
  let current = true;
  let receive: ((view: ClientSessionView) => void) | undefined;
  let finish: ((close: () => void) => void) | undefined;
  const attached = new Promise<() => void>(resolve => { finish = resolve; });
  const onView = vi.fn();
  const question = vi.fn(async () => 'late answer');
  const respondInteraction = vi.fn(async () => true);
  const observation = attachClassicPlaneDisplay({
    observe: (_id, listener) => { receive = listener; return attached; },
    readItem: async () => null, respondInteraction,
  }, 'old-session', { onView, isCurrent: () => current,
    dialogs: { question: async () => undefined, questionInput: question, questionMulti: async () => undefined,
      permission: async () => ({ confirmed: false }) } });
  current = false;
  receive?.({ session: { id: 'old-session', title: '' }, settings: {}, items: [], runs: [], queue: [],
    interactions: [{ requestId: 'old-question', sessionId: 'old-session', runId: 'old-run',
      kind: 'question_input', options: { question: 'Do not show this' }, createdAt: '2026-09-19T00:00:00Z',
      expiresAt: '2026-09-19T01:00:00Z' }] });
  finish?.(() => undefined);
  const close = await observation;
  try {
    expect(onView).not.toHaveBeenCalled();
    expect(question).not.toHaveBeenCalled();
    expect(respondInteraction).not.toHaveBeenCalled();
  } finally { close(); }
});

it('serializes a reconnect behind an unfinished content read and prints each character once', async () => {
  const listeners: ((view: ClientSessionView) => void)[] = [];
  const printed: string[] = [];
  let finish: (() => void) | undefined;
  const firstRead = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  const readItem = vi.fn(async (id: string, options: { offset?: number }) => {
    reads += 1;
    if (reads === 1) await firstRead;
    return { id, offset: options.offset ?? 0, text: 'abcdefghi'.slice(options.offset), totalLength: 9 };
  });
  const differ = createClassicPlaneDisplayDiffer(line => printed.push(line), readItem);
  const displayQueue = { pending: Promise.resolve() };
  const plane = {
    observe: async (_id: string, listener: (view: ClientSessionView) => void) => {
      listeners.push(listener); return () => undefined;
    },
    readItem: async () => null,
    respondInteraction: async () => false,
  };
  const base: ClientSessionView = { session: { id: 'same-session', title: '' },
    settings: {}, items: [], interactions: [], runs: [], queue: [] };
  const first = await attachClassicPlaneDisplay(plane, base.session.id, { differ, displayQueue });
  listeners[0]!(base);
  await displayQueue.pending;
  listeners[0]!({ ...base, items: [{ id: 'answer', type: 'assistant', timestamp: 1,
    text: 'def', textOffset: 3, totalTextLength: 6 }] });
  await vi.waitFor(() => expect(readItem).toHaveBeenCalledTimes(1));
  first();
  const second = await attachClassicPlaneDisplay(plane, base.session.id, { differ, displayQueue });
  try {
    listeners[1]!({ ...base, items: [{ id: 'answer', type: 'assistant', timestamp: 1,
      text: 'ghi', textOffset: 6, totalTextLength: 9 }] });
    finish?.();
    await displayQueue.pending;
    expect(printed).toEqual(['assistant:abcdef', 'assistant:ghi']);
    expect(readItem).toHaveBeenCalledTimes(1);
  } finally { finish?.(); first(); second(); }
});
