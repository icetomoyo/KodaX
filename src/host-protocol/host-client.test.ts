import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostRpcClient } from './client.js';
import { HOST_CLOSE_CODES, hostLinkEnd, type HostLinkClose, type HostLinkEnd } from './close.js';
import { HOST_PROTOCOL, HostProtocolError } from './codec.js';
import { createKodaXHostClient, createRequestId, type HostConnectionState, type KodaXHostClient } from './host-client.js';

type Params = Readonly<Record<string, unknown>>;
type Responder = (method: string, params: Params, host: FakeHost) => Promise<Params> | Params;

interface FakeHost {
  readonly id: string;
  readonly rpc: HostRpcClient;
  /** Every request this connection was sent, in order. */
  readonly sent: Array<{ method: string; params: Params }>;
  notify(method: string, params: Params): void;
  /** Ends the link from the Host side, as a crash or a restart would, or with the close code the Host sent. */
  drop(close?: HostLinkClose): void;
}

/** One connection to a Host, without frames: what `open` hands the client. */
function fakeHost(id: string, respond: Responder): FakeHost {
  const listeners = new Set<(method: string, params: Params) => void>();
  const inFlight = new Set<(error: HostProtocolError) => void>();
  let open = true;
  let ended: HostLinkEnd | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const drop = (close?: HostLinkClose): void => {
    if (!open) return;
    open = false;
    if (close !== undefined) ended = hostLinkEnd(close);
    for (const reject of [...inFlight]) reject(new HostProtocolError('unknown_outcome', 'Lost.', { reason: 'connection_closed' }));
    inFlight.clear();
    resolveClosed();
  };
  const host: FakeHost = {
    id,
    sent: [],
    notify: (method, params) => { for (const listener of [...listeners]) listener(method, params); },
    drop,
    rpc: {
      handshake: {
        protocol: HOST_PROTOCOL, revision: 1, role: 'owner', subject: 'person', host: { id, version: '0.0.0-test' },
        methods: [], features: [], locks: [], limits: { maxFrameBytes: 1024 * 1024 },
      },
      request: (method, params = {}) => {
        if (!open) return Promise.reject(new HostProtocolError('unavailable', 'Closed.', { reason: 'connection_closed' }));
        host.sent.push({ method, params });
        return new Promise((resolve, reject) => {
          inFlight.add(reject);
          Promise.resolve().then(() => respond(method, params, host)).then(resolve, reject)
            .finally(() => inFlight.delete(reject));
        });
      },
      onNotification: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      closed,
      get ended() { return ended; },
      close: () => drop(),
    },
  };
  return host;
}

/** Hands out a new connection each time the client opens one; `hosts` are the connections made so far. */
function hostSequence(respond: Responder, ids: readonly string[] = ['host_a']) {
  const hosts: FakeHost[] = [];
  const failures: unknown[] = [];
  const open = vi.fn(async () => {
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
    const host = fakeHost(ids[Math.min(hosts.length, ids.length - 1)]!, respond);
    hosts.push(host);
    return host.rpc;
  });
  return { hosts, failures, open, latest: () => hosts[hosts.length - 1]! };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const task of cleanup.splice(0)) task();
  vi.useRealTimers();
});

async function client(open: () => Promise<HostRpcClient>, onError = vi.fn()): Promise<KodaXHostClient<'local'>> {
  const created = await createKodaXHostClient<'local'>({ open, onError });
  cleanup.push(() => created.close());
  return created;
}

function states(target: KodaXHostClient<'local'>): HostConnectionState['state'][] {
  const seen: HostConnectionState['state'][] = [];
  target.onConnectionChange((state) => { seen.push(state.state); });
  return seen;
}

/** Never answers, so the call stays in flight until the link drops. */
const hang = (): Promise<Params> => new Promise(() => undefined);

describe('createRequestId', () => {
  it('works in a page that is not a secure context, which has no randomUUID', () => {
    // Shadows the prototype's method on this one object, as an http page on a LAN address lacks it.
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const ids = new Set([createRequestId(), createRequestId()]);
      expect(ids.size).toBe(2);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      Reflect.deleteProperty(globalThis.crypto, 'randomUUID');
    }
    expect(createRequestId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('a Host client that outlives its connections', () => {
  it('answers calls on the connection it opened', async () => {
    const sequence = hostSequence(() => ({}));
    const host = await client(sequence.open);
    await expect(host.call('ping')).resolves.toEqual({});
    expect(host.handshake.host.id).toBe('host_a');
  });

  it('sends a call that lost its link again on the next connection, with the same requestId', async () => {
    const sequence = hostSequence((method, params, connection) => (
      connection === sequence.hosts[0] ? hang() : { run: { id: 'run_1', echoed: params.requestId, method } }
    ));
    const host = await client(sequence.open);
    const seen = states(host);
    const requestId = createRequestId();
    const pending = host.call('input.submit', { requestId, sessionId: 's1', text: 'hello' });
    await vi.waitFor(() => expect(sequence.hosts[0]!.sent).toHaveLength(1));
    sequence.hosts[0]!.drop();

    await expect(pending).resolves.toMatchObject({ run: { echoed: requestId } });
    expect(sequence.open).toHaveBeenCalledTimes(2);
    expect(sequence.hosts[1]!.sent[0]).toEqual({ method: 'input.submit', params: { requestId, sessionId: 's1', text: 'hello' } });
    expect(seen).toEqual(['connected', 'reconnecting', 'connected']);
  });

  it('hands the caller an unknown outcome of a command not sent again, and sends one that never left', async () => {
    const sequence = hostSequence((_method, params, connection) => {
      if (connection !== sequence.hosts[0]) return { status: 'answered' };
      if (params.interactionId === 'i1') return hang();
      // A link that fails to send is closing: the call that was in flight hears so next.
      setTimeout(() => connection.drop(), 0);
      return Promise.reject(new HostProtocolError('unavailable', 'Not sent.', { reason: 'send_failed' }));
    });
    const host = await client(sequence.open);
    const respond = (interactionId: string) => host.call('interaction.respond', {
      requestId: createRequestId(), interactionId, response: { kind: 'skip' },
    });
    const received = respond('i1');
    await vi.waitFor(() => expect(sequence.hosts[0]!.sent).toHaveLength(1));
    const unsent = respond('i2');

    await expect(received).rejects.toMatchObject({ kodaxCode: 'unknown_outcome' });
    await expect(unsent).resolves.toEqual({ status: 'answered' });
    expect(sequence.hosts.map(connection => connection.sent.map(sent => sent.params.interactionId))).toEqual([['i1', 'i2'], ['i2']]);
  });

  it('holds calls made while it reconnects, and lets a caller give up waiting', async () => {
    vi.useFakeTimers();
    const sequence = hostSequence(() => ({}));
    const host = await client(sequence.open);
    sequence.failures.push(new HostProtocolError('unavailable', 'Starting.', { reason: 'connect_failed' }));
    sequence.hosts[0]!.drop();
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const abandoned = host.call('ping', {}, { signal: controller.signal });
    const held = host.call('ping');
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ kodaxCode: 'cancelled' });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(held).resolves.toEqual({});
    expect(sequence.hosts).toHaveLength(2);
  });

  it('keeps trying a Host that cannot be reached yet and reports each failure', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const sequence = hostSequence(() => ({}));
    const host = await client(sequence.open, onError);
    const unreachable = new HostProtocolError('unavailable', 'Starting.', { reason: 'connect_failed' });
    sequence.failures.push(unreachable, unreachable, unreachable);
    sequence.hosts[0]!.drop();
    const held = host.call('ping');

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(held).resolves.toEqual({});
    expect(onError).toHaveBeenCalledTimes(3);
    expect(sequence.open).toHaveBeenCalledTimes(5);
  });

  it('closes for good when the Host refuses in a way trying again would not change', async () => {
    const sequence = hostSequence(() => ({}));
    const host = await client(sequence.open);
    const refused = new HostProtocolError('unauthorized', 'The credential is not valid.');
    sequence.failures.push(refused);
    const seen: HostConnectionState[] = [];
    host.onConnectionChange((state) => { seen.push(state); });
    sequence.hosts[0]!.drop();

    await expect(host.call('ping')).rejects.toBe(refused);
    await host.closed;
    expect(seen.at(-1)).toEqual({ state: 'closed', error: refused });
  });

  it('closes for good when the Host closes the link and asks it not to come back', async () => {
    const sequence = hostSequence(() => ({}));
    const host = await client(sequence.open);
    const seen: HostConnectionState[] = [];
    host.onConnectionChange((state) => { seen.push(state); });
    sequence.hosts[0]!.drop({ code: HOST_CLOSE_CODES.revoked, reason: 'revoked' });

    await expect(host.call('ping')).rejects.toMatchObject({ kodaxCode: 'unauthorized', reason: 'revoked' });
    await host.closed;
    expect(seen.at(-1)).toMatchObject({ state: 'closed', error: { kodaxCode: 'unauthorized', reason: 'revoked' } });
    expect(sequence.open).toHaveBeenCalledTimes(1);
  });

  it('waits before it reconnects to a Host that closed the link as too busy, and at once after an idle close', async () => {
    vi.useFakeTimers();
    const sequence = hostSequence(() => ({}));
    const host = await client(sequence.open);
    sequence.hosts[0]!.drop({ code: HOST_CLOSE_CODES.overloaded, reason: 'overloaded' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sequence.open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sequence.open).toHaveBeenCalledTimes(2);

    sequence.hosts[1]!.drop({ code: HOST_CLOSE_CODES.idle, reason: 'idle' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sequence.open).toHaveBeenCalledTimes(3);
    await expect(host.call('ping')).resolves.toEqual({});
  });

  it('does not open the link again after the client exits', async () => {
    const sequence = hostSequence((method, _params, connection) => {
      // The Host answers, then goes away.
      if (method === 'client.exit.request') setTimeout(() => connection.drop(), 0);
      return { exit: { id: 'exit_1' } };
    });
    const host = await client(sequence.open);
    await host.call('client.exit.request', { requestId: createRequestId(), shutdownHost: true });
    await host.closed;
    expect(sequence.open).toHaveBeenCalledTimes(1);
    await expect(host.call('ping')).rejects.toMatchObject({ kodaxCode: 'unavailable', reason: 'client_closed' });
  });

  it('opens the link again when the Host refused the exit', async () => {
    const sequence = hostSequence((method, _params, connection) => {
      if (method === 'host.stop' && connection === sequence.hosts[0]) {
        throw new HostProtocolError('conflict', 'Work is running.');
      }
      return {};
    });
    const host = await client(sequence.open);
    await expect(host.call('host.stop', { requestId: createRequestId() })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    sequence.hosts[0]!.drop();
    await expect(host.call('ping')).resolves.toEqual({});
    expect(sequence.open).toHaveBeenCalledTimes(2);
  });

  it('settles every waiting call when the caller closes it', async () => {
    const sequence = hostSequence(hang);
    const host = await client(sequence.open);
    const pending = host.call('ping');
    await vi.waitFor(() => expect(sequence.hosts[0]!.sent).toHaveLength(1));
    host.close();
    await expect(pending).rejects.toMatchObject({ kodaxCode: 'unknown_outcome' });
    await expect(host.call('ping')).rejects.toMatchObject({ kodaxCode: 'unavailable', reason: 'client_closed' });
    expect(sequence.open).toHaveBeenCalledTimes(1);
  });
});

interface TestView {
  readonly items: Array<{ id: string; text: string }>;
  readonly runs: Array<{ id: string; phase: string }>;
}

const snapshot = (subscriptionId: unknown, view: TestView, seq = 0, epoch = 'e1'): Params => ({
  subscriptionId, epoch, seq, snapshot: view,
});

describe('following a Session view', () => {
  /** Answers every subscription with `views[n]` for the n-th one, and unsubscribes with nothing. */
  function viewHost(views: readonly TestView[], ids?: readonly string[], extra?: Responder) {
    let subscriptions = 0;
    return hostSequence((method, params, connection) => {
      if (method === 'view.subscribe') return snapshot(params.subscriptionId, views[Math.min(subscriptions++, views.length - 1)]!);
      if (method === 'view.unsubscribe') return {};
      return extra?.(method, params, connection) ?? {};
    }, ids);
  }
  const subscriptionOf = (connection: FakeHost, index = 0): string => (
    connection.sent.filter(request => request.method === 'view.subscribe')[index]!.params.subscriptionId as string
  );

  it('delivers the first view, then each change', async () => {
    const sequence = viewHost([{ items: [{ id: 'i1', text: 'he' }], runs: [] }]);
    const host = await client(sequence.open);
    const views: unknown[] = [];
    await host.observeSession('s1', { onView: view => views.push(view) });
    const connection = sequence.latest();
    expect(connection.sent[0]).toMatchObject({ method: 'view.subscribe', params: { target: { kind: 'session', sessionId: 's1' } } });
    connection.notify('view.patch', {
      subscriptionId: subscriptionOf(connection), epoch: 'e1', seq: 1,
      ops: [{ op: 'item.append', id: 'i1', field: 'text', text: 'llo' }],
    });
    expect(views).toEqual([
      { items: [{ id: 'i1', text: 'he' }], runs: [] },
      { items: [{ id: 'i1', text: 'hello' }], runs: [] },
    ]);
  });

  it('applies a patch that arrives before the answer it follows was read', async () => {
    let subscriptionId: unknown;
    const sequence = hostSequence((method, params, connection) => {
      if (method !== 'view.subscribe') return {};
      subscriptionId = params.subscriptionId;
      const answer = snapshot(subscriptionId, { items: [], runs: [] });
      // The answer and the next patch come in one read: the patch is dispatched before the answer's continuation runs.
      return Promise.resolve(answer).finally(() => connection.notify('view.patch', {
        subscriptionId, epoch: 'e1', seq: 1, ops: [{ op: 'item.put', item: { id: 'i1', text: 'x' } }],
      }));
    });
    const host = await client(sequence.open);
    const views: TestView[] = [];
    await host.observeSession('s1', { onView: view => views.push(view as unknown as TestView) });
    await vi.waitFor(() => expect(views.at(-1)).toEqual({ items: [{ id: 'i1', text: 'x' }], runs: [] }));
  });

  it('subscribes again when a patch does not follow its copy', async () => {
    const sequence = viewHost([{ items: [], runs: [] }, { items: [{ id: 'i9', text: 'fresh' }], runs: [] }]);
    const host = await client(sequence.open);
    const views: TestView[] = [];
    await host.observeSession('s1', { onView: view => views.push(view as unknown as TestView) });
    const connection = sequence.latest();
    const first = subscriptionOf(connection);
    connection.notify('view.patch', { subscriptionId: first, epoch: 'e1', seq: 5, ops: [] });

    await vi.waitFor(() => expect(views.at(-1)).toEqual({ items: [{ id: 'i9', text: 'fresh' }], runs: [] }));
    expect(connection.sent.map(request => request.method)).toEqual(['view.subscribe', 'view.unsubscribe', 'view.subscribe']);
    expect(connection.sent[1]!.params).toEqual({ subscriptionId: first });
    // A late patch for the replaced subscription changes nothing.
    connection.notify('view.patch', { subscriptionId: first, epoch: 'e1', seq: 1, ops: [{ op: 'item.remove', id: 'i9' }] });
    expect(views.at(-1)).toEqual({ items: [{ id: 'i9', text: 'fresh' }], runs: [] });
  });

  it('takes the whole view again on a reset, and stops when the Host ends the view', async () => {
    const sequence = viewHost([{ items: [], runs: [] }]);
    const host = await client(sequence.open);
    const views: TestView[] = [];
    const onClosed = vi.fn();
    await host.observeSession('s1', { onView: view => views.push(view as unknown as TestView), onClosed });
    const connection = sequence.latest();
    const id = subscriptionOf(connection);
    connection.notify('view.reset', snapshot(id, { items: [{ id: 'i2', text: 'again' }], runs: [] }, 7, 'e2'));
    connection.notify('view.patch', { subscriptionId: id, epoch: 'e2', seq: 8, ops: [{ op: 'item.append', id: 'i2', field: 'text', text: '!' }] });
    connection.notify('view.closed', { subscriptionId: id, reason: 'session_deleted' });
    connection.notify('view.patch', { subscriptionId: id, epoch: 'e2', seq: 9, ops: [] });

    expect(views.slice(1)).toEqual([
      { items: [{ id: 'i2', text: 'again' }], runs: [] },
      { items: [{ id: 'i2', text: 'again!' }], runs: [] },
    ]);
    expect(onClosed).toHaveBeenCalledWith('session_deleted');
  });

  it('tells the caller why the first view never came', async () => {
    const sequence = hostSequence(() => { throw new HostProtocolError('not_found', 'No such Session.'); });
    const host = await client(sequence.open);
    await expect(host.observeSession('missing', { onView: () => undefined })).rejects.toMatchObject({ kodaxCode: 'not_found' });
  });

  it('follows the view on the next connection after the link is lost', async () => {
    const sequence = viewHost([{ items: [], runs: [] }, { items: [{ id: 'i1', text: 'after' }], runs: [] }]);
    const host = await client(sequence.open);
    const views: TestView[] = [];
    await host.observeSession('s1', { onView: view => views.push(view as unknown as TestView) });
    sequence.hosts[0]!.drop();

    await vi.waitFor(() => expect(views.at(-1)).toEqual({ items: [{ id: 'i1', text: 'after' }], runs: [] }));
    expect(sequence.hosts[1]!.sent.map(request => request.method)).toEqual(['view.subscribe']);
  });

  it('continues the Runs a replaced Host left part-way, once, and not those this client stopped', async () => {
    const recovering = { items: [], runs: [{ id: 'run_1', phase: 'recovering' }, { id: 'run_2', phase: 'recovering' }] };
    const sequence = viewHost([recovering], ['host_a', 'host_b']);
    const host = await client(sequence.open);
    await host.observeSession('s1', { onView: () => undefined });
    await host.call('run.stop', { requestId: createRequestId(), runId: 'run_2' });
    sequence.hosts[0]!.drop();

    const replacement = await vi.waitUntil(() => sequence.hosts[1]);
    await vi.waitFor(() => expect(replacement.sent.some(request => request.method === 'run.recover')).toBe(true));
    // The run still shows as waiting in later views; it is not asked again under the same Host.
    replacement.notify('view.reset', snapshot(subscriptionOf(replacement), recovering, 3));
    await Promise.resolve();
    const recovers = replacement.sent.filter(request => request.method === 'run.recover');
    expect(recovers).toHaveLength(1);
    expect(recovers[0]!.params).toMatchObject({ runId: 'run_1', requestId: expect.any(String) });
  });

  it('lends a continued Run what the caller says it borrows from the new Host', async () => {
    const sequence = viewHost([{ items: [], runs: [{ id: 'run_1', phase: 'recovering' }] }], ['host_a', 'host_b']);
    const seenHosts: string[] = [];
    const host = await createKodaXHostClient<'local'>({
      open: sequence.open,
      recoveryLeases: async (runId) => {
        seenHosts.push(host.handshake.host.id);
        return { credential: `lease-for-${runId}` };
      },
    });
    cleanup.push(() => host.close());
    await host.observeSession('s1', { onView: () => undefined });
    sequence.hosts[0]!.drop();

    const replacement = await vi.waitUntil(() => sequence.hosts[1]);
    await vi.waitFor(() => expect(replacement.sent.some(request => request.method === 'run.recover')).toBe(true));
    expect(replacement.sent.find(request => request.method === 'run.recover')!.params)
      .toMatchObject({ runId: 'run_1', leases: { credential: 'lease-for-run_1' } });
    expect(seenHosts).toEqual(['host_b']);
  });

  it('reports a lease it could not get and does not continue the Run without it', async () => {
    const sequence = viewHost([{ items: [], runs: [{ id: 'run_1', phase: 'recovering' }] }], ['host_a', 'host_b']);
    const onError = vi.fn();
    const failure = new Error('No key for this provider.');
    const host = await createKodaXHostClient<'local'>({
      open: sequence.open, onError, recoveryLeases: async () => { throw failure; },
    });
    cleanup.push(() => host.close());
    await host.observeSession('s1', { onView: () => undefined });
    sequence.hosts[0]!.drop();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(sequence.hosts[1]!.sent.some(request => request.method === 'run.recover')).toBe(false);
  });

  it('leaves waiting Runs alone after reconnecting to the same Host', async () => {
    const sequence = viewHost([{ items: [], runs: [{ id: 'run_1', phase: 'recovering' }] }], ['host_a']);
    const host = await client(sequence.open);
    await host.observeSession('s1', { onView: () => undefined });
    sequence.hosts[0]!.drop();
    const replacement = await vi.waitUntil(() => sequence.hosts[1]);
    await vi.waitFor(() => expect(replacement.sent.some(request => request.method === 'view.subscribe')).toBe(true));
    await Promise.resolve();
    expect(replacement.sent.some(request => request.method === 'run.recover')).toBe(false);
  });

  it('tells the Host when the caller stops following', async () => {
    const sequence = viewHost([{ items: [], runs: [] }]);
    const host = await client(sequence.open);
    const views: unknown[] = [];
    const observation = await host.observeSession('s1', { onView: view => views.push(view) });
    const connection = sequence.latest();
    const id = subscriptionOf(connection);
    observation.close();
    connection.notify('view.patch', { subscriptionId: id, epoch: 'e1', seq: 1, ops: [] });
    expect(connection.sent.at(-1)).toEqual({ method: 'view.unsubscribe', params: { subscriptionId: id } });
    expect(views).toHaveLength(1);
  });
});

describe('answering the Host for a leased key', () => {
  const request = {
    callId: 'call_1', kind: 'credential', leaseId: 'lease_1', provider: 'p', sessionId: 's1',
    target: { kind: 'run', runId: 'r1' }, purpose: 'primary',
  } as const;
  const answers = (connection: FakeHost) => connection.sent.filter(sent => sent.method === 'lease.complete').map(sent => sent.params);

  it('answers with the key the handler gives', async () => {
    const sequence = hostSequence(() => ({ status: 'accepted' }));
    const host = await client(sequence.open);
    const handler = vi.fn(async () => 'key-1');
    host.answerLeaseRequests(handler);
    sequence.latest().notify('lease.request', request);
    await vi.waitFor(() => expect(answers(sequence.latest())).toHaveLength(1));
    expect(handler).toHaveBeenCalledWith(request);
    expect(answers(sequence.latest())[0]).toEqual({ requestId: expect.any(String), kind: 'credential', callId: 'call_1', credential: 'key-1' });
  });

  it('refuses at once without a handler, and when the handler has no key', async () => {
    const sequence = hostSequence(() => ({ status: 'accepted' }));
    const host = await client(sequence.open);
    sequence.latest().notify('lease.request', request);
    await vi.waitFor(() => expect(answers(sequence.latest())).toHaveLength(1));
    host.answerLeaseRequests(async () => undefined);
    sequence.latest().notify('lease.request', { ...request, callId: 'call_2' });
    await vi.waitFor(() => expect(answers(sequence.latest())).toHaveLength(2));
    expect(answers(sequence.latest()).map(answer => answer.error)).toEqual(['credential_unavailable', 'credential_unavailable']);
  });

  it('keeps what the handler threw off the wire and reports it', async () => {
    const onError = vi.fn();
    const sequence = hostSequence(() => ({ status: 'accepted' }));
    const host = await client(sequence.open, onError);
    const failure = new Error('vault said: token abc123 expired');
    host.answerLeaseRequests(async () => { throw failure; });
    sequence.latest().notify('lease.request', request);
    await vi.waitFor(() => expect(answers(sequence.latest())).toHaveLength(1));
    expect(answers(sequence.latest())[0]).toMatchObject({ callId: 'call_1', error: 'credential_broker_failed' });
    expect(JSON.stringify(sequence.latest().sent)).not.toContain('abc123');
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

describe('answering the Host for a call of a leased tool', () => {
  const call = {
    callId: 'call_1', kind: 'host_tool', leaseId: 'tools_1', sessionId: 's1', runId: 'r1',
    tool: 'lookup_order', input: { id: 'A1' }, sideEffect: 'none',
  } as const;
  const answers = (connection: FakeHost) => connection.sent.filter(sent => sent.method === 'lease.complete').map(sent => sent.params);

  it('answers with what the handler returns, and leaves key requests to their own handler', async () => {
    const sequence = hostSequence(() => ({ status: 'accepted' }));
    const host = await client(sequence.open);
    const handler = vi.fn(async () => ({ content: 'Ships on Friday.', structuredContent: { ships: 'Friday' } }));
    const keys = vi.fn(async () => 'key-1');
    host.answerToolCalls(handler);
    host.answerLeaseRequests(keys);
    sequence.latest().notify('lease.request', call);
    await vi.waitFor(() => expect(answers(sequence.latest())).toHaveLength(1));
    expect(handler).toHaveBeenCalledWith(call);
    expect(keys).not.toHaveBeenCalled();
    expect(answers(sequence.latest())[0]).toEqual({
      requestId: expect.any(String), kind: 'host_tool', callId: 'call_1',
      result: { content: 'Ships on Friday.', structuredContent: { ships: 'Friday' } },
    });
  });

  it('refuses at once without a handler, and keeps what the handler threw off the wire', async () => {
    const onError = vi.fn();
    const sequence = hostSequence(() => ({ status: 'accepted' }));
    const host = await client(sequence.open, onError);
    sequence.latest().notify('lease.request', call);
    await vi.waitFor(() => expect(answers(sequence.latest())).toHaveLength(1));
    const failure = new Error('database password hunter2 rejected');
    host.answerToolCalls(async () => { throw failure; });
    sequence.latest().notify('lease.request', { ...call, callId: 'call_2' });
    await vi.waitFor(() => expect(answers(sequence.latest())).toHaveLength(2));
    expect(answers(sequence.latest()).map(answer => answer.error)).toEqual(['host_tool_unavailable', 'host_tool_failed']);
    expect(JSON.stringify(sequence.latest().sent)).not.toContain('hunter2');
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
