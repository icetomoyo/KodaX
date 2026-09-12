import { expect, it } from 'vitest';
import { setKodaXDiagnosticSink } from '@kodax-ai/agent';
import { observeDaemonSessionView, type RuntimeDaemonClientTransport, type RuntimeDaemonTransportLifecycleState } from './client.js';
import { createRuntimeDaemonNotification, type RuntimeDaemonNotification } from './protocol.js';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';

it('reports idle interruption, fresh-view recovery and terminal closure to the consumer', async () => {
  const transport = createFakeTransport();
  const events: string[] = [];
  const observation = await observeDaemonSessionView(transport, 'session',
    (snapshot) => events.push(snapshot.items[0]!.text), {
      onStatus: (status) => events.push(status.state === 'closed' ? `${status.state}:${status.reason}` : status.state),
    });
  expect(events).toEqual(['view-1', 'live']);
  transport.lifecycle(disconnected('gen-1'));
  expect(events.at(-1)).toBe('interrupted');
  transport.plan({ kind: 'fail' });
  transport.plan({ kind: 'ok', text: 'fresh' });
  transport.lifecycle(connected('gen-2'));
  expect(events.at(-1)).toBe('interrupted');
  await expect.poll(() => events.slice(-2), { timeout: 4000 }).toEqual(['fresh', 'live']);
  transport.lifecycle({ state: 'disconnected', connectionId: 'gen-2', reconnectable: false });
  expect(events.at(-1)).toBe('closed:unavailable');
  observation.close();
  expect(events.filter((event) => event.startsWith('closed:'))).toEqual(['closed:unavailable']);
});

it('reports intentional observation closure separately', async () => {
  const events: string[] = [];
  const observation = await observeDaemonSessionView(createFakeTransport(), 'session', () => undefined, {
    onStatus: (status) => events.push(status.state === 'closed' ? status.reason : status.state),
  });
  observation.close();
  observation.close();
  expect(events).toEqual(['live', 'client']);
});

type LifecycleListener = (state: RuntimeDaemonTransportLifecycleState) => void;
type NotificationListener = (notification: RuntimeDaemonNotification) => void;
type ObserveOutcome = { kind: 'ok'; text: string } | { kind: 'fail' };

interface FakeTransport extends RuntimeDaemonClientTransport {
  readonly lifecycle: (state: RuntimeDaemonTransportLifecycleState) => void;
  readonly notify: (notification: RuntimeDaemonNotification) => void;
  readonly observeCount: () => number;
  readonly subscriptionId: () => string | undefined;
  readonly plan: (outcome: ObserveOutcome) => void;
}

function view(text: string): ClientSessionView {
  return {
    session: { id: 'session', title: 'Resubscribe' },
    settings: {},
    items: [{ id: `item-${text}`, type: 'info', text }],
    queue: [], interactions: [], runs: [],
  };
}

function createFakeTransport(): FakeTransport {
  let notificationListener: NotificationListener | undefined;
  let lifecycleListener: LifecycleListener | undefined;
  let observeCalls = 0;
  let subscriptionId: string | undefined;
  const outcomes: ObserveOutcome[] = [];
  const nextOutcome = (): ObserveOutcome => ({ kind: 'ok', text: `view-${observeCalls}` });
  const transport: FakeTransport = {
    request(method, params) {
      if (method === 'session.view.observe') {
        observeCalls += 1;
        if (typeof params === 'object' && params !== null && 'subscriptionId' in params) {
          subscriptionId = String((params as { subscriptionId: unknown }).subscriptionId);
        }
        const outcome = outcomes.shift() ?? nextOutcome();
        if (outcome.kind === 'fail') return Promise.reject(new Error('observe failed'));
        return Promise.resolve({ view: view(outcome.text) });
      }
      return Promise.resolve({ ok: true });
    },
    subscribe(listener) {
      notificationListener = listener;
      return { close: () => { notificationListener = undefined; } };
    },
    subscribeLifecycle(listener) {
      lifecycleListener = listener;
      // A connected transport reports its initial generation synchronously,
      // before the first observe round trip — the real transports do too.
      listener(connected('gen-1'));
      return { close: () => { lifecycleListener = undefined; } };
    },
    lifecycle(state) { lifecycleListener?.(state); },
    notify(notification) { notificationListener?.(notification); },
    observeCount: () => observeCalls,
    subscriptionId: () => subscriptionId,
    plan: (outcome) => { outcomes.push(outcome); },
  };
  return transport;
}

const connected = (id: string): RuntimeDaemonTransportLifecycleState => ({ state: 'connected', connectionId: id, reconnectable: true });
const disconnected = (id: string): RuntimeDaemonTransportLifecycleState => ({ state: 'disconnected', connectionId: id, reconnectable: true });

it('recovers the observation by retrying on the healthy current connection', async () => {
  const transport = createFakeTransport();
  const views: ClientSessionView[] = [];
  const observation = await observeDaemonSessionView(transport, 'session', (view) => views.push(view));
  try {
    transport.lifecycle(disconnected('gen-1'));
    // The first observe on the recovered connection fails; the connection
    // itself stays healthy and no further lifecycle event ever fires —
    // only a scheduled retry on the current connection can recover.
    transport.plan({ kind: 'fail' });
    transport.plan({ kind: 'ok', text: 'recovered' });
    transport.lifecycle(connected('gen-2'));
    await expect.poll(() => views.at(-1)?.items[0]?.text, { timeout: 4000 }).toBe('recovered');
    expect(transport.observeCount()).toBe(3);
    // The recovered subscription delivers live updates again.
    transport.notify(createRuntimeDaemonNotification('session.view', {
      subscriptionId: transport.subscriptionId(),
      view: view('live-update'),
    }));
    await expect.poll(() => views.at(-1)?.items[0]?.text, { timeout: 2000 }).toBe('live-update');
  } finally {
    observation.close();
  }
});

it.each([true, false])('cancels an in-flight resubscribe before/after the new generation becomes live (%s)', async (settleBeforeReconnect) => {
  const transport = createFakeTransport();
  const views: ClientSessionView[] = [];
  const observation = await observeDaemonSessionView(transport, 'session', (view) => views.push(view));
  try {
    transport.lifecycle(disconnected('gen-1'));
    // The generation-2 observe hangs; while it hangs the transport cycles to
    // generation 3. Its late resolution must be discarded, never delivered.
    const originalRequest = transport.request.bind(transport);
    let gateObserve: ((value: unknown) => void) | undefined;
    let gated = false;
    transport.request = ((method: string, ...rest: unknown[]) => {
      if (method === 'session.view.observe' && !gated) {
        gated = true;
        return new Promise((resolve) => { gateObserve = resolve; });
      }
      return (originalRequest as (method: string, ...rest: unknown[]) => Promise<unknown>)(method, ...rest);
    }) as typeof transport.request;
    transport.lifecycle(connected('gen-2'));
    await expect.poll(() => gated, { timeout: 2000 }).toBe(true);
    transport.lifecycle(disconnected('gen-2'));
    if (settleBeforeReconnect) {
      gateObserve?.({ view: view('late-gen2') });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(views.some((view) => view.items[0]?.text === 'late-gen2')).toBe(false);
    }
    transport.plan({ kind: 'ok', text: 'gen3-fresh' });
    transport.lifecycle(connected('gen-3'));
    await expect.poll(() => views.at(-1)?.items[0]?.text, { timeout: 4000 }).toBe('gen3-fresh');
    if (!settleBeforeReconnect) gateObserve?.({ view: view('late-gen2') });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(views.some((view) => view.items[0]?.text === 'late-gen2')).toBe(false);
  } finally {
    observation.close();
  }
});

it('detaches explicitly after exhausting bounded retries on one connection', async () => {
  const transport = createFakeTransport();
  const diagnostics: { message: string }[] = [];
  const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
  const statuses: string[] = [];
  const observation = await observeDaemonSessionView(transport, 'session', () => undefined, {
    onStatus: (status) => statuses.push(status.state === 'closed' ? status.reason : status.state),
  });
  try {
    transport.lifecycle(disconnected('gen-1'));
    transport.plan({ kind: 'fail' });
    transport.plan({ kind: 'fail' });
    transport.plan({ kind: 'fail' });
    transport.lifecycle(connected('gen-2'));
    await expect.poll(() => transport.observeCount(), { timeout: 4000 }).toBe(4);
    await expect.poll(() => diagnostics.some((diagnostic) =>
      diagnostic.message.includes('could not reopen')), { timeout: 2000 }).toBe(true);
    const settled = transport.observeCount();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(transport.observeCount()).toBe(settled);
    expect(statuses).toEqual(['live', 'interrupted', 'unavailable']);
  } finally {
    restore();
    observation.close();
  }
});

it('never delivers a stale pre-reconnect snapshot as the recovered state', async () => {
  const transport = createFakeTransport();
  const views: ClientSessionView[] = [];
  const observation = await observeDaemonSessionView(transport, 'session', (view) => views.push(view));
  try {
    transport.lifecycle(disconnected('gen-1'));
    // A late notification from the dead connection parks a stale view while
    // the observation is not ready; it must never surface after recovery.
    transport.notify(createRuntimeDaemonNotification('session.view', {
      subscriptionId: transport.subscriptionId(),
      view: view('stale-snapshot'),
    }));
    transport.plan({ kind: 'ok', text: 'fresh-snapshot' });
    transport.lifecycle(connected('gen-2'));
    await expect.poll(() => views.at(-1)?.items[0]?.text, { timeout: 4000 }).toBe('fresh-snapshot');
    expect(views.some((view) => view.items[0]?.text === 'stale-snapshot')).toBe(false);
  } finally {
    observation.close();
  }
});
