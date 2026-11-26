import { describe, expect, it } from 'vitest';
import { createRuntimeDaemonClient, type RuntimeDaemonClientTransport, type RuntimeDaemonTransportLifecycleState } from './client.js';
import { createRuntimeDaemonNotification, type RuntimeDaemonNotification } from './protocol.js';

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

describe('daemon subscription lifecycle', () => {
  it('terminates workflow observers on disconnect', async () => {
    const { client, disconnect, emit } = fixture();
    const errors: unknown[] = [];
    const events: unknown[] = [];
    const workflow = client.workflows.subscribe({}, (event) => events.push(event), (error) => errors.push(error));
    await workflow.ready;
    disconnect();
    expect(errors).toHaveLength(1);
    emit({ eventId: 'late' });
    expect(events).toEqual([]);
    workflow.close();
  });
  it('rejects readiness on early close and releases a late registration once', async () => {
    let register!: (value: unknown) => void;
    const { client, calls, emit } = fixture(new Promise((resolve) => { register = resolve; }));
    const events: unknown[] = [];
    const workflow = client.workflows.subscribe({}, (event) => events.push(event));
    workflow.close();
    workflow.close();
    await expect(workflow.ready).rejects.toThrow('Subscription closed before registration completed.');
    register({ subscriptionId: 'subscription-1' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    emit({ eventId: 'late' });
    expect(events).toEqual([]);
    expect(calls.filter((method) => method === 'workflow.unsubscribe')).toHaveLength(1);
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
  it('requires the subscription guarantee on old Hosts without issuing a subscription RPC', async () => {
    const { client, calls } = fixture(undefined, false);
    const workflow = client.workflows.subscribe({}, () => undefined);
    await expect(workflow.ready).rejects.toMatchObject({ code: 'daemon_upgrade_required', capability: 'subscriptionLifecycle' });
    expect(calls).toEqual([]);
    workflow.close();
  });
});
