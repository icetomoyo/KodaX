import { expect, it, vi } from 'vitest';
import type { KodaXRuntime, RuntimeConnectionState } from './sdk-runtime.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import { createRecoveringRuntimeClient } from './recovering-runtime-client.js';
import { createCliClientPlane } from './cli-client-plane.js';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';

it.each(['rejected', 'pending'] as const)('does not apply a stale Session Stop to a later Run (%s)', async state => {
  let disconnect!: (value: RuntimeConnectionState) => void;
  let rejectStop!: (error: Error) => void;
  const conflict = Object.assign(new Error('Stale Run'), { code: 'conflict' });
  const first = { identity: { runtimeId: 'old' }, close: async () => {}, runs: {},
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnect) => {
      disconnect = listener; return { close() {} };
    } },
    sessions: { cancel: async () => {
      if (state === 'rejected') throw conflict;
      return new Promise((_resolve, reject) => { rejectStop = reject; });
    } },
  } as unknown as KodaXRuntime;
  const recover = vi.fn(async () => ({ runId: 'later', sessionId: 's' }));
  const next = { identity: { runtimeId: 'new' }, close: async () => {}, sessions: { getSettings: async () => ({}) },
    runs: { get: async () => ({ runId: 'later', sessionId: 's', phase: 'recovering', contextRecovery: { checkpoint: {} } }),
      recover, await: async () => ({ phase: recover.mock.calls.length ? 'completed' : 'recovering' }) },
  } as unknown as KodaXRuntime;
  const runtime = createRecoveringRuntimeClient(first, async () => next);
  const stop = runtime.sessions.cancel({ sessionId: 's', expectedRunId: 'old-run', requestId: 'old-stop' });
  const stopped = expect(stop).rejects.toMatchObject({ code: 'conflict' });
  let result: Promise<unknown> | undefined;
  try {
    if (state === 'rejected') await stopped;
    disconnect({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old', code: 'protocol_closed', reconnectable: true });
    result = runtime.runs.await('later');
    // Attach a rejection handler so cleanup can close a still-waiting client on RED.
    void result.catch(() => undefined);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    await expect(result).resolves.toMatchObject({ phase: 'completed' });
  } finally {
    if (state === 'pending') rejectStop(conflict);
    await stopped;
    await runtime.close();
    if (result) await Promise.allSettled([result]);
  }
});

it.each(['recovery', 'observation'])('survives a second Host loss during %s', async stage => {
  const listeners: Array<(state: RuntimeConnectionState) => void> = [];
  const loss = Object.assign(new Error('second Host died'), { code: 'protocol_closed' });
  const delivered: ClientSessionView[] = [];
  const view = { runs: [] } as unknown as ClientSessionView;
  const hosts = ['first', 'second', 'third'].map((runtimeId, index) => ({ identity: { runtimeId }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof listeners[number]) => {
      listeners[index] = listener; return { close() {} };
    } },
    sessions: { observeView: async (_id: string, deliver: (value: ClientSessionView) => void) => {
      if (index === 1 && stage === 'observation') { listeners[1]!(disconnected); throw loss; }
      deliver(view); return { close() {} };
    } },
    runs: { get: async () => { if (index === 1) { listeners[1]!(disconnected); throw loss; } return { phase: 'completed' }; },
      await: async () => ({ phase: 'completed' }) },
  }) as unknown as KodaXRuntime);
  const disconnected: RuntimeConnectionState = { state: 'disconnected', connectionId: 'gone', runtimeEpoch: 'gone', code: 'protocol_closed', reconnectable: true };
  let index = 0;
  const runtime = createRecoveringRuntimeClient(hosts[0]!, async () => hosts[++index]!);
  const observation = stage === 'observation' ? await runtime.sessions.observeView('s', value => delivered.push(value)) : undefined;
  try {
    listeners[0]!(disconnected);
    if (stage === 'recovery') expect((await runtime.runs.await('r')).phase).toBe('completed');
    else await vi.waitFor(() => expect(delivered).toHaveLength(2), { timeout: 5_000 });
    expect(index).toBe(2);
  } finally { observation?.close(); await runtime.close(); }
});

it('cancels unavailable Host startup when the client explicitly exits', async () => {
  let disconnect!: (state: RuntimeConnectionState) => void;
  const first = { identity: { runtimeId: 'old' }, close: async () => {}, lifecycle: { requestExit: vi.fn() },
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnect) => { disconnect = listener; return { close() {} }; } },
  } as unknown as KodaXRuntime;
  const connect = vi.fn((signal: AbortSignal) => new Promise<KodaXRuntime>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const runtime = createRecoveringRuntimeClient(first, connect);
  try {
    disconnect({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old', code: 'protocol_closed', reconnectable: true });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    let settled = false;
    const exit = toKodaXProductClient(runtime).lifecycle.requestExit({ requestId: 'quit' }).catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(await exit).toBeInstanceOf(Error);
    expect(first.lifecycle!.requestExit).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('reattaches live progress, discards late events, and closes subscriptions once', async () => {
  let disconnect!: (state: RuntimeConnectionState) => void;
  const deliveries: Array<Parameters<KodaXRuntime['events']['subscribe']>[1]> = [];
  const releases = [vi.fn(), vi.fn()];
  const hosts = ['old', 'new'].map((runtimeId, i) => ({ identity: { runtimeId }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnect) => {
      disconnect = listener; listener({ state: 'connected', connectionId: runtimeId, runtimeEpoch: runtimeId, reconnectable: false }); return { close() {} };
    } },
    events: { subscribe: (_filter: unknown, deliver: typeof deliveries[number]) => { deliveries.push(deliver); return { close: releases[i] }; } },
  }) as unknown as KodaXRuntime);
  const runtime = createRecoveringRuntimeClient(hosts[0]!, async () => hosts[1]!);
  const received = vi.fn();
  const subscription = runtime.events.subscribe({ sessionId: 's' }, received);
  const status = vi.fn();
  const lifecycle = runtime.connection!.subscribe(status);
  try {
    disconnect({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old', code: 'transport_error', reconnectable: true });
    await vi.waitFor(() => expect(deliveries).toHaveLength(2));
    const event = { type: 'run.started' } as Parameters<typeof deliveries[number]>[0];
    deliveries[0]!(event); deliveries[1]!(event);
    expect(received).toHaveBeenCalledTimes(1);
    expect(runtime.connection!.current().state).toBe('connected');
    subscription.close(); subscription.close();
    expect(releases.map(close => close.mock.calls.length)).toEqual([1, 1]);
  } finally { lifecycle.close(); subscription.close(); await runtime.close(); }
});

it.each(['retry', 'reject', 'close'])('handles %s while reconnecting without an orphan retry', async behavior => {
  let disconnect!: (state: RuntimeConnectionState) => void;
  const first = { identity: { runtimeId: 'old' }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnect) => { disconnect = listener; return { close() {} }; } },
    runs: { await: async () => ({ phase: 'completed' }) },
  } as unknown as KodaXRuntime;
  const connect = vi.fn(async (signal: AbortSignal) => {
    if (behavior === 'close') return new Promise<KodaXRuntime>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    if (behavior === 'reject') throw new Error('Authority denied');
    if (connect.mock.calls.length === 1) throw Object.assign(new Error('not ready'), { code: 'ECONNREFUSED' });
    return first;
  });
  const runtime = createRecoveringRuntimeClient(first, connect);
  try {
    disconnect({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old', code: 'protocol_closed', reconnectable: true });
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    if (behavior === 'close') { await runtime.close(); expect(connect).toHaveBeenCalledTimes(1); }
    else if (behavior === 'reject') await expect(runtime.runs.await('r')).rejects.toThrow('Authority denied');
    else { expect((await runtime.runs.await('r')).phase).toBe('completed'); expect(connect).toHaveBeenCalledTimes(2); }
  } finally { await runtime.close(); }
});

it('keeps a graceful checkpoint outcome pending until the replacement Host connects', async () => {
  let disconnect!: (state: RuntimeConnectionState) => void;
  const first = { identity: { runtimeId: 'old' }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnect) => { disconnect = listener; return { close() {} }; } },
    runs: { await: vi.fn(async () => ({ phase: 'recovering' })) },
  } as unknown as KodaXRuntime;
  const next = { identity: { runtimeId: 'new' }, close: async () => {},
    runs: { get: async () => ({ phase: 'completed' }), await: async () => ({ phase: 'completed' }) },
  } as unknown as KodaXRuntime;
  const runtime = createRecoveringRuntimeClient(first, async () => next);
  try {
    const outcome = runtime.runs.await('r');
    await vi.waitFor(() => expect(first.runs.await).toHaveBeenCalledOnce());
    disconnect({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old', code: 'protocol_closed', reconnectable: true });
    expect((await outcome).phase).toBe('completed');
  } finally { await runtime.close(); }
});

it.each(['shutdown', 'requestExit'])('does not resurrect a Host after explicit %s', async action => {
  let disconnect!: (state: RuntimeConnectionState) => void;
  const quit = async () => {
    disconnect({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old', code: 'protocol_closed', reconnectable: true });
    return { accepted: true };
  };
  const first = { identity: { runtimeId: 'old' }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnect) => { disconnect = listener; return { close() {} }; } },
    daemon: { shutdown: quit }, lifecycle: { requestExit: quit },
  } as unknown as KodaXRuntime;
  const connect = vi.fn(async () => first);
  const runtime = createRecoveringRuntimeClient(first, connect);
  try {
    const client = toKodaXProductClient(runtime);
    if (action === 'shutdown') await client.host.shutdown();
    else await client.lifecycle.requestExit({ requestId: 'quit', shutdownHost: true });
    expect(connect).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it.each(['disposed', 'unavailable', 'authority'])('keeps observation %s explicit across Host replacement', async behavior => {
  let disconnect!: (state: RuntimeConnectionState) => void;
  let resolveObservation!: (value: { close(): void }) => void;
  const view = { runs: [{ runId: 'r', phase: 'recovering' }] } as unknown as ClientSessionView;
  const first = { identity: { runtimeId: 'old' }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnect) => { disconnect = listener; return { close() {} }; } },
    sessions: { observeView: async () => ({ close() {} }) },
  } as unknown as KodaXRuntime;
  const remoteClose = vi.fn();
  const next = { identity: { runtimeId: 'new' }, close: async () => {},
    sessions: { observeView: vi.fn(async (_id: string, deliver: (value: ClientSessionView) => void, options: { onStatus: (status: { state: 'live' }) => void }) => {
      if (behavior === 'unavailable') throw new Error('Session removed');
      if (behavior === 'disposed') return new Promise<{ close(): void }>(resolve => { resolveObservation = resolve; });
      deliver(view); options.onStatus({ state: 'live' }); return { close: remoteClose };
    }), getSettings: async () => ({}) },
    runs: { get: async () => ({ sessionId: 's', phase: 'recovering', contextRecovery: { checkpoint: {} } }) },
  } as unknown as KodaXRuntime;
  const runtime = createRecoveringRuntimeClient(first, async () => next, async () => { throw new Error('Authority unavailable'); });
  const onStatus = vi.fn();
  const subscription = await runtime.sessions.observeView('s', () => {}, { onStatus });
  try {
    disconnect({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old', code: 'protocol_closed', reconnectable: true });
    await vi.waitFor(() => expect(next.sessions.observeView).toHaveBeenCalled());
    if (behavior === 'disposed') {
      subscription.close(); resolveObservation({ close: remoteClose });
      await vi.waitFor(() => expect(remoteClose).toHaveBeenCalledOnce());
    } else await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: behavior === 'authority' ? 'interrupted' : 'closed' })));
  } finally { subscription.close(); await runtime.close(); }
});

it.each(['stop', 'cancel', 'missing-checkpoint', 'missing-authority', 'invalid-frame', 'mutation'])
('preserves the %s boundary during reconnection', async boundary => {
  let disconnect!: (value: RuntimeConnectionState) => void;
  let connectNow!: (runtime: KodaXRuntime) => void;
  let phase = 'recovering';
  const loss = Object.assign(new Error('lost'), { code: 'protocol_closed' });
  const submit = vi.fn(async () => { throw loss; });
  const recover = vi.fn();
  const first = { identity: { runtimeId: 'old' }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnect) => { disconnect = listener; return { close() {} }; } },
    runs: { acceptInput: submit }, sessions: { cancel: vi.fn() },
  } as unknown as KodaXRuntime;
  const next = { identity: { runtimeId: 'new' }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: () => ({ close() {} }) },
    sessions: { getSettings: async () => ({}), cancel: vi.fn(async () => { phase = 'cancelled'; return {}; }) },
    runs: { get: async () => ({ sessionId: 's', phase, ...(boundary === 'missing-checkpoint' ? {} : { contextRecovery: { checkpoint: {} } }) }),
      abort: vi.fn(async () => { phase = 'cancelled'; return true; }), recover,
      await: async () => ({ runId: 'r', sessionId: 's', phase: phase === 'recovering' ? 'interrupted' : phase }) },
  } as unknown as KodaXRuntime;
  const connect = vi.fn(() => new Promise<KodaXRuntime>(resolve => { connectNow = resolve; }));
  const runtime = createRecoveringRuntimeClient(first, connect, async () => { throw new Error('New authorization unavailable'); });
  try {
    if (boundary === 'mutation') {
      await expect(toKodaXProductClient(runtime).inputs.submit({ sessionId: 's', inputId: 'i', text: 'Do it once' })).rejects.toThrow('lost');
      expect(submit).toHaveBeenCalledTimes(1); expect(connect).not.toHaveBeenCalled(); return;
    }
    disconnect({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old',
      code: boundary === 'invalid-frame' ? 'invalid_frame' : 'protocol_closed', reconnectable: true });
    if (boundary === 'invalid-frame') { expect(connect).not.toHaveBeenCalled(); return; }
    await vi.waitFor(() => expect(connectNow).toBeTypeOf('function'));
    const stop = boundary === 'stop' ? runtime.runs.abort('r') : boundary === 'cancel'
      ? runtime.sessions.cancel({ sessionId: 's', requestId: 'cancel', expectedRunId: 'r' }) : undefined;
    connectNow(next);
    await stop;
    const outcome = runtime.runs.await('r');
    if (boundary === 'missing-authority') await expect(outcome).rejects.toThrow('New authorization unavailable');
    else expect((await outcome).phase).toBe(boundary === 'missing-checkpoint' ? 'interrupted' : 'cancelled');
    expect(recover).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('reopens REPL observations with a complete Host snapshot, recovers once, and ignores late old-Host deliveries', async () => {
  let disconnect!: (value: RuntimeConnectionState) => void;
  const views = ['old', 'new', 'late-old'].map(text => ({ session: { id: 's' }, items: [{ id: text, text }],
    runs: [{ runId: 'run', phase: 'recovering' }], interactions: [], queue: [], settings: {} }) as unknown as ClientSessionView);
  let oldDelivery!: (view: ClientSessionView) => void;
  const first = { identity: { runtimeId: 'old' }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnect) => { disconnect = listener; return { close() {} }; } },
    sessions: { observeView: async (_id: string, deliver: typeof oldDelivery) => { oldDelivery = deliver; deliver(views[0]!); return { close() {} }; } },
  } as unknown as KodaXRuntime;
  const recover = vi.fn(async () => ({ runId: 'run', sessionId: 's' }));
  const closeObservation = vi.fn();
  const next = { identity: { runtimeId: 'new' }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: () => ({ close() {} }) },
    sessions: { observeView: async (_id: string, deliver: typeof oldDelivery) => { deliver(views[1]!); return { close: closeObservation }; }, getSettings: async () => ({}) },
    runs: { get: async () => ({ sessionId: 's', phase: 'recovering', contextRecovery: { checkpoint: {} } }), recover },
  } as unknown as KodaXRuntime;
  const runtime = createRecoveringRuntimeClient(first, async () => next);
  const plane = createCliClientPlane(toKodaXProductClient(runtime));
  const delivered: ClientSessionView[] = [];
  const close = await plane.observe('s', view => delivered.push(view));
  try {
    disconnect({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old', code: 'protocol_closed', reconnectable: true });
    await vi.waitFor(() => expect(delivered.at(-1)?.items[0]?.text).toBe('new'));
    oldDelivery(views[2]!);
    expect(delivered.map(view => view.items[0]?.text)).toEqual(['old', 'new']);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    close();
    expect(closeObservation).toHaveBeenCalledTimes(1);
  } finally { close(); await runtime.close(); }
});

it('automatically resumes the same CLI Run with fresh authorization after Host replacement without submitting its input again', async () => {
  let disconnected!: (value: RuntimeConnectionState) => void;
  let rejectAwait!: (error: Error) => void;
  const loss = Object.assign(new Error('Host exited'), { code: 'protocol_closed', reconnectable: true });
  const first = {
    identity: { runtimeId: 'old' },
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnected) => {
      disconnected = listener; return { close() {} };
    } },
    close: vi.fn(async () => {}),
    runs: { await: () => new Promise((_resolve, reject) => { rejectAwait = reject; }) },
  } as unknown as KodaXRuntime;
  const recover = vi.fn(async () => ({ runId: 'original', sessionId: 'session' }));
  const submit = vi.fn();
  const next = {
    identity: { runtimeId: 'new' },
    connection: { current: () => ({ state: 'connected' }), subscribe: () => ({ close() {} }) },
    close: vi.fn(async () => {}),
    sessions: { getSettings: async () => ({ provider: 'deepseek' }) },
    runs: { get: async () => ({ runId: 'original', sessionId: 'session', phase: 'recovering', contextRecovery: { checkpoint: {} } }),
      recover, acceptInput: submit, await: async () => ({ runId: 'original', sessionId: 'session', phase: 'completed' }) },
  } as unknown as KodaXRuntime;
  const connect = vi.fn(async () => next);
  const authorize = vi.fn(async () => ({ credential: { leaseId: 'fresh', mode: 'scoped' as const, providers: ['deepseek'] } }));
  const runtime = createRecoveringRuntimeClient(first, connect, authorize);
  const result = toKodaXProductClient(runtime).runs.await('original');
  await vi.waitFor(() => expect(rejectAwait).toBeTypeOf('function'));
  disconnected({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old', code: 'protocol_closed', reconnectable: true });
  rejectAwait(loss);
  try {
    expect(await result).toMatchObject({ runId: 'original', phase: 'completed' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith({ kind: 'recovery', input: { sessionId: 'session', runId: 'original' } },
      expect.objectContaining({ identity: next.identity, createExecutionProfile: expect.any(Function) }));
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ runId: 'original', authorization: { credential: {
      leaseId: 'fresh', mode: 'scoped', providers: ['deepseek'],
    } } }));
    expect(submit).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});
