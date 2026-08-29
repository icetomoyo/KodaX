import { describe, expect, it } from 'vitest';
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import { KODAX_VERSION } from '@kodax-ai/repl';

import type {
  RuntimeEvent,
  RuntimeConnectionState,
  RuntimeSubscription,
} from '../sdk-runtime.js';
import {
  createRuntimeDaemonNotification,
  type RuntimeDaemonNotification,
} from './protocol.js';
import {
  createRuntimeDaemonClient,
  type RuntimeDaemonClientTransport,
  type RuntimeDaemonTransportLifecycleState,
} from './client.js';

const RUN_LIFECYCLE_CAPABILITIES = {
  runLifecycleControl: {
    version: 1,
    structuredStopReceipt: true,
    protocolCancellation: true,
    responseAcknowledgement: true,
  },
} as const;

describe('runtime daemon client proxy', () => {
  it('sends a stable compact operation in the envelope, never in params', async () => {
    let captured: {
      readonly params?: unknown;
      readonly operation?: { readonly operationId: string; readonly journalEpoch: string };
    } | undefined;
    const transport: RuntimeDaemonClientTransport = {
      async request(method, params, operation) {
        if (method === 'session.compact') captured = { params, operation };
        return { compacted: false, reason: 'below threshold' };
      },
      subscribe() {
        return { close() {} };
      },
    };
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-compact-operation',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-08-29T00:00:00.000Z',
        version: '0.7.96',
      },
      journalEpoch: 'journal-1',
      transport,
    });

    await client.sessions.compact({
      sessionId: 'session-1',
      triggerPercent: 75,
      triggerTokens: 150_000,
      operation: { operationId: 'compact-op-1', journalEpoch: 'journal-1' },
    });

    expect(captured).toEqual({
      params: {
        sessionId: 'session-1',
        triggerPercent: 75,
        triggerTokens: 150_000,
      },
      operation: {
        operationId: 'compact-op-1',
        journalEpoch: 'journal-1',
      },
    });
  });

  it('keeps Agent credential binding host-only and sends its operation in the envelope', async () => {
    let captured: {
      readonly params?: unknown;
      readonly operation?: { readonly operationId: string; readonly journalEpoch: string };
    } | undefined;
    const transport: RuntimeDaemonClientTransport = {
      async request(method, params, operation) {
        if (method === 'agents.spawn') captured = { params, operation };
        return { actorPath: '/root/reviewer', turnId: 'turn-1', state: 'accepted' };
      },
      subscribe() {
        return { close() {} };
      },
    };
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-agent-operation',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-08-29T00:00:00.000Z',
        version: '0.7.96',
      },
      transport,
      journalEpoch: 'journal-agent',
      capabilities: {
        actorControlPlane: { version: 1, methodNamespace: 'agents' },
      },
    });

    await client.agents.spawn('session-1', {
      taskName: 'reviewer',
      objective: 'Review the change.',
      capabilities: { providers: ['openai'] },
    }, {
      credential: {
        leaseId: 'lease-1',
        mode: 'scoped',
        providers: ['openai'],
      },
      operation: { operationId: 'agent-op-1' },
    });

    expect(captured).toEqual({
      params: {
        sessionId: 'session-1',
        input: {
          taskName: 'reviewer',
          objective: 'Review the change.',
          capabilities: { providers: ['openai'] },
        },
        credential: {
          leaseId: 'lease-1',
          mode: 'scoped',
          providers: ['openai'],
        },
      },
      operation: {
        operationId: 'agent-op-1',
        journalEpoch: 'journal-agent',
      },
    });
    expect(JSON.stringify((captured?.params as { input?: unknown }).input)).not.toContain('credential');
    await client.close();
  });

  it('shares concurrent close attempts and retries a transient transport failure', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const base = fakeTransport(calls);
    let closeCalls = 0;
    let releaseFirstClose: (() => void) | undefined;
    const firstCloseGate = new Promise<void>((resolve) => {
      releaseFirstClose = resolve;
    });
    const transport: RuntimeDaemonClientTransport = {
      ...base,
      async close() {
        closeCalls += 1;
        if (closeCalls === 1) {
          await firstCloseGate;
          throw new Error('transient transport close failure');
        }
      },
    };
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-close-retry',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-28T00:00:00.000Z',
        version: '0.7.78',
      },
      transport,
    });

    const first = client.close();
    const concurrent = client.close();
    expect(concurrent).toBe(first);
    releaseFirstClose?.();
    await expect(Promise.all([first, concurrent])).rejects.toThrow(
      'transient transport close failure',
    );
    expect(closeCalls).toBe(1);

    await expect(client.close()).resolves.toBeUndefined();
    expect(closeCalls).toBe(2);
    await expect(client.close()).resolves.toBeUndefined();
    expect(closeCalls).toBe(2);
  });

  it('requires an advertised Actor control plane before issuing Actor RPCs', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-old-daemon',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: '0.7.71',
      },
      transport: fakeTransport(calls),
      capabilities: {},
    });

    await expect(client.agents.tree('session-1')).rejects.toMatchObject({
      code: 'daemon_upgrade_required',
      capability: 'actorControlPlane',
      restartRequired: true,
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects an Actor control plane with the wrong method namespace', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-wrong-actor-namespace',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: '0.7.72',
      },
      transport: fakeTransport(calls),
      capabilities: {
        actorControlPlane: { version: 1, methodNamespace: 'legacy-agents' },
      },
    });

    await expect(client.agents.tree('session-1')).rejects.toMatchObject({
      code: 'daemon_upgrade_required',
      capability: 'actorControlPlane',
    });
    expect(calls).toHaveLength(0);
  });

  it('requires an upgraded daemon before Stop or cancellable reads', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-old-lifecycle-daemon',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: '0.7.78',
      },
      transport: fakeTransport(calls),
      capabilities: {},
    });

    await expect(client.runs.abort('run-1')).rejects.toMatchObject({
      code: 'daemon_upgrade_required',
      capability: 'runLifecycleControl',
      restartRequired: true,
    });
    await expect(
      client.sessions.transcript('session-1', { timeoutMs: 10 }),
    ).rejects.toMatchObject({
      code: 'daemon_upgrade_required',
      capability: 'runLifecycleControl',
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a legacy unconditional Stop success as an invalid receipt', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-misadvertised-lifecycle-daemon',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: '0.7.78',
      },
      transport: fakeTransport(calls, {
        runAbortResult: { ok: true },
      }),
      capabilities: RUN_LIFECYCLE_CAPABILITIES,
    });

    await expect(client.runs.abort('run-1')).rejects.toMatchObject({
      code: 'daemon_upgrade_required',
      capability: 'runLifecycleControl',
    });
    expect(calls).toEqual([
      { method: 'run.abort', params: { runId: 'run-1' } },
    ]);
  });

  it('accepts compatible newer lifecycle capabilities and rejects mismatched Stop receipts', async () => {
    const acceptedCalls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const acceptedClient = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-lifecycle-v2',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-30T00:00:00.000Z',
        version: '0.7.79',
      },
      transport: fakeTransport(acceptedCalls),
      capabilities: {
        runLifecycleControl: {
          ...RUN_LIFECYCLE_CAPABILITIES.runLifecycleControl,
          version: 2,
        },
      },
    });
    await expect(acceptedClient.runs.abort('run-1')).resolves.toMatchObject({
      runId: 'run-1',
      phase: 'completed',
    });

    const mismatchedClient = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-mismatched-stop',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-30T00:00:00.000Z',
        version: '0.7.79',
      },
      transport: fakeTransport([], {
        runAbortResult: {
          runId: 'run-other',
          sessionId: 'session-1',
          accepted: false,
          state: 'confirmed',
          outcome: 'completed',
          phase: 'completed',
          revision: 3,
        },
      }),
      capabilities: RUN_LIFECYCLE_CAPABILITIES,
    });
    await expect(mismatchedClient.runs.abort('run-1')).rejects.toMatchObject({
      code: 'daemon_upgrade_required',
      capability: 'runLifecycleControl',
    });
  });

  it('requires concrete permission scope capability before sending raw tool input', async () => {
    const oldCalls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const oldClient = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-old-permission-daemon',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: '0.7.72',
      },
      transport: fakeTransport(oldCalls),
      capabilities: {
        runtimeAutoModeGuardrail: { version: 2, owner: 'session-runtime' },
      },
    });

    await expect(oldClient.permissions.request({
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      toolInput: { command: 'npm test' },
    })).rejects.toMatchObject({
      code: 'daemon_upgrade_required',
      capability: 'runtimeAutoModeGuardrail',
      requiredVersion: 3,
      restartRequired: true,
    });
    expect(oldCalls).toHaveLength(0);

    const currentCalls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const currentClient = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-current-permission-daemon',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-20T00:00:00.000Z',
        version: '0.7.73',
      },
      transport: fakeTransport(currentCalls),
      capabilities: {
        runtimeAutoModeGuardrail: {
          version: 3,
          owner: 'session-runtime',
          concretePermissionMatchers: true,
          permissionGrantSuggestions: true,
        },
      },
    });
    await currentClient.permissions.request({
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      toolInput: { command: 'npm test' },
    });
    expect(currentCalls).toContainEqual({
      method: 'permission.request',
      params: {
        sessionId: 'session-1',
        runId: 'run-1',
        toolName: 'bash',
        toolInput: { command: 'npm test' },
      },
    });
  });

  it('rejects host-only run options instead of silently dropping them on the wire', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: '0.7.66',
      },
      transport: fakeTransport(calls),
    });

    await expect(client.runs.start({
      sessionId: 'session-1',
      options: {
        extensionRuntime: { activate: () => undefined },
      } as never,
    })).rejects.toMatchObject({
      code: 'invalid_transport_value',
      path: 'run.start.options.extensionRuntime.activate',
    });
    expect(calls).toHaveLength(0);
  });

  it('transports serializable Workflow host ceilings to the daemon', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: '0.7.72',
      },
      transport: fakeTransport(calls),
    });

    await client.runs.start({
      sessionId: 'session-1',
      prompt: 'explicit workflow request',
      options: {
        workflowHostPolicy: {
          maxAgents: 4,
          maxConcurrency: 2,
          tokenBudget: 50_000,
        },
      },
    });

    expect(calls[0]).toMatchObject({
      method: 'run.start',
      params: {
        options: {
          workflowHostPolicy: {
            maxAgents: 4,
            maxConcurrency: 2,
            tokenBudget: 50_000,
          },
        },
      },
    });
    await client.close();
  });

  it('exposes prompt daemon connection lifecycle and Runtime epochs', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-epoch-1',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
      journalEpoch: 'journal-epoch-1',
    });
    const seen: RuntimeConnectionState[] = [];

    const subscription = client.connection?.subscribe((state) => seen.push(state));
    transport.emitLifecycle({
      state: 'disconnected',
      connectionId: 'connection-1',
      reason: 'socket closed',
      reconnectable: true,
    });

    expect(client.connection?.current()).toMatchObject({
      state: 'disconnected',
      runtimeEpoch: 'runtime-epoch-1',
      journalEpoch: 'journal-epoch-1',
    });
    expect(seen.at(-1)).toMatchObject({ state: 'disconnected', reason: 'socket closed' });
    transport.emitLifecycle({
      state: 'connected',
      connectionId: 'connection-2',
      reconnectable: false,
    });
    await expect(client.diagnostics.latestProviderCacheDiagnostic({
      sessionId: 'session-1',
    })).resolves.toMatchObject({
      requestId: 'cache-latest',
      cachedReadTokens: 80,
    });
    expect(calls.at(-1)).toEqual({
      method: 'provider.cache.diagnostics.get',
      params: { sessionId: 'session-1' },
    });
    subscription?.close();
    await client.close();
  });

  it('maps typed daemon inspection and safe inline rollback without leaking operation metadata', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-management',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-15T00:00:00.000Z',
        version: '0.7.70',
      },
      transport: fakeTransport(calls),
    });

    const state = await client.daemon.inspect();
    expect(state.preflight.activeAgentTurns).toEqual([
      expect.objectContaining({ turnId: 'turn-legacy' }),
    ]);
    expect(state.preflight.activeAgentTasks).toBe(state.preflight.activeAgentTurns);
    const preflight = await client.status.preflight();
    expect(preflight.activeAgentTasks).toBe(preflight.activeAgentTurns);
    await expect(client.daemon.stopForInline({
      expectedRuntimeId: state.runtimeId,
      expectedRevision: state.revision,
      expectedOwnerPolicyRevision: state.ownerPolicy.revision,
      operation: { operationId: 'op-rollback' },
    })).resolves.toMatchObject({ accepted: true, ownerPolicy: { mode: 'inline' } });

    expect(calls).toEqual([
      { method: 'daemon.management.get', params: undefined },
      { method: 'daemon.preflight', params: undefined },
      {
        method: 'daemon.rollbackToInline',
        params: {
          expectedRuntimeId: 'runtime-management',
          expectedRevision: 4,
          expectedOwnerPolicyRevision: 2,
        },
      },
    ]);
    await client.close();
  });

  it('maps sessions and run handles onto daemon requests', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'embedded',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
      capabilities: RUN_LIFECYCLE_CAPABILITIES,
    });

    const session = await client.sessions.create({ title: 'From Client' });
    const handle = await client.runs.start({
      sessionId: session.id,
      prompt: 'hello daemon',
    });
    const result = await handle.result;
    const awaited = await client.runs.await(handle.runId);
    const stop = await client.runs.abort(handle.runId);

    expect(session).toMatchObject({ id: 'session-1', title: 'From Client' });
    expect(handle.runId).toBe('run-1');
    expect(result).toMatchObject({ runId: 'run-1', sessionId: 'session-1', phase: 'completed' });
    expect(awaited).toMatchObject({ runId: 'run-1', sessionId: 'session-1', phase: 'completed' });
    expect(stop).toEqual({
      runId: 'run-1',
      sessionId: 'session-1',
      accepted: false,
      state: 'confirmed',
      outcome: 'completed',
      phase: 'completed',
      revision: 3,
    });
    expect(calls.map((call) => call.method)).toEqual([
      'session.create',
      'run.start',
      'run.await',
      'run.await',
      'run.abort',
    ]);
  });

  it('routes daemon event notifications to matching local subscriptions', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'embedded',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
    });
    const seen: RuntimeEvent[] = [];

    const subscription = client.events.subscribe({ sessionId: 'session-1' }, (event) => {
      seen.push(event);
    });
    expect(subscription.ready).toBeInstanceOf(Promise);
    await subscription.ready;

    const event: RuntimeEvent = {
      id: 'evt-1',
      seq: 1,
      cursor: { sessionId: 'session-1', journalEpoch: 'epoch-session-1', seq: 1 },
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'assistant.delta',
      payload: { text: 'done' },
    };
    transport.emit(createRuntimeDaemonNotification('event', {
      subscriptionId: 'sub-1',
      event,
    }));
    subscription.close();

    expect(seen).toEqual([event]);
    expect(calls.map((call) => call.method)).toContain('event.subscribe');
    expect(calls.map((call) => call.method)).toContain('event.unsubscribe');
  });

  it('drops one malformed event without terminating the observation stream', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });
    const seen: RuntimeEvent[] = [];
    client.events.subscribe({ sessionId: 'session-1' }, (event) => seen.push(event));
    await Promise.resolve();

    transport.emit(createRuntimeDaemonNotification('event', {
      subscriptionId: 'sub-1',
      event: { type: 'assistant.delta', payload: { text: 42 } },
    }));
    const valid: RuntimeEvent = {
      id: 'evt-valid',
      seq: 2,
      cursor: { sessionId: 'session-1', journalEpoch: 'epoch-session-1', seq: 2 },
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'assistant.delta',
      payload: { text: 'continued' },
    };
    transport.emit(createRuntimeDaemonNotification('event', {
      subscriptionId: 'sub-1',
      event: valid,
    }));

    expect(seen).toEqual([valid]);
    await client.close();
  });

  it('drops malformed replay entries while retaining valid events', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const valid: RuntimeEvent = {
      id: 'evt-replay-valid',
      seq: 2,
      cursor: { sessionId: 'session-1', journalEpoch: 'epoch-session-1', seq: 2 },
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'assistant.delta',
      payload: { text: 'continued' },
    };
    const transport = fakeTransport(calls, {
      eventReplayResult: [{ type: 'assistant.delta', payload: { text: 42 } }, valid],
    });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });

    await expect(client.events.replay({ sessionId: 'session-1' })).resolves.toEqual([valid]);
    await client.close();
  });

  it('delivers notifications that arrive before subscribe resolves', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const event: RuntimeEvent = {
      id: 'evt-early',
      seq: 1,
      cursor: { sessionId: 'session-1', journalEpoch: 'epoch-session-1', seq: 1 },
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'assistant.delta',
      payload: { text: 'early' },
    };
    const transport = fakeTransport(calls, {
      notificationBeforeEventSubscribeResult: createRuntimeDaemonNotification('event', {
        subscriptionId: 'sub-1',
        event,
      }),
    });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
    });
    const seen: RuntimeEvent[] = [];

    client.events.subscribe({ sessionId: 'session-1' }, (item) => seen.push(item));
    await flushAsyncNotifications();

    expect(seen).toEqual([event]);
  });

  it('ignores unrelated subscription traffic during a session observation handshake', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    let resolveObservation!: (value: unknown) => void;
    const observationResult = new Promise<unknown>((resolve) => {
      resolveObservation = resolve;
    });
    const transport = fakeTransport(calls, { sessionObserveResult: observationResult });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });
    const observation = client.sessions.observe('session-target', () => undefined);
    for (let seq = 1; seq <= 300; seq += 1) {
      transport.emit(createRuntimeDaemonNotification('event', {
        subscriptionId: 'unrelated-subscription',
        event: {
          id: `evt-unrelated-${seq}`,
          seq,
          cursor: {
            sessionId: 'session-unrelated',
            journalEpoch: 'epoch-session-unrelated',
            seq,
          },
          time: '2026-07-09T00:00:00.000Z',
          sessionId: 'session-unrelated',
          runId: 'run-unrelated',
          type: 'run.progress',
          payload: {},
        },
      }));
    }
    resolveObservation({
      subscriptionId: 'observe-target',
      snapshot: {
        runtimeId: 'runtime-client',
        cursor: { sessionId: 'session-target', journalEpoch: 'epoch-session-target', seq: 0 },
        transcriptRevision: 'sha256:test',
        session: { id: 'session-target', title: 'Target' },
        transcript: null,
        settings: { revision: 0, value: {} },
        runs: [],
        pendingPermissions: [],
        live: {
          assistantTextByRun: {},
          thinkingTextByRun: {},
          activeTools: [],
          pendingUserInputs: [],
          managedTasks: [],
        },
      },
    });

    await expect(observation).resolves.toMatchObject({
      snapshot: { session: { id: 'session-target' } },
    });
    await client.close();
  });

  it('hands off the observation snapshot before events and invalidates on disconnect', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });
    const seen: RuntimeEvent[] = [];
    const observation = await client.sessions.observe(
      'session-1',
      (event) => seen.push(event),
    );
    const event: RuntimeEvent = {
      id: 'evt-after-snapshot',
      seq: 1,
      cursor: { sessionId: 'session-1', journalEpoch: 'epoch-session-1', seq: 1 },
      time: '2026-07-09T00:00:01.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'assistant.delta',
      payload: { text: 'after snapshot' },
    };

    transport.emit(createRuntimeDaemonNotification('event', {
      subscriptionId: 'observe-sub-1',
      event,
    }));
    expect(seen).toEqual([]);
    await flushAsyncNotifications();
    expect(seen).toEqual([event]);

    transport.emitLifecycle({
      state: 'disconnected',
      connectionId: 'connection-1',
      reason: 'daemon restarted',
      reconnectable: true,
    });
    await expect(observation.invalidated).resolves.toMatchObject({
      code: 'observation_invalidated',
      reason: 'transport_disconnected',
    });
    observation.close();
    await client.close();
  });

  it('accepts daemon observation invalidation before the observe response', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    let resolveObservation: ((value: unknown) => void) | undefined;
    const sessionObserveResult = new Promise<unknown>((resolve) => {
      resolveObservation = resolve;
    });
    const transport = fakeTransport(calls, { sessionObserveResult });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });
    const observationPromise = client.sessions.observe(
      'session-1',
      () => undefined,
    );
    transport.emit(createRuntimeDaemonNotification('observation.invalidated', {
      subscriptionId: 'observe-sub-invalidated',
      sessionId: 'session-1',
      invalidation: {
        code: 'observation_invalidated',
        reason: 'event_overflow',
        runtimeId: 'runtime-daemon',
        message: 'Server observation handoff overflowed.',
      },
    }));
    resolveObservation?.({
      subscriptionId: 'observe-sub-invalidated',
      snapshot: {
        runtimeId: 'runtime-daemon',
        cursor: { sessionId: 'session-1', journalEpoch: 'epoch-session-1', seq: 0 },
        transcriptRevision: 'sha256:test',
        session: { id: 'session-1', title: 'Session' },
        transcript: null,
        settings: { revision: 0, value: {} },
        runs: [],
        pendingPermissions: [],
        live: {
          assistantTextByRun: {},
          thinkingTextByRun: {},
          activeTools: [],
          pendingUserInputs: [],
          managedTasks: [],
        },
      },
    });

    const observation = await observationPromise;
    let invalidation: unknown;
    void observation.invalidated.then((value) => {
      invalidation = value;
    });
    await flushAsyncNotifications();
    expect(invalidation).toEqual({
      code: 'observation_invalidated',
      reason: 'event_overflow',
      runtimeId: 'runtime-daemon',
      message: 'Server observation handoff overflowed.',
    });
    observation.close();
    await client.close();
  });

  it('ignores other Session invalidations during observation handoff', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    let resolveObservation: ((value: unknown) => void) | undefined;
    const sessionObserveResult = new Promise<unknown>((resolve) => {
      resolveObservation = resolve;
    });
    const transport = fakeTransport(calls, { sessionObserveResult });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });
    const observationPromise = client.sessions.observe(
      'session-1',
      () => undefined,
    );
    for (let index = 0; index < 300; index += 1) {
      transport.emit(createRuntimeDaemonNotification('observation.invalidated', {
        subscriptionId: `unrelated-observation-${index}`,
        sessionId: 'session-2',
        invalidation: {
          code: 'observation_invalidated',
          reason: 'event_overflow',
          runtimeId: 'runtime-daemon',
          message: 'Unrelated observation invalidated.',
        },
      }));
    }
    resolveObservation?.({
      subscriptionId: 'observe-sub-1',
      snapshot: {
        runtimeId: 'runtime-daemon',
        cursor: { sessionId: 'session-1', journalEpoch: 'epoch-session-1', seq: 0 },
        transcriptRevision: 'sha256:test',
        session: { id: 'session-1', title: 'Session' },
        transcript: null,
        settings: { revision: 0, value: {} },
        runs: [],
        pendingPermissions: [],
        live: {
          assistantTextByRun: {},
          thinkingTextByRun: {},
          activeTools: [],
          pendingUserInputs: [],
          managedTasks: [],
        },
      },
    });

    const observation = await observationPromise;
    expect(observation.snapshot.session.id).toBe('session-1');
    observation.close();
    await client.close();
  });

  it('invalidates and unsubscribes when a terminal observation listener throws', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });
    const baselineListenerCount = transport.listenerCount();
    const observation = await client.sessions.observe('session-1', (event) => {
      if (event.type === 'run.completed') {
        throw new Error('Space reducer failed');
      }
    });

    expect(() => transport.emit(createRuntimeDaemonNotification('event', {
      subscriptionId: 'observe-sub-1',
      event: {
        id: 'evt-terminal-listener-failure',
        seq: observation.snapshot.cursor.seq + 1,
        cursor: {
          sessionId: 'session-1',
          journalEpoch: observation.snapshot.cursor.journalEpoch,
          seq: observation.snapshot.cursor.seq + 1,
        },
        time: '2026-07-09T00:00:01.000Z',
        sessionId: 'session-1',
        runId: 'run-1',
        type: 'run.completed',
        payload: {
          runId: 'run-1',
          sessionId: 'session-1',
          phase: 'completed',
          startedAt: '2026-07-09T00:00:00.000Z',
          provider: 'mock',
        },
      },
    }))).not.toThrow();

    await expect(observation.invalidated).resolves.toMatchObject({
      code: 'observation_invalidated',
      reason: 'delivery_failed',
    });
    await flushAsyncNotifications();
    expect(calls).toContainEqual({
      method: 'event.unsubscribe',
      params: { subscriptionId: 'observe-sub-1' },
    });
    expect(transport.listenerCount()).toBe(baselineListenerCount);
    await client.close();
  });

  it('returns stable timeout and cancellation errors for daemon history reads', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const interruptedReads: AbortSignal[] = [];
    const base = fakeTransport(calls);
    const transport: RuntimeDaemonClientTransport = {
      ...base,
      request(method, params, operation, control) {
        if (method === 'session.transcript') {
          if (control?.signal !== undefined) interruptedReads.push(control.signal);
          return new Promise((_resolve, reject) => {
            control?.signal?.addEventListener('abort', () => {
              reject(control.signal?.reason);
            }, { once: true });
          });
        }
        return base.request(method, params, operation, control);
      },
    };
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
      capabilities: RUN_LIFECYCLE_CAPABILITIES,
    });

    await expect(
      client.sessions.transcript('session-1', { timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: 'read_timeout' });
    expect(interruptedReads[0]?.aborted).toBe(true);

    const controller = new AbortController();
    const cancelled = client.sessions.transcript('session-1', {
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'read_cancelled' });
    expect(interruptedReads[1]?.aborted).toBe(true);
    await expect(client.sessions.create({ title: 'after timeout' })).resolves.toMatchObject({
      id: 'session-1',
      title: 'after timeout',
    });
    await client.close();
  });

  it('propagates cancellation from the daemon Agent wait facade', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const base = fakeTransport(calls);
    let waitSignal: AbortSignal | undefined;
    const transport: RuntimeDaemonClientTransport = {
      ...base,
      request(method, params, operation, control) {
        if (method !== 'agents.wait') {
          return base.request(method, params, operation, control);
        }
        calls.push({ method, params });
        waitSignal = control?.signal;
        return new Promise((_resolve, reject) => {
          control?.signal?.addEventListener('abort', () => {
            reject(control.signal?.reason);
          }, { once: true });
        });
      },
    };
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-agent-wait-cancel',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-31T00:00:00.000Z',
        version: '0.7.79',
      },
      transport,
      capabilities: {
        ...RUN_LIFECYCLE_CAPABILITIES,
        actorControlPlane: { version: 1, methodNamespace: 'agents' },
      },
    });
    const controller = new AbortController();

    const pending = client.agents.wait('session-1', 4, 30_000, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'read_cancelled' });
    expect(waitSignal?.aborted).toBe(true);
    expect(calls).toContainEqual({
      method: 'agents.wait',
      params: { sessionId: 'session-1', afterSequence: 4, timeoutMs: 30_000 },
    });
    await client.close();
  });

  it('unsubscribes a Session observation whose response arrives after timeout', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const base = fakeTransport(calls);
    const transport: RuntimeDaemonClientTransport = {
      ...base,
      request(method, params, operation, control) {
        if (method !== 'session.observe') {
          return base.request(method, params, operation, control);
        }
        calls.push({ method, params });
        return new Promise((_resolve, reject) => {
          control?.signal?.addEventListener('abort', () => {
            reject(control.signal?.reason);
            queueMicrotask(() => {
              control.onLateResult?.({
                subscriptionId: 'observe-sub-late',
                snapshot: {},
              });
            });
          }, { once: true });
        });
      },
    };
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
      capabilities: RUN_LIFECYCLE_CAPABILITIES,
    });

    await expect(client.sessions.observe(
      'session-1',
      () => undefined,
      { timeoutMs: 1 },
    )).rejects.toMatchObject({ code: 'read_timeout' });
    await flushAsyncNotifications();

    expect(calls).toContainEqual({
      method: 'event.unsubscribe',
      params: { subscriptionId: 'observe-sub-late' },
    });
    await client.close();
  });

  it('hydrates serialized daemon run failures as Error instances', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls, {
      runAwaitResult: {
        runId: 'run-1',
        sessionId: 'session-1',
        phase: 'failed',
        error: {
          name: 'ProviderError',
          message: 'provider unavailable',
          stack: 'ProviderError: provider unavailable',
        },
      },
    });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
    });

    const result = await client.runs.await('run-1');

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).toMatchObject({
      name: 'ProviderError',
      message: 'provider unavailable',
    });
  });

  it('preserves structured blocked terminal facts across daemon run await', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls, {
      runAwaitResult: {
        runId: 'run-blocked',
        sessionId: 'session-1',
        phase: 'failed',
        terminal: {
          revision: 1,
          kind: 'failed',
          code: 'blocked',
          effectOutcome: 'known',
          message: 'Choose the target API version.',
        },
      },
    });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-24T00:00:00.000Z',
        version: '0.7.74',
      },
      transport,
    });

    await expect(client.runs.await('run-blocked')).resolves.toMatchObject({
      phase: 'failed',
      terminal: {
        kind: 'failed',
        code: 'blocked',
        message: 'Choose the target API version.',
      },
    });
  });

  it('unsubscribes remote event subscriptions when closed before subscribe resolves', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    let resolveSubscribe!: (value: unknown) => void;
    const subscribeResult = new Promise<unknown>((resolve) => {
      resolveSubscribe = resolve;
    });
    const transport = fakeTransport(calls, {
      eventSubscribeResult: subscribeResult,
    });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'embedded',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
    });

    const subscription = client.events.subscribe({ sessionId: 'session-1' }, () => undefined);
    subscription.close();
    resolveSubscribe({ subscriptionId: 'late-event-sub' });
    await flushAsyncNotifications();

    expect(calls.some((call) => (
      call.method === 'event.unsubscribe'
      && isRecord(call.params)
      && call.params.subscriptionId === 'late-event-sub'
    ))).toBe(true);
  });

  it('unsubscribes remote workflow subscriptions when closed before subscribe resolves', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    let resolveSubscribe!: (value: unknown) => void;
    const subscribeResult = new Promise<unknown>((resolve) => {
      resolveSubscribe = resolve;
    });
    const transport = fakeTransport(calls, {
      workflowSubscribeResult: subscribeResult,
    });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'embedded',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
    });

    const subscription = client.workflows.subscribe({}, () => undefined);
    subscription.close();
    resolveSubscribe({ subscriptionId: 'late-workflow-sub' });
    await flushAsyncNotifications();

    expect(calls.some((call) => (
      call.method === 'workflow.unsubscribe'
      && isRecord(call.params)
      && call.params.subscriptionId === 'late-workflow-sub'
    ))).toBe(true);
  });

  it('drops local event listeners when remote subscribe rejects', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls, {
      eventSubscribeResult: Promise.reject(new Error('subscribe failed')),
    });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'embedded',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
    });

    const subscription = client.events.subscribe({ sessionId: 'session-1' }, () => undefined);
    await expect(subscription.ready).rejects.toThrow('subscribe failed');

    // The persistent reverse-capability listener remains; the failed event
    // subscription itself is removed.
    expect(transport.listenerCount()).toBe(1);
  });

  it('maps runtime admin/catalog/MCP/artifact services onto daemon requests', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
    });

    await client.config.patch({ model: 'm1' });
    await client.catalog.resolveCommand({ name: 'help' });
    await client.catalog.describeSkill({ name: 'review' });
    await client.catalog.customProviders();
    await client.catalog.upsertCustomProvider({
      name: 'custom-openai',
      protocol: 'openai',
      baseUrl: 'https://example.invalid/v1',
      apiKeyEnv: 'CUSTOM_OPENAI_KEY',
      model: 'custom-model',
    });
    await client.catalog.deleteCustomProvider('custom-openai');
    await client.catalog.extensions();
    await client.mcp.validateServer('local', { type: 'stdio', command: 'echo' });
    await client.mcp.upsertServer('local', { type: 'stdio', command: 'echo' });
    await client.mcp.listTools({ server: 'local' });
    await client.artifacts.create({ kind: 'file', path: '/tmp/a.txt' });
    await client.diagnostics.latestContextBudget({ sessionId: 'session-1' });
    await client.diagnostics.latestToolExposure({ runId: 'run-1' });
    await client.diagnostics.latestProviderCacheDiagnostic({
      sessionId: 'session-1',
      contextKind: 'child',
      agentId: '/root/reviewer',
    });

    expect(calls.map((call) => call.method)).toEqual([
      'config.patch',
      'command.resolve',
      'skill.describe',
      'provider.custom.list',
      'provider.custom.upsert',
      'provider.custom.remove',
      'extension.list',
      'mcp.server.validate',
      'mcp.server.upsert',
      'mcp.tool.list',
      'artifact.create',
      'context.budget.get',
      'tool.exposure.preview',
      'provider.cache.diagnostics.get',
    ]);
  });

  it('maps the remaining SDK runtime service methods onto daemon requests', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
      capabilities: RUN_LIFECYCLE_CAPABILITIES,
    });

    await client.sessions.load('session-1');
    await client.sessions.list({ limit: 5 });
    await client.sessions.status('session-1');
    await client.sessions.transcript('session-1');
    await client.sessions.transcriptSearch({ sessionId: 'session-1', query: 'old detail' });
    await client.sessions.conversation('session-1');
    await client.sessions.conversationPage({ sessionId: 'session-1', limit: 5 });
    await client.sessions.conversationEntryChunk({
      sessionId: 'session-1',
      revision: 'sha256:conversation',
      entryIndex: 0,
    });
    const observation = await client.sessions.observe('session-1', () => undefined);
    observation.close();
    const diagnostic = await client.sessions.diagnostics({
      sessionId: 'session-1',
      runId: 'run-1',
      timeoutMs: 2_000,
    });
    expect(diagnostic).toMatchObject({
      sdkVersion: KODAX_VERSION,
      runtimeMode: 'daemon',
      runtimeVersion: '0.7.66',
      daemonVersion: '0.7.66',
    });
    await client.sessions.fork({ sessionId: 'session-1' });
    await client.sessions.getSettings('session-1');
    const shellExecution = {
      version: 1 as const,
      shell: { kind: 'pwsh' as const, profile: 'none' as const },
      cache: { ttlMs: 30_000, refreshToken: 'daemon-test' },
    };
    await client.sessions.updateSettings('session-1', {
      model: 'm1',
      shellExecution,
    });
    await client.sessions.appendNotice({ sessionId: 'session-1', content: 'notice' });
    await client.sessions.rewind({ sessionId: 'session-1', selector: 'entry-1' });
    await client.sessions.setActiveEntry({ sessionId: 'session-1', entryId: 'entry-1' });
    await client.sessions.compact({ sessionId: 'session-1' });
    await client.sessions.archive('session-1');
    await client.sessions.unarchive('session-1');
    await client.sessions.delete('session-1');
    await client.runs.get('run-1');
    await client.runs.list({ sessionId: 'session-1' });
    await client.runs.submitInput({
      sessionId: 'session-1',
      afterRunId: 'run-1',
      delivery: 'after_turn',
      input: { type: 'text', text: 'continue' },
    });
    await client.runs.abort('run-1');
    await client.runs.setModel('run-1', 'm2');
    await client.runs.setProvider('run-1', 'openai');
    await client.runs.setReasoning('run-1', 'balanced');
    await client.events.replay({ sessionId: 'session-1' });
    await client.permissions.request({
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      inputPreview: 'echo ok',
    });
    await client.permissions.listPending({ runId: 'run-1' });
    await client.permissions.listGrants();
    await client.permissions.revokeGrant('grant-1', 0);
    await client.userInputs.listPending({ runId: 'run-1' });
    await client.userInputs.respond('input-1', 'yes', { expectedRevision: 0 });
    await client.userInputs.dismiss('input-2', { expectedRevision: 0 });
    await client.workflows.list({ activeOnly: true });
    await client.workflows.pause('workflow-1');
    await client.workflows.resume('workflow-1');
    await client.workflows.stop('workflow-1');
    await client.config.read();
    await client.config.reload();
    await client.catalog.providers();
    await client.catalog.models({ provider: 'openai' });
    await client.catalog.commands('C:/repo');
    await client.catalog.skills({ userInvocableOnly: true });
    await client.mcp.listServers();
    await client.mcp.deleteServer('local');
    await client.mcp.reloadServers();
    await client.artifacts.delete('art-1');
    await client.status.snapshot();

    expect(calls.map((call) => call.method)).toEqual([
      'session.load',
      'session.list',
      'session.status',
      'session.transcript',
      'session.transcript.search',
      'session.conversation',
      'session.conversation.page',
      'session.conversation.entryChunk',
      'session.observe',
      'event.unsubscribe',
      'session.diagnostics',
      'session.fork',
      'session.settings.get',
      'session.settings.getVersioned',
      'session.settings.updateVersioned',
      'session.notice.append',
      'session.rewind',
      'session.active_entry.set',
      'session.compact',
      'session.archive',
      'session.unarchive',
      'session.delete',
      'run.get',
      'run.list',
      'run.input.submit',
      'run.abort',
      'run.model.set',
      'run.provider.set',
      'run.reasoning.set',
      'event.replay',
      'permission.request',
      'permission.list',
      'permission.grants.list',
      'permission.grants.revoke',
      'user_input.listPending',
      'user_input.respond',
      'user_input.dismiss',
      'workflow.list',
      'workflow.pause',
      'workflow.resume',
      'workflow.stop',
      'config.read',
      'config.reload',
      'provider.list',
      'model.list',
      'command.list',
      'skill.list',
      'mcp.server.list',
      'mcp.server.delete',
      'mcp.server.reload',
      'artifact.delete',
      'daemon.status',
    ]);
    expect(
      calls.find((call) => call.method === 'session.settings.updateVersioned')
        ?.params,
    ).toMatchObject({
      sessionId: 'session-1',
      patch: { model: 'm1', shellExecution },
    });
  });

  it('passes permission response run bindings through the transport', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
    });

    const accepted = await client.permissions.respond(
      'perm-1',
      { type: 'allow_once' },
      { runId: 'run-1' },
    );

    expect(accepted).toBe(true);
    expect(calls).toEqual([{
      method: 'permission.respond',
      params: {
        requestId: 'perm-1',
        decision: { type: 'allow_once' },
        runId: 'run-1',
      },
    }]);
  });

  it('answers credential and host-tool reverse calls without replaying a handler', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });
    const credential = await client.credentials.register({ providers: ['openai'] }, async () => 'secret');
    let handlerCalls = 0;
    const hostTools = await client.hostTools.register([{
      name: 'space_artifact_create',
      description: 'Create a Space artifact',
      inputSchema: { type: 'object' },
      sideEffect: 'non_idempotent',
    }], {
      async space_artifact_create() {
        handlerCalls += 1;
        return { content: 'artifact-created' };
      },
    });

    transport.emit(createRuntimeDaemonNotification('credential.request', {
      requestId: 'credential-request-1',
      leaseId: credential.id,
      provider: 'openai',
      sessionId: 'session-1',
      runId: 'run-1',
    }));
    const invocation = createRuntimeDaemonNotification('host_tool.invoke', {
      invocationId: 'host-invocation-1',
      leaseId: hostTools.id,
      toolName: 'space_artifact_create',
      sessionId: 'session-1',
      runId: 'run-1',
      input: { title: 'Report' },
    });
    transport.emit(invocation);
    transport.emit(invocation);
    await flushAsyncNotifications();

    expect(handlerCalls).toBe(1);
    expect(calls).toContainEqual({
      method: 'credential.supply',
      params: { requestId: 'credential-request-1', credential: 'secret' },
    });
    expect(calls.filter((call) => call.method === 'host_tool.complete')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'host_tool.complete')[0]?.params)
      .toEqual({ invocationId: 'host-invocation-1', result: { content: 'artifact-created' } });
    await client.close();
  });

  it('routes scoped credential requests only to the v2 broker', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-08-29T00:00:00.000Z',
        version: '0.7.96',
      },
      transport,
      capabilities: { providerCredentialBroker: { version: 2 } },
    });
    const requests: unknown[] = [];
    const lease = await client.credentials.registerScoped(
      { providers: ['openai', 'anthropic'] },
      async (request) => {
        requests.push(request);
        return 'scoped-secret';
      },
    );

    transport.emit(createRuntimeDaemonNotification('credential.request', {
      requestId: 'credential-request-v2',
      brokerVersion: 2,
      leaseId: lease.id,
      provider: 'anthropic',
      sessionId: 'session-1',
      target: {
        kind: 'operation',
        operation: 'session.compact',
        operationId: 'compact-op-1',
      },
      purpose: 'compaction',
    }));
    await flushAsyncNotifications();

    expect(requests).toEqual([{
      requestId: 'credential-request-v2',
      leaseId: lease.id,
      provider: 'anthropic',
      sessionId: 'session-1',
      target: {
        kind: 'operation',
        operation: 'session.compact',
        operationId: 'compact-op-1',
      },
      purpose: 'compaction',
    }]);
    expect(calls).toContainEqual({
      method: 'credential.supply',
      params: { requestId: 'credential-request-v2', credential: 'scoped-secret' },
    });
    await client.close();
  });

  it('does not send a scoped lease registration to a v1 daemon', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client-v1',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-08-29T00:00:00.000Z',
        version: '0.7.95',
      },
      transport: fakeTransport(calls),
      capabilities: { providerCredentialBroker: { version: 1 } },
    });

    await expect(client.credentials.registerScoped(
      { providers: ['openai'] },
      async () => 'must-not-run',
    )).rejects.toMatchObject({
      code: 'daemon_upgrade_required',
      capability: 'providerCredentialBroker',
    });
    expect(calls).toEqual([]);
    await client.close();
  });

  it('never evicts pending host-tool invocations into duplicate side effects', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });
    let handlerCalls = 0;
    const tools = await client.hostTools.register([{
      name: 'space_side_effect',
      description: 'Perform one Space side effect',
      inputSchema: { type: 'object' },
      sideEffect: 'non_idempotent',
    }], {
      space_side_effect() {
        handlerCalls += 1;
        return new Promise(() => undefined);
      },
    });
    const notification = (invocationId: string) => createRuntimeDaemonNotification(
      'host_tool.invoke',
      {
        invocationId,
        leaseId: tools.id,
        toolName: 'space_side_effect',
        sessionId: 'session-1',
        runId: 'run-1',
        input: {},
      },
    );

    for (let index = 0; index <= 1_000; index += 1) {
      transport.emit(notification(`invocation-${index}`));
    }
    transport.emit(notification('invocation-0'));
    await flushAsyncNotifications();

    expect(handlerCalls).toBe(1_001);
    await client.close();
  });

  it('reports reverse credential delivery failures without leaking broker errors', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    const transport = fakeTransport(calls, {
      reverseRequestError: new Error('SECRET_BROKER_DETAIL'),
    });
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });
    try {
      const credential = await client.credentials.register(
        { providers: ['openai'] },
        async () => 'secret',
      );
      transport.emit(createRuntimeDaemonNotification('credential.request', {
        requestId: 'credential-request-failed',
        leaseId: credential.id,
        provider: 'openai',
        sessionId: 'session-1',
        runId: 'run-1',
      }));
      await flushAsyncNotifications();

      expect(diagnostics).toContainEqual(expect.objectContaining({
        source: 'runtime.daemon.client',
        level: 'warn',
      }));
      expect(JSON.stringify(diagnostics)).not.toContain('SECRET_BROKER_DETAIL');
    } finally {
      restore();
      await client.close();
    }
  });

  it('reattaches credential and host handlers after a stable client reconnect', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.69',
      },
      transport,
    });

    await expect(client.credentials.resume('credential-resumed', async () => 'secret'))
      .resolves.toMatchObject({ providers: ['openai'] });
    await expect(client.hostTools.resume('host-resumed', {
      async space_control() { return { content: 'done' }; },
    })).resolves.toMatchObject({ id: 'host-resumed' });
    await expect(client.hostTools.getInvocation('invocation-1')).resolves.toMatchObject({
      state: 'unknown',
    });

    expect(calls.map((call) => call.method)).toEqual([
      'credential.get',
      'host_tool.get',
      'host_tool.invocation.get',
    ]);
    await client.close();
  });

  it('rejects a scoped v2 lease before installing a legacy v1 broker', async () => {
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method === 'credential.get') {
          return {
            id: 'credential-scoped',
            providers: ['openai'],
            brokerVersion: 2,
          };
        }
        return undefined;
      },
      subscribe() { return { close() {} }; },
    };
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.96',
      },
      transport,
    });

    await expect(client.credentials.resume(
      'credential-scoped',
      async () => 'must-not-run',
    )).rejects.toMatchObject({ code: 'credential_unavailable' });
    await client.close();
  });

  it('maps daemon null lookup results back to SDK undefined semantics', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const transport = fakeTransport(calls);
    const client = createRuntimeDaemonClient({
      identity: {
        runtimeId: 'runtime-client',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66',
      },
      transport,
    });

    await expect(client.workflows.get('missing-run')).resolves.toBeUndefined();
    await expect(client.mcp.getServer('missing-server')).resolves.toBeUndefined();
    await expect(client.artifacts.get('missing-artifact')).resolves.toBeUndefined();
    await expect(client.admin.agentRegistrations.setEnabled('external:missing', false, {
      expectedConfigurationRevision: 'rev-before',
      expectedManagementOwner: null,
      claimOwner: 'runtime-config-test',
    }))
      .resolves.toBeUndefined();
    const registration = {
      agentId: 'external:managed',
      displayName: 'Managed',
      enabled: true,
      executorId: 'managed-http',
      protocol: 'http',
      configurationRevision: 'rev-1',
      endpointIdentityHash: 'sha256:managed',
      capabilities: {
        streaming: 'supported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: 'read', workspace: 'proposal' },
    } as const;
    await client.admin.agentRegistrations.upsert(registration, {
      expectedConfigurationRevision: null,
      expectedManagementOwner: null,
    });
    await client.admin.agentRegistrations.remove(registration.agentId, {
      expectedConfigurationRevision: registration.configurationRevision,
      expectedManagementOwner: 'runtime-config-test',
    });

    expect(calls.map((call) => call.method)).toEqual([
      'workflow.get',
      'mcp.server.get',
      'artifact.get',
      'agentRegistrations.setEnabled',
      'agentRegistrations.upsert',
      'agentRegistrations.remove',
    ]);
    expect(calls.at(-3)?.params).toEqual({
      agentId: 'external:missing',
      enabled: false,
      expectedConfigurationRevision: 'rev-before',
      expectedManagementOwner: null,
      claimOwner: 'runtime-config-test',
    });
    expect(calls.at(-2)?.params).toEqual({
      registration,
      expectedConfigurationRevision: null,
      expectedManagementOwner: null,
    });
    expect(calls.at(-1)?.params).toEqual({
      agentId: 'external:managed',
      expectedConfigurationRevision: 'rev-1',
      expectedManagementOwner: 'runtime-config-test',
    });
  });
});

function fakeTransport(
  calls: Array<{ readonly method: string; readonly params: unknown }>,
  options: {
    readonly eventSubscribeResult?: Promise<unknown>;
    readonly eventReplayResult?: unknown;
    readonly workflowSubscribeResult?: Promise<unknown>;
    readonly notificationBeforeEventSubscribeResult?: RuntimeDaemonNotification;
    readonly runAwaitResult?: unknown;
    readonly runAbortResult?: unknown;
    readonly reverseRequestError?: Error;
    readonly sessionObserveResult?: Promise<unknown>;
  } = {},
): RuntimeDaemonClientTransport & {
  emit(notification: RuntimeDaemonNotification): void;
  emitLifecycle(state: RuntimeDaemonTransportLifecycleState): void;
  listenerCount(): number;
} {
  const listeners: Array<Parameters<RuntimeDaemonClientTransport['subscribe']>[0]> = [];
  const lifecycleListeners: Array<(state: RuntimeDaemonTransportLifecycleState) => void> = [];
  const transport: RuntimeDaemonClientTransport & {
    emit(notification: RuntimeDaemonNotification): void;
    emitLifecycle(state: RuntimeDaemonTransportLifecycleState): void;
    listenerCount(): number;
  } = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'session.create') {
        const title = params && typeof params === 'object' && 'title' in params
          && typeof params.title === 'string'
          ? params.title
          : 'Session';
        return { id: 'session-1', title };
      }
      if (method === 'run.start') {
        return { runId: 'run-1', sessionId: 'session-1' };
      }
      if (method === 'daemon.management.get') {
        const activeAgentTasks = [{
          sessionId: 'session-legacy',
          actorPath: '/root',
          turnId: 'turn-legacy',
          kind: 'native',
        }];
        return {
          runtimeId: 'runtime-management',
          revision: 4,
          ownerPolicy: {
            mode: 'daemon',
            revision: 2,
            updatedAt: '2026-07-15T00:00:00.000Z',
          },
          preflight: {
            runtimeId: 'runtime-management',
            clientCount: 1,
            activeRuns: [],
            queuedRuns: [],
            activeWorkflows: [],
            activeAgentTasks,
            pendingPermissions: [],
            pendingUserInputs: [],
            blockers: [],
            canStop: true,
          },
        };
      }
      if (method === 'daemon.preflight') {
        const activeAgentTasks = [{
          sessionId: 'session-legacy',
          actorPath: '/root',
          turnId: 'turn-legacy',
          kind: 'native',
        }];
        return {
          runtimeId: 'runtime-management',
          clientCount: 1,
          activeRuns: [],
          queuedRuns: [],
          activeWorkflows: [],
          activeAgentTasks,
          pendingPermissions: [],
          pendingUserInputs: [],
          blockers: ['active_agent_tasks'],
          canStop: false,
        };
      }
      if (method === 'daemon.rollbackToInline') {
        return {
          accepted: true,
          runtimeId: 'runtime-management',
          revision: 5,
          ownerPolicy: {
            mode: 'inline',
            revision: 3,
            updatedAt: '2026-07-15T00:00:01.000Z',
          },
        };
      }
      if (method === 'run.input.submit') {
        return {
          accepted: true,
          delivery: 'after_turn',
          runId: 'run-2',
          sessionId: 'session-1',
          afterRunId: 'run-1',
          sessionOrder: 2,
        };
      }
      if (method === 'credential.register') {
        const input = params as {
          readonly leaseId: string;
          readonly providers: readonly string[];
          readonly brokerVersion?: 2;
        };
        return {
          id: input.leaseId,
          providers: input.providers,
          ...(input.brokerVersion === 2 ? { brokerVersion: 2 } : {}),
        };
      }
      if (method === 'credential.get') {
        return { id: 'credential-resumed', providers: ['openai'] };
      }
      if (method === 'host_tool.register') {
        const input = params as { readonly leaseId: string; readonly tools: readonly unknown[] };
        return { id: input.leaseId, tools: input.tools };
      }
      if (method === 'host_tool.get') {
        return {
          id: 'host-resumed',
          tools: [{
            name: 'space_control',
            description: 'Control Space',
            inputSchema: { type: 'object' },
            sideEffect: 'non_idempotent',
          }],
        };
      }
      if (method === 'host_tool.invocation.get') {
        return {
          invocationId: 'invocation-1',
          leaseId: 'host-resumed',
          toolName: 'space_control',
          sessionId: 'session-1',
          runId: 'run-1',
          state: 'unknown',
          updatedAt: '2026-07-09T00:00:00.000Z',
        };
      }
      if (method === 'credential.supply' || method === 'host_tool.complete') {
        if (options.reverseRequestError) throw options.reverseRequestError;
        return true;
      }
      if (method === 'session.observe') {
        if (options.sessionObserveResult) return options.sessionObserveResult;
        return {
          subscriptionId: 'observe-sub-1',
          snapshot: {
            runtimeId: 'runtime-client',
            cursor: { sessionId: 'session-1', journalEpoch: 'epoch-session-1', seq: 0 },
            transcriptRevision: 'sha256:test',
            session: { id: 'session-1', title: 'Session' },
            transcript: null,
            settings: { revision: 0, value: {} },
            runs: [],
            pendingPermissions: [],
            live: {
              assistantTextByRun: {},
              thinkingTextByRun: {},
              activeTools: [],
              pendingUserInputs: [],
              managedTasks: [],
            },
          },
        };
      }
      if (method === 'session.settings.getVersioned') {
        return { revision: 0, value: {} };
      }
      if (method === 'session.settings.updateVersioned') {
        return { revision: 1, value: {} };
      }
      if (method === 'run.await') {
        return options.runAwaitResult
          ?? { runId: 'run-1', sessionId: 'session-1', phase: 'completed' };
      }
      if (method === 'run.abort') {
        return options.runAbortResult ?? {
          runId: 'run-1',
          sessionId: 'session-1',
          accepted: false,
          state: 'confirmed',
          outcome: 'completed',
          phase: 'completed',
          revision: 3,
        };
      }
      if (method === 'event.subscribe') {
        if (options.notificationBeforeEventSubscribeResult) {
          transport.emit(options.notificationBeforeEventSubscribeResult);
        }
        if (options.eventSubscribeResult) return options.eventSubscribeResult;
        return { subscriptionId: 'sub-1' };
      }
      if (method === 'event.replay') {
        return options.eventReplayResult ?? [];
      }
      if (method === 'event.unsubscribe') {
        return { ok: true };
      }
      if (method === 'workflow.subscribe') {
        if (options.workflowSubscribeResult) return options.workflowSubscribeResult;
        return { subscriptionId: 'workflow-sub-1' };
      }
      if (method === 'workflow.unsubscribe') {
        return { ok: true };
      }
      if (method === 'workflow.get') {
        return null;
      }
      if (method === 'permission.respond') {
        return true;
      }
      if (method === 'command.resolve') {
        return { name: 'help', description: 'Show help', source: 'builtin' };
      }
      if (method === 'skill.describe') {
        return {
          name: 'review',
          description: 'Review code',
          userInvocable: true,
          path: '/skills/review',
          source: 'project',
          disableModelInvocation: false,
          content: 'Review instructions',
          skillFilePath: '/skills/review/SKILL.md',
        };
      }
      if (method === 'provider.custom.list') {
        return [];
      }
      if (method === 'provider.custom.upsert') {
        return {
          name: 'custom-openai',
          protocol: 'openai',
          baseUrl: 'https://example.invalid/v1',
          apiKeyEnv: 'CUSTOM_OPENAI_KEY',
          model: 'custom-model',
        };
      }
      if (method === 'provider.custom.remove') {
        return true;
      }
      if (method === 'extension.list') {
        return { active: false, extensions: [] };
      }
      if (method === 'mcp.server.validate') {
        return { ok: true, config: { type: 'stdio', command: 'echo' } };
      }
      if (method === 'mcp.server.upsert') {
        return { type: 'stdio', command: 'echo' };
      }
      if (method === 'mcp.server.get') {
        return null;
      }
      if (method === 'mcp.tool.list') {
        return [];
      }
      if (method === 'artifact.create') {
        return {
          id: 'art-1',
          kind: 'file',
          path: '/tmp/a.txt',
          createdAt: '2026-07-09T00:00:00.000Z',
        };
      }
      if (method === 'artifact.get') {
        return null;
      }
      if (method === 'agentRegistrations.setEnabled') {
        return null;
      }
      if (method === 'context.budget.get') {
        return { usedTokens: 42 };
      }
      if (method === 'tool.exposure.preview') {
        return { reportOnly: true };
      }
      if (method === 'session.status') {
        return {
          sessionId: 'session-1',
          runtimeId: 'runtime-client',
          phase: 'idle',
          observedAt: '2026-07-09T00:00:00.000Z',
        };
      }
      if (method === 'session.diagnostics') {
        return {
          schemaVersion: 1,
          captureStartedAt: '2026-07-30T00:00:00.000Z',
          capturedAt: '2026-07-30T00:00:00.001Z',
          sdkVersion: '0.7.70',
          runtimeVersion: '0.7.79',
          daemonVersion: null,
          runtimeId: 'runtime-client',
          runtimeMode: 'embedded',
          sessionId: 'session-1',
          observation: {
            cursor: { sessionId: 'session-1', journalEpoch: 'epoch-session-1', seq: 0 },
            transcriptRevision: 'sha256:test',
          },
          run: {
            controlRecord: 'unknown',
            state: 'unknown',
            stage: 'unknown',
            terminalTimeKnown: false,
            activeSubtaskCount: null,
            activeSubtaskCountSource: 'unknown',
            errors: [{
              code: 'run_control_unknown',
              message: 'No Run control record is available.',
            }],
          },
        };
      }
      if (method === 'provider.cache.diagnostics.get') {
        return {
          requestId: 'cache-latest',
          phase: 'response',
          cachedReadTokens: 80,
        };
      }
      return {};
    },
    subscribe(listener) {
      listeners.push(listener);
      const subscription: RuntimeSubscription = {
        close() {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
      return subscription;
    },
    subscribeLifecycle(listener) {
      lifecycleListeners.push(listener);
      listener({ state: 'connected', connectionId: 'connection-1', reconnectable: false });
      return {
        close() {
          const index = lifecycleListeners.indexOf(listener);
          if (index >= 0) lifecycleListeners.splice(index, 1);
        },
      };
    },
    emit(notification) {
      for (const listener of listeners) {
        listener(notification);
      }
    },
    emitLifecycle(state) {
      for (const listener of lifecycleListeners) listener(state);
    },
    listenerCount() {
      return listeners.length;
    },
  };
  return transport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function flushAsyncNotifications(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
