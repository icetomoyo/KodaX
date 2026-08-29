import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExternalAgentRegistrationConflictError,
  setKodaXDiagnosticSink,
} from '@kodax-ai/agent';
import {
  createExtensionRuntime,
  getTool,
  registerTool,
  setActiveExtensionRuntime,
  type KodaXToolExecutionContext,
} from '@kodax-ai/coding';

import type {
  KodaXRuntime,
  RuntimeClientCapabilities,
  RuntimeCompactSessionInput,
  RuntimeCompactSessionResult,
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventListener,
  RuntimeEventReplayFilter,
  RuntimeObservationInvalidation,
  RuntimePermissionDecision,
  RuntimePermissionRespondOptions,
  RuntimeRunResult,
  RuntimeSessionObservation,
  RuntimeStartRunInput,
} from '../sdk-runtime.js';
import {
  RUNTIME_DAEMON_METHODS,
  createRuntimeDaemonRequest,
  isRuntimeDaemonSuccessResponse,
  type RuntimeDaemonMethod,
  type RuntimeDaemonNotification,
} from './protocol.js';
import {
  createRuntimeDaemonDispatcher,
  createRuntimeDaemonRunResultStore,
} from './server.js';
import {
  createRuntimeDaemonClient,
  type RuntimeDaemonClientTransport,
} from './client.js';
import { createRuntimeControlJournal } from './control-journal.js';
import { createRuntimeDaemonReverseBridgeHub } from './reverse-bridge.js';
import type { RuntimeDaemonManagementController } from './management.js';

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('runtime daemon dispatcher', () => {
  afterEach(() => setActiveExtensionRuntime(null));

  it('passes Agent revision fences and maps stale follow-ups to conflict', async () => {
    const runtime = makeRuntime();
    const followup = vi.spyOn(runtime.agents, 'followup').mockRejectedValue(Object.assign(
      new Error('Actor revision 4 is stale; current revision is 5.'),
      { code: 'revision_conflict' as const, expectedRevision: 4, currentRevision: 5 },
    ));
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-agent-followup-conflict',
      'agents.followup',
      {
        sessionId: 'session-1',
        actorPath: '/root/worker',
        objective: 'Distinct stale follow-up.',
        expectedRevision: 4,
      },
    ));

    expect(followup).toHaveBeenCalledWith(
      'session-1',
      '/root/worker',
      'Distinct stale follow-up.',
      {
        expectedRevision: 4,
        requireCredentialForNewTurn: true,
      },
    );
    expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(response)) {
      expect(response.error).toMatchObject({
        code: 'conflict',
        data: {
          conflict: 'revision_conflict',
          expectedRevision: 4,
          currentRevision: 5,
        },
      });
    }
    dispatcher.close();
  });

  it('maps fenced external Agent registration conflicts to the stable daemon conflict code', async () => {
    const runtime = makeRuntime();
    vi.spyOn(runtime.admin.agentRegistrations, 'upsert')
      .mockRejectedValue(new ExternalAgentRegistrationConflictError('external:stale'));
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      allowAgentRegistrationAdmin: true,
    });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-registration-conflict',
      'agentRegistrations.upsert',
      {
        registration: {
          agentId: 'external:stale',
          displayName: 'Stale',
          enabled: true,
          executorId: 'a2a',
          protocol: 'a2a',
          configurationRevision: 'stale-revision',
          endpointIdentityHash: 'stale-endpoint',
          capabilities: {},
          effects: { remote: 'read', workspace: 'proposal' },
        },
        expectedConfigurationRevision: 'expected-revision',
      },
    ));

    expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(response)) {
      expect(response.error).toMatchObject({
        code: 'conflict',
        data: {
          agentId: 'external:stale',
          conflict: 'external_agent_registration_conflict',
        },
      });
    }
    dispatcher.close();
  });

  it('requires initialize before runtime methods and rejects double initialize', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });

    const preInitialize = await dispatcher.handle(createRuntimeDaemonRequest('req-before-init', 'run.list'));
    expect(isRuntimeDaemonSuccessResponse(preInitialize)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(preInitialize)) {
      expect(preInitialize.error.code).toBe('not_initialized');
    }

    await initializeDispatcher(dispatcher);

    const secondInitialize = await dispatcher.handle(createRuntimeDaemonRequest('req-init-again', 'initialize', {
      profile: 'default',
    }));
    expect(isRuntimeDaemonSuccessResponse(secondInitialize)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(secondInitialize)) {
      expect(secondInitialize.error.code).toBe('conflict');
    }
  });

  it('validates method params and dispatcher results against the protocol schema', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      providerList: () => ({ invalid: 'provider-list-result' }),
    });
    await initializeDispatcher(dispatcher);

    const invalidParams = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-invalid-params',
      'session.load',
      { sessionId: 42 },
    ));
    const invalidResult = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-invalid-result',
      'provider.list',
    ));

    expect(isRuntimeDaemonSuccessResponse(invalidParams)).toBe(false);
    expect(isRuntimeDaemonSuccessResponse(invalidResult)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(invalidParams)) {
      expect(invalidParams.error).toMatchObject({ code: 'invalid_params' });
      expect(invalidParams.error.data).toMatchObject({
        issues: expect.arrayContaining(['params.sessionId must be string.']),
      });
    }
    if (!isRuntimeDaemonSuccessResponse(invalidResult)) {
      expect(invalidResult.error).toMatchObject({ code: 'internal_error' });
      expect(invalidResult.error.message).toContain('invalid result');
    }
  });

  it('applies session admission to event, interaction, and diagnostic side paths', async () => {
    const runtime = makeRuntime();
    vi.spyOn(runtime.sessions, 'transcript').mockImplementation(async (sessionId) => {
      if (sessionId === 'partner-session') {
        throw Object.assign(new Error('Partner session is not admitted.'), {
          code: 'session_not_admitted' as const,
        });
      }
      return null;
    });
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const requests = [
      createRuntimeDaemonRequest('req-event-subscribe', 'event.subscribe', {
        filter: { sessionId: 'partner-session' },
      }),
      createRuntimeDaemonRequest('req-event-replay', 'event.replay', {
        sessionId: 'partner-session',
      }),
      createRuntimeDaemonRequest('req-permission-list', 'permission.list', {
        sessionId: 'partner-session',
      }),
      createRuntimeDaemonRequest('req-permission-request', 'permission.request', {
        sessionId: 'partner-session',
        runId: 'partner-run',
        toolName: 'read',
      }),
      createRuntimeDaemonRequest('req-user-input-list', 'user_input.listPending', {
        sessionId: 'partner-session',
      }),
      createRuntimeDaemonRequest('req-diagnostic', 'context.budget.get', {
        sessionId: 'partner-session',
      }),
    ];

    for (const request of requests) {
      const response = await dispatcher.handle(request);
      expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
      if (!isRuntimeDaemonSuccessResponse(response)) {
        expect(response.error.code).toBe('session_not_admitted');
      }
    }
  });

  it('requires the configured daemon token during initialize', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      authToken: 'token-1',
    });

    const missing = await dispatcher.handle(createRuntimeDaemonRequest('req-missing-token', 'initialize', {
      profile: 'default',
    }));
    expect(isRuntimeDaemonSuccessResponse(missing)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(missing)) {
      expect(missing.error.code).toBe('unauthorized');
    }

    const accepted = await dispatcher.handle(createRuntimeDaemonRequest('req-token', 'initialize', {
      profile: 'default',
      token: 'token-1',
    }));
    expect(isRuntimeDaemonSuccessResponse(accepted)).toBe(true);
  });

  it('requires the negotiated durable envelope and deduplicates an exact mutation retry', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-operations-'));
    try {
      const runtime = makeRuntime();
      const start = vi.spyOn(runtime.runs, 'start');
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime,
        controlJournal,
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, { operationDeduplication: true });

      const missing = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-missing-operation',
        'run.start',
        { sessionId: 'session-1', prompt: 'hello' },
      ));
      expect(isRuntimeDaemonSuccessResponse(missing)).toBe(false);
      if (!isRuntimeDaemonSuccessResponse(missing)) {
        expect(missing.error.code).toBe('operation_required');
      }

      const operation = {
        operationId: 'op-server-1',
        journalEpoch: controlJournal.journalEpoch,
      } as const;
      const first = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-operation-1',
        'run.start',
        { sessionId: 'session-1', prompt: 'hello' },
        operation,
      ));
      const retried = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-operation-2',
        'run.start',
        { sessionId: 'session-1', prompt: 'hello' },
        operation,
      ));
      const receipt = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-operation-get',
        'operation.get',
        operation,
      ));

      expect(isRuntimeDaemonSuccessResponse(first)).toBe(true);
      expect(retried).toEqual({ ...first, id: 'req-operation-2' });
      expect(isRuntimeDaemonSuccessResponse(receipt)).toBe(true);
      if (isRuntimeDaemonSuccessResponse(receipt)) {
        expect(receipt.result).toMatchObject({ operationId: operation.operationId, state: 'applied' });
        expect(receipt.result).toMatchObject({
          result: { runId: 'run-1', sessionId: 'session-1' },
        });
      }
      expect(start).toHaveBeenCalledTimes(1);
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('marks every dispatched mutation unknown-safe before applying its effect', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-dispatch-'));
    try {
      const runtime = makeRuntime();
      let resolveCreate: ((value: Awaited<ReturnType<KodaXRuntime['sessions']['create']>>) => void)
        | undefined;
      const pendingCreate = new Promise<Awaited<ReturnType<KodaXRuntime['sessions']['create']>>>(
        (resolve) => { resolveCreate = resolve; },
      );
      vi.spyOn(runtime.sessions, 'create').mockImplementation(() => pendingCreate);
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime,
        controlJournal,
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, { operationDeduplication: true });
      const operation = {
        operationId: 'op-session-create',
        journalEpoch: controlJournal.journalEpoch,
      } as const;

      const response = dispatcher.handle(createRuntimeDaemonRequest(
        'req-session-create',
        'session.create',
        { title: 'Created once' },
        operation,
      ));

      await vi.waitFor(() => {
        expect(controlJournal.get(operation.operationId)?.state).toBe('dispatched');
      });
      resolveCreate?.({ id: 'session-created', title: 'Created once' });
      expect(isRuntimeDaemonSuccessResponse(await response)).toBe(true);
      expect(controlJournal.get(operation.operationId)?.state).toBe('applied');
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps a legacy client read-only when durable operations are required', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-legacy-'));
    try {
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime: makeRuntime(),
        controlJournal: createRuntimeControlJournal({ rootDir }),
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, {});

      const read = await dispatcher.handle(createRuntimeDaemonRequest('req-read', 'run.list'));
      const mutation = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-write',
        'session.create',
        { title: 'legacy write' },
      ));

      expect(isRuntimeDaemonSuccessResponse(read)).toBe(true);
      expect(isRuntimeDaemonSuccessResponse(mutation)).toBe(false);
      if (!isRuntimeDaemonSuccessResponse(mutation)) {
        expect(mutation.error.code).toBe('client_upgrade_required');
      }
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('routes reverse-bridge state changes through the daemon draining fence', async () => {
    const fencedMutations: RuntimeDaemonMethod[] = [];
    const conflict = Object.assign(new Error('Runtime daemon is draining.'), {
      code: 'conflict' as const,
    });
    const management: RuntimeDaemonManagementController = {
      armOrphanExitAfterReady() {},
      attachClient() {},
      detachClient() {},
      async runMutation<T>(method: RuntimeDaemonMethod): Promise<T> {
        fencedMutations.push(method);
        throw conflict;
      },
      async preflight() { throw new Error('not used'); },
      async inspect() { throw new Error('not used'); },
      async stop() { throw new Error('not used'); },
      async rollbackToInline() { throw new Error('not used'); },
      close() {},
    };
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      management,
      requireOperationEnvelope: true,
    });
    await initializeDispatcher(dispatcher, { operationDeduplication: true });
    const requests: readonly {
      readonly method: RuntimeDaemonMethod;
      readonly params: unknown;
    }[] = [
      {
        method: 'credential.register',
        params: { leaseId: 'credential-fenced', providers: ['mock'] },
      },
      { method: 'credential.revoke', params: { leaseId: 'credential-fenced' } },
      {
        method: 'credential.supply',
        params: { requestId: 'credential-request-fenced', credential: 'never-dispatched' },
      },
      {
        method: 'host_tool.register',
        params: {
          leaseId: 'host-tools-fenced',
          tools: [{
            name: 'space_artifact_create',
            inputSchema: { type: 'object' },
            sideEffect: 'non_idempotent',
          }],
        },
      },
      { method: 'host_tool.revoke', params: { leaseId: 'host-tools-fenced' } },
      {
        method: 'host_tool.complete',
        params: { invocationId: 'host-invocation-fenced', error: 'not dispatched' },
      },
    ];

    for (const [index, request] of requests.entries()) {
      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        `req-fenced-${index}`,
        request.method,
        request.params,
      ));
      expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
      if (!isRuntimeDaemonSuccessResponse(response)) {
        expect(response.error).toMatchObject({ code: 'conflict' });
      }
    }

    expect(fencedMutations).toEqual(requests.map((request) => request.method));
    dispatcher.close();
  });

  it('rejects non-versioned session setting writes on a shared daemon', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-settings-'));
    try {
      const runtime = makeRuntime();
      const update = vi.spyOn(runtime.sessions, 'updateSettings');
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime,
        controlJournal,
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, { operationDeduplication: true });

      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-legacy-settings',
        'session.settings.update',
        { sessionId: 'session-1', patch: { model: 'racing-model' } },
        {
          operationId: 'op-legacy-settings',
          journalEpoch: controlJournal.journalEpoch,
        },
      ));

      expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
      if (!isRuntimeDaemonSuccessResponse(response)) {
        expect(response.error.code).toBe('client_upgrade_required');
      }
      expect(update).not.toHaveBeenCalled();
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('orders an after-turn continuation once across an exact operation retry', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-input-'));
    try {
      const runtime = makeRuntime();
      vi.spyOn(runtime.runs, 'get').mockResolvedValue({
        runId: 'run-active',
        sessionId: 'session-1',
        phase: 'running',
        startedAt: '2026-07-14T00:00:00.000Z',
        provider: 'mock',
      });
      const submit = vi.spyOn(runtime.runs, 'submitInput').mockResolvedValue({
        accepted: true,
        delivery: 'after_turn',
        runId: 'run-continuation',
        sessionId: 'session-1',
        afterRunId: 'run-active',
        sessionOrder: 2,
      });
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime,
        controlJournal,
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, { operationDeduplication: true });
      const operation = {
        operationId: 'op-input-1',
        journalEpoch: controlJournal.journalEpoch,
      } as const;
      const params = {
        sessionId: 'session-1',
        afterRunId: 'run-active',
        delivery: 'after_turn',
        input: { type: 'text', text: 'continue' },
      } as const;

      const first = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-input-1',
        'run.input.submit',
        params,
        operation,
      ));
      const retry = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-input-2',
        'run.input.submit',
        params,
        operation,
      ));

      expect(isRuntimeDaemonSuccessResponse(first)).toBe(true);
      expect(retry).toEqual({ ...first, id: 'req-input-2' });
      expect(runtime.runs.get).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(1);
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('queues an interrupt once across an exact operation retry', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-interrupt-'));
    try {
      const runtime = makeRuntime();
      vi.spyOn(runtime.runs, 'get').mockResolvedValue({
        runId: 'run-active',
        sessionId: 'session-1',
        phase: 'running',
        startedAt: '2026-07-14T00:00:00.000Z',
        provider: 'mock',
      });
      const submit = vi.spyOn(runtime.runs, 'submitInput').mockResolvedValue({
        accepted: true,
        delivery: 'interrupt',
        inputId: 'input-interrupt-1',
        runId: 'run-active',
        sessionId: 'session-1',
        afterRunId: 'run-active',
        sessionOrder: 1,
      });
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime,
        controlJournal,
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, { operationDeduplication: true });
      const operation = {
        operationId: 'op-interrupt-1',
        journalEpoch: controlJournal.journalEpoch,
      } as const;
      const params = {
        sessionId: 'session-1',
        afterRunId: 'run-active',
        delivery: 'interrupt',
        input: { type: 'text', text: 'urgent' },
      } as const;

      const first = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-interrupt-1',
        'run.input.submit',
        params,
        operation,
      ));
      const retry = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-interrupt-2',
        'run.input.submit',
        params,
        operation,
      ));

      expect(isRuntimeDaemonSuccessResponse(first)).toBe(true);
      if (isRuntimeDaemonSuccessResponse(first)) {
        expect(first.result).toMatchObject({
          accepted: true,
          delivery: 'interrupt',
          inputId: 'input-interrupt-1',
        });
      }
      expect(retry).toEqual({ ...first, id: 'req-interrupt-2' });
      expect(runtime.runs.get).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        afterRunId: 'run-active',
        delivery: 'interrupt',
        origin: expect.objectContaining({ operationId: 'op-interrupt-1' }),
      }));
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps interrupt input fenced to the current active session run', async () => {
    const runtime = makeRuntime();
    const get = vi.spyOn(runtime.runs, 'get').mockResolvedValue({
      runId: 'run-queued',
      sessionId: 'session-1',
      phase: 'queued',
      startedAt: '2026-07-14T00:00:00.000Z',
      provider: 'mock',
    });
    const submit = vi.spyOn(runtime.runs, 'submitInput');
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);
    const params = {
      sessionId: 'session-1',
      afterRunId: 'run-queued',
      delivery: 'interrupt',
      input: { type: 'text', text: 'urgent' },
    } as const;

    const queued = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-interrupt-queued',
      'run.input.submit',
      params,
    ));
    expect(isRuntimeDaemonSuccessResponse(queued)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(queued)) {
      expect(queued.result).toMatchObject({ accepted: false, reason: 'stale_run' });
    }

    get.mockResolvedValue({
      runId: 'run-other-session',
      sessionId: 'session-2',
      phase: 'running',
      startedAt: '2026-07-14T00:00:00.000Z',
      provider: 'mock',
    });
    const crossSession = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-interrupt-cross-session',
      'run.input.submit',
      { ...params, afterRunId: 'run-other-session' },
    ));
    expect(isRuntimeDaemonSuccessResponse(crossSession)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(crossSession)) {
      expect(crossSession.error.code).toBe('conflict');
    }
    expect(submit).not.toHaveBeenCalled();
    dispatcher.close();
  });

  it.each(['waiting_agent', 'recovering'] as const)(
    'keeps %s Runs eligible for after-turn input',
    async (phase) => {
      const runtime = makeRuntime();
      vi.spyOn(runtime.runs, 'get').mockResolvedValue({
        runId: 'run-active',
        sessionId: 'session-1',
        phase,
        startedAt: '2026-07-14T00:00:00.000Z',
        provider: 'mock',
      });
      const submit = vi.spyOn(runtime.runs, 'submitInput').mockResolvedValue({
        accepted: true,
        delivery: 'after_turn',
        runId: 'run-continuation',
        sessionId: 'session-1',
        afterRunId: 'run-active',
        sessionOrder: 2,
      });
      const dispatcher = createRuntimeDaemonDispatcher({ runtime });
      await initializeDispatcher(dispatcher);

      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        `req-after-turn-${phase}`,
        'run.input.submit',
        {
          sessionId: 'session-1',
          afterRunId: 'run-active',
          delivery: 'after_turn',
          input: { type: 'text', text: 'continue' },
        },
      ));

      expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
      if (isRuntimeDaemonSuccessResponse(response)) {
        expect(response.result).toMatchObject({
          accepted: true,
          runId: 'run-continuation',
        });
      }
      expect(submit).toHaveBeenCalledTimes(1);
      dispatcher.close();
    },
  );

  it('admits after-turn input only for an exact Actor durability-unknown Run', async () => {
    const runtime = makeRuntime();
    const get = vi.spyOn(runtime.runs, 'get').mockResolvedValue({
      runId: 'run-actor-unknown',
      sessionId: 'session-1',
      phase: 'unknown',
      stage: 'unknown',
      startedAt: '2026-08-09T00:00:00.000Z',
      provider: 'mock',
      lifecycleError: {
        code: 'actor_settlement_not_persisted',
        message: 'Actor settlement persistence is unknown.',
        retryable: false,
      },
    });
    const submit = vi.spyOn(runtime.runs, 'submitInput').mockResolvedValue({
      accepted: true,
      delivery: 'after_turn',
      runId: 'run-continuation',
      sessionId: 'session-1',
      afterRunId: 'run-actor-unknown',
      sessionOrder: 2,
    });
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);
    const input = {
      sessionId: 'session-1',
      afterRunId: 'run-actor-unknown',
      input: { type: 'text', text: 'continue after repair' },
    } as const;

    const afterTurn = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-actor-unknown-after-turn',
      'run.input.submit',
      { ...input, delivery: 'after_turn' },
    ));
    expect(isRuntimeDaemonSuccessResponse(afterTurn)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(afterTurn)) {
      expect(afterTurn.result).toMatchObject({ accepted: true, delivery: 'after_turn' });
    }
    expect(submit).toHaveBeenCalledTimes(1);

    submit.mockClear();
    const interrupt = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-actor-unknown-interrupt',
      'run.input.submit',
      { ...input, delivery: 'interrupt' },
    ));
    expect(isRuntimeDaemonSuccessResponse(interrupt)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(interrupt)) {
      expect(interrupt.result).toMatchObject({ accepted: false, reason: 'stale_run' });
    }
    expect(submit).not.toHaveBeenCalled();

    get.mockResolvedValue({
      runId: 'run-other-unknown',
      sessionId: 'session-1',
      phase: 'unknown',
      stage: 'unknown',
      startedAt: '2026-08-09T00:00:00.000Z',
      provider: 'mock',
      lifecycleError: {
        code: 'run_control_unknown',
        message: 'Run control is unknown.',
        retryable: false,
      },
    });
    const unrelatedUnknown = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-other-unknown-after-turn',
      'run.input.submit',
      { ...input, afterRunId: 'run-other-unknown', delivery: 'after_turn' },
    ));
    expect(isRuntimeDaemonSuccessResponse(unrelatedUnknown)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(unrelatedUnknown)) {
      expect(unrelatedUnknown.result).toMatchObject({ accepted: false, reason: 'stale_run' });
    }
    expect(submit).not.toHaveBeenCalled();
    dispatcher.close();
  });

  it('binds reverse calls to one run without degrading the active MCP snapshot', async () => {
    const runtime = makeRuntime();
    const activeExtensionRuntime = createExtensionRuntime();
    const mcpItems = Array.from({ length: 14 }, (_, index) => ({
      id: `mcp:db-query-server:tool:tool-${index + 1}`,
      kind: 'tool' as const,
      name: `tool-${index + 1}`,
    }));
    activeExtensionRuntime.registerCapabilityProvider({
      id: 'mcp',
      kinds: ['tool'],
      search: async () => mcpItems.slice(0, 10),
      searchSnapshot: async (_query, options) => {
        if (options?.server !== undefined) expect(options.server).toBe('db-query-server');
        return {
          items: mcpItems,
          revision: 'db-query-server-v1',
          complete: true,
          freshness: 'live',
        };
      },
    });
    setActiveExtensionRuntime(activeExtensionRuntime);
    const reverseBridgeHub = createRuntimeDaemonReverseBridgeHub();
    let notificationListener: ((notification: RuntimeDaemonNotification) => void) | undefined;
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      reverseBridgeHub,
      notify(notification) {
        notificationListener?.(notification);
      },
    });
    await initializeDispatcher(dispatcher);
    const transport: RuntimeDaemonClientTransport = {
      async request(method, params, operation) {
        const response = await dispatcher.handle(createRuntimeDaemonRequest(
          `req-loopback-${randomRequestSuffix()}`,
          method,
          params,
          operation,
        ));
        if (isRuntimeDaemonSuccessResponse(response)) return response.result;
        throw Object.assign(new Error(response.error.message), { code: response.error.code });
      },
      subscribe(listener) {
        notificationListener = listener;
        return {
          close() {
            if (notificationListener === listener) notificationListener = undefined;
          },
        };
      },
    };
    let handlerCalls = 0;
    const start = vi.spyOn(runtime.runs, 'start').mockImplementation(async (input) => {
      const trusted = input as RuntimeStartRunInput & {
        readonly providerCredential?: string;
        readonly trustedRunId: string;
      };
      expect(trusted.providerCredential).toBe('space-secret');
      const extensionRuntime = input.options?.extensionRuntime;
      if (!extensionRuntime) throw new Error('expected run-bound extension runtime');
      const mcpSearch = getTool('mcp_search');
      if (!mcpSearch) throw new Error('expected mcp_search tool');
      const toolContext = {
        backups: new Map(),
        executionCwd: process.cwd(),
        gitRoot: process.cwd(),
        extensionRuntime,
      } satisfies KodaXToolExecutionContext;
      if (trusted.prompt === 'host only') {
        const hostOnlyOutput = await mcpSearch({ kind: 'tool' }, toolContext);
        if (typeof hostOnlyOutput !== 'string') throw new Error('expected Host-only search result');
        expect(hostOnlyOutput).toContain('freshness=live | complete=true');
        expect(hostOnlyOutput).toContain('Page: returned=1 | total=1 | has_more=false');
        expect(hostOnlyOutput).toContain('host:');
        const missingServerOutput = await mcpSearch({
          server: 'db-query-server',
          kind: 'tool',
        }, toolContext);
        if (typeof missingServerOutput !== 'string') {
          throw new Error('expected empty missing-server search result');
        }
        expect(missingServerOutput).toContain('freshness=unknown | complete=false');
        expect(missingServerOutput).toContain('Page: returned=0 | total=0 | has_more=false');
        expect(missingServerOutput).not.toContain('[Tool Error]');
      } else if (trusted.prompt === 'legacy MCP') {
        const legacyOutput = await mcpSearch({
          server: 'db-query-server',
          kind: 'tool',
          limit: 30,
        }, toolContext);
        if (typeof legacyOutput !== 'string') throw new Error('expected legacy MCP search result');
        expect(legacyOutput).toContain('freshness=unknown | complete=false');
        expect(legacyOutput).toContain('Page: returned=14 | total=14 | has_more=false');
        expect(legacyOutput).toContain('mcp:db-query-server:tool:tool-14');
      } else {
        const searchOutput = await mcpSearch({
          server: 'db-query-server',
          kind: 'tool',
          limit: 30,
        }, toolContext);
        if (typeof searchOutput !== 'string') throw new Error('expected text mcp_search result');
        expect(searchOutput).toContain(
          'Catalog: revision=db-query-server-v1 | freshness=live | complete=true',
        );
        expect(searchOutput).toContain('Page: returned=14 | total=14 | has_more=false');
        expect(searchOutput).toContain('mcp:db-query-server:tool:tool-14');
        expect(searchOutput).not.toContain('host:');
        const hostSearchOutput = await mcpSearch({
          server: 'host',
          kind: 'tool',
        }, toolContext);
        if (typeof hostSearchOutput !== 'string') throw new Error('expected Host Tool search result');
        expect(hostSearchOutput).toContain('freshness=live | complete=true');
        expect(hostSearchOutput).toContain('Page: returned=1 | total=1 | has_more=false');
        expect(hostSearchOutput).toContain('host:');
        expect(hostSearchOutput).not.toContain('mcp:db-query-server:');
        const combinedSearchOutput = await mcpSearch({ kind: 'tool', limit: 30 }, toolContext);
        if (typeof combinedSearchOutput !== 'string') {
          throw new Error('expected combined capability search result');
        }
        expect(combinedSearchOutput).toContain('freshness=live | complete=true');
        expect(combinedSearchOutput).toContain('Page: returned=15 | total=15 | has_more=false');
        expect(combinedSearchOutput).toContain('host:');
        expect(combinedSearchOutput).toContain('mcp:db-query-server:tool:tool-14');
        const snapshot = await extensionRuntime.searchCapabilitySnapshot?.('mcp', '', {
          kind: 'tool',
          server: 'db-query-server',
        });
        expect(snapshot).toMatchObject({
          items: mcpItems,
          revision: 'db-query-server-v1',
          complete: true,
          freshness: 'live',
        });
      }
      const [tool] = await extensionRuntime.searchCapabilities('mcp', 'space_artifact_create', {
        kind: 'tool',
      }) as Array<{ readonly id: string }>;
      if (!tool) throw new Error('expected bound host tool');
      await expect(extensionRuntime.executeCapability('mcp', tool.id, { title: 'Report' }))
        .resolves.toMatchObject({ content: 'artifact-created' });
      const result: RuntimeRunResult = {
        runId: trusted.trustedRunId,
        sessionId: input.sessionId,
        phase: 'completed',
      };
      return { runId: result.runId, sessionId: result.sessionId, result: Promise.resolve(result) };
    });
    vi.spyOn(runtime.runs, 'get').mockImplementation(async (runId) => ({
      runId,
      sessionId: 'session-1',
      phase: 'running',
      startedAt: '2026-07-14T00:00:00.000Z',
      provider: 'mock',
    }));
    const client = createRuntimeDaemonClient({
      identity: runtime.identity,
      transport,
      capabilities: {},
    });
    const credential = await client.credentials.register({ providers: ['mock'] }, async () => 'space-secret');
    const tools = await client.hostTools.register([{
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

    const handle = await client.runs.start({
      sessionId: 'session-1',
      prompt: 'create an artifact',
      credential: { leaseId: credential.id, provider: 'mock' },
      hostTools: { leaseId: tools.id },
    });
    await expect(client.runs.get(handle.runId)).resolves.toMatchObject({
      requirements: {
        credential: { leaseId: credential.id, provider: 'mock', state: 'ready' },
        hostTools: { leaseId: tools.id, state: 'ready' },
      },
    });
    await expect(handle.result).resolves.toMatchObject({ phase: 'completed' });

    const emptyExtensionRuntime = createExtensionRuntime().activate();
    const hostOnlyHandle = await client.runs.start({
      sessionId: 'session-1',
      prompt: 'host only',
      credential: { leaseId: credential.id, provider: 'mock' },
      hostTools: { leaseId: tools.id },
    });
    await expect(hostOnlyHandle.result).resolves.toMatchObject({ phase: 'completed' });

    const legacyExtensionRuntime = createExtensionRuntime();
    legacyExtensionRuntime.registerCapabilityProvider({
      id: 'mcp',
      kinds: ['tool'],
      search: async (_query, options) => mcpItems.slice(0, options?.limit ?? 10),
    });
    legacyExtensionRuntime.activate();
    const legacyHandle = await client.runs.start({
      sessionId: 'session-1',
      prompt: 'legacy MCP',
      credential: { leaseId: credential.id, provider: 'mock' },
      hostTools: { leaseId: tools.id },
    });
    await expect(legacyHandle.result).resolves.toMatchObject({ phase: 'completed' });

    expect(start).toHaveBeenCalledTimes(3);
    expect(handlerCalls).toBe(3);
    await client.close();
    dispatcher.close();
    reverseBridgeHub.close();
    await activeExtensionRuntime.dispose();
    await emptyExtensionRuntime.dispose();
    await legacyExtensionRuntime.dispose();
  });

  it('binds manual compaction to a stable v2 operation without exposing the secret', async () => {
    const runtime = makeRuntime();
    const reverseBridgeHub = createRuntimeDaemonReverseBridgeHub();
    let notificationListener: ((notification: RuntimeDaemonNotification) => void) | undefined;
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      reverseBridgeHub,
      notify(notification) {
        notificationListener?.(notification);
      },
    });
    await initializeDispatcher(dispatcher);
    const transport: RuntimeDaemonClientTransport = {
      async request(method, params, operation) {
        const response = await dispatcher.handle(createRuntimeDaemonRequest(
          `req-compact-${randomRequestSuffix()}`,
          method,
          params,
          operation,
        ));
        if (isRuntimeDaemonSuccessResponse(response)) return response.result;
        throw Object.assign(new Error(response.error.message), { code: response.error.code });
      },
      subscribe(listener) {
        notificationListener = listener;
        return {
          close() {
            if (notificationListener === listener) notificationListener = undefined;
          },
        };
      },
    };
    const compact = vi.spyOn(runtime.sessions, 'compact').mockImplementation(async (input) => {
      const trusted = input as RuntimeCompactSessionInput & {
        readonly providerCredentialAccess?: {
          readonly allowedProviders: readonly string[];
          acquire(provider: string, purpose: 'compaction', signal: AbortSignal): Promise<string>;
        };
      };
      expect(JSON.stringify(input)).not.toContain('keychain-secret');
      expect(trusted.providerCredentialAccess?.allowedProviders).toEqual(['openai']);
      const credential = await trusted.providerCredentialAccess?.acquire(
        'openai',
        'compaction',
        new AbortController().signal,
      );
      expect(credential).toBe('keychain-secret');
      return {
        compacted: true,
        tokensBefore: 1_000,
        tokensAfter: 100,
      } as RuntimeCompactSessionResult;
    });
    const client = createRuntimeDaemonClient({
      identity: runtime.identity,
      transport,
      journalEpoch: 'journal-compact',
      capabilities: { providerCredentialBroker: { version: 2 } },
    });
    const requests: unknown[] = [];
    const lease = await client.credentials.registerScoped(
      { providers: ['openai'] },
      async (request) => {
        requests.push(request);
        return 'keychain-secret';
      },
    );

    await expect(client.sessions.compact({
      sessionId: 'session-1',
      provider: 'openai',
      credential: {
        leaseId: lease.id,
        mode: 'scoped',
        providers: ['openai'],
      },
      operation: {
        operationId: 'compact-op-1',
        journalEpoch: 'journal-compact',
      },
    })).resolves.toMatchObject({ compacted: true });

    await expect(client.sessions.compact({
      sessionId: 'session-1',
      provider: 'anthropic',
      credential: {
        leaseId: lease.id,
        mode: 'scoped',
        providers: ['openai'],
      },
      operation: {
        operationId: 'compact-op-provider-mismatch',
        journalEpoch: 'journal-compact',
      },
    })).rejects.toMatchObject({ code: 'credential_unavailable' });

    expect(requests).toEqual([expect.objectContaining({
      provider: 'openai',
      sessionId: 'session-1',
      target: {
        kind: 'operation',
        operation: 'session.compact',
        operationId: 'compact-op-1',
      },
      purpose: 'compaction',
    })]);
    expect(compact).toHaveBeenCalledTimes(1);
    await client.close();
    dispatcher.close();
    reverseBridgeHub.close();
  });

  it('binds a scoped credential to the exact admitted Agent turn', async () => {
    const runtime = makeRuntime();
    const reverseBridgeHub = createRuntimeDaemonReverseBridgeHub();
    let notificationListener: ((notification: RuntimeDaemonNotification) => void) | undefined;
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      reverseBridgeHub,
      notify(notification) {
        notificationListener?.(notification);
      },
    });
    await initializeDispatcher(dispatcher);
    const transport: RuntimeDaemonClientTransport = {
      async request(method, params, operation) {
        const response = await dispatcher.handle(createRuntimeDaemonRequest(
          `req-agent-credential-${randomRequestSuffix()}`,
          method,
          params,
          operation,
        ));
        if (isRuntimeDaemonSuccessResponse(response)) return response.result;
        throw Object.assign(new Error(response.error.message), { code: response.error.code });
      },
      subscribe(listener) {
        notificationListener = listener;
        return {
          close() {
            if (notificationListener === listener) notificationListener = undefined;
          },
        };
      },
    };
    const spawn = vi.spyOn(runtime.agents, 'spawn').mockImplementation(
      async (_sessionId, actorInput, options) => {
        const trusted = options as typeof options & {
          readonly providerCredentialAccessFactory?: (target: {
            readonly actorPath: string;
            readonly turnId: string;
            readonly providers: readonly string[];
          }) => {
            readonly allowedProviders: readonly string[];
            acquire(provider: string, purpose: 'agent', signal: AbortSignal): Promise<string>;
          };
        };
        expect(actorInput).not.toHaveProperty('credential');
        if (actorInput.kind === 'external') {
          expect(trusted?.providerCredentialAccessFactory).toBeUndefined();
          return {
            actorPath: '/root/remote',
            turnId: 'turn-agent-1',
            state: 'accepted',
          };
        }
        const access = trusted?.providerCredentialAccessFactory?.({
          actorPath: '/root/reviewer',
          turnId: 'turn-agent-1',
          providers: ['openai'],
        });
        expect(access?.allowedProviders).toEqual(['openai']);
        await expect(access?.acquire(
          'openai',
          'agent',
          new AbortController().signal,
        )).resolves.toBe('keychain-agent-secret');
        return {
          actorPath: '/root/reviewer',
          turnId: 'turn-agent-1',
          state: 'accepted',
        };
      },
    );
    const readAgentDetail = runtime.agents.detail.bind(runtime.agents);
    let exposeCurrentTurn = false;
    vi.spyOn(runtime.agents, 'detail').mockImplementation(async (sessionId, actorPath) => {
      const detail = await readAgentDetail(sessionId, actorPath);
      return {
        ...detail,
        actor: {
          ...detail.actor,
          path: actorPath,
          kind: 'native',
          ...(exposeCurrentTurn ? { currentTurnId: 'turn-agent-followup' } : {}),
        },
      };
    });
    const followup = vi.spyOn(runtime.agents, 'followup').mockImplementation(
      async (_sessionId, actorPath, _objective, options) => {
        const trusted = options as typeof options & {
          readonly providerCredentialAccessFactory?: (target: {
            readonly actorPath: string;
            readonly turnId: string;
            readonly providers: readonly string[];
          }) => {
            acquire(provider: string, purpose: 'agent', signal: AbortSignal): Promise<string>;
          };
        };
        const access = trusted?.providerCredentialAccessFactory?.({
          actorPath,
          turnId: 'turn-agent-followup',
          providers: ['openai'],
        });
        if (access === undefined) {
          return {
            delivery: 'current_turn',
            turn: { actorPath, turnId: 'turn-agent-followup', state: 'running' },
          };
        }
        await expect(access?.acquire(
          'openai',
          'agent',
          new AbortController().signal,
        )).resolves.toBe('keychain-agent-secret');
        return {
          delivery: 'started_turn',
          turn: { actorPath, turnId: 'turn-agent-followup', state: 'accepted' },
        };
      },
    );
    const client = createRuntimeDaemonClient({
      identity: runtime.identity,
      transport,
      journalEpoch: 'journal-agent',
      capabilities: {
        actorControlPlane: { version: 1, methodNamespace: 'agents' },
        providerCredentialBroker: { version: 2 },
      },
    });
    const requests: unknown[] = [];
    const lease = await client.credentials.registerScoped(
      { providers: ['openai'] },
      async (request) => {
        requests.push(request);
        return 'keychain-agent-secret';
      },
    );

    await expect(client.agents.spawn('session-1', {
      taskName: 'reviewer',
      objective: 'Review with an explicit lease.',
      capabilities: { providers: ['openai'] },
    }, {
      credential: {
        leaseId: lease.id,
        mode: 'scoped',
        providers: ['openai'],
      },
      operation: { operationId: 'agent-op-1' },
    })).resolves.toMatchObject({ turnId: 'turn-agent-1' });

    await expect(client.agents.spawn('session-1', {
      taskName: 'unbound-native',
      objective: 'Must not use daemon environment credentials.',
    })).rejects.toMatchObject({ code: 'credential_unavailable' });
    await expect(client.agents.spawn('session-1', {
      taskName: 'remote',
      objective: 'Use the external credentialRef plane.',
      kind: 'external',
    })).resolves.toMatchObject({ turnId: 'turn-agent-1' });
    await expect(client.agents.spawn('session-1', {
      taskName: 'bound-remote',
      objective: 'Must not cross credential planes.',
      kind: 'external',
    }, {
      credential: {
        leaseId: lease.id,
        mode: 'scoped',
        providers: ['openai'],
      },
    })).rejects.toMatchObject({ code: 'invalid_params' });

    await expect(client.agents.followup(
      'session-1',
      '/root/reviewer',
      'Continue with the same narrow Provider set.',
      {
        credential: {
          leaseId: lease.id,
          mode: 'scoped',
          providers: ['openai'],
        },
      },
    )).resolves.toMatchObject({ turn: { turnId: 'turn-agent-followup' } });
    await expect(client.agents.followup(
      'session-1',
      '/root/reviewer',
      'Must not use the daemon environment.',
    )).rejects.toMatchObject({ code: 'credential_unavailable' });
    exposeCurrentTurn = true;
    await expect(client.agents.followup(
      'session-1',
      '/root/reviewer',
      'Continue the already credential-bound turn.',
    )).resolves.toMatchObject({ delivery: 'current_turn' });

    expect(requests).toEqual([
      expect.objectContaining({
        provider: 'openai',
        sessionId: 'session-1',
        target: {
          kind: 'actor_turn',
          actorPath: '/root/reviewer',
          turnId: 'turn-agent-1',
        },
        purpose: 'agent',
      }),
      expect.objectContaining({
        provider: 'openai',
        sessionId: 'session-1',
        target: {
          kind: 'actor_turn',
          actorPath: '/root/reviewer',
          turnId: 'turn-agent-followup',
        },
        purpose: 'agent',
      }),
    ]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(followup).toHaveBeenCalledTimes(2);
    await client.close();
    dispatcher.close();
    reverseBridgeHub.close();
  });

  it('rejects a host tool binding whose names collide with registered tools', async () => {
    // FEATURE_294: materialized host tools must never shadow a registry tool,
    // so the binding is rejected up front (before any hostToolRuns record).
    const disposeCollidingTool = registerTool({
      name: 'space_colliding_tool',
      description: 'Registered before the host binding attempts the same name',
      input_schema: { type: 'object' },
      handler: async () => 'ok',
      sideEffect: 'readonly',
      planModeAllowed: true,
    });
    try {
      const runtime = makeRuntime();
      const reverseBridgeHub = createRuntimeDaemonReverseBridgeHub();
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime,
        reverseBridgeHub,
        notify() {},
      });
      await initializeDispatcher(dispatcher);
      const transport: RuntimeDaemonClientTransport = {
        async request(method, params, operation) {
          const response = await dispatcher.handle(createRuntimeDaemonRequest(
            `req-collide-${randomRequestSuffix()}`,
            method,
            params,
            operation,
          ));
          if (isRuntimeDaemonSuccessResponse(response)) return response.result;
          throw Object.assign(new Error(response.error.message), { code: response.error.code });
        },
        subscribe() {
          return { close() {} };
        },
      };
      const client = createRuntimeDaemonClient({
        identity: runtime.identity,
        transport,
        capabilities: {},
      });
      const tools = await client.hostTools.register([{
        name: 'space_colliding_tool',
        description: 'Host duplicate of a registered tool',
        inputSchema: { type: 'object' },
        sideEffect: 'none',
      }], {
        async space_colliding_tool() {
          return { content: 'never-reached' };
        },
      });
      await expect(client.runs.start({
        sessionId: 'session-1',
        prompt: 'colliding host tool binding',
        hostTools: { leaseId: tools.id },
      })).rejects.toMatchObject({ code: 'invalid_params' });
      await client.close();
      dispatcher.close();
      reverseBridgeHub.close();
    } finally {
      disposeCollidingTool();
    }
  });

  it('rejects initialize when the requested profile differs from the daemon identity', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });

    const mismatch = await dispatcher.handle(createRuntimeDaemonRequest('req-profile-mismatch', 'initialize', {
      profile: 'space',
    }));
    expect(isRuntimeDaemonSuccessResponse(mismatch)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(mismatch)) {
      expect(mismatch.error.code).toBe('conflict');
      expect(mismatch.error.message).toContain('Runtime daemon profile mismatch');
    }

    const accepted = await dispatcher.handle(createRuntimeDaemonRequest('req-profile-ok', 'initialize', {
      profile: 'default',
    }));
    expect(isRuntimeDaemonSuccessResponse(accepted)).toBe(true);
  });

  it('routes every declared daemon method to an implemented dispatcher branch', async () => {
    for (const method of RUNTIME_DAEMON_METHODS) {
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime: makeRuntime(),
        allowAgentRegistrationAdmin: true,
      });
      if (!isInitializeMethod(method)) {
        await initializeDispatcher(dispatcher);
      }

      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        `req-${method.replace(/[^a-zA-Z0-9]/g, '-')}`,
        method,
        METHOD_SMOKE_PARAMS[method],
      ));
      dispatcher.close();

      const implemented = isRuntimeDaemonSuccessResponse(response) || (
        (
          method === 'daemon.management.get'
          || method === 'daemon.rollbackToInline'
        )
        && response.error.code === 'client_upgrade_required'
      );
      expect(
        implemented,
        `${method} should be implemented by runtime daemon dispatcher`,
      ).toBe(true);
    }
  });

  it('requires host authorization but never treats client capability claims as authorization', async () => {
    const hostDenied = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      capabilities: {
        externalAgentAdmin: { version: 99 },
        a2aConfigReconciler: { version: 99 },
      },
    });
    const deniedInitialization = await initializeDispatcher(hostDenied, { configAdmin: true });
    expect(deniedInitialization).toMatchObject({ capabilities: { externalAgents: true } });
    expect((deniedInitialization.capabilities as Record<string, unknown>).externalAgentAdmin)
      .toBeUndefined();
    expect((deniedInitialization.capabilities as Record<string, unknown>).a2aConfigReconciler)
      .toBeUndefined();
    const denied = await hostDenied.handle(createRuntimeDaemonRequest(
      'req-agent-admin-host-denied',
      'agentRegistrations.list',
    ));
    expect(isRuntimeDaemonSuccessResponse(denied)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(denied)) {
      expect(denied.error.code).toBe('permission_denied');
    }

    const hostAccepted = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      allowAgentRegistrationAdmin: true,
    });
    const acceptedInitialization = await initializeDispatcher(hostAccepted, {});
    expect(acceptedInitialization).toMatchObject({
      capabilities: { externalAgentAdmin: { version: 1 } },
    });
    const accepted = await hostAccepted.handle(createRuntimeDaemonRequest(
      'req-agent-admin-host-accepted',
      'agentRegistrations.list',
    ));
    expect(isRuntimeDaemonSuccessResponse(accepted)).toBe(true);
  });

  it('forwards registration ownership and revision-CAS mutation fields', async () => {
    const runtime = makeRuntime();
    const upsert = vi.spyOn(runtime.admin.agentRegistrations, 'upsert');
    const setEnabled = vi.spyOn(runtime.admin.agentRegistrations, 'setEnabled');
    const remove = vi.spyOn(runtime.admin.agentRegistrations, 'remove');
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      allowAgentRegistrationAdmin: true,
    });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-agent-set-enabled-cas',
      'agentRegistrations.setEnabled',
      {
        agentId: 'external:smoke',
        enabled: false,
        expectedConfigurationRevision: 'rev-1',
        expectedManagementOwner: null,
        claimOwner: 'runtime-config-test',
      },
    ));
    expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith('external:smoke', false, {
      expectedConfigurationRevision: 'rev-1',
      expectedManagementOwner: null,
      claimOwner: 'runtime-config-test',
    });

    await dispatcher.handle(createRuntimeDaemonRequest(
      'req-agent-upsert-cas',
      'agentRegistrations.upsert',
      {
        registration: METHOD_SMOKE_PARAMS['agentRegistrations.upsert'].registration,
        expectedConfigurationRevision: null,
        expectedManagementOwner: null,
      },
    ));
    expect(upsert).toHaveBeenCalledWith(
      METHOD_SMOKE_PARAMS['agentRegistrations.upsert'].registration,
      { expectedConfigurationRevision: null, expectedManagementOwner: null },
    );

    await dispatcher.handle(createRuntimeDaemonRequest(
      'req-agent-remove-cas',
      'agentRegistrations.remove',
      {
        agentId: 'external:smoke',
        expectedConfigurationRevision: 'rev-1',
        expectedManagementOwner: 'runtime-config-test',
      },
    ));
    expect(remove).toHaveBeenCalledWith('external:smoke', {
      expectedConfigurationRevision: 'rev-1',
      expectedManagementOwner: 'runtime-config-test',
    });

    const invalid = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-agent-set-enabled-empty-owner',
      'agentRegistrations.setEnabled',
      { agentId: 'external:smoke', enabled: false, claimOwner: '' },
    ));
    expect(isRuntimeDaemonSuccessResponse(invalid)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(invalid)) {
      expect(invalid.error).toMatchObject({ code: 'invalid_request' });
    }
  });

  it('uses server-issued scopes instead of client capability claims for authorization', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      grantedScopes: ['session:observe'],
    });
    await initializeDispatcher(dispatcher, { configAdmin: true });

    const read = await dispatcher.handle(createRuntimeDaemonRequest('req-scoped-read', 'session.list'));
    const write = await dispatcher.handle(createRuntimeDaemonRequest('req-scoped-write', 'config.patch', {
      patch: { model: 'mock-model' },
    }));
    const effective = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-scoped-effective',
      'config.effective',
    ));

    expect(isRuntimeDaemonSuccessResponse(read)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(write)).toBe(false);
    expect(isRuntimeDaemonSuccessResponse(effective)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(write)) {
      expect(write.error.code).toBe('unauthorized');
      expect(write.error.message).toContain('integration:admin');
    }
    if (!isRuntimeDaemonSuccessResponse(effective)) {
      expect(effective.error.code).toBe('unauthorized');
      expect(effective.error.message).toContain('integration:admin');
    }
  });

  it('authorizes paged transcript and conversation reads with the session observation scope', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      grantedScopes: ['session:observe'],
    });
    await initializeDispatcher(dispatcher);

    const page = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-scoped-transcript-page',
      'session.transcript.page',
      { sessionId: 'session-1' },
    ));
    const chunk = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-scoped-transcript-chunk',
      'session.transcript.entryChunk',
      { sessionId: 'session-1', revision: 'rev-1', entryIndex: 0 },
    ));
    const search = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-scoped-transcript-search',
      'session.transcript.search',
      { sessionId: 'session-1', query: 'old detail' },
    ));
    const conversation = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-scoped-conversation',
      'session.conversation',
      { sessionId: 'session-1' },
    ));
    const conversationPage = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-scoped-conversation-page',
      'session.conversation.page',
      { sessionId: 'session-1' },
    ));
    const conversationChunk = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-scoped-conversation-chunk',
      'session.conversation.entryChunk',
      { sessionId: 'session-1', revision: 'rev-1', entryIndex: 0 },
    ));

    expect(isRuntimeDaemonSuccessResponse(page)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(chunk)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(search)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(conversation)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(conversationPage)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(conversationChunk)).toBe(true);
    dispatcher.close();
  });

  it('rejects an oversized legacy transcript before it can exceed the wire frame', async () => {
    const runtime = makeRuntime();
    vi.spyOn(runtime.sessions, 'transcript').mockResolvedValue({
      id: 'session-1',
      title: 'Large transcript',
      messages: [{ role: 'user', content: 'x'.repeat(600_000) }],
    } as never);
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-large-legacy-transcript',
      'session.transcript',
      { sessionId: 'session-1' },
    ));

    expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(response)) {
      expect(response.error.code).toBe('invalid_request');
      expect(response.error.message).toContain('session.transcript.page');
    }
    dispatcher.close();
  });

  it('advertises versioned shared-daemon facts including interrupt support', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-capabilities-'));
    try {
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime: makeRuntime(),
        controlJournal,
        allowAgentRegistrationAdmin: true,
      });
      const initialized = await initializeDispatcher(dispatcher, { operationDeduplication: true });

      expect(initialized).toMatchObject({
        capabilities: {
          sessionObservation: { version: 1 },
          operationDeduplication: { version: 1 },
          externalAgentAdmin: {
            version: 1,
            activation: true,
            conditionalMutations: true,
            managementOwner: true,
          },
          afterTurnInput: { version: 1 },
          interruptInput: { version: 1, availability: 'per_run' },
          contextCompaction: {
            version: 3,
            durableBeforeEvict: true,
            exactHistoryRecovery: true,
          },
          transcriptSearch: {
            version: 1,
            defaultScope: 'compacted',
            citedEntries: true,
          },
          conversationHistory: {
            version: 2,
            immutablePaging: true,
            revisionedBoundaries: true,
            ambiguityReporting: true,
            topologyTransparentManagedContext: true,
            directCloneProvenance: true,
          },
          skillLearningLoop: {
            version: 1,
            activation: 'project_scoped_canary',
            immutableDecisions: true,
            recordGatedDiscovery: true,
            exactUseAttribution: true,
            rollback: true,
          },
          askUserTransport: { version: 1 },
          permissionCas: { version: 1 },
          providerCredentialBroker: {
            version: 2,
            credentialLifetime: 'provider_request',
            lazyProviderResolution: true,
          },
          effectiveConfig: {
            version: 1,
            credentialValues: false,
            sourceMetadata: true,
          },
          runBoundHostTools: { version: 2, materializedAgentTools: true },
          coderOwnerFencing: { version: 1 },
          crashOutcomeModel: { version: 2 },
          sessionAdmission: { version: 1, partnerDenied: true },
          completeObservationSnapshot: { version: 1, queuedInputs: true },
          connectionLifecycle: { version: 1 },
          runLifecycleControl: {
            version: 1,
            structuredStopReceipt: true,
            protocolCancellation: true,
            responseAcknowledgement: true,
          },
          typedRuntimeEvents: { version: 1 },
          daemonSafeRunInput: { version: 1 },
          managedRunDurability: {
            version: 1,
            initialInputBeforeExecution: true,
            completedTurnBeforeEvent: true,
            deliveredInputBeforeEvent: true,
            persistenceFailure: 'fail_closed',
          },
          actorSettlementConvergence: {
            version: 2,
            rootFence: 'fail_closed',
            sameOwnerRepair: 'automatic',
            unknownAfterTurnQueue: true,
            terminal: 'failed',
          },
          runtimeEventCoalescing: { version: 1 },
          runtimeAutoModeGuardrail: {
            version: 4,
            owner: 'session-runtime',
            escalationCreatesPermission: true,
            fallbackPersistsEngine: false,
            defaultClassifierTimeoutMs: 45_000,
            defaultSpeculativeWindowMs: 500,
            boundedClassifierInput: true,
            diagnosticsVersion: 1,
            permissionGrantSuggestions: true,
            concretePermissionMatchers: true,
            clientScopeExpansion: false,
          },
          sharedSessionSettings: {
            version: 1,
            keys: expect.arrayContaining([
              'agentMode',
              'autoModeEngine',
              'autoModeClassifierModel',
              'autoModeTimeoutMs',
              'autoModeSpeculativeWindowMs',
            ]),
          },
          durableRecoveryQueries: {
            version: 1,
            operationResult: true,
            daemonPreflight: true,
            terminalAcknowledgement: false,
          },
        },
      });
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('closes a Session observation that resolves after protocol cancellation', async () => {
    const baseRuntime = makeRuntime();
    let resolveObservation:
      | ((observation: RuntimeSessionObservation) => void)
      | undefined;
    const observation = createTestObservation('session-1');
    const closeObservation = vi.spyOn(observation, 'close');
    let reusedWaitSignal: AbortSignal | undefined;
    const runtime: KodaXRuntime & { emit(event: RuntimeEvent): void } = {
      ...baseRuntime,
      sessions: {
        ...baseRuntime.sessions,
        observe() {
          return new Promise<RuntimeSessionObservation>((resolve) => {
            resolveObservation = resolve;
          });
        },
      },
      agents: {
        ...baseRuntime.agents,
        wait(_sessionId, _afterSequence, _timeoutMs, options) {
          reusedWaitSignal = options?.signal;
          return new Promise<undefined>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve(undefined), {
              once: true,
            });
          });
        },
      },
    };
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);
    const pending = dispatcher.handle(createRuntimeDaemonRequest(
      'req-observe-slow',
      'session.observe',
      { sessionId: 'session-1' },
    ));
    await Promise.resolve();

    const cancelled = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-cancel-observe',
      'request.cancel',
      { requestId: 'req-observe-slow' },
    ));
    expect(cancelled).toMatchObject({
      result: { ok: true },
    });
    const response = await pending;
    expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(response)) {
      expect(response.error.code).toBe('read_cancelled');
    }
    const reused = dispatcher.handle(createRuntimeDaemonRequest(
      'req-observe-slow',
      'agents.wait',
      { sessionId: 'session-1', timeoutMs: 30_000 },
    ));
    await Promise.resolve();
    resolveObservation?.(observation);
    await vi.waitFor(() => expect(closeObservation).toHaveBeenCalledTimes(1));
    await expect(dispatcher.handle(createRuntimeDaemonRequest(
      'req-observe-slow',
      'run.get',
      { runId: 'run-still-running' },
    ))).resolves.toMatchObject({ error: { code: 'invalid_request' } });
    await dispatcher.handle(createRuntimeDaemonRequest(
      'req-cancel-reused-observe-id',
      'request.cancel',
      { requestId: 'req-observe-slow' },
    ));
    await expect(reused).resolves.toMatchObject({
      error: { code: 'read_cancelled' },
    });
    expect(reusedWaitSignal?.aborted).toBe(true);
    dispatcher.close();
  });

  it('cancels waiters without cancelling Runs and fences late request-id cleanup', async () => {
    const runtime = makeRuntime();
    let resolveRun: ((result: RuntimeRunResult) => void) | undefined;
    const runResult = new Promise<RuntimeRunResult>((resolve) => {
      resolveRun = resolve;
    });
    let agentWaitSignal: AbortSignal | undefined;
    vi.spyOn(runtime.runs, 'await').mockReturnValue(runResult);
    const abortRun = vi.spyOn(runtime.runs, 'abort');
    vi.spyOn(runtime.agents, 'wait').mockImplementation(
      (_sessionId, _afterSequence, _timeoutMs, options) => {
        agentWaitSignal = options?.signal;
        return new Promise<undefined>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(undefined), {
            once: true,
          });
        });
      },
    );
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const first = dispatcher.handle(createRuntimeDaemonRequest(
      'req-reused-after-cancel',
      'run.await',
      { runId: 'run-still-running' },
    ));
    await Promise.resolve();
    await expect(dispatcher.handle(createRuntimeDaemonRequest(
      'req-cancel-run-waiter',
      'request.cancel',
      { requestId: 'req-reused-after-cancel' },
    ))).resolves.toMatchObject({ result: { ok: true } });
    await expect(first).resolves.toMatchObject({
      error: { code: 'read_cancelled' },
    });
    expect(abortRun).not.toHaveBeenCalled();

    const second = dispatcher.handle(createRuntimeDaemonRequest(
      'req-reused-after-cancel',
      'agents.wait',
      { sessionId: 'session-1', timeoutMs: 30_000 },
    ));
    await Promise.resolve();
    resolveRun?.({
      runId: 'run-still-running',
      sessionId: 'session-1',
      phase: 'completed',
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect(dispatcher.handle(createRuntimeDaemonRequest(
      'req-reused-after-cancel',
      'run.get',
      { runId: 'run-still-running' },
    ))).resolves.toMatchObject({
      error: { code: 'invalid_request' },
    });
    await dispatcher.handle(createRuntimeDaemonRequest(
      'req-cancel-agent-waiter',
      'request.cancel',
      { requestId: 'req-reused-after-cancel' },
    ));
    await expect(second).resolves.toMatchObject({
      error: { code: 'read_cancelled' },
    });
    expect(agentWaitSignal?.aborted).toBe(true);
    dispatcher.close();
  });

  it('does not let control frames reuse an active request id or ack unfinished work', async () => {
    const runtime = makeRuntime();
    let waitSignal: AbortSignal | undefined;
    vi.spyOn(runtime.agents, 'wait').mockImplementation(
      (_sessionId, _afterSequence, _timeoutMs, options) => {
        waitSignal = options?.signal;
        return new Promise<undefined>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(undefined), {
            once: true,
          });
        });
      },
    );
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const pending = dispatcher.handle(createRuntimeDaemonRequest(
      'req-control-fence',
      'agents.wait',
      { sessionId: 'session-1', timeoutMs: 30_000 },
    ));
    await Promise.resolve();
    await expect(dispatcher.handle(createRuntimeDaemonRequest(
      'req-control-fence',
      'request.cancel',
      { requestId: 'req-control-fence' },
    ))).resolves.toMatchObject({ error: { code: 'invalid_request' } });
    expect(waitSignal?.aborted).toBe(false);

    await expect(dispatcher.handle(createRuntimeDaemonRequest(
      'req-early-ack',
      'request.ack',
      { requestId: 'req-control-fence' },
    ))).resolves.toMatchObject({ result: { ok: false } });
    await expect(dispatcher.handle(createRuntimeDaemonRequest(
      'req-control-fence',
      'run.get',
      { runId: 'run-still-running' },
    ))).resolves.toMatchObject({ error: { code: 'invalid_request' } });

    await dispatcher.handle(createRuntimeDaemonRequest(
      'req-final-cancel',
      'request.cancel',
      { requestId: 'req-control-fence' },
    ));
    await expect(pending).resolves.toMatchObject({
      error: { code: 'read_cancelled' },
    });
    dispatcher.close();
  });

  it('cancels an observation after creation until its response is acknowledged', async () => {
    const baseRuntime = makeRuntime();
    const observation = createTestObservation('session-1');
    const closeObservation = vi.spyOn(observation, 'close');
    const runtime: KodaXRuntime & { emit(event: RuntimeEvent): void } = {
      ...baseRuntime,
      sessions: {
        ...baseRuntime.sessions,
        async observe() {
          return observation;
        },
      },
    };
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const observed = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-observe-created',
      'session.observe',
      { sessionId: 'session-1' },
    ));
    expect(isRuntimeDaemonSuccessResponse(observed)).toBe(true);

    const cancelled = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-cancel-created-observe',
      'request.cancel',
      { requestId: 'req-observe-created' },
    ));
    expect(cancelled).toMatchObject({ result: { ok: true } });
    expect(closeObservation).toHaveBeenCalledTimes(1);
    dispatcher.close();
  });

  it('advertises orphan exit only when the daemon host actually enabled that policy', async () => {
    const persistent = createRuntimeDaemonDispatcher({
      runtime: {
        ...makeRuntime(),
        capabilities: {},
      },
      capabilities: {
        daemonOrphanExit: { version: 99 },
        runtimeEventCoalescing: { version: 99 },
      },
    });
    const persistentInitialized = await initializeDispatcher(persistent);
    expect(persistentInitialized.capabilities).not.toHaveProperty('daemonOrphanExit');
    expect(persistentInitialized.capabilities).not.toHaveProperty(
      'runtimeEventCoalescing',
    );
    persistent.close();

    const spaceManaged = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      orphanExitEnabled: true,
    });
    const spaceInitialized = await initializeDispatcher(spaceManaged);
    expect(spaceInitialized).toMatchObject({
      capabilities: {
        daemonOrphanExit: {
          version: 1,
          idleOnly: true,
          bootstrapGrace: true,
        },
      },
    });
    spaceManaged.close();
  });

  it.skipIf(process.platform !== 'win32')(
    'does not trust a spoofed Job-containment environment marker',
    async () => {
      const previous = {
        contained: process.env.KODAX_DAEMON_JOB_CONTAINED,
        jobName: process.env.KODAX_DAEMON_JOB_NAME,
        supervisorPid: process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID,
      };
      try {
        process.env.KODAX_DAEMON_JOB_CONTAINED = '1';
        process.env.KODAX_DAEMON_JOB_NAME = `spoofed-${Date.now()}`;
        process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID = String(process.pid);
        const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });
        const initialized = await initializeDispatcher(dispatcher);
        expect(initialized.capabilities).not.toHaveProperty('daemonShutdownVerification');
        dispatcher.close();
      } finally {
        restoreEnvironment('KODAX_DAEMON_JOB_CONTAINED', previous.contained);
        restoreEnvironment('KODAX_DAEMON_JOB_NAME', previous.jobName);
        restoreEnvironment('KODAX_DAEMON_JOB_SUPERVISOR_PID', previous.supervisorPid);
      }
    },
  );

  it('routes canonical protocol aliases for external clients', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });
    const initialized = await dispatcher.handle(createRuntimeDaemonRequest('req-init', 'runtime.initialize', {
      profile: 'default',
      capabilities: { contextDiagnostics: true },
    }));
    expect(isRuntimeDaemonSuccessResponse(initialized)).toBe(true);

    const status = await dispatcher.handle(createRuntimeDaemonRequest('req-status', 'runtime.status'));
    const capabilities = await dispatcher.handle(createRuntimeDaemonRequest('req-capabilities', 'runtime.capabilities'));
    const setModel = await dispatcher.handle(createRuntimeDaemonRequest('req-model', 'run.setModel', {
      runId: 'run-1',
      model: 'mock-model-2',
    }));
    const setProvider = await dispatcher.handle(createRuntimeDaemonRequest('req-provider', 'run.setProvider', {
      runId: 'run-1',
      provider: 'mock-provider-2',
    }));
    const setReasoning = await dispatcher.handle(createRuntimeDaemonRequest('req-reasoning', 'run.setReasoning', {
      runId: 'run-1',
      reasoning: 'balanced',
    }));
    const activeEntry = await dispatcher.handle(createRuntimeDaemonRequest('req-active-entry', 'session.activeEntry.set', {
      sessionId: 'session-1',
      entryId: 'entry-1',
    }));
    const pendingPermissions = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-permissions',
      'permission.listPending',
    ));
    const skill = await dispatcher.handle(createRuntimeDaemonRequest('req-skill-read', 'skill.read', {
      name: 'review',
    }));
    const removedMcp = await dispatcher.handle(createRuntimeDaemonRequest('req-mcp-remove', 'mcp.server.remove', {
      name: 'local',
    }));

    for (const response of [
      status,
      capabilities,
      setModel,
      setProvider,
      setReasoning,
      activeEntry,
      pendingPermissions,
      skill,
      removedMcp,
    ]) {
      expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
    }
    if (isRuntimeDaemonSuccessResponse(capabilities)) {
      expect(capabilities.result).toMatchObject({
        events: true,
        contextDiagnostics: true,
        actorControlPlane: { version: 1, methodNamespace: 'agents' },
        managedRunDurability: { version: 1 },
        runtimeEventCoalescing: { version: 1 },
      });
    }
    if (isRuntimeDaemonSuccessResponse(activeEntry)) {
      expect(activeEntry.result).toMatchObject({ id: 'session-1', title: 'Active Entry Session' });
    }
    if (isRuntimeDaemonSuccessResponse(skill)) {
      expect(skill.result).toMatchObject({ name: 'review', content: 'Review instructions' });
    }
    if (isRuntimeDaemonSuccessResponse(removedMcp)) {
      expect(removedMcp.result).toBe(true);
    }
  });

  it('returns an explicit upgrade path for the retired agentTasks namespace', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle({
      ...createRuntimeDaemonRequest('req-retired-agent-tasks', 'ping'),
      method: 'agentTasks.start',
      params: {},
    });

    expect(response).toMatchObject({
      kind: 'error',
      error: {
        code: 'client_upgrade_required',
        message: expect.stringContaining('actorControlPlane v1'),
      },
    });
    dispatcher.close();
  });

  it('routes run.start and run.await through the hosted runtime', async () => {
    const runtime = makeRuntime();
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const started = await dispatcher.handle(createRuntimeDaemonRequest('req-1', 'run.start', {
      sessionId: 'session-1',
      prompt: 'hello',
    }));
    const awaited = await dispatcher.handle(createRuntimeDaemonRequest('req-2', 'run.await', {
      runId: 'run-1',
    }));

    expect(isRuntimeDaemonSuccessResponse(started)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(awaited)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(started)) {
      expect(started.result).toMatchObject({ runId: 'run-1', sessionId: 'session-1' });
    }
    if (isRuntimeDaemonSuccessResponse(awaited)) {
      expect(awaited.result).toMatchObject({ runId: 'run-1', sessionId: 'session-1', phase: 'completed' });
    }
  });

  it('strips caller-controlled learning owner identity from raw run.start payloads', async () => {
    const runtime = makeRuntime();
    const start = vi.spyOn(runtime.runs, 'start');
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-untrusted-learning-owner',
      'run.start',
      {
        sessionId: 'session-1',
        prompt: 'hello',
        options: {
          context: {
            gitRoot: 'C:\\trusted-project',
            configHome: 'C:\\attacker-home',
            memoryIdentity: {
              tenantId: 'attacker',
              agentId: 'attacker',
              sessionId: 'session-1',
              projectId: 'other-project',
              configHome: 'C:\\attacker-home',
            },
          },
        },
      },
    ));

    expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
    const context = start.mock.calls[0]?.[0].options?.context as unknown as
      Record<string, unknown> | undefined;
    expect(context).toMatchObject({ gitRoot: 'C:\\trusted-project' });
    expect(context).not.toHaveProperty('configHome');
    expect(context).not.toHaveProperty('memoryIdentity');
    dispatcher.close();
  });

  it('shares retained run results across daemon dispatchers', async () => {
    const runtime = makeRuntime();
    const runResults = createRuntimeDaemonRunResultStore();
    const firstConnection = createRuntimeDaemonDispatcher({ runtime, runResults });
    const secondConnection = createRuntimeDaemonDispatcher({ runtime, runResults });
    await initializeDispatcher(firstConnection);
    await initializeDispatcher(secondConnection);

    const started = await firstConnection.handle(createRuntimeDaemonRequest('req-1', 'run.start', {
      sessionId: 'session-1',
      prompt: 'hello',
    }));
    expect(isRuntimeDaemonSuccessResponse(started)).toBe(true);
    await Promise.resolve();

    const awaited = await secondConnection.handle(createRuntimeDaemonRequest('req-2', 'run.await', {
      runId: 'run-1',
    }));

    expect(isRuntimeDaemonSuccessResponse(awaited)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(awaited)) {
      expect(awaited.result).toMatchObject({
        runId: 'run-1',
        sessionId: 'session-1',
        phase: 'completed',
        result: {
          success: true,
          lastText: 'done',
        },
      });
    }
  });

  it('serializes retained run errors into a stable JSON wire shape', async () => {
    const runResults = createRuntimeDaemonRunResultStore();
    runResults.remember('run-failed', Promise.resolve({
      runId: 'run-failed',
      sessionId: 'session-1',
      phase: 'failed',
      error: new TypeError('provider unavailable'),
    }));
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      runResults,
    });
    await initializeDispatcher(dispatcher);

    const awaited = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-failed',
      'run.await',
      { runId: 'run-failed' },
    ));

    expect(isRuntimeDaemonSuccessResponse(awaited)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(awaited)) {
      const wireResponse = JSON.parse(JSON.stringify(awaited)) as unknown;
      expect(wireResponse).toMatchObject({
        result: {
          phase: 'failed',
          error: {
            name: 'TypeError',
            message: 'provider unavailable',
          },
        },
      });
    }
  });

  it('round-trips structured blocked terminal facts through daemon await', async () => {
    const runResults = createRuntimeDaemonRunResultStore();
    runResults.remember('run-blocked', Promise.resolve({
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
    }));
    const runtime = makeRuntime();
    const dispatcher = createRuntimeDaemonDispatcher({ runtime, runResults });
    await initializeDispatcher(dispatcher);
    const transport: RuntimeDaemonClientTransport = {
      async request(method, params, operation) {
        const response = await dispatcher.handle(createRuntimeDaemonRequest(
          `req-loopback-${randomRequestSuffix()}`,
          method,
          params,
          operation,
        ));
        if (isRuntimeDaemonSuccessResponse(response)) return response.result;
        throw Object.assign(new Error(response.error.message), {
          code: response.error.code,
        });
      },
      subscribe() {
        return { close() {} };
      },
    };
    const client = createRuntimeDaemonClient({
      identity: runtime.identity,
      transport,
      capabilities: {},
    });

    await expect(client.runs.await('run-blocked')).resolves.toMatchObject({
      phase: 'failed',
      terminal: {
        kind: 'failed',
        code: 'blocked',
        message: 'Choose the target API version.',
      },
    });
    await client.close();
    dispatcher.close();
  });

  it('forwards runtime event subscriptions as daemon notifications', async () => {
    const runtime = makeRuntime();
    const notifications: RuntimeDaemonNotification[] = [];
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      notify: (notification) => notifications.push(notification),
    });
    await initializeDispatcher(dispatcher);

    const subscribed = await dispatcher.handle(createRuntimeDaemonRequest('req-1', 'event.subscribe', {
      filter: { sessionId: 'session-1' },
    }));
    expect(isRuntimeDaemonSuccessResponse(subscribed)).toBe(true);

    const event: RuntimeEvent = {
      id: 'evt-1',
      seq: 1,
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'run.completed',
      payload: { ok: true },
    };
    runtime.emit(event);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.method).toBe('event');
    expect(notifications[0]?.params).toMatchObject({ event });
  });

  it('admits a run-only event scope from persisted events when Run status is absent', async () => {
    const runtime = makeRuntime();
    runtime.emit({
      id: 'evt-synthetic-run',
      seq: 1,
      cursor: {
        sessionId: 'session-1',
        journalEpoch: 'epoch-session-1',
        seq: 1,
      },
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'synthetic-run',
      type: 'session.created',
      payload: {},
    });
    vi.spyOn(runtime.runs, 'get').mockRejectedValue(
      Object.assign(new Error('Run not found'), { code: 'not_found' as const }),
    );
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const replay = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-synthetic-run',
      'event.replay',
      { runId: 'synthetic-run' },
    ));

    expect(isRuntimeDaemonSuccessResponse(replay)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(replay)) {
      expect(replay.result).toEqual([
        expect.objectContaining({ id: 'evt-synthetic-run' }),
      ]);
    }
    dispatcher.close();
  });

  it('forwards session observation invalidation as a daemon notification', async () => {
    const runtime = makeRuntime();
    let invalidateObservation:
      | ((value: RuntimeObservationInvalidation) => void)
      | undefined;
    runtime.sessions.observe = async (sessionId) => ({
      ...createTestObservation(sessionId),
      invalidated: new Promise<RuntimeObservationInvalidation>((resolve) => {
        invalidateObservation = resolve;
      }),
    });
    const notifications: RuntimeDaemonNotification[] = [];
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      notify: (notification) => notifications.push(notification),
    });
    await initializeDispatcher(dispatcher);
    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-observe-invalidated',
      'session.observe',
      { sessionId: 'session-1' },
    ));
    expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
    if (!isRuntimeDaemonSuccessResponse(response)) return;
    const subscriptionId = (
      response.result as { readonly subscriptionId: string }
    ).subscriptionId;

    invalidateObservation?.({
      code: 'observation_invalidated',
      reason: 'event_overflow',
      runtimeId: 'runtime-test',
      message: 'Observation handoff overflowed.',
    });
    await vi.waitFor(() => {
      expect(notifications).toContainEqual(expect.objectContaining({
        method: 'observation.invalidated',
        params: {
          subscriptionId,
          sessionId: 'session-1',
          invalidation: {
            code: 'observation_invalidated',
            reason: 'event_overflow',
            runtimeId: 'runtime-test',
            message: 'Observation handoff overflowed.',
          },
        },
      }));
    });
    dispatcher.close();
  });

  it('contains observation invalidation delivery failures and closes the subscription', async () => {
    const runtime = makeRuntime();
    let invalidateObservation:
      | ((value: RuntimeObservationInvalidation) => void)
      | undefined;
    const close = vi.fn();
    runtime.sessions.observe = async (sessionId) => ({
      ...createTestObservation(sessionId),
      close,
      invalidated: new Promise<RuntimeObservationInvalidation>((resolve) => {
        invalidateObservation = resolve;
      }),
    });
    const diagnostics: Array<{ readonly message: string }> = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
    });
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      notify() {
        throw new Error('notification sink failed');
      },
    });
    try {
      await initializeDispatcher(dispatcher);
      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-observe-notify-failure',
        'session.observe',
        { sessionId: 'session-1' },
      ));
      expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);

      invalidateObservation?.({
        code: 'observation_invalidated',
        reason: 'event_overflow',
        runtimeId: 'runtime-test',
        message: 'Observation handoff overflowed.',
      });
      await vi.waitFor(() => {
        expect(close).toHaveBeenCalledTimes(1);
        expect(diagnostics).toContainEqual(expect.objectContaining({
          message: expect.stringContaining(
            'Failed to deliver Session observation invalidation',
          ),
        }));
      });
    } finally {
      dispatcher.close();
      restoreDiagnostics();
    }
  });

  it('returns the same read-only Session diagnostic contract through the daemon', async () => {
    const runtime = makeRuntime();
    const diagnostics = vi.spyOn(runtime.sessions, 'diagnostics');
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-session-diagnostics',
      'session.diagnostics',
      {
        sessionId: 'session-1',
        runId: 'run-missing',
        timeoutMs: 2_000,
      },
    ));

    expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(response)) {
      expect(response.result).toMatchObject({
        schemaVersion: 1,
        runtimeId: 'runtime-test',
        sessionId: 'session-1',
        run: {
          controlRecord: 'unknown',
          runId: 'run-missing',
          activeSubtaskCount: null,
          activeSubtaskCountSource: 'unknown',
        },
      });
    }
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      runId: 'run-missing',
      timeoutMs: 2_000,
    }));
    dispatcher.close();
  });

  it('assigns a subscription id before synchronous runtime notifications', async () => {
    const runtime = makeRuntime();
    const event: RuntimeEvent = {
      id: 'evt-sync',
      seq: 1,
      cursor: { sessionId: 'session-1', journalEpoch: 'epoch-session-1', seq: 1 },
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'run.started',
      payload: {},
    };
    runtime.events.subscribe = (_filter, listener) => {
      listener(event);
      return { close() {} };
    };
    const notifications: RuntimeDaemonNotification[] = [];
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      notify: (notification) => notifications.push(notification),
    });
    await initializeDispatcher(dispatcher);

    const subscribed = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-sub-sync',
      'event.subscribe',
      { filter: { sessionId: 'session-1' } },
    ));

    expect(isRuntimeDaemonSuccessResponse(subscribed)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(subscribed)) {
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.params).toMatchObject({
        subscriptionId: (subscribed.result as { subscriptionId: string }).subscriptionId,
        event,
      });
    }
  });

  it('returns latest context diagnostic payloads from runtime event replay', async () => {
    const runtime = makeRuntime();
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    runtime.emit({
      id: 'evt-budget-1',
      seq: 1,
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'context.budget.snapshot',
      payload: { usedTokens: 100 },
    });
    runtime.emit({
      id: 'evt-budget-2',
      seq: 2,
      time: '2026-07-09T00:00:01.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'context.budget.snapshot',
      payload: { usedTokens: 80 },
    });
    runtime.emit({
      id: 'evt-budget-child',
      seq: 3,
      time: '2026-07-09T00:00:02.000Z',
      sessionId: 'child-worker-session',
      runId: 'run-1',
      type: 'context.budget.snapshot',
      payload: {
        contextId: `session-1/agent/${encodeURIComponent('/root/reviewer')}`,
        contextKind: 'child',
        agentId: '/root/reviewer',
        usedTokens: 120,
      },
    });
    for (let index = 0; index < 101; index += 1) {
      runtime.emit({
        id: `evt-budget-child-${index}`,
        seq: 4 + index,
        time: '2026-07-09T00:00:02.000Z',
        sessionId: 'child-worker-session',
        runId: 'run-1',
        type: 'context.budget.snapshot',
        payload: {
          contextId: `session-1/agent/${encodeURIComponent('/root/reviewer')}`,
          contextKind: 'child',
          agentId: '/root/reviewer',
          usedTokens: 121 + index,
        },
      });
    }
    runtime.emit({
      id: 'evt-budget-unrelated-child',
      seq: 105,
      time: '2026-07-09T00:00:03.000Z',
      sessionId: 'unrelated-child-worker-session',
      runId: 'run-2',
      type: 'context.budget.snapshot',
      payload: {
        contextId: `unrelated-root-session/agent/${encodeURIComponent('/root/reviewer')}`,
        contextKind: 'child',
        agentId: '/root/reviewer',
        usedTokens: 999,
      },
    });
    runtime.emit({
      id: 'evt-exposure-1',
      seq: 106,
      time: '2026-07-09T00:00:04.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'tool.exposure.planned',
      payload: { profile: 'bridge_non_core', bridgedCount: 4 },
    });
    runtime.emit({
      id: 'evt-cache-root',
      seq: 107,
      time: '2026-07-09T00:00:05.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'provider.cache.diagnostics',
      payload: {
        contextId: 'session-1',
        contextKind: 'root',
        requestId: 'cache-root',
        phase: 'response',
        cachedReadTokens: 0,
      },
    });
    runtime.emit({
      id: 'evt-cache-child',
      seq: 108,
      time: '2026-07-09T00:00:06.000Z',
      sessionId: 'child-worker-session',
      runId: 'run-1',
      type: 'provider.cache.diagnostics',
      payload: {
        contextId: `session-1/agent/${encodeURIComponent('/root/reviewer')}`,
        parentContextId: 'session-1',
        contextKind: 'child',
        agentId: '/root/reviewer',
        requestId: 'cache-child',
        phase: 'response',
        cachedReadTokens: 96,
      },
    });
    runtime.emit({
      id: 'evt-cache-other-agent',
      seq: 109,
      time: '2026-07-09T00:00:07.000Z',
      sessionId: 'other-child-worker-session',
      runId: 'run-1',
      type: 'provider.cache.diagnostics',
      payload: {
        contextId: `session-1/agent/${encodeURIComponent('/root/other')}`,
        parentContextId: 'session-1',
        contextKind: 'child',
        agentId: '/root/other',
        requestId: 'cache-other-agent',
        phase: 'response',
        cachedReadTokens: 12,
      },
    });
    runtime.emit({
      id: 'evt-cache-unrelated-session',
      seq: 110,
      time: '2026-07-09T00:00:08.000Z',
      sessionId: 'unrelated-child-worker-session',
      runId: 'run-2',
      type: 'provider.cache.diagnostics',
      payload: {
        contextId: `unrelated-root-session/agent/${encodeURIComponent('/root/reviewer')}`,
        parentContextId: 'unrelated-root-session',
        contextKind: 'child',
        agentId: '/root/reviewer',
        requestId: 'cache-unrelated-session',
        phase: 'response',
        cachedReadTokens: 999,
      },
    });
    runtime.emit({
      id: 'evt-cache-unreported',
      seq: 111,
      time: '2026-07-09T00:00:09.000Z',
      sessionId: 'session-unreported',
      runId: 'run-unreported',
      type: 'provider.cache.diagnostics',
      payload: {
        contextId: 'session-unreported',
        contextKind: 'root',
        requestId: 'cache-unreported',
        phase: 'response',
      },
    });

    const budget = await dispatcher.handle(createRuntimeDaemonRequest('req-1', 'context.budget.get', {
      sessionId: 'session-1',
      runId: 'run-1',
    }));
    const exposure = await dispatcher.handle(createRuntimeDaemonRequest('req-2', 'tool.exposure.preview', {
      sessionId: 'session-1',
    }));
    const childBudget = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-child-budget',
      'context.budget.get',
      {
        sessionId: 'session-1',
        contextKind: 'child',
        agentId: '/root/reviewer',
      },
    ));
    const unrelatedRootChildBudget = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-unrelated-child-budget',
      'context.budget.get',
      {
        sessionId: 'unrelated-root-session-2',
        contextKind: 'child',
        agentId: '/root/reviewer',
      },
    ));
    const rootCache = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-root-cache',
      'provider.cache.diagnostics.get',
      { sessionId: 'session-1' },
    ));
    const childCache = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-child-cache',
      'provider.cache.diagnostics.get',
      {
        sessionId: 'session-1',
        contextKind: 'child',
        agentId: '/root/reviewer',
      },
    ));
    const unrelatedChildCache = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-unrelated-child-cache',
      'provider.cache.diagnostics.get',
      {
        sessionId: 'unrelated-root-session',
        contextKind: 'child',
        agentId: '/root/reviewer',
      },
    ));
    const unknownChildCache = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-unknown-child-cache',
      'provider.cache.diagnostics.get',
      {
        sessionId: 'unknown-root-session',
        contextKind: 'child',
        agentId: '/root/reviewer',
      },
    ));
    const unreportedRootCache = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-unreported-root-cache',
      'provider.cache.diagnostics.get',
      { sessionId: 'session-unreported' },
    ));

    expect(isRuntimeDaemonSuccessResponse(budget)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(exposure)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(childBudget)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(unrelatedRootChildBudget)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(rootCache)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(childCache)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(unrelatedChildCache)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(unknownChildCache)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(unreportedRootCache)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(budget)) {
      expect(budget.result).toEqual({ usedTokens: 80 });
    }
    if (isRuntimeDaemonSuccessResponse(exposure)) {
      expect(exposure.result).toEqual({ profile: 'bridge_non_core', bridgedCount: 4 });
    }
    if (isRuntimeDaemonSuccessResponse(childBudget)) {
      expect(childBudget.result).toEqual({
        contextId: `session-1/agent/${encodeURIComponent('/root/reviewer')}`,
        contextKind: 'child',
        agentId: '/root/reviewer',
        usedTokens: 221,
      });
    }
    if (isRuntimeDaemonSuccessResponse(unrelatedRootChildBudget)) {
      expect(unrelatedRootChildBudget.result).toBeNull();
    }
    if (isRuntimeDaemonSuccessResponse(rootCache)) {
      expect(rootCache.result).toMatchObject({
        contextId: 'session-1',
        requestId: 'cache-root',
        cachedReadTokens: 0,
      });
    }
    if (isRuntimeDaemonSuccessResponse(childCache)) {
      expect(childCache.result).toMatchObject({
        contextId: `session-1/agent/${encodeURIComponent('/root/reviewer')}`,
        agentId: '/root/reviewer',
        requestId: 'cache-child',
        cachedReadTokens: 96,
      });
    }
    if (isRuntimeDaemonSuccessResponse(unrelatedChildCache)) {
      expect(unrelatedChildCache.result).toMatchObject({
        contextId: `unrelated-root-session/agent/${encodeURIComponent('/root/reviewer')}`,
        requestId: 'cache-unrelated-session',
        cachedReadTokens: 999,
      });
    }
    if (isRuntimeDaemonSuccessResponse(unknownChildCache)) {
      expect(unknownChildCache.result).toBeNull();
    }
    if (isRuntimeDaemonSuccessResponse(unreportedRootCache)) {
      expect(unreportedRootCache.result).toMatchObject({
        contextId: 'session-unreported',
        requestId: 'cache-unreported',
      });
      expect(unreportedRootCache.result).not.toHaveProperty('cachedReadTokens');
    }
  });

  it('accepts only explicit user-scope learned Skill promotion over the daemon boundary', async () => {
    const runtime = makeRuntime();
    const promote = vi.spyOn(runtime.learning, 'promote');
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      grantedScopes: ['learning:control'],
    });
    await initializeDispatcher(dispatcher);

    const accepted = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-learning-promote-user',
      'learning.promote',
      { nameOrSlug: 'runtime-test-skill', scope: 'user' },
    ));
    const rejected = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-learning-promote-project',
      'learning.promote',
      { nameOrSlug: 'runtime-test-skill', scope: 'project' },
    ));

    expect(isRuntimeDaemonSuccessResponse(accepted)).toBe(true);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledWith('runtime-test-skill', 'user');
    expect(isRuntimeDaemonSuccessResponse(rejected)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(rejected)) {
      expect(rejected.error).toMatchObject({
        code: 'invalid_params',
        message: 'Invalid params for learning.promote.',
      });
      expect(rejected.error.data).toMatchObject({
        issues: ['params.scope must be one of: user.'],
      });
    }
    dispatcher.close();
  });

  it('gates context diagnostics by negotiated client capability', async () => {
    const runtime = makeRuntime();
    runtime.emit({
      id: 'evt-normal',
      seq: 1,
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'run.completed',
      payload: { ok: true },
    });
    runtime.emit({
      id: 'evt-budget',
      seq: 2,
      time: '2026-07-09T00:00:01.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'context.budget.snapshot',
      payload: { usedTokens: 42 },
    });
    runtime.emit({
      id: 'evt-compaction-skipped',
      seq: 3,
      time: '2026-07-09T00:00:02.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'context.compaction.skipped',
      payload: { reason: 'cooldown' },
    });
    runtime.emit({
      id: 'evt-cache-diagnostics',
      seq: 4,
      time: '2026-07-09T00:00:03.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'provider.cache.diagnostics',
      payload: { phase: 'response', cachedReadTokens: 80 },
    });

    const basic = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(basic, {});
    const basicReplay = await basic.handle(createRuntimeDaemonRequest(
      'req-basic-replay',
      'event.replay',
      { sessionId: 'session-1' },
    ));
    const basicBudget = await basic.handle(createRuntimeDaemonRequest('req-basic-budget', 'context.budget.get', {
      sessionId: 'session-1',
      runId: 'run-1',
    }));
    const basicCache = await basic.handle(createRuntimeDaemonRequest(
      'req-basic-cache',
      'provider.cache.diagnostics.get',
      { sessionId: 'session-1', runId: 'run-1' },
    ));

    expect(isRuntimeDaemonSuccessResponse(basicReplay)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(basicReplay)) {
      expect(basicReplay.result).toEqual([
        expect.objectContaining({ type: 'run.completed' }),
      ]);
    }
    expect(isRuntimeDaemonSuccessResponse(basicBudget)).toBe(false);
    expect(isRuntimeDaemonSuccessResponse(basicCache)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(basicBudget)) {
      expect(basicBudget.error.code).toBe('unauthorized');
    }
    if (!isRuntimeDaemonSuccessResponse(basicCache)) {
      expect(basicCache.error.code).toBe('unauthorized');
    }

    const diagnostic = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(diagnostic, { contextDiagnostics: true });
    const diagnosticReplay = await diagnostic.handle(createRuntimeDaemonRequest(
      'req-diagnostic-replay',
      'event.replay',
      { sessionId: 'session-1' },
    ));
    const diagnosticBudget = await diagnostic.handle(createRuntimeDaemonRequest(
      'req-diagnostic-budget',
      'context.budget.get',
      { sessionId: 'session-1', runId: 'run-1' },
    ));
    const diagnosticCache = await diagnostic.handle(createRuntimeDaemonRequest(
      'req-diagnostic-cache',
      'provider.cache.diagnostics.get',
      { sessionId: 'session-1', runId: 'run-1' },
    ));

    expect(isRuntimeDaemonSuccessResponse(diagnosticReplay)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(diagnosticReplay)) {
      expect(diagnosticReplay.result).toEqual([
        expect.objectContaining({ type: 'run.completed' }),
        expect.objectContaining({ type: 'context.budget.snapshot' }),
        expect.objectContaining({ type: 'context.compaction.skipped' }),
        expect.objectContaining({ type: 'provider.cache.diagnostics' }),
      ]);
    }
    expect(isRuntimeDaemonSuccessResponse(diagnosticBudget)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(diagnosticCache)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(diagnosticBudget)) {
      expect(diagnosticBudget.result).toEqual({ usedTokens: 42 });
    }
    if (isRuntimeDaemonSuccessResponse(diagnosticCache)) {
      expect(diagnosticCache.result).toEqual({
        phase: 'response',
        cachedReadTokens: 80,
      });
    }
  });

  it('serves redacted config and provider/model catalogs through admin methods', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      config: () => ({
        provider: 'openai',
        apiKey: 'secret-api-key',
        nested: {
          token: 'secret-token',
          safe: 'visible',
        },
      }),
      providerList: () => [
        {
          name: 'openai',
          model: 'gpt-test',
          models: ['gpt-test', 'gpt-other'],
          configured: true,
          reasoningCapability: 'native',
          capabilityProfile: { transport: 'http' },
        },
      ],
    });
    await initializeDispatcher(dispatcher);

    const config = await dispatcher.handle(createRuntimeDaemonRequest('req-1', 'config.read'));
    const providers = await dispatcher.handle(createRuntimeDaemonRequest('req-2', 'provider.list'));
    const models = await dispatcher.handle(createRuntimeDaemonRequest('req-3', 'model.list', {
      provider: 'openai',
    }));
    const customProviders = await dispatcher.handle(createRuntimeDaemonRequest('req-4', 'provider.custom.list'));

    expect(isRuntimeDaemonSuccessResponse(config)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(providers)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(models)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(customProviders)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(config)) {
      expect(config.result).toEqual({
        provider: 'openai',
        apiKey: '[redacted]',
        nested: {
          token: '[redacted]',
          safe: 'visible',
        },
      });
    }
    if (isRuntimeDaemonSuccessResponse(providers)) {
      expect(providers.result).toMatchObject([{ name: 'openai', models: ['gpt-test', 'gpt-other'] }]);
    }
    if (isRuntimeDaemonSuccessResponse(models)) {
      expect(models.result).toEqual({ provider: 'openai', models: ['gpt-test', 'gpt-other'] });
    }
    if (isRuntimeDaemonSuccessResponse(customProviders)) {
      expect(customProviders.result).toEqual([{
        name: 'custom-openai',
        protocol: 'openai',
        baseUrl: 'https://example.invalid/v1',
        apiKeyEnv: 'CUSTOM_OPENAI_KEY',
        model: 'custom-model',
      }]);
    }
  });

  it('routes config, MCP, command, skill, and artifact methods through runtime services', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });
    await initializeDispatcher(dispatcher);

    const patched = await dispatcher.handle(createRuntimeDaemonRequest('req-config', 'config.patch', {
      patch: { model: 'mock-model' },
    }));
    const customUpsert = await dispatcher.handle(createRuntimeDaemonRequest('req-custom-upsert', 'provider.custom.upsert', {
      config: {
        name: 'custom-openai',
        protocol: 'openai',
        baseUrl: 'https://example.invalid/v1',
        apiKeyEnv: 'CUSTOM_OPENAI_KEY',
        model: 'custom-model',
      },
    }));
    const customRemove = await dispatcher.handle(createRuntimeDaemonRequest('req-custom-remove', 'provider.custom.remove', {
      name: 'custom-openai',
    }));
    const mcpUpsert = await dispatcher.handle(createRuntimeDaemonRequest('req-mcp-upsert', 'mcp.server.upsert', {
      name: 'local',
      config: { type: 'stdio', command: 'echo' },
    }));
    const mcpValidate = await dispatcher.handle(createRuntimeDaemonRequest('req-mcp-validate', 'mcp.server.validate', {
      name: 'local',
      config: { type: 'stdio', command: 'echo' },
    }));
    const extensions = await dispatcher.handle(createRuntimeDaemonRequest('req-extension-list', 'extension.list'));
    const command = await dispatcher.handle(createRuntimeDaemonRequest('req-command', 'command.resolve', {
      name: 'help',
    }));
    const skill = await dispatcher.handle(createRuntimeDaemonRequest('req-skill', 'skill.describe', {
      name: 'review',
    }));
    const artifact = await dispatcher.handle(createRuntimeDaemonRequest('req-artifact', 'artifact.create', {
      kind: 'file',
      path: '/tmp/input.txt',
    }));

    expect(isRuntimeDaemonSuccessResponse(patched)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(customUpsert)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(customRemove)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(mcpUpsert)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(mcpValidate)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(extensions)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(command)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(skill)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(artifact)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(patched)) {
      expect(patched.result).toMatchObject({ provider: 'mock', model: 'mock-model' });
    }
    if (isRuntimeDaemonSuccessResponse(customUpsert)) {
      expect(customUpsert.result).toMatchObject({ name: 'custom-openai', model: 'custom-model' });
    }
    if (isRuntimeDaemonSuccessResponse(customRemove)) {
      expect(customRemove.result).toBe(true);
    }
    if (isRuntimeDaemonSuccessResponse(mcpUpsert)) {
      expect(mcpUpsert.result).toEqual({ type: 'stdio', command: 'echo' });
    }
    if (isRuntimeDaemonSuccessResponse(mcpValidate)) {
      expect(mcpValidate.result).toEqual({ ok: true, config: { type: 'stdio', command: 'echo' } });
    }
    if (isRuntimeDaemonSuccessResponse(extensions)) {
      expect(extensions.result).toMatchObject({
        active: true,
        extensions: [{ label: 'demo' }],
      });
    }
    if (isRuntimeDaemonSuccessResponse(command)) {
      expect(command.result).toMatchObject({ name: 'help', description: 'Show help' });
    }
    if (isRuntimeDaemonSuccessResponse(skill)) {
      expect(skill.result).toMatchObject({ name: 'review', content: 'Review instructions' });
    }
    if (isRuntimeDaemonSuccessResponse(artifact)) {
      expect(artifact.result).toMatchObject({ id: 'art-1', kind: 'file', path: '/tmp/input.txt' });
    }
  });

  it('passes permission response run bindings to the hosted runtime', async () => {
    const baseRuntime = makeRuntime();
    let captured: {
      readonly requestId: string;
      readonly decision: RuntimePermissionDecision;
      readonly options?: RuntimePermissionRespondOptions;
    } | undefined;
    const runtime: KodaXRuntime & { emit(event: RuntimeEvent): void } = {
      ...baseRuntime,
      permissions: {
        ...baseRuntime.permissions,
        async respond(requestId, decision, options) {
          captured = {
            requestId,
            decision,
            ...(options !== undefined ? { options } : {}),
          };
          return false;
        },
      },
    };
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest('req-permission', 'permission.respond', {
      requestId: 'perm-1',
      decision: { type: 'allow_once' },
      runId: 'run-1',
    }));

    expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(response)) {
      expect(response.result).toBe(false);
    }
    expect(captured).toEqual({
      requestId: 'perm-1',
      decision: { type: 'allow_once' },
      options: { runId: 'run-1' },
    });
  });

  it('forwards concrete permission input without exposing owner-only safety context', async () => {
    const baseRuntime = makeRuntime();
    const request = vi.fn(async (): Promise<RuntimePermissionDecision> => ({
      type: 'reject',
      reason: 'permission request timed out',
      cause: 'approval_timeout',
    }));
    const runtime: KodaXRuntime & { emit(event: RuntimeEvent): void } = {
      ...baseRuntime,
      permissions: {
        ...baseRuntime.permissions,
        request,
      },
    };
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-concrete-permission',
      'permission.request',
      {
        sessionId: 'session-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        toolName: 'bash',
        toolInput: { command: 'npm test' },
        executionCwd: 'C:\\work\\repo',
      },
    ));

    expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(response)) {
      expect(response.result).toEqual({
        type: 'reject',
        reason: 'permission request timed out',
        cause: 'approval_timeout',
      });
    }
    expect(request).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      executionCwd: 'C:\\work\\repo',
    });
  });
});

async function initializeDispatcher(
  dispatcher: ReturnType<typeof createRuntimeDaemonDispatcher>,
  capabilities: RuntimeClientCapabilities = {
    contextDiagnostics: true,
    permissionPrompts: true,
    configAdmin: true,
  },
): Promise<Record<string, unknown>> {
  const initialized = await dispatcher.handle(createRuntimeDaemonRequest('req-init', 'initialize', {
    profile: 'default',
    clientInfo: { name: 'vitest' },
    capabilities,
  }));
  expect(isRuntimeDaemonSuccessResponse(initialized)).toBe(true);
  if (!isRuntimeDaemonSuccessResponse(initialized)) {
    throw new Error(`Runtime daemon initialize failed: ${initialized.error.message}`);
  }
  if (!initialized.result || typeof initialized.result !== 'object' || Array.isArray(initialized.result)) {
    throw new Error('Runtime daemon initialize returned an invalid result');
  }
  return initialized.result as Record<string, unknown>;
}

function isInitializeMethod(method: RuntimeDaemonMethod): boolean {
  return method === 'initialize' || method === 'runtime.initialize';
}

let loopbackRequestSequence = 0;
function randomRequestSuffix(): string {
  loopbackRequestSequence += 1;
  return String(loopbackRequestSequence);
}

const METHOD_SMOKE_PARAMS = {
  initialize: { profile: 'default', capabilities: { contextDiagnostics: true } },
  'runtime.initialize': { profile: 'default', capabilities: { contextDiagnostics: true } },
  ping: undefined,
  'runtime.identity': undefined,
  'runtime.status': undefined,
  'runtime.shutdown': undefined,
  'runtime.capabilities': undefined,
  'daemon.status': undefined,
  'daemon.stop': undefined,
  'daemon.logs': undefined,
  'daemon.preflight': undefined,
  'daemon.management.get': undefined,
  'daemon.rollbackToInline': {
    expectedRuntimeId: 'runtime-smoke',
    expectedRevision: 0,
    expectedOwnerPolicyRevision: 0,
  },
  'operation.get': { operationId: 'op-missing', journalEpoch: 'epoch-missing' },
  'session.create': { sessionId: 'session-smoke', title: 'Smoke Session' },
  'session.load': { sessionId: 'session-1' },
  'session.list': { limit: 5 },
  'session.status': { sessionId: 'session-1' },
  'session.transcript': { sessionId: 'session-1' },
  'session.transcript.page': { sessionId: 'session-1' },
  'session.transcript.entryChunk': {
    sessionId: 'session-1',
    revision: 'sha256:smoke',
    entryIndex: 0,
  },
  'session.transcript.search': { sessionId: 'session-1', query: 'historical detail' },
  'session.conversation': { sessionId: 'session-1' },
  'session.conversation.page': { sessionId: 'session-1' },
  'session.conversation.entryChunk': {
    sessionId: 'session-1',
    revision: 'sha256:conversation-smoke',
    entryIndex: 0,
  },
  'session.observe': { sessionId: 'session-1' },
  'session.diagnostics': { sessionId: 'session-1' },
  'session.fork': { sessionId: 'session-1' },
  'session.notice.append': { sessionId: 'session-1', content: 'smoke' },
  'session.rewind': { sessionId: 'session-1', selector: 'entry-1' },
  'session.active_entry.set': { sessionId: 'session-1', entryId: 'entry-1' },
  'session.activeEntry.set': { sessionId: 'session-1', entryId: 'entry-1' },
  'session.compact': { sessionId: 'session-1' },
  'session.archive': { sessionId: 'session-1' },
  'session.unarchive': { sessionId: 'session-1' },
  'session.delete': { sessionId: 'session-1' },
  'session.settings.get': { sessionId: 'session-1' },
  'session.settings.getVersioned': { sessionId: 'session-1' },
  'session.autoMode.getStats': { sessionId: 'session-1' },
  'session.settings.update': { sessionId: 'session-1', patch: { model: 'mock-model' } },
  'session.settings.updateVersioned': {
    sessionId: 'session-1',
    patch: { model: 'mock-model' },
    expectedRevision: 0,
  },
  'run.start': { sessionId: 'session-1', prompt: 'hello daemon' },
  'run.input.submit': {
    sessionId: 'session-1',
    afterRunId: 'run-1',
    delivery: 'after_turn',
    input: { type: 'text', text: 'continue' },
  },
  'run.get': { runId: 'run-1' },
  'run.list': { sessionId: 'session-1' },
  'run.await': { runId: 'run-1' },
  'run.abort': { runId: 'run-1' },
  'run.model.set': { runId: 'run-1', model: 'mock-model' },
  'run.provider.set': { runId: 'run-1', provider: 'mock' },
  'run.reasoning.set': { runId: 'run-1', reasoning: 'off' },
  'run.setModel': { runId: 'run-1', model: 'mock-model' },
  'run.setProvider': { runId: 'run-1', provider: 'mock' },
  'run.setReasoning': { runId: 'run-1', reasoning: 'off' },
  'request.cancel': { requestId: 'request-missing' },
  'request.ack': { requestId: 'request-missing' },
  'event.subscribe': { filter: { sessionId: 'session-1' } },
  'event.unsubscribe': { subscriptionId: 'sub-missing' },
  'event.replay': { sessionId: 'session-1', limit: 5 },
  'permission.list': { runId: 'run-1' },
  'permission.listPending': { runId: 'run-1' },
  'permission.request': { sessionId: 'session-1', runId: 'run-1', toolName: 'read' },
  'permission.respond': { requestId: 'perm-1', runId: 'run-1', decision: { type: 'allow_once' } },
  'permission.grants.list': {},
  'permission.grants.revoke': { grantId: 'grant-1', expectedRevision: 0 },
  'user_input.listPending': { sessionId: 'session-1' },
  'user_input.respond': { requestId: 'input-1', answer: 'yes', expectedRevision: 0 },
  'user_input.dismiss': { requestId: 'input-1', expectedRevision: 0 },
  'credential.register': { leaseId: 'credential-1', providers: ['mock'] },
  'credential.get': { leaseId: 'credential-1' },
  'credential.revoke': { leaseId: 'credential-1' },
  'credential.supply': { requestId: 'credential-request-1', error: 'unavailable' },
  'host_tool.register': {
    leaseId: 'host-tools-1',
    tools: [{
      name: 'space_artifact_create',
      description: 'Create a Space artifact',
      inputSchema: { type: 'object' },
      sideEffect: 'non_idempotent',
    }],
  },
  'host_tool.get': { leaseId: 'host-tools-1' },
  'host_tool.invocation.get': { invocationId: 'host-invocation-1' },
  'host_tool.revoke': { leaseId: 'host-tools-1' },
  'host_tool.complete': { invocationId: 'host-invocation-1', error: 'unknown' },
  'workflow.list': { runId: 'run-1' },
  'workflow.get': { runId: 'run-1' },
  'workflow.subscribe': { filter: { runId: 'run-1' } },
  'workflow.unsubscribe': { subscriptionId: 'workflow-sub-missing' },
  'workflow.pause': { runId: 'run-1' },
  'workflow.resume': { runId: 'run-1' },
  'workflow.stop': { runId: 'run-1' },
  'learning.list': {},
  'learning.get': { nameOrSlug: 'runtime-test-skill' },
  'learning.snapshot': undefined,
  'learning.events': { afterRevision: 0 },
  'learning.acknowledge': { nameOrSlug: 'runtime-test-skill' },
  'learning.snooze': { nameOrSlug: 'runtime-test-skill', until: '2026-07-18T00:00:00.000Z' },
  'learning.reject': { nameOrSlug: 'runtime-test-skill' },
  'learning.disable': { nameOrSlug: 'runtime-test-skill' },
  'learning.rollback': { nameOrSlug: 'runtime-test-skill' },
  'learning.promote': { nameOrSlug: 'runtime-test-skill', scope: 'user' },
  'learning.review': { nameOrSlug: 'runtime-test-skill' },
  'learning.trust': { nameOrSlug: 'runtime-test-skill' },
  'config.read': undefined,
  'config.effective': undefined,
  'config.patch': { patch: { model: 'mock-model' } },
  'config.reload': undefined,
  'model.list': { provider: 'mock' },
  'provider.list': undefined,
  'provider.custom.list': undefined,
  'provider.custom.upsert': {
    config: {
      name: 'custom-openai',
      protocol: 'openai',
      baseUrl: 'https://example.invalid/v1',
      apiKeyEnv: 'CUSTOM_OPENAI_KEY',
      model: 'custom-model',
    },
  },
  'provider.custom.remove': { name: 'custom-openai' },
  'mcp.server.list': undefined,
  'mcp.server.get': { name: 'local' },
  'mcp.server.validate': { name: 'local', config: { type: 'stdio', command: 'echo' } },
  'mcp.server.upsert': { name: 'local', config: { type: 'stdio', command: 'echo' } },
  'mcp.server.delete': { name: 'local' },
  'mcp.server.remove': { name: 'local' },
  'mcp.server.reload': undefined,
  'mcp.tool.list': { server: 'local' },
  'extension.list': undefined,
  'extension.reload': undefined,
  'command.list': { projectRoot: process.cwd() },
  'command.resolve': { name: 'help', projectRoot: process.cwd() },
  'skill.list': { projectRoot: process.cwd(), userInvocableOnly: true },
  'skill.describe': { name: 'review', projectRoot: process.cwd() },
  'skill.read': { name: 'review', projectRoot: process.cwd() },
  'artifact.create': { kind: 'file', path: '/tmp/runtime-daemon-smoke.txt' },
  'artifact.get': { artifactId: 'art-1' },
  'artifact.delete': { artifactId: 'art-1' },
  'agentRegistrations.list': undefined,
  'agentRegistrations.upsert': {
    registration: {
      agentId: 'external:smoke',
      displayName: 'Smoke Agent',
      enabled: true,
      executorId: 'smoke-executor',
      protocol: 'http',
      configurationRevision: 'rev-1',
      endpointIdentityHash: 'sha256:smoke',
      capabilities: {
        streaming: 'supported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: 'read', workspace: 'proposal' },
    },
  },
  'agentRegistrations.setEnabled': { agentId: 'external:smoke', enabled: false },
  'agentRegistrations.remove': { agentId: 'external:smoke' },
  'agents.listDispatchable': { actorId: 'actor-smoke' },
  'agents.describe': { agentId: 'external:smoke', query: { actorId: 'actor-smoke' } },
  'agents.preflight': {
    agentId: 'external:smoke',
    query: { actorId: 'actor-smoke' },
  },
  'agents.tree': { sessionId: 'session-1' },
  'agents.detail': { sessionId: 'session-1', actorPath: '/root' },
  'agents.spawn': {
    sessionId: 'session-1',
    input: { taskName: 'smoke', objective: 'Smoke test', kind: 'external' },
  },
  'agents.send': {
    sessionId: 'session-1', actorPath: '/root/smoke', content: 'continue',
  },
  'agents.followup': {
    sessionId: 'session-1', actorPath: '/root/smoke', objective: 'Continue',
  },
  'agents.interrupt': { sessionId: 'session-1', actorPath: '/root/smoke' },
  'agents.output': { sessionId: 'session-1', actorPath: '/root/smoke' },
  'agents.events': { sessionId: 'session-1', afterSequence: 0 },
  'agents.wait': { sessionId: 'session-1', afterSequence: 0, timeoutMs: 1 },
  'context.budget.get': { sessionId: 'session-1', runId: 'run-1' },
  'tool.exposure.preview': { sessionId: 'session-1', runId: 'run-1' },
  'provider.cache.diagnostics.get': { sessionId: 'session-1', runId: 'run-1' },
} satisfies Record<RuntimeDaemonMethod, unknown>;

function makeRuntime(): KodaXRuntime & { emit(event: RuntimeEvent): void } {
  const listeners: Array<{
    readonly filter: RuntimeEventFilter;
    readonly listener: RuntimeEventListener;
  }> = [];
  const runs = new Map<string, RuntimeRunResult>();
  const eventLog: RuntimeEvent[] = [];
  const externalCapabilities = {
    streaming: 'supported',
    durableTasks: 'supported',
    inputRequired: 'supported',
    cancellation: 'supported',
    artifacts: 'supported',
  } as const;
  const externalRegistration = {
    agentId: 'external:smoke',
    displayName: 'Smoke Agent',
    enabled: true,
    executorId: 'smoke-executor',
    protocol: 'http',
    configurationRevision: 'rev-1',
    endpointIdentityHash: 'sha256:smoke',
    credentialConfigured: false,
    capabilities: externalCapabilities,
    effects: { remote: 'read', workspace: 'proposal' },
    diagnostics: [],
  } as const;
  const externalListing = {
    descriptor: {
      agentId: externalRegistration.agentId,
      displayName: externalRegistration.displayName,
      origin: 'external',
      protocol: 'http',
      configurationRevision: externalRegistration.configurationRevision,
      skills: [],
      inputModalities: ['text'],
      outputModalities: ['text'],
      capabilities: externalCapabilities,
      effects: externalRegistration.effects,
    },
    dispatchability: {
      status: 'dispatchable',
      checkedAt: '2026-07-09T00:00:00.000Z',
      reasons: [],
    },
  } as const;
  const runtime: KodaXRuntime & { emit(event: RuntimeEvent): void } = {
    identity: {
      runtimeId: 'runtime-test',
      mode: 'embedded',
      profile: 'default',
      startedAt: '2026-07-09T00:00:00.000Z',
      version: '0.7.66',
    },
    capabilities: {
      runtimeEventCoalescing: { version: 1 },
    },
    sessions: {
      async create(input) {
        return {
          id: input?.sessionId ?? 'session-1',
          title: input?.title ?? 'Test Session',
        };
      },
      async load(sessionId) {
        return { id: sessionId, title: 'Loaded Session' };
      },
      async list() {
        return [{ id: 'session-1', title: 'Test Session', msgCount: 0 }];
      },
      async status(sessionId) {
        return {
          sessionId,
          runtimeId: 'runtime-test',
          phase: 'idle' as const,
          observedAt: '2026-07-09T00:00:00.000Z',
        };
      },
      async transcript() {
        return null;
      },
      async transcriptPage() {
        return null;
      },
      async transcriptEntryChunk() {
        return null;
      },
      async transcriptSearch() {
        return null;
      },
      async conversation() {
        return null;
      },
      async conversationPage() {
        return null;
      },
      async conversationEntryChunk() {
        return null;
      },
      async observe(sessionId) {
        return createTestObservation(sessionId);
      },
      async diagnostics(input) {
        return {
          schemaVersion: 1,
          captureStartedAt: '2026-07-30T00:00:00.000Z',
          capturedAt: '2026-07-30T00:00:00.001Z',
          sdkVersion: '0.7.79',
          runtimeVersion: '0.7.79',
          daemonVersion: null,
          runtimeId: 'runtime-test',
          runtimeMode: 'embedded',
          sessionId: input.sessionId,
          observation: {
            cursor: {
              sessionId: input.sessionId,
              journalEpoch: `epoch-${input.sessionId}`,
              seq: 0,
            },
            transcriptRevision: 'sha256:test',
          },
          run: {
            controlRecord: 'unknown',
            ...(input.runId !== undefined ? { runId: input.runId } : {}),
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
      },
      async fork() {
        return { id: 'fork-1', title: 'Forked Session' };
      },
      async getSettings() {
        return {};
      },
      async getSettingsVersioned() {
        return { revision: 0, value: {} };
      },
      async getAutoModeStats() {
        return undefined;
      },
      async updateSettings(_sessionId, patch) {
        return Object.fromEntries(
          Object.entries(patch).filter((entry): entry is [string, string | boolean] => (
            entry[1] !== null && entry[1] !== undefined
          )),
        );
      },
      async updateSettingsVersioned(_sessionId, patch, options) {
        return {
          revision: options.expectedRevision + 1,
          value: Object.fromEntries(
            Object.entries(patch).filter((entry): entry is [string, string | boolean] => (
              entry[1] !== null && entry[1] !== undefined
            )),
          ),
        };
      },
      async appendNotice() {
        return null;
      },
      async rewind(input) {
        return { id: input.sessionId, title: 'Rewound Session' };
      },
      async setActiveEntry(input) {
        return { id: input.sessionId, title: 'Active Entry Session' };
      },
      async compact(input) {
        return {
          compacted: false,
          tokensBefore: 0,
          tokensAfter: 0,
          session: { id: input.sessionId, title: 'Compacted Session' },
        } as RuntimeCompactSessionResult;
      },
      async archive() {},
      async unarchive() {},
      async delete() {},
    },
    runs: {
      async start(input: RuntimeStartRunInput) {
        const result: RuntimeRunResult = {
          runId: 'run-1',
          sessionId: input.sessionId,
          phase: 'completed',
          result: {
            success: true,
            lastText: 'done',
            messages: [],
            sessionId: input.sessionId,
          },
        };
        runs.set(result.runId, result);
        return {
          runId: result.runId,
          sessionId: result.sessionId,
          result: Promise.resolve(result),
        };
      },
      async submitInput(input) {
        return {
          accepted: false,
          delivery: input.delivery,
          sessionId: input.sessionId,
          afterRunId: input.afterRunId,
          reason: 'stale_run',
        };
      },
      async await(runId) {
        const result = runs.get(runId);
        if (result) return result;
        return { runId, sessionId: 'session-1', phase: 'completed' };
      },
      async get(runId) {
        const result = runs.get(runId);
        return {
          runId,
          sessionId: result?.sessionId ?? 'session-1',
          phase: result?.phase ?? 'completed',
          startedAt: '2026-07-09T00:00:00.000Z',
          provider: 'mock',
        };
      },
      async list() {
        return [];
      },
      async abort(runId) {
        return {
          runId,
          sessionId: 'session-1',
          accepted: false,
          state: 'confirmed',
          outcome: 'completed',
          phase: 'completed',
          revision: 1,
        };
      },
      async setModel() {},
      async setProvider() {},
      async setReasoning() {},
    },
    events: {
      subscribe(filter, listener) {
        listeners.push({ filter, listener });
        return {
          close() {
            const index = listeners.findIndex((entry) => entry.listener === listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      },
      async replay(filter) {
        const matched = eventLog.filter((event) => eventMatchesReplayFilter(event, filter));
        return filter?.limit !== undefined ? matched.slice(-filter.limit) : matched;
      },
    },
    permissions: {
      async request() {
        return { type: 'allow_once' };
      },
      async listPending() {
        return [];
      },
      async respond() {
        return true;
      },
      async listGrants() { return { revision: 0, value: [] }; },
      async revokeGrant() { return false; },
    },
    userInputs: createTestUserInputs(),
    credentials: createTestCredentialService(),
    hostTools: createTestHostToolService(),
    operations: {
      async get(input) {
        return {
          ...input,
          principalId: 'vitest',
          method: 'run.start',
          requestDigest: 'digest',
          state: 'applied',
          updatedAt: '2026-07-14T00:00:00.000Z',
        };
      },
    },
    workflows: {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      subscribe() {
        return { close() {} };
      },
      async pause() {
        return false;
      },
      async resume() {
        return false;
      },
      async stop() {
        return false;
      },
    },
    learning: {
      async list() {
        return { items: [], revision: 0 };
      },
      async get(nameOrSlug) {
        return {
          schemaVersion: 1,
          capabilityId: 'lc_runtime_test',
          displayName: 'Runtime test Skill',
          slug: nameOrSlug,
          carrier: 'skill',
          lifecycle: 'ready',
          revision: 1,
          createdAt: '2026-07-17T00:00:00.000Z',
          updatedAt: '2026-07-17T00:00:00.000Z',
          source: { kind: 'learning_controller' },
        };
      },
      async getSnapshot() {
        return { ready: 0, newlyActive: 0, attention: 0, active: 0, revision: 0 };
      },
      async events() { return []; },
      async *subscribe() {},
      async acknowledge() {},
      async snooze() {},
      async reject() {},
      async disable() {},
      async rollback() {},
      async promote() {},
      async review() {},
      async trust() {},
    },
    config: {
      async read() {
        return { provider: 'mock' };
      },
      async readEffective() {
        return {
          schemaVersion: 1 as const,
          capturedAt: '2026-08-29T00:00:00.000Z',
          persistedConfig: { state: 'loaded' as const },
          entries: {
            provider: {
              present: true,
              applied: true,
              source: 'runtime_override' as const,
              priority: 400,
              value: 'mock',
            },
          },
          credentials: {
            OPENAI_API_KEY: { present: false, source: 'unset' as const },
          },
        };
      },
      async patch(patch) {
        return { provider: 'mock', ...patch };
      },
      async reload() {
        return { ok: true, config: { provider: 'mock' } };
      },
    },
    catalog: {
      async providers() {
        return [{ name: 'mock', models: ['mock-model'] }];
      },
      async models(filter) {
        return filter?.provider
          ? { provider: filter.provider, models: ['mock-model'] }
          : [{ provider: 'mock', models: ['mock-model'] }];
      },
      async commands() {
        return [{
          name: 'help',
          aliases: ['h'],
          description: 'Show help',
          source: 'builtin',
        }];
      },
      async resolveCommand(input) {
        return input.name === 'help'
          ? {
              name: 'help',
              aliases: ['h'],
              description: 'Show help',
              source: 'builtin',
            }
          : null;
      },
      async skills() {
        return [{
          name: 'review',
          description: 'Review code',
          userInvocable: true,
          path: '/skills/review',
          source: 'project',
          disableModelInvocation: false,
        }];
      },
      async describeSkill(input) {
        return input.name === 'review'
          ? {
              name: 'review',
              description: 'Review code',
              userInvocable: true,
              path: '/skills/review',
              source: 'project',
              disableModelInvocation: false,
              content: 'Review instructions',
              skillFilePath: '/skills/review/SKILL.md',
          }
          : null;
      },
      async customProviders() {
        return [{
          name: 'custom-openai',
          protocol: 'openai',
          baseUrl: 'https://example.invalid/v1',
          apiKeyEnv: 'CUSTOM_OPENAI_KEY',
          model: 'custom-model',
        }];
      },
      async upsertCustomProvider(config) {
        return config;
      },
      async deleteCustomProvider() {
        return true;
      },
      async extensions() {
        return {
          active: true,
          extensions: [{
            path: '/extensions/demo/index.js',
            label: 'demo',
            loadSource: 'api',
          }],
          diagnostics: {
            loadedExtensions: [{
              path: '/extensions/demo/index.js',
              label: 'demo',
              loadSource: 'api',
            }],
            capabilityProviders: [],
            commands: [],
            tools: [],
            hooks: [],
            failures: [],
            defaults: {
              modelSelection: {},
            },
          },
        };
      },
      async reloadExtensions() {
        return { ok: true, active: false };
      },
    },
    mcp: {
      async listServers() {
        return {};
      },
      async getServer() {
        return undefined;
      },
      async validateServer(_name, config) {
        return {
          ok: true,
          config: config as Parameters<KodaXRuntime['mcp']['upsertServer']>[1],
        };
      },
      async upsertServer(_name, config) {
        return config;
      },
      async deleteServer() {
        return true;
      },
      async reloadServers() {
        return { ok: true, servers: [] };
      },
      async listTools() {
        return [];
      },
    },
    artifacts: {
      async create(input) {
        return {
          id: 'art-1',
          kind: input.kind,
          path: input.path,
          sizeBytes: 0,
          createdAt: '2026-07-09T00:00:00.000Z',
        };
      },
      async get(artifactId) {
        return artifactId === 'art-1'
          ? {
              id: 'art-1',
              kind: 'file',
              path: '/tmp/file.txt',
              sizeBytes: 0,
              createdAt: '2026-07-09T00:00:00.000Z',
            }
          : undefined;
      },
      async delete() {
        return true;
      },
    },
    admin: {
      agentRegistrations: {
        async list() { return [externalRegistration]; },
        async upsert() { return externalRegistration; },
        async setEnabled() { return { ...externalRegistration, enabled: false as const }; },
        async remove() { return true; },
      },
    },
    agents: {
      enabled: true,
      async listDispatchable() { return [externalListing]; },
      async describe() { return externalListing; },
      async preflight() {
        return {
          ok: true,
          descriptor: externalListing.descriptor,
          dispatchability: externalListing.dispatchability,
          reasons: [],
        };
      },
      async tree() {
        return {
          rootPath: '/root' as const,
          actors: [],
          activeNonRootTurns: 0,
          maxConcurrentThreads: 4,
          revision: 0,
        };
      },
      async detail(_sessionId, actorPath) {
        return {
          actor: {
            path: '/root',
            taskName: 'root',
            kind: actorPath === '/root' ? 'native' as const : 'external' as const,
            state: 'idle' as const,
            capabilities: {
              tools: [], filesystem: 'write' as const, network: true, providers: [], canAskUser: true,
            },
            turnIds: [],
            mailboxCursor: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            revision: 0,
          },
          turns: [],
          mailbox: [],
        };
      },
      async spawn() {
        return { actorPath: '/root/smoke', turnId: 'turn-smoke', state: 'accepted' as const };
      },
      async send() {},
      async followup() {
        return {
          delivery: 'started_turn' as const,
          turn: { actorPath: '/root/smoke', turnId: 'turn-smoke', state: 'accepted' as const },
        };
      },
      async interrupt() {},
      async output() {
        return {
          actorPath: '/root/smoke',
          turnId: 'turn-smoke',
          state: 'completed' as const,
          output: 'done',
          artifacts: [],
          progress: [],
        };
      },
      async events() { return []; },
      async wait() { return undefined; },
    },
    status: {
      async snapshot() {
        return {
          ...runtime.identity,
          sessions: [],
          runs: [],
          pendingPermissions: [],
          workflows: [],
        };
      },
      async preflight() {
        return {
          runtimeId: runtime.identity.runtimeId,
          clientCount: 0,
          activeRuns: [],
          queuedRuns: [],
          activeWorkflows: [],
          activeAgentTurns: [],
          activeAgentTasks: [],
          pendingPermissions: [],
          pendingUserInputs: [],
          blockers: [],
          canStop: true,
        };
      },
    },
    diagnostics: {
      async latestContextBudget(filter) {
        return latestTestDiagnostic(eventLog, 'context.budget.snapshot', filter);
      },
      async latestToolExposure(filter) {
        return latestTestDiagnostic(eventLog, 'tool.exposure.planned', filter);
      },
      async latestProviderCacheDiagnostic(filter) {
        return latestTestDiagnostic(eventLog, 'provider.cache.diagnostics', filter);
      },
    },
    async close() {},
    emit(event) {
      const normalized = event.cursor === undefined
        ? {
            ...event,
            cursor: {
              sessionId: event.sessionId,
              journalEpoch: `epoch-${event.sessionId}`,
              seq: event.seq,
            },
          }
        : event;
      eventLog.push(normalized);
      for (const entry of listeners) {
        if (entry.filter.sessionId && entry.filter.sessionId !== normalized.sessionId) continue;
        entry.listener(normalized);
      }
    },
  };

  return runtime;
}

function createTestUserInputs(): KodaXRuntime['userInputs'] {
  return {
    async listPending() { return []; },
    async respond(requestId) {
      return { requestId, accepted: false, status: 'already_resolved' };
    },
    async dismiss(requestId) {
      return { requestId, accepted: false, status: 'already_resolved' };
    },
  };
}

function createTestCredentialService(): KodaXRuntime['credentials'] {
  return {
    async register(input) { return { id: 'credential-test', ...input }; },
    async resume() { throw new Error('Missing credential lease.'); },
    async revoke() { return false; },
  };
}

function createTestHostToolService(): KodaXRuntime['hostTools'] {
  return {
    async register(tools) { return { id: 'host-tools-test', tools }; },
    async resume() { throw new Error('Missing host tool lease.'); },
    async revoke() { return false; },
    async getInvocation() { return undefined; },
  };
}

function createTestObservation(sessionId: string) {
  return {
    snapshot: {
      runtimeId: 'runtime-test',
      cursor: { sessionId, journalEpoch: `epoch-${sessionId}`, seq: 0 },
      transcriptRevision: 'sha256:test',
      session: { id: sessionId, title: 'Test Session' },
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
    invalidated: new Promise(() => undefined),
    close() {},
  };
}

function latestTestDiagnostic(
  events: readonly RuntimeEvent[],
  type: RuntimeEvent['type'],
  filter: {
    readonly sessionId?: string;
    readonly runId?: string;
    readonly contextKind?: 'root' | 'child';
    readonly agentId?: string;
  } | undefined,
): unknown {
  const requestedContextKind = filter?.contextKind
    ?? (filter?.agentId === undefined ? 'root' : undefined);
  const requestsChildContext = requestedContextKind === 'child'
    || filter?.agentId !== undefined;
  const matching = [...events].reverse().find((event) => {
    if (event.type !== type) return false;
    if (filter?.runId !== undefined && event.runId !== filter.runId) return false;
    if (
      !requestsChildContext
      && filter?.sessionId !== undefined
      && event.sessionId !== filter.sessionId
    ) return false;
    if (!isTestRecord(event.payload)) {
      return filter?.contextKind === undefined && filter?.agentId === undefined;
    }
    const actualContextKind = event.payload.contextKind === 'child' ? 'child' : 'root';
    if (requestedContextKind !== undefined && actualContextKind !== requestedContextKind) {
      return false;
    }
    if (filter?.agentId !== undefined && event.payload.agentId !== filter.agentId) {
      return false;
    }
    if (!requestsChildContext || filter?.sessionId === undefined) return true;
    const expectedPrefix = `${filter.sessionId}/agent/`;
    if (typeof event.payload.contextId !== 'string') return false;
    return filter.agentId === undefined
      ? event.payload.contextId.startsWith(expectedPrefix)
      : event.payload.contextId === `${expectedPrefix}${encodeURIComponent(filter.agentId)}`;
  });
  return matching?.payload ?? null;
}

function isTestRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eventMatchesReplayFilter(
  event: RuntimeEvent,
  filter: RuntimeEventReplayFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(event.type)) return false;
  }
  if (filter.after !== undefined && event.seq <= filter.after.seq) return false;
  return true;
}
