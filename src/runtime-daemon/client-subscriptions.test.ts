import { describe, expect, it } from 'vitest';
import { createRuntimeDaemonClient, type RuntimeDaemonClientTransport, type RuntimeDaemonTransportLifecycleState } from './client.js';
import { createRuntimeDaemonNotification, type RuntimeDaemonNotification } from './protocol.js';
import { createReplLearningBinding } from '../repl-learning-binding.js';

function fixture(handshake: Promise<unknown> = Promise.resolve({ subscriptionId: 'subscription-1' }), supported = true) {
  const notifications = new Set<(event: RuntimeDaemonNotification) => void>();
  const lifecycle = new Set<(state: RuntimeDaemonTransportLifecycleState) => void>();
  const calls: string[] = [];
  const transport: RuntimeDaemonClientTransport = {
    async request(method) {
      calls.push(method);
      if (method.endsWith('.subscribe')) return handshake;
      return {};
    },
    subscribe(listener) { notifications.add(listener); return { close() { notifications.delete(listener); } }; },
    subscribeLifecycle(listener) { lifecycle.add(listener); return { close() { lifecycle.delete(listener); } }; },
  };
  const client = createRuntimeDaemonClient({ transport, capabilities: supported ? { subscriptionLifecycle: { version: 1, errorNotifications: true } } : {}, identity: {
    runtimeId: 'subscriptions', mode: 'embedded', profile: 'test', startedAt: '2026-09-26T00:00:00Z', version: 'test',
  } });
  return { client, calls,
    disconnect() { for (const listener of [...lifecycle]) listener({ state: 'disconnected', connectionId: 'one', reconnectable: true }); },
    emit(event: unknown) { for (const listener of [...notifications]) listener(createRuntimeDaemonNotification('event', { subscriptionId: 'subscription-1', event })); },
    fail(message: string) { for (const listener of [...notifications]) listener(createRuntimeDaemonNotification('subscription.error', { subscriptionId: 'subscription-1', message })); },
  };
}

async function settled<T>(promise: Promise<T>) {
  return Promise.race([
    promise.then((value) => ({ status: 'fulfilled', value }), (error: unknown) => ({ status: 'rejected', error })),
    new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 30)),
  ]);
}

describe('daemon subscription lifecycle', () => {
  it('retains a failed handshake for next called after the failure', async () => {
    const failure = new Error('registration failed');
    const { client } = fixture(Promise.reject(failure));
    const iterator = client.learning.subscribe()[Symbol.asyncIterator]();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(await settled(iterator.next())).toEqual({ status: 'rejected', error: failure });
    await iterator.return?.();
  });
  it('delivers concurrent next calls FIFO and closes every remaining waiter', async () => {
    const { client, emit } = fixture();
    const iterator = client.learning.subscribe()[Symbol.asyncIterator]();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const first = iterator.next();
    const second = iterator.next();
    emit({ eventId: 'one' });
    expect(await settled(first)).toEqual({ status: 'fulfilled', value: { done: false, value: { eventId: 'one' } } });
    const third = iterator.next();
    await iterator.return?.();
    expect(await settled(second)).toEqual({ status: 'fulfilled', value: { done: true, value: undefined } });
    expect(await settled(third)).toEqual({ status: 'fulfilled', value: { done: true, value: undefined } });
  });
  it('terminates learning waiters and workflow observers on disconnect', async () => {
    const { client, disconnect, emit } = fixture();
    const iterator = client.learning.subscribe()[Symbol.asyncIterator]();
    const errors: unknown[] = [];
    const events: unknown[] = [];
    const workflow = client.workflows.subscribe({}, (event) => events.push(event), (error) => errors.push(error));
    await workflow.ready;
    const pending = settled(iterator.next());
    disconnect();
    expect((await pending).status).toBe('rejected');
    expect(errors).toHaveLength(1);
    emit({ eventId: 'late' });
    expect(events).toEqual([]);
    expect((await settled(iterator.next())).status).toBe('rejected');
    await iterator.return?.();
    workflow.close();
  });
  it('settles ready and next on early return, and cleans up a late handshake once', async () => {
    let register!: (value: unknown) => void;
    const { client, calls, emit } = fixture(new Promise((resolve) => { register = resolve; }));
    const stream = client.learning.subscribe();
    expect(stream.ready).toBeInstanceOf(Promise);
    const ready = settled(stream.ready);
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await iterator.return?.();
    await iterator.return?.();
    expect((await ready).status).toBe('rejected');
    expect(await pending).toEqual({ done: true, value: undefined });
    register({ subscriptionId: 'subscription-1' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    emit({ eventId: 'late' });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(calls.filter((method) => method === 'learning.unsubscribe')).toHaveLength(1);
  });
  it('exposes readiness and observation errors through the production REPL binding', async () => {
    const { client, disconnect } = fixture();
    const errors: unknown[] = [];
    const binding = createReplLearningBinding(client);
    const subscription = binding.subscribe(() => undefined, undefined, (error) => errors.push(error));
    expect(subscription.ready).toBeInstanceOf(Promise);
    await subscription.ready;
    disconnect();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    subscription.close();
  });
  it('retains a Host error arriving before the registration acknowledgement', async () => {
    let register!: (value: unknown) => void;
    const { client, fail } = fixture(new Promise((resolve) => { register = resolve; }));
    const stream = client.learning.subscribe();
    const pending = settled(stream.next());
    fail('backend failed during handshake');
    register({ subscriptionId: 'subscription-1' });
    await expect(stream.ready).rejects.toThrow('backend failed during handshake');
    expect(await pending).toMatchObject({ status: 'rejected', error: { message: 'backend failed during handshake' } });
    await expect(stream.next()).rejects.toThrow('backend failed during handshake');
    await stream.return?.();
  });
  it('rejects workflow readiness when the Host terminates observation before acknowledging registration', async () => {
    let register!: (value: unknown) => void;
    const { client, fail } = fixture(new Promise((resolve) => { register = resolve; }));
    const errors: unknown[] = [];
    const workflow = client.workflows.subscribe({}, () => undefined, (error) => errors.push(error));
    fail('workflow backend failed during handshake');
    register({ subscriptionId: 'subscription-1' });
    await expect(workflow.ready).rejects.toThrow('workflow backend failed during handshake');
    expect(errors).toHaveLength(1);
    workflow.close();
  });
  it('retains undefined failures for every waiter until explicit return', async () => {
    const { client } = fixture(Promise.reject(undefined));
    const stream = client.learning.subscribe();
    const first = settled(stream.next());
    const second = settled(stream.next());
    expect(await first).toEqual({ status: 'rejected', error: undefined });
    expect(await second).toEqual({ status: 'rejected', error: undefined });
    expect(await settled(stream.ready)).toEqual({ status: 'rejected', error: undefined });
    expect(await settled(stream.next())).toEqual({ status: 'rejected', error: undefined });
    await stream.return?.();
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });
  it('requires the subscription guarantee on old Hosts without issuing a subscription RPC', async () => {
    const { client, calls } = fixture(undefined, false);
    const stream = client.learning.subscribe();
    await expect(stream.ready).rejects.toMatchObject({ code: 'daemon_upgrade_required', capability: 'subscriptionLifecycle' });
    await expect(stream.next()).rejects.toMatchObject({ code: 'daemon_upgrade_required' });
    const workflow = client.workflows.subscribe({}, () => undefined);
    await expect(workflow.ready).rejects.toMatchObject({ code: 'daemon_upgrade_required' });
    expect(calls).toEqual([]);
    await stream.return?.();
    workflow.close();
  });
});
