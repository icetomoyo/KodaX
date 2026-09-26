import { expect, it } from 'vitest';
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import { createRuntimeDaemonClient, type RuntimeDaemonClientTransport } from './client.js';

it.each(['before', 'after'] as const)('reports failed event cleanup when closed %s registration', async timing => {
  let registered!: (value: unknown) => void;
  const registration = new Promise<unknown>(resolve => { registered = resolve; });
  const failure = new Error('isolated subscription release failed');
  const diagnostics: KodaXDiagnostic[] = [];
  const restore = setKodaXDiagnosticSink(diagnostic => diagnostics.push(diagnostic));
  let closes = 0;
  const transport: RuntimeDaemonClientTransport = {
    async request(method) {
      if (method === 'session.observe') return registration;
      if (method === 'subscription.close') { closes += 1; throw failure; }
      throw new Error(`Unexpected request: ${method}`);
    },
    subscribe() { return { close() {} }; },
  };
  const client = createRuntimeDaemonClient({ transport, identity: {
    runtimeId: 'cleanup-fixture', mode: 'embedded', profile: 'test',
    startedAt: '2026-09-26T00:00:00Z', version: 'test',
  } });
  try {
    const subscription = client.events.subscribe({ sessionId: 'session' }, () => undefined);
    if (timing === 'before') subscription.close();
    registered({ subscriptionId: 'late-subscription' });
    await subscription.ready;
    subscription.close();
    await expect.poll(() => diagnostics.some(item => item.message.includes('Failed to close a remote Session'))).toBe(true);
    expect(closes).toBe(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: 'warn', detail: failure }));
  } finally { restore(); }
});
