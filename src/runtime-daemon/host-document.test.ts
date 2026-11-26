import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostDocument } from '../host-protocol/view.js';
import { createHostDocumentStreams } from './host-document.js';

const session = (id: string) => ({ id, title: id, archived: false });
const document = (...ids: string[]) => ({ items: [], sessions: ids.map(session), runs: [], interactions: [] });

afterEach(() => {
  vi.useRealTimers();
});

function makeStreams(options: { readonly congested?: () => boolean } = {}) {
  const frames: Array<{ method: string; params: Record<string, unknown> }> = [];
  let changed = (): void => undefined;
  const stopped = vi.fn();
  const errors: unknown[] = [];
  const streams = createHostDocumentStreams({
    contract: HostDocument,
    send: frame => frames.push(JSON.parse(frame) as { method: string; params: Record<string, unknown> }),
    congested: options.congested ?? (() => false),
    follow: async (listener) => {
      changed = listener;
      return stopped;
    },
    onInternalError: (_method, error) => errors.push(error),
  });
  return { streams, frames, stopped, errors, changed: () => changed() };
}

describe('Host document streams', () => {
  it('reads again at most once a second however often something changes', async () => {
    vi.useFakeTimers();
    const { streams, frames, changed } = makeStreams();
    let current = document('a');
    const read = vi.fn(async () => current);
    const subscription = await streams.subscribe('host', read);
    subscription.answered();
    expect(subscription.answer).toMatchObject({ seq: 0, snapshot: document('a') });

    current = document('b', 'a');
    for (let index = 0; index < 5; index += 1) changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(frames).toEqual([{
      jsonrpc: '2.0', method: 'view.patch',
      params: { subscriptionId: 'host', epoch: subscription.answer.epoch, seq: 1, ops: [{ op: 'set', key: 'sessions', value: [session('b'), session('a')] }] },
    }]);

    // A read that finds nothing new sends nothing.
    changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(frames).toHaveLength(1);
  });

  it('holds what changed while the link is congested and sends the newest once it drains', async () => {
    vi.useFakeTimers();
    let congested = true;
    const { streams, frames, changed } = makeStreams({ congested: () => congested });
    let current = document('a');
    const subscription = await streams.subscribe('host', async () => current);
    subscription.answered();

    current = document('b');
    changed();
    await vi.advanceTimersByTimeAsync(1000);
    current = document('c');
    changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames).toEqual([]);

    congested = false;
    streams.drained();
    expect(frames.map(frame => frame.params.ops)).toEqual([[{ op: 'set', key: 'sessions', value: [session('c')] }]]);
  });

  it('ends a subscription whose document cannot be read, and stops following once none is left', async () => {
    vi.useFakeTimers();
    const { streams, frames, stopped, errors, changed } = makeStreams();
    let fail = false;
    const subscription = await streams.subscribe('host', async () => {
      if (fail) throw new Error('disk gone');
      return document('a');
    });
    subscription.answered();

    fail = true;
    changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toEqual([new Error('disk gone')]);
    expect(frames).toEqual([{
      jsonrpc: '2.0', method: 'view.closed', params: { subscriptionId: 'host', reason: 'internal', incidentId: expect.any(String) },
    }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toHaveBeenCalledTimes(1);
  });
});
