import { randomUUID } from 'node:crypto';

import type {
  KodaXDaemonRuntime,
  KodaXRuntime,
  RuntimeCompactSessionResult,
  RuntimeCredentialBroker,
  RuntimeCredentialLease,
  RuntimeScopedCredentialBroker,
  RuntimeScopedCredentialPurpose,
  RuntimeScopedCredentialTarget,
  RuntimeConfigReloadResult,
  RuntimeConfigPatch,
  RuntimeConnectionState,
  RuntimeContextBudgetSnapshot,
  RuntimeCommandResolveInput,
  RuntimeCommandInfo,
  RuntimeCreateArtifactInput,
  RuntimeArtifact,
  RuntimeDiagnosticFilter,
  RuntimeDaemonPreflight,
  RuntimeDaemonManagementState,
  RuntimeDaemonRollbackInput,
  RuntimeDaemonRollbackResult,
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventListener,
  RuntimeExtensionListResult,
  RuntimeIdentity,
  RuntimeGrantedScope,
  RuntimeHostToolDescriptor,
  RuntimeHostToolHandler,
  RuntimeHostToolInvocationStatus,
  RuntimeHostToolLease,
  RuntimeHostToolResult,
  RuntimeMcpReloadResult,
  RuntimeMcpToolListFilter,
  RuntimeMcpValidateResult,
  RuntimeModelListFilter,
  RuntimeOperationOptions,
  RuntimeObservationInvalidation,
  RuntimePermissionDecision,
  RuntimePermissionFilter,
  RuntimePermissionRequest,
  RuntimePermissionRequestInput,
  RuntimePermissionRespondOptions,
  RuntimeReadOptions,
  RuntimeRunFilter,
  RuntimeRunHandle,
  RuntimeRunResult,
  RuntimeRunStopReceipt,
  RuntimeRunStatus,
  RuntimeSession,
  RuntimeSessionDiagnostics,
  RuntimeSessionObservation,
  RuntimeSessionObservationSnapshot,
  RuntimeSessionCursor,
  RuntimeSessionSettings,
  RuntimeSessionStatus,
  RuntimeSessionSummary,
  RuntimeSkillDescribeInput,
  RuntimeSkillDescription,
  RuntimeSkillListFilter,
  RuntimeSkillSummary,
  RuntimeDaemonStartRunInput,
  RuntimeStatusSnapshot,
  RuntimeSubscription,
  RuntimeToolExposurePlan,
  RuntimeTranscript,
  RuntimeTranscriptEntryChunk,
  RuntimeTranscriptSearchResult,
  RuntimeTranscriptSlice,
  RuntimeConversationHistory,
  RuntimeConversationHistoryEntryChunk,
  RuntimeConversationHistorySlice,
  RuntimeUserInputRequest,
  RuntimeUserInputResolution,
  RuntimeWorkflowFilter,
  RuntimeWorkflowListener,
  RuntimeWorkflowSnapshot,
  RuntimeWorkflowSummary,
} from '../sdk-runtime.js';
import type { KodaXPromptCacheDiagnosticEvent } from '@kodax-ai/coding';
import { parseRuntimeEvent } from '../runtime-event.js';
import type {
  LearningEvent,
  McpServerConfig,
  McpServerToolList,
} from '@kodax-ai/agent';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { KODAX_VERSION } from '@kodax-ai/repl';
import type {
  RuntimeDaemonMethod,
  RuntimeDaemonNotification,
  RuntimeDaemonOperationEnvelope,
} from './protocol.js';
import { isRuntimeDaemonMutationMethod } from './protocol.js';

const MAX_PENDING_SUBSCRIPTION_NOTIFICATIONS = 256;
const MAX_RETAINED_HOST_TOOL_RESULTS = 1_000;

interface HostToolInvocationResult {
  readonly promise: Promise<RuntimeHostToolResult>;
  settled: boolean;
}

export interface RuntimeDaemonClientTransport {
  request(
    method: RuntimeDaemonMethod,
    params?: unknown,
    operation?: RuntimeDaemonOperationEnvelope,
    control?: RuntimeDaemonRequestControl,
  ): Promise<unknown>;
  subscribe(listener: (notification: RuntimeDaemonNotification) => void): RuntimeSubscription;
  subscribeLifecycle?(
    listener: (state: RuntimeDaemonTransportLifecycleState) => void,
  ): RuntimeSubscription;
  close?(): Promise<void> | void;
}

export interface RuntimeDaemonRequestControl {
  readonly signal?: AbortSignal;
  readonly onLateResult?: (value: unknown) => void;
}

/** Factual state for one daemon connection; disconnected does not imply daemon crash. */
export interface RuntimeDaemonTransportLifecycleState {
  readonly state: 'connected' | 'disconnected';
  readonly connectionId: string;
  readonly code?: RuntimeDaemonDisconnectCode;
  readonly reason?: string;
  readonly reconnectable: boolean;
}

/** Transport-observable close reason. Run/daemon crash classification needs durable evidence. */
export type RuntimeDaemonDisconnectCode =
  | 'protocol_closed'
  | 'transport_error'
  | 'invalid_frame'
  | 'client_closed';

export class RuntimeTransportBoundaryError extends Error {
  readonly code = 'invalid_transport_value' as const;

  constructor(readonly path: string, message: string) {
    super(message);
    this.name = 'RuntimeTransportBoundaryError';
  }
}

export class RuntimeDaemonUpgradeRequiredError extends Error {
  readonly code = 'daemon_upgrade_required' as const;
  readonly capability = 'actorControlPlane' as const;
  readonly restartRequired = true as const;

  constructor() {
    super(
      'Runtime daemon does not advertise actorControlPlane v1. Upgrade KodaX and restart the daemon before using Runtime Actor control.',
    );
    this.name = 'RuntimeDaemonUpgradeRequiredError';
  }
}

export class RuntimePermissionScopeUpgradeRequiredError extends Error {
  readonly code = 'daemon_upgrade_required' as const;
  readonly capability = 'runtimeAutoModeGuardrail' as const;
  readonly requiredVersion = 3 as const;
  readonly restartRequired = true as const;

  constructor() {
    super(
      'Runtime daemon does not advertise concrete permission scopes. Upgrade KodaX and restart the daemon before requesting grants for a concrete tool call.',
    );
    this.name = 'RuntimePermissionScopeUpgradeRequiredError';
  }
}

export class RuntimeCredentialBrokerUpgradeRequiredError extends Error {
  readonly code = 'daemon_upgrade_required' as const;
  readonly capability = 'providerCredentialBroker' as const;
  readonly restartRequired = true as const;

  constructor() {
    super(
      'Runtime daemon does not advertise providerCredentialBroker v2. Upgrade KodaX and restart the daemon before using scoped credential leases.',
    );
    this.name = 'RuntimeCredentialBrokerUpgradeRequiredError';
  }
}

export class RuntimeRunLifecycleUpgradeRequiredError extends Error {
  readonly code = 'daemon_upgrade_required' as const;
  readonly capability = 'runLifecycleControl' as const;
  readonly requiredVersion = 1 as const;
  readonly restartRequired = true as const;

  constructor() {
    super(
      'Runtime daemon does not advertise structured Stop receipts and protocol-level request cancellation. Upgrade KodaX and restart the daemon.',
    );
    this.name = 'RuntimeRunLifecycleUpgradeRequiredError';
  }
}

export interface RuntimeDaemonClientOptions {
  readonly identity: RuntimeIdentity;
  readonly transport: RuntimeDaemonClientTransport;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly journalEpoch?: string;
  readonly grantedScopes?: readonly RuntimeGrantedScope[];
}

type RuntimeDaemonPreflightWire = Omit<
  RuntimeDaemonPreflight,
  'activeAgentTurns' | 'activeAgentTasks'
> & Partial<Pick<RuntimeDaemonPreflight, 'activeAgentTurns' | 'activeAgentTasks'>>;

type RuntimeDaemonManagementStateWire = Omit<RuntimeDaemonManagementState, 'preflight'> & {
  readonly preflight: RuntimeDaemonPreflightWire;
};

function normalizeRuntimeDaemonPreflight(
  value: RuntimeDaemonPreflightWire,
): RuntimeDaemonPreflight {
  const activeAgentTurns = value.activeAgentTurns ?? value.activeAgentTasks ?? [];
  return {
    ...value,
    activeAgentTurns,
    activeAgentTasks: activeAgentTurns,
  };
}

export function createRuntimeDaemonClient(
  options: RuntimeDaemonClientOptions,
): KodaXDaemonRuntime {
  const request = (
    method: RuntimeDaemonMethod,
    params?: unknown,
    operation?: RuntimeOperationOptions,
    control?: RuntimeDaemonRequestControl,
  ): Promise<unknown> => options.transport.request(
    method,
    params,
    isRuntimeDaemonMutationMethod(method)
      ? createOperationEnvelope(options.journalEpoch, operation)
      : undefined,
    control,
  );
  const readRequest = (
    method: RuntimeDaemonMethod,
    params: Readonly<Record<string, unknown>>,
    readOptions?: RuntimeReadOptions,
    onLateResult?: (value: unknown) => void,
  ): Promise<unknown> => {
    try {
      validateRuntimeDaemonReadOptions(readOptions);
      if (
        (readOptions?.timeoutMs !== undefined || readOptions?.signal !== undefined)
        && !supportsRunLifecycleControl(options.capabilities)
      ) {
        throw new RuntimeRunLifecycleUpgradeRequiredError();
      }
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    const controller = new AbortController();
    let abandoned = false;
    let lateResultDelivered = false;
    const deliverLateResult = (value: unknown): void => {
      if (lateResultDelivered) return;
      lateResultDelivered = true;
      try {
        onLateResult?.(value);
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'runtime.daemon.client',
          level: 'warn',
          message: 'Runtime daemon late-result cleanup failed.',
          detail: error,
        });
      }
    };
    const operation = request(method, {
      ...params,
      ...(readOptions?.timeoutMs !== undefined
        ? { timeoutMs: readOptions.timeoutMs }
        : {}),
    }, undefined, {
      signal: controller.signal,
      ...(onLateResult !== undefined
        ? { onLateResult: deliverLateResult }
        : {}),
    });
    if (onLateResult !== undefined) {
      void operation.then(
        (value) => {
          if (abandoned) deliverLateResult(value);
        },
        () => undefined,
      );
    }
    return raceRuntimeDaemonRead(operation, readOptions, (error) => {
      abandoned = true;
      controller.abort(error);
    });
  };
  const actorControlPlaneError = (): RuntimeDaemonUpgradeRequiredError | undefined => {
    const capability = options.capabilities?.actorControlPlane;
    if (
      typeof capability !== 'object'
      || capability === null
      || !('version' in capability)
      || capability.version !== 1
      || !('methodNamespace' in capability)
      || capability.methodNamespace !== 'agents'
    ) {
      return new RuntimeDaemonUpgradeRequiredError();
    }
    return undefined;
  };
  const concretePermissionScopeError = (): RuntimePermissionScopeUpgradeRequiredError | undefined => {
    const capability = options.capabilities?.runtimeAutoModeGuardrail;
    if (
      typeof capability !== 'object'
      || capability === null
      || !('version' in capability)
      || typeof capability.version !== 'number'
      || capability.version < 3
      || !('concretePermissionMatchers' in capability)
      || capability.concretePermissionMatchers !== true
      || !('permissionGrantSuggestions' in capability)
      || capability.permissionGrantSuggestions !== true
    ) {
      return new RuntimePermissionScopeUpgradeRequiredError();
    }
    return undefined;
  };
  const credentialBrokers = new Map<
    string,
    | { readonly version: 1; readonly broker: RuntimeCredentialBroker }
    | { readonly version: 2; readonly broker: RuntimeScopedCredentialBroker }
  >();
  const hostToolHandlers = new Map<string, Readonly<Record<string, RuntimeHostToolHandler>>>();
  const hostToolResults = new Map<string, HostToolInvocationResult>();
  const connectionListeners = new Set<(state: RuntimeConnectionState) => void>();
  let connectionState: RuntimeConnectionState = {
    state: 'connected',
    connectionId: `connection_${randomUUID().replace(/-/g, '')}`,
    runtimeEpoch: options.identity.runtimeId,
    ...(options.journalEpoch !== undefined ? { journalEpoch: options.journalEpoch } : {}),
    reconnectable: false,
  };
  const transportLifecycleSubscription = options.transport.subscribeLifecycle?.((state) => {
    connectionState = {
      ...state,
      runtimeEpoch: options.identity.runtimeId,
      ...(options.journalEpoch !== undefined ? { journalEpoch: options.journalEpoch } : {}),
    };
    for (const listener of connectionListeners) {
      try {
        listener(connectionState);
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'runtime.daemon.client',
          level: 'warn',
          message: 'Runtime connection lifecycle listener failed.',
          detail: { errorType: error instanceof Error ? error.name : typeof error },
        });
      }
    }
  });
  const reverseSubscription = options.transport.subscribe((notification) => {
    if (notification.method === 'credential.request') {
      void answerCredentialRequest(notification.params, credentialBrokers, request)
        .catch(() => reportReverseBridgeFailure('credential request'));
    } else if (notification.method === 'host_tool.invoke') {
      void answerHostToolInvocation(
        notification.params,
        hostToolHandlers,
        hostToolResults,
        request,
      ).catch(() => reportReverseBridgeFailure('host tool invocation'));
    }
  });
  let localResourcesClosed = false;
  let transportClosed = false;
  let closeAttempt: Promise<void> | undefined;
  const closeClient = (): Promise<void> => {
    if (transportClosed) return Promise.resolve();
    if (closeAttempt) return closeAttempt;
    const attempt = (async (): Promise<void> => {
      if (!localResourcesClosed) {
        transportLifecycleSubscription?.close();
        reverseSubscription.close();
        connectionListeners.clear();
        credentialBrokers.clear();
        hostToolHandlers.clear();
        hostToolResults.clear();
        localResourcesClosed = true;
      }
      await options.transport.close?.();
      transportClosed = true;
    })();
    closeAttempt = attempt;
    void attempt.finally(() => {
      if (closeAttempt === attempt) closeAttempt = undefined;
    }).catch(() => undefined);
    return attempt;
  };

  return {
    identity: options.identity,
    capabilities: options.capabilities,
    ...(options.grantedScopes !== undefined ? { grantedScopes: options.grantedScopes } : {}),
    sessions: {
      create(input = {}) {
        const { operation, ...transportInput } = input;
        return request('session.create', transportInput, operation) as Promise<RuntimeSession>;
      },
      load(sessionId, readOptions) {
        return readRequest('session.load', { sessionId }, readOptions) as Promise<RuntimeSession>;
      },
      list(filter) {
        return request('session.list', filter) as Promise<readonly RuntimeSessionSummary[]>;
      },
      status(sessionId) {
        return request('session.status', { sessionId }) as Promise<RuntimeSessionStatus>;
      },
      transcript(sessionId, readOptions) {
        return readRequest('session.transcript', { sessionId }, readOptions) as Promise<RuntimeTranscript | null>;
      },
      transcriptPage(input, readOptions) {
        return readRequest('session.transcript.page', input, readOptions) as Promise<RuntimeTranscriptSlice | null>;
      },
      transcriptEntryChunk(input, readOptions) {
        return readRequest('session.transcript.entryChunk', input, readOptions) as Promise<RuntimeTranscriptEntryChunk | null>;
      },
      transcriptSearch(input, readOptions) {
        return readRequest('session.transcript.search', input, readOptions) as Promise<RuntimeTranscriptSearchResult | null>;
      },
      conversation(sessionId, readOptions) {
        return readRequest(
          'session.conversation',
          { sessionId },
          readOptions,
        ) as Promise<RuntimeConversationHistory | null>;
      },
      conversationPage(input, readOptions) {
        return readRequest(
          'session.conversation.page',
          input as unknown as Readonly<Record<string, unknown>>,
          readOptions,
        ) as Promise<RuntimeConversationHistorySlice | null>;
      },
      conversationEntryChunk(input, readOptions) {
        return readRequest(
          'session.conversation.entryChunk',
          input as unknown as Readonly<Record<string, unknown>>,
          readOptions,
        ) as Promise<RuntimeConversationHistoryEntryChunk | null>;
      },
      observe(sessionId, listener, readOptions) {
        return observeDaemonSession(options.transport, readRequest, sessionId, listener, readOptions);
      },
      diagnostics(input) {
        return readRequest(
          'session.diagnostics',
          {
            sessionId: input.sessionId,
            ...(input.runId !== undefined ? { runId: input.runId } : {}),
          },
          input,
        ).then((value) => ({
          ...(value as RuntimeSessionDiagnostics),
          sdkVersion: KODAX_VERSION,
          runtimeVersion: options.identity.version,
          daemonVersion:
            options.identity.mode === 'daemon' ? options.identity.version : null,
          runtimeMode: options.identity.mode,
        }));
      },
      fork(input) {
        return request('session.fork', input) as Promise<RuntimeSession | null>;
      },
      getSettings(sessionId) {
        return request('session.settings.get', { sessionId }) as Promise<RuntimeSessionSettings>;
      },
      getSettingsVersioned(sessionId) {
        return request('session.settings.getVersioned', { sessionId }) as ReturnType<KodaXRuntime['sessions']['getSettingsVersioned']>;
      },
      getAutoModeStats(sessionId) {
        return request('session.autoMode.getStats', { sessionId }) as ReturnType<KodaXRuntime['sessions']['getAutoModeStats']>;
      },
      async updateSettings(sessionId, patch) {
        const current = await this.getSettingsVersioned(sessionId);
        return (await this.updateSettingsVersioned(
          sessionId,
          patch,
          { expectedRevision: current.revision },
        )).value;
      },
      updateSettingsVersioned(sessionId, patch, operation) {
        return request(
          'session.settings.updateVersioned',
          { sessionId, patch, expectedRevision: operation.expectedRevision },
          operation,
        ) as ReturnType<KodaXRuntime['sessions']['updateSettingsVersioned']>;
      },
      appendNotice(input) {
        return request('session.notice.append', input) as ReturnType<KodaXRuntime['sessions']['appendNotice']>;
      },
      rewind(input) {
        return request('session.rewind', input) as Promise<RuntimeSession | null>;
      },
      setActiveEntry(input) {
        return request('session.active_entry.set', input) as Promise<RuntimeSession | null>;
      },
      compact(input) {
        const { operation, ...transportInput } = input;
        return request(
          'session.compact',
          transportInput,
          operation,
        ) as Promise<RuntimeCompactSessionResult>;
      },
      async archive(sessionId) {
        await request('session.archive', { sessionId });
      },
      async unarchive(sessionId) {
        await request('session.unarchive', { sessionId });
      },
      async delete(sessionId) {
        await request('session.delete', { sessionId });
      },
    },
    runs: {
      async start(input: RuntimeDaemonStartRunInput): Promise<RuntimeRunHandle> {
        const { operation, ...transportInput } = input;
        assertRuntimeTransportSafe(transportInput, 'run.start');
        const started = requireRecord(await request('run.start', transportInput, operation));
        const runId = requireStringField(started, 'runId');
        const sessionId = requireStringField(started, 'sessionId');
        const turnId = optionalStringField(started, 'turnId');
        return {
          runId,
          sessionId,
          ...(turnId !== undefined ? { turnId } : {}),
          result: requestRuntimeRunResult(request, runId),
        };
      },
      async submitInput(input) {
        const { operation, ...transportInput } = input;
        assertRuntimeTransportSafe(transportInput, 'run.input.submit');
        return request('run.input.submit', transportInput, operation) as ReturnType<
          KodaXRuntime['runs']['submitInput']
        >;
      },
      await(runId) {
        return requestRuntimeRunResult(request, runId);
      },
      get(runId) {
        return request('run.get', { runId }) as Promise<RuntimeRunStatus>;
      },
      list(filter?: RuntimeRunFilter) {
        return request('run.list', filter) as Promise<readonly RuntimeRunStatus[]>;
      },
      abort(runId) {
        if (!supportsRunLifecycleControl(options.capabilities)) {
          return Promise.reject(new RuntimeRunLifecycleUpgradeRequiredError());
        }
        return request('run.abort', { runId }).then((value) =>
          parseRuntimeRunStopReceipt(value, runId)
        );
      },
      async setModel(runId, model) {
        await request('run.model.set', { runId, model });
      },
      async setProvider(runId, provider) {
        await request('run.provider.set', { runId, provider });
      },
      async setReasoning(runId, reasoning) {
        await request('run.reasoning.set', { runId, reasoning });
      },
    },
    events: {
      subscribe(filter, listener) {
        return subscribeToDaemonEvents(options.transport, request, filter, listener);
      },
      replay(filter) {
        return request('event.replay', filter).then((value) => {
          if (!Array.isArray(value)) throw new Error('Expected daemon event replay array.');
          return value.flatMap((item) => {
            const event = parseRuntimeEventForClient(item);
            return event === undefined ? [] : [event];
          });
        });
      },
    },
    permissions: {
      request(input: RuntimePermissionRequestInput) {
        if (input.toolInput !== undefined) {
          const unavailable = concretePermissionScopeError();
          if (unavailable) return Promise.reject(unavailable);
        }
        return request('permission.request', input) as Promise<RuntimePermissionDecision>;
      },
      listPending(filter?: RuntimePermissionFilter) {
        return request('permission.list', filter) as Promise<readonly RuntimePermissionRequest[]>;
      },
      respond(requestId: string, decision: RuntimePermissionDecision, options?: RuntimePermissionRespondOptions) {
        return request('permission.respond', {
          requestId,
          decision,
          ...(options?.runId !== undefined ? { runId: options.runId } : {}),
        }) as Promise<boolean>;
      },
      listGrants() {
        return request('permission.grants.list') as ReturnType<KodaXRuntime['permissions']['listGrants']>;
      },
      revokeGrant(grantId, expectedRevision) {
        return request('permission.grants.revoke', { grantId, expectedRevision }) as Promise<boolean>;
      },
    },
    userInputs: {
      listPending(filter) {
        return request('user_input.listPending', filter) as Promise<readonly RuntimeUserInputRequest[]>;
      },
      respond(requestId, answer, options) {
        return request('user_input.respond', {
          requestId,
          answer,
          ...(options?.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
          ...(options?.runId !== undefined ? { runId: options.runId } : {}),
        }) as Promise<RuntimeUserInputResolution>;
      },
      dismiss(requestId, options) {
        return request('user_input.dismiss', {
          requestId,
          ...(options?.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
          ...(options?.runId !== undefined ? { runId: options.runId } : {}),
        }) as Promise<RuntimeUserInputResolution>;
      },
    },
    credentials: {
      async register(input, broker) {
        const leaseId = `credlease_${randomUUID().replace(/-/g, '')}`;
        credentialBrokers.set(leaseId, { version: 1, broker });
        try {
          return await request('credential.register', {
            leaseId,
            providers: input.providers,
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          }) as RuntimeCredentialLease;
        } catch (error: unknown) {
          credentialBrokers.delete(leaseId);
          throw error;
        }
      },
      async resume(leaseId, broker) {
        credentialBrokers.set(leaseId, { version: 1, broker });
        try {
          const value = await request('credential.get', { leaseId });
          if (value === null || value === undefined) {
            throw Object.assign(
              new Error(`Credential lease is unavailable after Runtime reconnect: ${leaseId}`),
              { code: 'credential_unavailable' as const },
            );
          }
          const lease = requireRecord(value) as unknown as RuntimeCredentialLease;
          if (lease.brokerVersion === 2) {
            throw Object.assign(
              new Error(`Credential lease is scoped v2 and cannot use the v1 broker: ${leaseId}`),
              { code: 'credential_unavailable' as const },
            );
          }
          return lease;
        } catch (error: unknown) {
          credentialBrokers.delete(leaseId);
          throw error;
        }
      },
      async registerScoped(input, broker) {
        if (!supportsScopedCredentialBroker(options.capabilities)) {
          throw new RuntimeCredentialBrokerUpgradeRequiredError();
        }
        const leaseId = `credlease_${randomUUID().replace(/-/g, '')}`;
        credentialBrokers.set(leaseId, { version: 2, broker });
        try {
          return await request('credential.register', {
            leaseId,
            providers: input.providers,
            brokerVersion: 2,
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          }) as RuntimeCredentialLease;
        } catch (error: unknown) {
          credentialBrokers.delete(leaseId);
          throw error;
        }
      },
      async resumeScoped(leaseId, broker) {
        if (!supportsScopedCredentialBroker(options.capabilities)) {
          throw new RuntimeCredentialBrokerUpgradeRequiredError();
        }
        credentialBrokers.set(leaseId, { version: 2, broker });
        try {
          const value = await request('credential.get', { leaseId });
          if (value === null || value === undefined) {
            throw Object.assign(
              new Error(`Credential lease is unavailable after Runtime reconnect: ${leaseId}`),
              { code: 'credential_unavailable' as const },
            );
          }
          const lease = requireRecord(value) as unknown as RuntimeCredentialLease;
          if (lease.brokerVersion !== 2) {
            throw Object.assign(
              new Error(`Credential lease is not a scoped v2 lease: ${leaseId}`),
              { code: 'credential_unavailable' as const },
            );
          }
          return lease;
        } catch (error: unknown) {
          credentialBrokers.delete(leaseId);
          throw error;
        }
      },
      async revoke(leaseId) {
        const revoked = await request('credential.revoke', { leaseId }) as boolean;
        credentialBrokers.delete(leaseId);
        return revoked;
      },
    },
    hostTools: {
      async register(tools, handlers) {
        validateHostToolHandlers(tools, handlers);
        const leaseId = `hostlease_${randomUUID().replace(/-/g, '')}`;
        hostToolHandlers.set(leaseId, handlers);
        try {
          return await request('host_tool.register', { leaseId, tools }) as RuntimeHostToolLease;
        } catch (error: unknown) {
          hostToolHandlers.delete(leaseId);
          throw error;
        }
      },
      async resume(leaseId, handlers) {
        hostToolHandlers.set(leaseId, handlers);
        try {
          const value = await request('host_tool.get', { leaseId });
          if (value === null || value === undefined) {
            throw Object.assign(
              new Error(`Host tool lease is unavailable after Runtime reconnect: ${leaseId}`),
              { code: 'host_tool_unavailable' as const },
            );
          }
          const lease = requireRecord(value) as unknown as RuntimeHostToolLease;
          validateHostToolHandlers(lease.tools, handlers);
          return lease;
        } catch (error: unknown) {
          hostToolHandlers.delete(leaseId);
          throw error;
        }
      },
      async getInvocation(invocationId) {
        return nullToUndefined<RuntimeHostToolInvocationStatus>(
          await request('host_tool.invocation.get', { invocationId }),
        );
      },
      async revoke(leaseId) {
        const revoked = await request('host_tool.revoke', { leaseId }) as boolean;
        if (revoked) hostToolHandlers.delete(leaseId);
        return revoked;
      },
    },
    operations: {
      get(input) {
        return request('operation.get', input) as ReturnType<KodaXRuntime['operations']['get']>;
      },
    },
    workflows: {
      list(filter?: RuntimeWorkflowFilter) {
        return request('workflow.list', filter) as Promise<readonly RuntimeWorkflowSummary[]>;
      },
      get(runId: string) {
        return request('workflow.get', { runId }).then(nullToUndefined<RuntimeWorkflowSnapshot>);
      },
      subscribe(filter: RuntimeWorkflowFilter, listener: RuntimeWorkflowListener) {
        return subscribeToDaemonWorkflowEvents(options.transport, request, filter, listener);
      },
      pause(runId: string) {
        return request('workflow.pause', { runId }) as Promise<boolean>;
      },
      resume(runId: string) {
        return request('workflow.resume', { runId }) as Promise<boolean>;
      },
      stop(runId: string) {
        return request('workflow.stop', { runId }) as Promise<boolean>;
      },
    },
    learning: {
      list(query) {
        return request('learning.list', query ?? {}) as ReturnType<KodaXRuntime['learning']['list']>;
      },
      get(nameOrSlug) {
        return request('learning.get', { nameOrSlug }) as ReturnType<KodaXRuntime['learning']['get']>;
      },
      getSnapshot() {
        return request('learning.snapshot') as ReturnType<KodaXRuntime['learning']['getSnapshot']>;
      },
      events(afterRevision) {
        return request('learning.events', {
          ...(afterRevision !== undefined ? { afterRevision } : {}),
        }) as ReturnType<KodaXRuntime['learning']['events']>;
      },
      subscribe(subscribeOptions) {
        return pollRuntimeLearningEvents(request, subscribeOptions?.afterRevision ?? 0);
      },
      async acknowledge(nameOrSlug) {
        await request('learning.acknowledge', { nameOrSlug });
      },
      async snooze(nameOrSlug, until) {
        await request('learning.snooze', { nameOrSlug, until });
      },
      async reject(nameOrSlug) {
        await request('learning.reject', { nameOrSlug });
      },
      async disable(nameOrSlug) {
        await request('learning.disable', { nameOrSlug });
      },
      async rollback(nameOrSlug) {
        await request('learning.rollback', { nameOrSlug });
      },
      async promote(nameOrSlug, scope) {
        await request('learning.promote', { nameOrSlug, scope });
      },
      async review(nameOrSlug) {
        await request('learning.review', { nameOrSlug });
      },
      async trust(nameOrSlug) {
        await request('learning.trust', { nameOrSlug });
      },
    },
    config: {
      read() {
        return request('config.read');
      },
      readEffective() {
        return request('config.effective') as ReturnType<
          KodaXRuntime['config']['readEffective']
        >;
      },
      patch(patch: RuntimeConfigPatch) {
        return request('config.patch', { patch });
      },
      reload() {
        return request('config.reload') as Promise<RuntimeConfigReloadResult>;
      },
    },
    catalog: {
      providers() {
        return request('provider.list');
      },
      models(filter?: RuntimeModelListFilter) {
        return request('model.list', filter);
      },
      commands(projectRoot?: string) {
        return request(
          'command.list',
          projectRoot !== undefined ? { projectRoot } : undefined,
        ) as Promise<readonly RuntimeCommandInfo[]>;
      },
      resolveCommand(input: RuntimeCommandResolveInput) {
        return request('command.resolve', input) as Promise<RuntimeCommandInfo | null>;
      },
      skills(filter?: RuntimeSkillListFilter) {
        return request('skill.list', filter) as Promise<readonly RuntimeSkillSummary[]>;
      },
      describeSkill(input: RuntimeSkillDescribeInput) {
        return request('skill.describe', input) as Promise<RuntimeSkillDescription | null>;
      },
      customProviders() {
        return request('provider.custom.list') as ReturnType<KodaXRuntime['catalog']['customProviders']>;
      },
      upsertCustomProvider(config) {
        return request('provider.custom.upsert', { config }) as ReturnType<KodaXRuntime['catalog']['upsertCustomProvider']>;
      },
      deleteCustomProvider(name: string) {
        return request('provider.custom.remove', { name }) as Promise<boolean>;
      },
      extensions() {
        return request('extension.list') as Promise<RuntimeExtensionListResult>;
      },
      reloadExtensions() {
        return request('extension.reload') as ReturnType<KodaXRuntime['catalog']['reloadExtensions']>;
      },
    },
    mcp: {
      listServers() {
        return request('mcp.server.list') as Promise<Record<string, McpServerConfig>>;
      },
      getServer(name: string) {
        return request('mcp.server.get', { name }).then(nullToUndefined<McpServerConfig>);
      },
      validateServer(name: string, config: unknown) {
        return request('mcp.server.validate', { name, config }) as Promise<RuntimeMcpValidateResult>;
      },
      upsertServer(name: string, config: McpServerConfig) {
        return request('mcp.server.upsert', { name, config }) as Promise<McpServerConfig>;
      },
      deleteServer(name: string) {
        return request('mcp.server.delete', { name }) as Promise<boolean>;
      },
      reloadServers() {
        return request('mcp.server.reload') as Promise<RuntimeMcpReloadResult>;
      },
      listTools(filter?: RuntimeMcpToolListFilter) {
        return request('mcp.tool.list', filter) as Promise<readonly McpServerToolList[]>;
      },
    },
    artifacts: {
      create(input: RuntimeCreateArtifactInput) {
        return request('artifact.create', input) as Promise<RuntimeArtifact>;
      },
      get(artifactId: string) {
        return request('artifact.get', { artifactId }).then(nullToUndefined<RuntimeArtifact>);
      },
      delete(artifactId: string) {
        return request('artifact.delete', { artifactId }) as Promise<boolean>;
      },
    },
    admin: {
      agentRegistrations: {
        list() {
          return request('agentRegistrations.list') as ReturnType<KodaXRuntime['admin']['agentRegistrations']['list']>;
        },
        upsert(registration, options) {
          assertRuntimeTransportSafe(registration, 'agentRegistrations.upsert.registration');
          return request('agentRegistrations.upsert', {
            registration,
            ...(options?.expectedConfigurationRevision !== undefined
              ? { expectedConfigurationRevision: options.expectedConfigurationRevision } : {}),
            ...(options?.expectedManagementOwner !== undefined
              ? { expectedManagementOwner: options.expectedManagementOwner } : {}),
          }) as ReturnType<KodaXRuntime['admin']['agentRegistrations']['upsert']>;
        },
        setEnabled(agentId, enabled, options) {
          return request('agentRegistrations.setEnabled', {
            agentId,
            enabled,
            ...(options?.expectedConfigurationRevision !== undefined
              ? { expectedConfigurationRevision: options.expectedConfigurationRevision } : {}),
            ...(options?.expectedManagementOwner !== undefined
              ? { expectedManagementOwner: options.expectedManagementOwner } : {}),
            ...(options?.claimOwner !== undefined ? { claimOwner: options.claimOwner } : {}),
          })
            .then(nullToUndefined<Awaited<ReturnType<KodaXRuntime['admin']['agentRegistrations']['setEnabled']>>>);
        },
        remove(agentId, options) {
          return request('agentRegistrations.remove', {
            agentId,
            ...(options?.expectedConfigurationRevision !== undefined
              ? { expectedConfigurationRevision: options.expectedConfigurationRevision } : {}),
            ...(options?.expectedManagementOwner !== undefined
              ? { expectedManagementOwner: options.expectedManagementOwner } : {}),
          }) as Promise<boolean>;
        },
      },
    },
    agents: {
      enabled: options.capabilities?.externalAgents === true,
      listDispatchable(query) {
        return request('agents.listDispatchable', query) as ReturnType<KodaXRuntime['agents']['listDispatchable']>;
      },
      describe(agentId, query) {
        return request('agents.describe', { agentId, query })
          .then(nullToUndefined<Awaited<ReturnType<KodaXRuntime['agents']['describe']>>>);
      },
      preflight(input) {
        return request('agents.preflight', input) as ReturnType<KodaXRuntime['agents']['preflight']>;
      },
      tree(sessionId) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return request('agents.tree', { sessionId }) as ReturnType<KodaXRuntime['agents']['tree']>;
      },
      detail(sessionId, actorPath) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return request('agents.detail', { sessionId, actorPath }) as ReturnType<
          KodaXRuntime['agents']['detail']
        >;
      },
      spawn(sessionId, input, options) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        assertRuntimeTransportSafe(input, 'agents.spawn');
        assertRuntimeTransportSafe(options?.credential, 'agents.spawn.credential');
        return request('agents.spawn', {
          sessionId,
          input,
          ...(options?.credential !== undefined
            ? { credential: options.credential }
            : {}),
        }, options?.operation) as ReturnType<
          KodaXRuntime['agents']['spawn']
        >;
      },
      async send(sessionId, actorPath, content, classification) {
        const unavailable = actorControlPlaneError();
        if (unavailable) throw unavailable;
        await request('agents.send', {
          sessionId,
          actorPath,
          content,
          ...(classification !== undefined ? { classification } : {}),
        });
      },
      followup(sessionId, actorPath, objective, options) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        assertRuntimeTransportSafe(options?.credential, 'agents.followup.credential');
        return request('agents.followup', {
          sessionId,
          actorPath,
          objective,
          ...(options?.expectedRevision !== undefined
            ? { expectedRevision: options.expectedRevision }
            : {}),
          ...(options?.credential !== undefined
            ? { credential: options.credential }
            : {}),
        }, options?.operation) as ReturnType<
          KodaXRuntime['agents']['followup']
        >;
      },
      async interrupt(sessionId, actorPath, reason) {
        const unavailable = actorControlPlaneError();
        if (unavailable) throw unavailable;
        await request('agents.interrupt', {
          sessionId,
          actorPath,
          ...(reason !== undefined ? { reason } : {}),
        });
      },
      output(sessionId, actorPath, turnId) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return request('agents.output', {
          sessionId,
          actorPath,
          ...(turnId !== undefined ? { turnId } : {}),
        }) as ReturnType<KodaXRuntime['agents']['output']>;
      },
      events(sessionId, afterSequence) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return request('agents.events', {
          sessionId,
          ...(afterSequence !== undefined ? { afterSequence } : {}),
        }) as ReturnType<KodaXRuntime['agents']['events']>;
      },
      wait(sessionId, afterSequence, timeoutMs, options) {
        const unavailable = actorControlPlaneError();
        if (unavailable) return Promise.reject(unavailable);
        return readRequest('agents.wait', {
          sessionId,
          ...(afterSequence !== undefined ? { afterSequence } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }, options).then(
          nullToUndefined<Awaited<ReturnType<KodaXRuntime['agents']['wait']>>>,
        );
      },
    },
    status: {
      snapshot() {
        return request('daemon.status') as Promise<RuntimeStatusSnapshot>;
      },
      preflight() {
        return request('daemon.preflight').then((value) => (
          normalizeRuntimeDaemonPreflight(value as RuntimeDaemonPreflightWire)
        ));
      },
    },
    daemon: {
      inspect() {
        return request('daemon.management.get').then((value) => {
          const state = value as RuntimeDaemonManagementStateWire;
          return {
            ...state,
            preflight: normalizeRuntimeDaemonPreflight(state.preflight),
          };
        });
      },
      stopForInline(input: RuntimeDaemonRollbackInput) {
        const { operation, ...params } = input;
        return request(
          'daemon.rollbackToInline',
          params,
          operation,
        ) as Promise<RuntimeDaemonRollbackResult>;
      },
    },
    diagnostics: {
      latestContextBudget(filter?: RuntimeDiagnosticFilter) {
        return request('context.budget.get', filter) as Promise<RuntimeContextBudgetSnapshot | null>;
      },
      latestToolExposure(filter?: RuntimeDiagnosticFilter) {
        return request('tool.exposure.preview', filter) as Promise<RuntimeToolExposurePlan | null>;
      },
      latestProviderCacheDiagnostic(filter?: RuntimeDiagnosticFilter) {
        return request(
          'provider.cache.diagnostics.get',
          filter,
        ) as Promise<KodaXPromptCacheDiagnosticEvent | null>;
      },
    },
    connection: {
      current() {
        return connectionState;
      },
      subscribe(listener) {
        connectionListeners.add(listener);
        listener(connectionState);
        return {
          close() {
            connectionListeners.delete(listener);
          },
        };
      },
    },
    close: closeClient,
  };
}

async function* pollRuntimeLearningEvents(
  request: (method: RuntimeDaemonMethod, params?: unknown) => Promise<unknown>,
  initialRevision: number,
): AsyncIterable<LearningEvent> {
  let revision = initialRevision;
  while (true) {
    const events = await request('learning.events', { afterRevision: revision }) as readonly LearningEvent[];
    if (events.length === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      continue;
    }
    for (const event of events) {
      revision = event.sequence;
      yield event;
    }
  }
}

function reportReverseBridgeFailure(kind: string): void {
  emitKodaXDiagnostic({
    source: 'runtime.daemon.client',
    level: 'warn',
    message: `Failed to deliver ${kind} result to the Runtime daemon.`,
  });
}

async function answerCredentialRequest(
  params: unknown,
  brokers: ReadonlyMap<
    string,
    | { readonly version: 1; readonly broker: RuntimeCredentialBroker }
    | { readonly version: 2; readonly broker: RuntimeScopedCredentialBroker }
  >,
  request: (
    method: RuntimeDaemonMethod,
    params?: unknown,
    operation?: RuntimeOperationOptions,
  ) => Promise<unknown>,
): Promise<void> {
  const payload = requireRecord(params);
  const requestId = requireStringField(payload, 'requestId');
  const leaseId = requireStringField(payload, 'leaseId');
  const registered = brokers.get(leaseId);
  if (!registered) {
    await request('credential.supply', { requestId, error: 'credential_lease_unavailable' });
    return;
  }
  try {
    const credential = registered.version === 1
      ? await registered.broker({
          leaseId,
          provider: requireStringField(payload, 'provider'),
          sessionId: requireStringField(payload, 'sessionId'),
          runId: requireStringField(payload, 'runId'),
        })
      : await registered.broker({
          requestId,
          leaseId,
          provider: requireStringField(payload, 'provider'),
          sessionId: requireStringField(payload, 'sessionId'),
          target: parseScopedCredentialTarget(payload.target),
          purpose: parseScopedCredentialPurpose(payload.purpose),
        });
    await request('credential.supply', {
      requestId,
      ...(credential !== undefined ? { credential } : { error: 'credential_unavailable' }),
    });
  } catch {
    await request('credential.supply', { requestId, error: 'credential_broker_failed' });
  }
}

async function answerHostToolInvocation(
  params: unknown,
  handlersByLease: ReadonlyMap<string, Readonly<Record<string, RuntimeHostToolHandler>>>,
  results: Map<string, HostToolInvocationResult>,
  request: (
    method: RuntimeDaemonMethod,
    params?: unknown,
    operation?: RuntimeOperationOptions,
  ) => Promise<unknown>,
): Promise<void> {
  const payload = requireRecord(params);
  const invocationId = requireStringField(payload, 'invocationId');
  const leaseId = requireStringField(payload, 'leaseId');
  const toolName = requireStringField(payload, 'toolName');
  const handler = handlersByLease.get(leaseId)?.[toolName];
  if (!handler) {
    await request('host_tool.complete', { invocationId, error: 'host_tool_unavailable' });
    return;
  }
  let result = results.get(invocationId);
  if (!result) {
    const promise = Promise.resolve().then(() => handler({
        invocationId,
        leaseId,
        toolName,
        sessionId: requireStringField(payload, 'sessionId'),
        runId: requireStringField(payload, 'runId'),
        input: requireRecord(payload.input),
      }));
    result = { promise, settled: false };
    results.set(invocationId, result);
    const tracked = result;
    void promise.finally(() => {
      tracked.settled = true;
      pruneHostToolResults(results);
    }).catch(() => undefined);
    pruneHostToolResults(results);
  }
  try {
    await request('host_tool.complete', { invocationId, result: await result.promise });
  } catch {
    try {
      await request('host_tool.complete', { invocationId, error: 'host_tool_failed' });
    } catch (error: unknown) {
      throw new Error('Failed to report the Host Tool outcome to the Runtime daemon.', {
        cause: error,
      });
    }
  }
}

function validateHostToolHandlers(
  tools: readonly RuntimeHostToolDescriptor[],
  handlers: Readonly<Record<string, RuntimeHostToolHandler>>,
): void {
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== tools.length || tools.length === 0) {
    throw new Error('Host tool descriptors must have unique, non-empty names.');
  }
  for (const name of names) {
    if (typeof handlers[name] !== 'function') {
      throw new Error(`Missing host tool handler: ${name}`);
    }
  }
}

function pruneHostToolResults(results: Map<string, HostToolInvocationResult>): void {
  if (results.size <= MAX_RETAINED_HOST_TOOL_RESULTS) return;
  for (const [invocationId, result] of results) {
    if (results.size <= MAX_RETAINED_HOST_TOOL_RESULTS) return;
    if (result.settled) results.delete(invocationId);
  }
}

function createOperationEnvelope(
  journalEpoch: string | undefined,
  operation: RuntimeOperationOptions | undefined,
): RuntimeDaemonOperationEnvelope | undefined {
  const epoch = operation?.journalEpoch ?? journalEpoch;
  if (epoch === undefined) return undefined;
  return {
    operationId: operation?.operationId ?? `op_${randomUUID().replace(/-/g, '')}`,
    journalEpoch: epoch,
  };
}

function subscribeToDaemonEvents(
  transport: RuntimeDaemonClientTransport,
  request: RuntimeDaemonClientTransport['request'],
  filter: RuntimeEventFilter,
  listener: RuntimeEventListener,
): RuntimeSubscription {
  return subscribeToDaemonNotification(transport, request, 'event.subscribe', {
    filter,
  }, (event) => {
    deliverRuntimeEvent(event, listener);
  });
}

async function observeDaemonSession(
  transport: RuntimeDaemonClientTransport,
  request: (
    method: RuntimeDaemonMethod,
    params: Readonly<Record<string, unknown>>,
    options?: RuntimeReadOptions,
    onLateResult?: (value: unknown) => void,
  ) => Promise<unknown>,
  sessionId: string,
  listener: RuntimeEventListener,
  readOptions?: RuntimeReadOptions,
): Promise<RuntimeSessionObservation> {
  let closed = false;
  let live = false;
  let remoteSubscriptionId: string | undefined;
  let bufferOverflowed = false;
  let cursor: RuntimeSessionCursor | undefined;
  let invalidated = false;
  let connectionId: string | undefined;
  let resolveInvalidated:
    | ((value: RuntimeObservationInvalidation) => void)
    | undefined;
  const invalidation = new Promise<RuntimeObservationInvalidation>((resolve) => {
    resolveInvalidated = resolve;
  });
  const pending: Array<{
    readonly method: 'event' | 'observation.invalidated';
    readonly payload: Record<string, unknown>;
  }> = [];
  let local: RuntimeSubscription | undefined;
  let lifecycle: RuntimeSubscription | undefined;
  const closeResources = (): void => {
    pending.length = 0;
    local?.close();
    local = undefined;
    lifecycle?.close();
    lifecycle = undefined;
    const subscriptionId = remoteSubscriptionId;
    remoteSubscriptionId = undefined;
    if (subscriptionId !== undefined) {
      void request('event.unsubscribe', { subscriptionId }).catch(
        (error: unknown) => {
          emitKodaXDiagnostic({
            source: 'runtime.daemon.client',
            level: 'warn',
            message: 'Failed to unsubscribe an invalidated Session observation.',
            detail: error,
          });
        },
      );
    }
  };
  const invalidate = (
    reason: RuntimeObservationInvalidation['reason'],
    message: string,
    runtimeId: string,
  ): void => {
    if (closed || invalidated) return;
    invalidated = true;
    closeResources();
    resolveInvalidated?.({
      code: 'observation_invalidated',
      reason,
      runtimeId,
      message,
    });
  };
  const deliver = (
    payload: Record<string, unknown>,
    runtimeId: string,
  ): void => {
    const event = parseRuntimeEventForClient(payload.event);
    if (event === undefined) {
      invalidate(
        'event_order',
        'Runtime delivered an invalid observation event; full resync is required.',
        runtimeId,
      );
      return;
    }
    if (
      cursor !== undefined
      && (
        event.cursor.sessionId !== cursor.sessionId
        || event.cursor.journalEpoch !== cursor.journalEpoch
      )
    ) {
      invalidate(
        'runtime_changed',
        'Runtime Session event journal changed; full resync is required.',
        runtimeId,
      );
      return;
    }
    if (cursor !== undefined && event.seq < cursor.seq) {
      if (!live) return;
      invalidate(
        'event_order',
        `Runtime observation event order regressed from ${cursor.seq} to ${event.seq}.`,
        runtimeId,
      );
      return;
    }
    if (cursor !== undefined && event.seq === cursor.seq) return;
    cursor = event.cursor;
    try {
      listener(event);
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'runtime.daemon.client',
        level: 'error',
        message: `Session observation listener failed for ${event.type}.`,
        detail: error,
      });
      invalidate(
        'delivery_failed',
        `Session observation listener failed while delivering ${event.type}; discard local state and resync.`,
        runtimeId,
      );
    }
  };
  const deliverInvalidation = (
    payload: Record<string, unknown>,
    runtimeId: string,
  ): void => {
    const parsed = parseRuntimeObservationInvalidation(payload.invalidation);
    if (parsed === undefined) {
      invalidate(
        'event_order',
        'Runtime delivered an invalid observation invalidation; full resync is required.',
        runtimeId,
      );
      return;
    }
    invalidate(parsed.reason, parsed.message, parsed.runtimeId);
  };
  local = transport.subscribe((notification) => {
    if (
      closed
      || invalidated
      || (
        notification.method !== 'event'
        && notification.method !== 'observation.invalidated'
      )
    ) return;
    const payload = requireRecord(notification.params);
    if (
      remoteSubscriptionId === undefined
      || !live
    ) {
      if (
        notification.method === 'event'
        && !isRuntimeEventForSession(payload.event, sessionId)
      ) return;
      if (
        notification.method === 'observation.invalidated'
        && typeof payload.sessionId === 'string'
        && payload.sessionId !== sessionId
      ) return;
      if (pending.length >= MAX_PENDING_SUBSCRIPTION_NOTIFICATIONS) {
        bufferOverflowed = true;
        invalidate(
          'event_overflow',
          'Runtime observation handoff overflowed; full resync is required.',
          'daemon',
        );
      } else {
        pending.push({ method: notification.method, payload });
      }
      return;
    }
    if (payload.subscriptionId === remoteSubscriptionId) {
      if (notification.method === 'event') {
        deliver(payload, 'daemon');
      } else {
        deliverInvalidation(payload, 'daemon');
      }
    }
  });
  lifecycle = transport.subscribeLifecycle?.((state) => {
    if (state.state === 'connected') {
      if (connectionId !== undefined && connectionId !== state.connectionId) {
        invalidate(
          'runtime_changed',
          'Runtime transport connection changed; discard the observation and resync.',
          'daemon',
        );
      }
      connectionId = state.connectionId;
      return;
    }
    invalidate(
      'transport_disconnected',
      state.reason ?? 'Runtime transport disconnected; observation is invalid.',
      'daemon',
    );
  });
  const unsubscribeLateObservation = (value: unknown): void => {
    try {
      const subscriptionId = requireStringField(
        requireRecord(value),
        'subscriptionId',
      );
      void request('event.unsubscribe', { subscriptionId }).catch(
        (error: unknown) => {
          emitKodaXDiagnostic({
            source: 'runtime.daemon.client',
            level: 'warn',
            message: 'Failed to unsubscribe a late Session observation.',
            detail: error,
          });
        },
      );
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'runtime.daemon.client',
        level: 'warn',
        message: 'Ignored an invalid late Session observation response.',
        detail: error,
      });
    }
  };
  try {
    const result = requireRecord(await request(
      'session.observe',
      { sessionId },
      readOptions,
      unsubscribeLateObservation,
    ));
    remoteSubscriptionId = requireStringField(result, 'subscriptionId');
    if (bufferOverflowed) {
      throw Object.assign(
        new Error('Runtime session observation handshake exceeded its event buffer; full resync is required.'),
        { code: 'resync_required' as const },
      );
    }
    const snapshot = requireRecord(result.snapshot) as unknown as RuntimeSessionObservationSnapshot;
    cursor = snapshot.cursor;
    const observation: RuntimeSessionObservation = {
      snapshot,
      invalidated: invalidation,
      close() {
        if (closed) return;
        closed = true;
        closeResources();
      },
    };
    queueMicrotask(() => queueMicrotask(() => {
      if (closed || invalidated) return;
      while (pending.length > 0) {
        const batch = pending.splice(0);
        for (const notification of batch) {
          if (invalidated) break;
          const { method, payload } = notification;
          if (payload.subscriptionId === remoteSubscriptionId) {
            if (method === 'event') {
              deliver(payload, snapshot.runtimeId);
            } else {
              deliverInvalidation(payload, snapshot.runtimeId);
            }
          }
        }
      }
      live = true;
    }));
    return observation;
  } catch (error: unknown) {
    closed = true;
    closeResources();
    throw error;
  }
}

function parseScopedCredentialPurpose(value: unknown): RuntimeScopedCredentialPurpose {
  if (
    value === 'primary'
    || value === 'fallback'
    || value === 'classifier'
    || value === 'sidecar'
    || value === 'compaction'
    || value === 'agent'
    || value === 'workflow'
    || value === 'utility'
  ) return value;
  throw new Error('Invalid scoped credential purpose.');
}

function parseScopedCredentialTarget(value: unknown): RuntimeScopedCredentialTarget {
  const target = requireRecord(value);
  const kind = requireStringField(target, 'kind');
  if (kind === 'run') {
    return {
      kind,
      runId: requireStringField(target, 'runId'),
      ...(optionalStringField(target, 'operationId') !== undefined
        ? { operationId: optionalStringField(target, 'operationId') }
        : {}),
    };
  }
  if (kind === 'operation') {
    const operation = requireStringField(target, 'operation');
    if (operation !== 'session.compact') throw new Error('Invalid credential operation target.');
    return {
      kind,
      operation,
      operationId: requireStringField(target, 'operationId'),
    };
  }
  if (kind === 'actor_turn') {
    return {
      kind,
      actorPath: requireStringField(target, 'actorPath'),
      turnId: requireStringField(target, 'turnId'),
      ...(optionalStringField(target, 'parentRunId') !== undefined
        ? { parentRunId: optionalStringField(target, 'parentRunId') }
        : {}),
    };
  }
  if (kind === 'workflow') {
    return {
      kind,
      workflowRunId: requireStringField(target, 'workflowRunId'),
      ...(optionalStringField(target, 'parentRunId') !== undefined
        ? { parentRunId: optionalStringField(target, 'parentRunId') }
        : {}),
    };
  }
  throw new Error('Invalid scoped credential target.');
}

async function raceRuntimeDaemonRead<T>(
  operation: Promise<T>,
  options: RuntimeReadOptions | undefined,
  interrupt: (error: Error) => void,
): Promise<T> {
  validateRuntimeDaemonReadOptions(options);
  if (options?.signal === undefined && options?.timeoutMs === undefined) {
    return operation;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        if (options?.timeoutMs !== undefined) {
          timer = setTimeout(
            () => {
              const error = Object.assign(new Error(
                `Runtime read timed out after ${options.timeoutMs}ms`,
              ), { code: 'read_timeout' as const });
              reject(error);
              interrupt(error);
            },
            options.timeoutMs,
          );
        }
        if (options?.signal !== undefined) {
          abort = () => {
            const error = Object.assign(
              new Error('Runtime read cancelled'),
              { code: 'read_cancelled' as const },
            );
            reject(error);
            interrupt(error);
          };
          options.signal.addEventListener('abort', abort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) {
      options?.signal?.removeEventListener('abort', abort);
    }
  }
}

function validateRuntimeDaemonReadOptions(
  options: RuntimeReadOptions | undefined,
): void {
  if (options?.signal?.aborted) {
    throw Object.assign(new Error('Runtime read cancelled'), {
      code: 'read_cancelled' as const,
    });
  }
  if (options?.timeoutMs !== undefined && (
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0
  )) {
    throw new Error('Runtime read timeoutMs must be a positive safe integer');
  }
}

function isRuntimeEventForSession(value: unknown, sessionId: string): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).sessionId === sessionId;
}

function parseRuntimeObservationInvalidation(
  value: unknown,
): RuntimeObservationInvalidation | undefined {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.code !== 'observation_invalidated'
    || (
      record.reason !== 'event_overflow'
      && record.reason !== 'event_order'
      && record.reason !== 'delivery_failed'
      && record.reason !== 'runtime_changed'
      && record.reason !== 'transport_disconnected'
    )
    || typeof record.runtimeId !== 'string'
    || typeof record.message !== 'string'
  ) return undefined;
  return {
    code: 'observation_invalidated',
    reason: record.reason,
    runtimeId: record.runtimeId,
    message: record.message,
  };
}

function deliverRuntimeEvent(value: unknown, listener: RuntimeEventListener): void {
  const event = parseRuntimeEventForClient(value);
  if (event !== undefined) listener(event);
}

function parseRuntimeEventForClient(value: unknown): RuntimeEvent | undefined {
  const parsed = parseRuntimeEvent(value);
  if (!parsed.ok) {
    emitKodaXDiagnostic({
      source: 'runtime.daemon.client',
      level: 'warn',
      message: `Ignored malformed Runtime event: ${parsed.error}`,
    });
    return;
  }
  return parsed.event;
}

function subscribeToDaemonWorkflowEvents(
  transport: RuntimeDaemonClientTransport,
  request: RuntimeDaemonClientTransport['request'],
  filter: RuntimeWorkflowFilter,
  listener: RuntimeWorkflowListener,
): RuntimeSubscription {
  return subscribeToDaemonNotification(transport, request, 'workflow.subscribe', {
    filter,
  }, (event) => {
    listener(event as Parameters<RuntimeWorkflowListener>[0]);
  });
}

function subscribeToDaemonNotification(
  transport: RuntimeDaemonClientTransport,
  request: RuntimeDaemonClientTransport['request'],
  method: 'event.subscribe' | 'workflow.subscribe',
  params: unknown,
  listener: (event: unknown) => void,
): RuntimeSubscription {
  let closed = false;
  let remoteSubscriptionId: string | undefined;
  const pendingNotifications: Array<Record<string, unknown>> = [];
  const local = transport.subscribe((notification) => {
    if (closed || notification.method !== 'event') return;
    const payload = requireRecord(notification.params);
    if (remoteSubscriptionId === undefined) {
      if (pendingNotifications.length >= MAX_PENDING_SUBSCRIPTION_NOTIFICATIONS) {
        pendingNotifications.shift();
      }
      pendingNotifications.push(payload);
      return;
    }
    if (payload.subscriptionId !== remoteSubscriptionId) return;
    listener(payload.event);
  });
  const ready = request(method, params).then((result) => {
    remoteSubscriptionId = requireStringField(requireRecord(result), 'subscriptionId');
    if (closed) {
      unsubscribeRemote(request, method, remoteSubscriptionId);
      pendingNotifications.length = 0;
      return;
    }
    for (const payload of pendingNotifications.splice(0)) {
      if (payload.subscriptionId === remoteSubscriptionId) {
        listener(payload.event);
      }
    }
  }).catch((error: unknown) => {
    pendingNotifications.length = 0;
    local.close();
    throw error;
  });
  // Callers that need a cross-connection happens-before can await `ready`.
  // Attach a handler here as well so legacy callers that ignore it do not
  // create an unhandled rejection when the remote handshake fails.
  void ready.catch(() => undefined);
  return {
    ready,
    close() {
      closed = true;
      local.close();
      if (remoteSubscriptionId !== undefined) {
        unsubscribeRemote(request, method, remoteSubscriptionId);
      }
    },
  };
}

function requestRuntimeRunResult(
  request: RuntimeDaemonClientTransport['request'],
  runId: string,
): Promise<RuntimeRunResult> {
  return request('run.await', { runId }).then(deserializeRuntimeRunResult);
}

function deserializeRuntimeRunResult(value: unknown): RuntimeRunResult {
  const record = requireRecord(value);
  const error = Object.prototype.hasOwnProperty.call(record, 'error')
    ? deserializeRuntimeError(record.error)
    : undefined;
  const normalized = { ...record };
  delete normalized.error;
  return {
    ...normalized,
    ...(error !== undefined ? { error } : {}),
  } as unknown as RuntimeRunResult;
}

function deserializeRuntimeError(value: unknown): Error | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  const record = requireRecord(value);
  const error = new Error(
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : 'Runtime run failed.',
  );
  if (typeof record.name === 'string' && record.name.length > 0) {
    error.name = record.name;
  }
  if (typeof record.stack === 'string' && record.stack.length > 0) {
    error.stack = record.stack;
  }
  return error;
}

function unsubscribeRemote(
  request: RuntimeDaemonClientTransport['request'],
  subscribeMethod: 'event.subscribe' | 'workflow.subscribe',
  subscriptionId: string,
): void {
  const unsubscribeMethod = subscribeMethod === 'event.subscribe'
    ? 'event.unsubscribe'
    : 'workflow.unsubscribe';
  void request(unsubscribeMethod, { subscriptionId }).catch(() => undefined);
}

function nullToUndefined<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : value as T;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected daemon response object.');
  }
  return value as Record<string, unknown>;
}

function supportsRunLifecycleControl(
  capabilities: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const lifecycle = capabilities?.runLifecycleControl;
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) {
    return false;
  }
  const value = lifecycle as Readonly<Record<string, unknown>>;
  return Number.isSafeInteger(value.version)
    && Number(value.version) >= 1
    && value.structuredStopReceipt === true
    && value.protocolCancellation === true
    && value.responseAcknowledgement === true;
}

function supportsScopedCredentialBroker(
  capabilities: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const broker = capabilities?.providerCredentialBroker;
  return broker !== null
    && typeof broker === 'object'
    && !Array.isArray(broker)
    && 'version' in broker
    && Number.isSafeInteger(broker.version)
    && Number(broker.version) >= 2;
}

function parseRuntimeRunStopReceipt(
  value: unknown,
  expectedRunId: string,
): RuntimeRunStopReceipt {
  let record: Record<string, unknown>;
  try {
    record = requireRecord(value);
  } catch {
    throw new RuntimeRunLifecycleUpgradeRequiredError();
  }
  const runId = record.runId;
  const sessionId = record.sessionId;
  const accepted = record.accepted;
  const state = record.state;
  const outcome = record.outcome;
  const phase = record.phase;
  const revision = record.revision;
  const states: readonly RuntimeRunStopReceipt['state'][] = [
    'unknown',
    'confirmed',
  ];
  const outcomes: readonly RuntimeRunStopReceipt['outcome'][] = [
    'unknown',
    'cancelled',
    'interrupted',
    'completed',
    'failed',
  ];
  const phases: readonly RuntimeRunStopReceipt['phase'][] = [
    'queued',
    'running',
    'waiting_agent',
    'recovering',
    'waiting_permission',
    'waiting_user_input',
    'unknown',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ];
  if (
    typeof accepted !== 'boolean'
    || typeof runId !== 'string'
    || runId.length === 0
    || runId !== expectedRunId
    || typeof sessionId !== 'string'
    || sessionId.length === 0
    || typeof state !== 'string'
    || !states.includes(state as RuntimeRunStopReceipt['state'])
    || typeof outcome !== 'string'
    || !outcomes.includes(outcome as RuntimeRunStopReceipt['outcome'])
    || typeof phase !== 'string'
    || !phases.includes(phase as RuntimeRunStopReceipt['phase'])
    || !Number.isSafeInteger(revision)
    || Number(revision) < 0
  ) {
    throw new RuntimeRunLifecycleUpgradeRequiredError();
  }
  return {
    runId,
    sessionId,
    accepted,
    state: state as RuntimeRunStopReceipt['state'],
    outcome: outcome as RuntimeRunStopReceipt['outcome'],
    phase: phase as RuntimeRunStopReceipt['phase'],
    revision: Number(revision),
  };
}

function requireStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected daemon response string field: ${key}`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Expected daemon response optional string field: ${key}`);
  }
  return value;
}

function assertRuntimeTransportSafe(
  value: unknown,
  path: string,
  ancestors: WeakSet<object> = new WeakSet(),
): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new RuntimeTransportBoundaryError(
      path,
      `${path} is not transport-safe: numbers must be finite.`,
    );
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new RuntimeTransportBoundaryError(
      path,
      `${path} is not transport-safe: ${typeof value} values cannot cross a Runtime boundary.`,
    );
  }
  if (typeof value !== 'object') return;
  if (ancestors.has(value)) {
    throw new RuntimeTransportBoundaryError(
      path,
      `${path} is not transport-safe: cyclic values cannot cross a Runtime boundary.`,
    );
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    const name = prototype?.constructor?.name ?? 'object';
    throw new RuntimeTransportBoundaryError(
      path,
      `${path} is not transport-safe: ${name} instances cannot cross a Runtime boundary.`,
    );
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRuntimeTransportSafe(entry, `${path}[${index}]`, ancestors));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertRuntimeTransportSafe(entry, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}
