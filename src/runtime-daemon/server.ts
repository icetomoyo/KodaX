import { randomUUID } from "node:crypto";
import {
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  DEFAULT_SPECULATIVE_WINDOW_MS,
  getActiveExtensionRuntime,
  listTools,
} from "@kodax-ai/coding";
import type {
  CapabilitySearchSnapshot,
  CodingActorCredentialAccessFactory,
  ExtensionRuntimeContract,
} from "@kodax-ai/coding";
import {
  emitKodaXDiagnostic,
  ExternalAgentRegistrationConflictError,
  isCurrentProcessWindowsJobContained,
} from "@kodax-ai/agent";
import type {
  ProviderCredentialAttribution,
  ProviderCredentialLeaseAccess,
} from "@kodax-ai/llm";

import type {
  KodaXRuntime,
  RuntimeAppendNoticeInput,
  RuntimeClientCapabilities,
  RuntimeCompactSessionInput,
  RuntimeCreateSessionInput,
  RuntimeDaemonClientSnapshot,
  RuntimeDaemonClientType,
  RuntimeDaemonPreflight,
  RuntimeDaemonRollbackInput,
  RuntimeDiagnosticFilter,
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventReplayFilter,
  RuntimeEventType,
  RuntimeForkSessionInput,
  RuntimeGrantedScope,
  RuntimeHostToolDescriptor,
  RuntimeAgentFollowupOptions,
  RuntimeAgentOperationOptions,
  RuntimePermissionDecision,
  RuntimePermissionFilter,
  RuntimePermissionRequestInput,
  RuntimeReadOptions,
  RuntimeRewindSessionInput,
  RuntimeRunFilter,
  RuntimeRunResult,
  RuntimeRunStatus,
  RuntimeSetActiveEntryInput,
  RuntimeSessionFilter,
  RuntimeSessionDiagnosticsInput,
  RuntimeSessionSettingsPatch,
  RuntimeSessionObservationSnapshot,
  RuntimeTranscriptEntryChunkInput,
  RuntimeTranscriptPageInput,
  RuntimeTranscriptSearchInput,
  RuntimeConversationHistoryEntryChunkInput,
  RuntimeConversationHistoryPageInput,
  RuntimeStartRunInput,
  RuntimeScopedCredentialTarget,
  RuntimeSubmitInput,
  RuntimeSubscription,
  RuntimeWorkflowFilter,
} from "../sdk-runtime.js";
import { bindRuntimeLearningClient } from "../runtime-learning.js";
import { sandboxRuntimeCapability } from "../sandbox-runtime.js";
import {
  createRuntimeDaemonErrorResponse,
  createRuntimeDaemonNotification,
  createRuntimeDaemonSuccessResponse,
  type RuntimeDaemonErrorCode,
  type RuntimeDaemonErrorResponse,
  type RuntimeDaemonMethod,
  type RuntimeDaemonNotification,
  type RuntimeDaemonRequest,
  type RuntimeDaemonSuccessResponse,
  RUNTIME_DAEMON_METHODS,
  isRuntimeDaemonDrainingSensitiveMethod,
  isRuntimeDaemonMutationMethod,
  isRuntimeDaemonRetiredMethod,
  type RuntimeDaemonWireMethod,
} from "./protocol.js";
import type { RuntimeControlJournal } from "./control-journal.js";
import type { RuntimeDaemonManagementController } from "./management.js";
import {
  RUNTIME_DAEMON_METHOD_SCHEMAS,
  validateRuntimeDaemonJsonSchema,
} from "./schema.js";
import {
  createRuntimeDaemonReverseBridge,
  runtimeDaemonReverseBridgeLimits,
  type RuntimeDaemonReverseBridge,
  type RuntimeDaemonReverseBridgeHub,
  type RuntimeDaemonReverseBridgeHubAttachment,
} from "./reverse-bridge.js";

const RUNTIME_DAEMON_CLIENT_DISPLAY_LIMITS = {
  name: 128,
  title: 256,
  version: 64,
} as const;
const UNSAFE_RUNTIME_DAEMON_CLIENT_DISPLAY_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export type RuntimeDaemonNotificationSink = (
  notification: RuntimeDaemonNotification,
) => void;

// Keep the compatibility endpoint comfortably below the 8 MiB transport
// ceiling. Larger histories must use the bounded page/chunk protocol.
const LEGACY_TRANSCRIPT_WIRE_BUDGET_BYTES = 512 * 1024;

export interface RuntimeDaemonDispatcherOptions {
  readonly runtime: KodaXRuntime;
  readonly notify?: RuntimeDaemonNotificationSink;
  readonly runResults?: RuntimeDaemonRunResultStore;
  readonly authToken?: string;
  readonly status?: () => Promise<unknown> | unknown;
  readonly stop?: () => Promise<unknown> | unknown;
  readonly preflight?: () =>
    Promise<RuntimeDaemonPreflight> | RuntimeDaemonPreflight;
  readonly logs?: () => Promise<unknown> | unknown;
  readonly config?: () => Promise<unknown> | unknown;
  readonly providerList?: () => Promise<unknown> | unknown;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  /** Host authorization; client capability negotiation alone never grants registration admin. */
  readonly allowAgentRegistrationAdmin?: boolean;
  /** Trusted host fact; arbitrary capability overrides cannot assert config ownership. */
  readonly ownsA2AConfigReconciler?: boolean;
  /** Trusted host fact; true only when this daemon was started with orphan idle-exit enabled. */
  readonly orphanExitEnabled?: boolean;
  readonly controlJournal?: RuntimeControlJournal;
  readonly requireOperationEnvelope?: boolean;
  readonly grantedScopes?: readonly RuntimeGrantedScope[];
  readonly reverseBridgeHub?: RuntimeDaemonReverseBridgeHub;
  readonly durableHostToolInvocations?: boolean;
  readonly management?: RuntimeDaemonManagementController;
}

export interface RuntimeDaemonDispatcher {
  handle(
    request: RuntimeDaemonRequest<RuntimeDaemonWireMethod>,
  ): Promise<RuntimeDaemonSuccessResponse | RuntimeDaemonErrorResponse>;
  close(): void;
}

const MAX_DAEMON_RUN_RESULT_RECORDS = 1_000;
const CODER_DAEMON_SESSION_SURFACES = [
  "code",
  "cli",
  "repl",
  "acp",
  "a2a",
  "sdk",
  "ide",
  "space-desktop",
] as const;
const RUNTIME_PROBE_METHODS = new Set<RuntimeDaemonMethod>([
  "ping",
  "runtime.identity",
  "runtime.status",
  "runtime.capabilities",
  "daemon.status",
]);

const ALL_RUNTIME_GRANTED_SCOPES = [
  "session:observe",
  "session:write",
  "run:control",
  "interaction:respond",
  "permission:respond",
  "permission:grant-admin",
  "integration:admin",
  "workflow:control",
  "learning:read",
  "learning:control",
  "artifact:write",
  "agent:control",
  "credential:register",
  "host-tool:register",
  "owner:admin",
  "daemon:admin",
] as const satisfies readonly RuntimeGrantedScope[];

const RUNTIME_METHOD_SCOPES: ReadonlyMap<
  RuntimeDaemonMethod,
  RuntimeGrantedScope
> = new Map([
  ...scopeEntries("session:observe", [
    "ping",
    "runtime.identity",
    "runtime.status",
    "runtime.capabilities",
    "daemon.status",
    "daemon.logs",
    "operation.get",
    "session.load",
    "session.list",
    "session.status",
    "session.transcript",
    "session.transcript.page",
    "session.transcript.entryChunk",
    "session.observe",
    "session.diagnostics",
    "session.settings.get",
    "session.transcript.search",
    "session.conversation",
    "session.conversation.page",
    "session.conversation.entryChunk",
    "session.settings.getVersioned",
    "session.autoMode.getStats",
    "run.get",
    "run.list",
    "run.await",
    "request.cancel",
    "request.ack",
    "event.subscribe",
    "event.unsubscribe",
    "event.replay",
    "permission.list",
    "permission.listPending",
    "permission.grants.list",
    "user_input.listPending",
    "workflow.list",
    "workflow.get",
    "workflow.subscribe",
    "workflow.unsubscribe",
    "context.budget.get",
    "tool.exposure.preview",
    "provider.cache.diagnostics.get",
    "config.read",
    "model.list",
    "provider.list",
    "provider.custom.list",
    "mcp.server.list",
    "mcp.server.get",
    "mcp.tool.list",
    "extension.list",
    "command.list",
    "command.resolve",
    "skill.list",
    "skill.describe",
    "skill.read",
    "artifact.get",
  ]),
  ...scopeEntries("session:write", [
    "session.create",
    "session.fork",
    "session.notice.append",
    "session.rewind",
    "session.active_entry.set",
    "session.activeEntry.set",
    "session.compact",
    "session.archive",
    "session.unarchive",
    "session.delete",
    "session.settings.update",
    "session.settings.updateVersioned",
  ]),
  ...scopeEntries("run:control", [
    "run.start",
    "run.input.submit",
    "run.abort",
    "run.model.set",
    "run.provider.set",
    "run.reasoning.set",
    "run.setModel",
    "run.setProvider",
    "run.setReasoning",
    "permission.request",
  ]),
  ...scopeEntries("permission:respond", ["permission.respond"]),
  ...scopeEntries("permission:grant-admin", ["permission.grants.revoke"]),
  ...scopeEntries("interaction:respond", [
    "user_input.respond",
    "user_input.dismiss",
  ]),
  ...scopeEntries("credential:register", [
    "credential.register",
    "credential.get",
    "credential.revoke",
    "credential.supply",
  ]),
  ...scopeEntries("host-tool:register", [
    "host_tool.register",
    "host_tool.get",
    "host_tool.invocation.get",
    "host_tool.revoke",
    "host_tool.complete",
  ]),
  ...scopeEntries("integration:admin", [
    "config.effective",
    "config.patch",
    "config.reload",
    "provider.custom.upsert",
    "provider.custom.remove",
    "mcp.server.validate",
    "mcp.server.upsert",
    "mcp.server.delete",
    "mcp.server.remove",
    "mcp.server.reload",
    "extension.reload",
  ]),
  ...scopeEntries("workflow:control", [
    "workflow.pause",
    "workflow.resume",
    "workflow.stop",
  ]),
  ...scopeEntries("learning:read", [
    "learning.list",
    "learning.get",
    "learning.snapshot",
    "learning.events",
  ]),
  ...scopeEntries("learning:control", [
    "learning.acknowledge",
    "learning.snooze",
    "learning.reject",
    "learning.disable",
    "learning.rollback",
    "learning.promote",
    "learning.review",
    "learning.trust",
  ]),
  ...scopeEntries("artifact:write", ["artifact.create", "artifact.delete"]),
  ...scopeEntries("agent:control", [
    "agentRegistrations.list",
    "agentRegistrations.upsert",
    "agentRegistrations.setEnabled",
    "agentRegistrations.remove",
    "agents.listDispatchable",
    "agents.describe",
    "agents.preflight",
    "agents.tree",
    "agents.detail",
    "agents.spawn",
    "agents.send",
    "agents.followup",
    "agents.interrupt",
    "agents.output",
    "agents.events",
    "agents.wait",
  ]),
  ...scopeEntries("owner:admin", ["daemon.rollbackToInline"]),
  ...scopeEntries("daemon:admin", [
    "runtime.shutdown",
    "daemon.stop",
    "daemon.preflight",
    "daemon.management.get",
  ]),
]);

const UNSCOPED_RUNTIME_METHODS = RUNTIME_DAEMON_METHODS.filter(
  (method) =>
    method !== "initialize" &&
    method !== "runtime.initialize" &&
    !RUNTIME_METHOD_SCOPES.has(method),
);
if (UNSCOPED_RUNTIME_METHODS.length > 0) {
  throw new Error(
    `Runtime daemon methods are missing authorization scopes: ${UNSCOPED_RUNTIME_METHODS.join(", ")}`,
  );
}

function scopeEntries(
  scope: RuntimeGrantedScope,
  methods: readonly RuntimeDaemonMethod[],
): readonly [RuntimeDaemonMethod, RuntimeGrantedScope][] {
  return methods.map((method) => [method, scope]);
}

interface RuntimeDaemonRunResultEntry {
  readonly promise: Promise<RuntimeRunResult>;
  settled: boolean;
}

export interface RuntimeDaemonRunResultStore {
  remember(runId: string, result: Promise<RuntimeRunResult>): void;
  get(runId: string): Promise<RuntimeRunResult> | undefined;
  clear(): void;
}

export function createRuntimeDaemonRunResultStore(): RuntimeDaemonRunResultStore {
  const records = new Map<string, RuntimeDaemonRunResultEntry>();

  const pruneSettled = (): void => {
    if (records.size <= MAX_DAEMON_RUN_RESULT_RECORDS) return;
    for (const [runId, entry] of records) {
      if (records.size <= MAX_DAEMON_RUN_RESULT_RECORDS) break;
      if (entry.settled) records.delete(runId);
    }
  };

  const markSettled = (
    runId: string,
    entry: RuntimeDaemonRunResultEntry,
  ): void => {
    if (records.get(runId) !== entry) return;
    entry.settled = true;
    pruneSettled();
  };

  return {
    remember(runId, result) {
      let entry: RuntimeDaemonRunResultEntry | undefined;
      const promise = result.finally(() => {
        if (entry) markSettled(runId, entry);
      });
      promise.catch(() => undefined);
      entry = { promise, settled: false };
      records.set(runId, entry);
      pruneSettled();
    },
    get(runId) {
      return records.get(runId)?.promise;
    },
    clear() {
      records.clear();
    },
  };
}

function isInitializeMethod(method: RuntimeDaemonMethod): boolean {
  return method === "initialize" || method === "runtime.initialize";
}

export function createRuntimeDaemonDispatcher(
  options: RuntimeDaemonDispatcherOptions,
): RuntimeDaemonDispatcher {
  const subscriptions = new Map<string, RuntimeSubscription>();
  const inFlightRequests = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly subscriptionIds: Set<string>;
      readonly cancellable: boolean;
      completed: boolean;
    }
  >();
  type InFlightRequest = (typeof inFlightRequests) extends Map<string, infer T>
    ? T
    : never;
  const deleteInFlightRequest = (
    requestId: string,
    expected: InFlightRequest,
  ): void => {
    if (inFlightRequests.get(requestId) === expected) {
      inFlightRequests.delete(requestId);
    }
  };
  const subscriptionRequests = new Map<string, {
    readonly requestId: string;
    readonly inFlight: InFlightRequest;
  }>();
  const runResults = options.runResults ?? createRuntimeDaemonRunResultStore();
  const connectionId = `connection_${randomUUID().replace(/-/g, "")}`;
  const privateReverseBridge = createRuntimeDaemonReverseBridge(options.notify);
  let reverseBridge = privateReverseBridge;
  let reverseBridgeAttachment:
    RuntimeDaemonReverseBridgeHubAttachment | undefined;
  let initialized = false;
  let logicalClientAttached = false;
  let connectionPurpose: "client" | "probe" = "client";
  let clientCapabilities: RuntimeClientCapabilities = {};
  let principalId = `client_${randomUUID().replace(/-/g, "")}`;
  let clientName: string | undefined;
  let clientVersion: string | undefined;
  const grantedScopes = new Set(
    options.grantedScopes ?? ALL_RUNTIME_GRANTED_SCOPES,
  );

  const closeSubscription = (subscriptionId: string): boolean => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) return false;
    subscriptions.delete(subscriptionId);
    const owner = subscriptionRequests.get(subscriptionId);
    subscriptionRequests.delete(subscriptionId);
    if (owner !== undefined) {
      const request = inFlightRequests.get(owner.requestId);
      if (request === owner.inFlight) {
        request.subscriptionIds.delete(subscriptionId);
      }
      if (request === owner.inFlight && request.completed && request.subscriptionIds.size === 0) {
        deleteInFlightRequest(owner.requestId, request);
      }
    }
    subscription.close();
    return true;
  };

  const rememberSubscription = (
    subscriptionId: string,
    subscription: RuntimeSubscription,
  ): void => {
    subscriptions.set(subscriptionId, subscription);
  };

  const notify = (subscriptionId: string, event: unknown): void => {
    if (
      isContextDiagnosticRuntimeEvent(event) &&
      clientCapabilities.contextDiagnostics !== true
    ) {
      return;
    }
    options.notify?.(
      createRuntimeDaemonNotification("event", {
        subscriptionId,
        event,
      }),
    );
  };

  const handle = async (
    wireRequest: RuntimeDaemonRequest<RuntimeDaemonWireMethod>,
  ): Promise<RuntimeDaemonSuccessResponse | RuntimeDaemonErrorResponse> => {
    let requestToCleanup:
      | {
          readonly id: string;
          readonly subscriptionIds: Set<string>;
          readonly inFlight: InFlightRequest;
        }
      | undefined;
    try {
      if (isRuntimeDaemonRetiredMethod(wireRequest.method)) {
        throw daemonError(
          "client_upgrade_required",
          "The legacy agentTasks control plane was retired. Upgrade the KodaX SDK; if this daemon does not advertise actorControlPlane v1, restart it with the upgraded KodaX installation.",
        );
      }
      const request = wireRequest as RuntimeDaemonRequest;
      validateDaemonMethodValue(
        request.method,
        "params",
        request.params === undefined ? {} : request.params,
        "invalid_params",
      );
      let initializeParams: Record<string, unknown> | undefined;
      if (!initialized && !isInitializeMethod(request.method)) {
        throw daemonError(
          "not_initialized",
          "Runtime daemon connection must initialize before runtime methods are accepted.",
        );
      }
      if (initialized && isInitializeMethod(request.method)) {
        throw daemonError(
          "conflict",
          "Runtime daemon connection is already initialized.",
        );
      }
      if (
        initialized &&
        connectionPurpose === "probe" &&
        !RUNTIME_PROBE_METHODS.has(request.method)
      ) {
        throw daemonError(
          "unauthorized",
          "Runtime daemon probe connections are read-only and method-limited.",
        );
      }
      if (isInitializeMethod(request.method)) {
        initializeParams = optionalRecord(request.params);
        connectionPurpose =
          initializeParams?.connectionPurpose === "probe" ? "probe" : "client";
        const token =
          typeof initializeParams?.token === "string"
            ? initializeParams.token
            : undefined;
        if (options.authToken !== undefined && token !== options.authToken) {
          throw daemonError(
            "unauthorized",
            "Runtime daemon initialize token is invalid.",
          );
        }
        const requestedProfile =
          typeof initializeParams?.profile === "string"
            ? initializeParams.profile
            : undefined;
        if (
          requestedProfile !== undefined &&
          requestedProfile !== options.runtime.identity.profile
        ) {
          throw daemonError(
            "conflict",
            `Runtime daemon profile mismatch: expected ${options.runtime.identity.profile}, got ${requestedProfile}.`,
          );
        }
        principalId = parseRuntimeClientPrincipal(
          initializeParams?.clientInfo,
          principalId,
        );
        clientName = parseRuntimeClientName(initializeParams?.clientInfo);
        clientVersion = parseRuntimeClientVersion(initializeParams?.clientInfo);
      }
      if (!isInitializeMethod(request.method)) {
        requireRuntimeMethodScope(request.method, grantedScopes);
        requirePersistentGrantScope(request, grantedScopes);
      }
      if (inFlightRequests.has(request.id)) {
        throw daemonError(
          "invalid_request",
          `Runtime daemon request id is already in flight: ${request.id}.`,
        );
      }
      if (request.method === "request.cancel") {
        const requestId = requireStringParam(request.params, "requestId");
        const inFlight = inFlightRequests.get(requestId);
        if (inFlight?.cancellable === true) {
          inFlight.controller.abort(
            Object.assign(new Error("Runtime daemon request cancelled."), {
              code: "read_cancelled" as const,
            }),
          );
          for (const subscriptionId of inFlight.subscriptionIds) {
            closeSubscription(subscriptionId);
          }
        }
        return createRuntimeDaemonSuccessResponse(request.id, {
          ok: inFlight?.cancellable === true,
        });
      }
      if (request.method === "request.ack") {
        const requestId = requireStringParam(request.params, "requestId");
        const inFlight = inFlightRequests.get(requestId);
        if (inFlight?.completed === true) {
          for (const subscriptionId of inFlight.subscriptionIds) {
            const owner = subscriptionRequests.get(subscriptionId);
            if (owner?.inFlight === inFlight) {
              subscriptionRequests.delete(subscriptionId);
            }
          }
          deleteInFlightRequest(requestId, inFlight);
        }
        return createRuntimeDaemonSuccessResponse(request.id, {
          ok: inFlight?.completed === true,
        });
      }
      const requestController = new AbortController();
      const inFlight = {
        controller: requestController,
        subscriptionIds: new Set<string>(),
        cancellable: !isRuntimeDaemonDrainingSensitiveMethod(request.method),
        completed: false,
      };
      inFlightRequests.set(request.id, inFlight);
      requestToCleanup = {
        id: request.id,
        subscriptionIds: inFlight.subscriptionIds,
        inFlight,
      };
      const dispatch = () =>
        dispatchRuntimeDaemonRequest(
          request,
          options,
          runResults,
          (subscriptionId, subscription) => {
            if (
              requestController.signal.aborted
              || inFlightRequests.get(request.id) !== inFlight
            ) {
              subscription.close();
              return;
            }
            rememberSubscription(subscriptionId, subscription);
            inFlight.subscriptionIds.add(subscriptionId);
            subscriptionRequests.set(subscriptionId, {
              requestId: request.id,
              inFlight,
            });
          },
          closeSubscription,
          notify,
          () => clientCapabilities,
          principalId,
          clientName,
          clientVersion,
          reverseBridge,
          requestController.signal,
        );
      let dispatched: unknown;
      try {
        const operation = dispatchWithOperation(
          request,
          options,
          clientCapabilities,
          principalId,
          dispatch,
        );
        dispatched = isRuntimeDaemonDrainingSensitiveMethod(request.method)
          ? await operation
          : await raceRuntimeDaemonRequestCancellation(
              operation,
              requestController.signal,
            );
      } catch (error: unknown) {
        for (const subscriptionId of [...inFlight.subscriptionIds]) {
          closeSubscription(subscriptionId);
        }
        deleteInFlightRequest(request.id, inFlight);
        throw error;
      }
      const result = serializeRuntimeDaemonMethodResult(
        request.method,
        dispatched,
      );
      validateDaemonMethodValue(
        request.method,
        "result",
        result,
        "internal_error",
      );
      if (isInitializeMethod(request.method)) {
        clientCapabilities = parseRuntimeClientCapabilities(
          initializeParams?.capabilities,
        );
        if (
          connectionPurpose === "client" &&
          options.reverseBridgeHub !== undefined &&
          options.notify !== undefined
        ) {
          reverseBridgeAttachment = options.reverseBridgeHub.attach({
            principalId,
            connectionId,
            ...(parseRuntimeClientInstanceSecret(
              initializeParams?.clientInfo,
            ) !== undefined
              ? {
                  instanceSecret: parseRuntimeClientInstanceSecret(
                    initializeParams?.clientInfo,
                  ),
                }
              : {}),
            notify: options.notify,
          });
          reverseBridge = reverseBridgeAttachment.bridge;
          privateReverseBridge.close();
        }
        if (
          connectionPurpose === "client" &&
          options.management !== undefined
        ) {
          try {
            options.management.attachClient(
              runtimeDaemonClientSnapshot(
                connectionId,
                principalId,
                initializeParams?.clientInfo,
              ),
            );
            logicalClientAttached = true;
          } catch (error: unknown) {
            reverseBridgeAttachment?.close();
            reverseBridgeAttachment = undefined;
            throw error;
          }
        }
        initialized = true;
      }
      inFlight.completed = true;
      if (inFlight.subscriptionIds.size === 0) {
        deleteInFlightRequest(request.id, inFlight);
      }
      requestToCleanup = undefined;
      return createRuntimeDaemonSuccessResponse(request.id, result);
    } catch (error: unknown) {
      if (requestToCleanup !== undefined) {
        for (const subscriptionId of [...requestToCleanup.subscriptionIds]) {
          closeSubscription(subscriptionId);
        }
        deleteInFlightRequest(requestToCleanup.id, requestToCleanup.inFlight);
      }
      return createRuntimeDaemonErrorResponse(
        normalizeRuntimeDaemonError(error),
        wireRequest.id,
      );
    }
  };

  return {
    handle,
    close() {
      for (const request of inFlightRequests.values()) {
        request.controller.abort(
          Object.assign(new Error("Runtime daemon connection closed."), {
            code: "read_cancelled" as const,
          }),
        );
      }
      inFlightRequests.clear();
      for (const id of [...subscriptions.keys()]) {
        closeSubscription(id);
      }
      if (reverseBridgeAttachment !== undefined)
        reverseBridgeAttachment.close();
      else reverseBridge.close();
      if (logicalClientAttached) {
        options.management?.detachClient(connectionId);
        logicalClientAttached = false;
      }
    },
  };
}

function raceRuntimeDaemonRequestCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? daemonError("read_cancelled", "Runtime daemon request cancelled."),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        signal.reason ?? daemonError("read_cancelled", "Runtime daemon request cancelled."),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function dispatchWithOperation(
  request: RuntimeDaemonRequest,
  options: RuntimeDaemonDispatcherOptions,
  capabilities: RuntimeClientCapabilities,
  principalId: string,
  dispatch: () => Promise<unknown>,
): Promise<unknown> {
  const execute = (): Promise<unknown> =>
    options.management !== undefined && isManagedRuntimeMutation(request.method)
      ? options.management.runMutation(request.method, dispatch)
      : dispatch();
  if (
    !isRuntimeDaemonMutationMethod(request.method) ||
    options.requireOperationEnvelope !== true
  ) {
    return execute();
  }
  if (capabilities.operationDeduplication !== true) {
    throw daemonError(
      "client_upgrade_required",
      "Runtime daemon mutations require durable operation support.",
    );
  }
  if (!request.operation) {
    throw daemonError(
      "operation_required",
      "Runtime daemon mutation is missing its operation envelope.",
    );
  }
  if (!options.controlJournal) {
    throw daemonError(
      "internal_error",
      "Runtime daemon control journal is unavailable.",
    );
  }
  return options.controlJournal.execute(
    {
      operationId: request.operation.operationId,
      journalEpoch: request.operation.journalEpoch,
      principalId,
      method: request.method,
      ...(operationResourceId(request.params) !== undefined
        ? { resourceId: operationResourceId(request.params) }
        : {}),
      params: request.params ?? {},
    },
    {
      // Once dispatch begins, every mutation may have changed durable or
      // externally visible state before its applied receipt is persisted.
      externalEffect: true,
    },
    execute,
  );
}

function isManagedRuntimeMutation(method: RuntimeDaemonMethod): boolean {
  return (
    isRuntimeDaemonDrainingSensitiveMethod(method) &&
    method !== "daemon.stop" &&
    method !== "runtime.shutdown" &&
    method !== "daemon.rollbackToInline"
  );
}

function requireRuntimeMethodScope(
  method: RuntimeDaemonMethod,
  grantedScopes: ReadonlySet<RuntimeGrantedScope>,
): void {
  const required = RUNTIME_METHOD_SCOPES.get(method);
  if (required === undefined) {
    throw daemonError(
      "internal_error",
      `Runtime daemon method has no authorization scope: ${method}.`,
    );
  }
  if (grantedScopes.has(required)) return;
  throw daemonError(
    "unauthorized",
    `Runtime daemon method requires scope ${required}.`,
  );
}

function requirePersistentGrantScope(
  request: RuntimeDaemonRequest,
  grantedScopes: ReadonlySet<RuntimeGrantedScope>,
): void {
  if (request.method !== "permission.respond") return;
  const params = isRecord(request.params) ? request.params : undefined;
  const decision =
    params && isRecord(params.decision) ? params.decision : undefined;
  if (
    decision?.type !== "allow_always" ||
    grantedScopes.has("permission:grant-admin")
  )
    return;
  throw daemonError(
    "unauthorized",
    "Persistent permission grants require scope permission:grant-admin.",
  );
}

function operationResourceId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of [
    "sessionId",
    "runId",
    "taskId",
    "artifactId",
    "requestId",
    "name",
  ]) {
    if (typeof value[key] === "string" && value[key].length > 0)
      return value[key];
  }
  return undefined;
}

function parseRuntimeClientPrincipal(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const instanceId = value.instanceId;
  if (
    typeof instanceId !== "string" ||
    !/^[A-Za-z0-9_.:-]{4,160}$/.test(instanceId)
  ) {
    return fallback;
  }
  return instanceId;
}

function parseRuntimeClientInstanceSecret(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const secret = value.instanceSecret;
  return typeof secret === "string" ? secret : undefined;
}

async function dispatchRuntimeDaemonRequest(
  request: RuntimeDaemonRequest,
  options: RuntimeDaemonDispatcherOptions,
  runResults: RuntimeDaemonRunResultStore,
  rememberSubscription: (
    subscriptionId: string,
    subscription: RuntimeSubscription,
  ) => void,
  closeSubscription: (subscriptionId: string) => boolean,
  notify: (subscriptionId: string, event: unknown) => void,
  getClientCapabilities: () => RuntimeClientCapabilities,
  principalId: string,
  clientName: string | undefined,
  clientVersion: string | undefined,
  reverseBridge: RuntimeDaemonReverseBridge,
  requestSignal: AbortSignal,
): Promise<unknown> {
  const runtime = options.runtime;
  const runRequirementSource = options.reverseBridgeHub ?? reverseBridge;

  switch (request.method) {
    case "initialize":
    case "runtime.initialize":
      return {
        identity: runtime.identity,
        capabilities: runtimeDaemonCapabilities(
          options.capabilities,
          runtime.agents.enabled,
          runtime.agents.enabled &&
            options.allowAgentRegistrationAdmin === true,
          options.ownsA2AConfigReconciler === true,
          options.controlJournal,
          options.reverseBridgeHub !== undefined,
          options.durableHostToolInvocations === true,
          options.management !== undefined,
          options.orphanExitEnabled === true,
          runtimeImplementsEventCoalescing(runtime),
        ),
        principalId,
        ...(options.controlJournal !== undefined
          ? { journalEpoch: options.controlJournal.journalEpoch }
          : {}),
        grantedScopes: [
          ...(options.grantedScopes ?? ALL_RUNTIME_GRANTED_SCOPES),
        ],
      };
    case "ping":
      return { ok: true, runtimeId: runtime.identity.runtimeId };
    case "runtime.identity":
      return runtime.identity;
    case "daemon.status":
    case "runtime.status":
      return augmentStatusRunRequirements(
        await (options.status ? options.status() : runtime.status.snapshot()),
        runRequirementSource,
      );
    case "daemon.stop":
    case "runtime.shutdown":
      return options.management
        ? options.management.stop()
        : options.stop
          ? options.stop()
          : runtime.close().then(() => ({ ok: true }));
    case "daemon.logs":
      return options.logs ? options.logs() : { entries: [] };
    case "daemon.preflight":
      return augmentPreflightRunRequirements(
        await (options.management
          ? options.management.preflight()
          : options.preflight
            ? options.preflight()
            : runtime.status.preflight()),
        runRequirementSource,
      );
    case "daemon.management.get":
      if (!options.management) {
        throw daemonError(
          "client_upgrade_required",
          "Runtime daemon management is unavailable.",
        );
      }
      return options.management.inspect();
    case "daemon.rollbackToInline": {
      if (!options.management) {
        throw daemonError(
          "client_upgrade_required",
          "Runtime daemon rollback management is unavailable.",
        );
      }
      const params = requireRecord(request.params);
      const rollback: RuntimeDaemonRollbackInput = {
        expectedRuntimeId: requireStringField(params, "expectedRuntimeId"),
        expectedRevision: requireIntegerField(params, "expectedRevision"),
        expectedOwnerPolicyRevision: requireIntegerField(
          params,
          "expectedOwnerPolicyRevision",
        ),
      };
      return options.management.rollbackToInline(rollback);
    }
    case "runtime.capabilities":
      return runtimeDaemonCapabilities(
        options.capabilities,
        runtime.agents.enabled,
        runtime.agents.enabled && options.allowAgentRegistrationAdmin === true,
        options.ownsA2AConfigReconciler === true,
        options.controlJournal,
        options.reverseBridgeHub !== undefined,
        options.durableHostToolInvocations === true,
        options.management !== undefined,
        options.orphanExitEnabled === true,
        runtimeImplementsEventCoalescing(runtime),
      );
    case "operation.get": {
      const params = requireRecord(request.params);
      const operationId = requireStringField(params, "operationId");
      const journalEpoch = requireStringField(params, "journalEpoch");
      if (!options.controlJournal) {
        return runtime.operations.get({ operationId, journalEpoch });
      }
      if (journalEpoch !== options.controlJournal.journalEpoch) {
        throw daemonError(
          "operation_epoch_mismatch",
          "Runtime operation belongs to another journal epoch.",
        );
      }
      const receipt = options.controlJournal.get(operationId);
      if (!receipt || receipt.principalId !== principalId) {
        throw daemonError("not_found", "Runtime operation was not found.");
      }
      return publicOperationReceipt(receipt);
    }
    case "config.read":
      return options.config
        ? redactRuntimeConfig(await options.config())
        : runtime.config.read();
    case "config.effective":
      return runtime.config.readEffective();
    case "config.patch": {
      const patch = requireRecordField(requireRecord(request.params), "patch");
      return runtime.config.patch(patch);
    }
    case "config.reload":
      return runtime.config.reload();
    case "provider.list":
      return options.providerList
        ? options.providerList()
        : runtime.catalog.providers();
    case "model.list":
      return options.providerList
        ? listRuntimeModels(
            await options.providerList(),
            optionalRecord(request.params),
          )
        : runtime.catalog.models(parseModelListFilter(request.params));
    case "provider.custom.list":
      return runtime.catalog.customProviders();
    case "provider.custom.upsert": {
      const params = requireRecord(request.params);
      return runtime.catalog.upsertCustomProvider(
        requireRecord(params.config) as unknown as Parameters<
          KodaXRuntime["catalog"]["upsertCustomProvider"]
        >[0],
      );
    }
    case "provider.custom.remove":
      return runtime.catalog.deleteCustomProvider(
        requireStringParam(request.params, "name"),
      );
    case "mcp.server.list":
      return runtime.mcp.listServers();
    case "mcp.server.get":
      return runtime.mcp.getServer(requireStringParam(request.params, "name"));
    case "mcp.server.validate": {
      const params = requireRecord(request.params);
      return runtime.mcp.validateServer(
        requireStringField(params, "name"),
        params.config,
      );
    }
    case "mcp.server.upsert": {
      const params = requireRecord(request.params);
      return runtime.mcp.upsertServer(
        requireStringField(params, "name"),
        requireRecord(params.config) as Parameters<
          KodaXRuntime["mcp"]["upsertServer"]
        >[1],
      );
    }
    case "mcp.server.delete":
    case "mcp.server.remove":
      return runtime.mcp.deleteServer(
        requireStringParam(request.params, "name"),
      );
    case "mcp.server.reload":
      return runtime.mcp.reloadServers();
    case "mcp.tool.list":
      return runtime.mcp.listTools(parseMcpToolListFilter(request.params));
    case "extension.list":
      return runtime.catalog.extensions();
    case "extension.reload":
      return runtime.catalog.reloadExtensions();
    case "command.list": {
      const params = optionalRecord(request.params);
      const projectRoot =
        typeof params?.projectRoot === "string"
          ? params.projectRoot
          : undefined;
      return runtime.catalog.commands(projectRoot);
    }
    case "command.resolve": {
      const params = requireRecord(request.params);
      return runtime.catalog.resolveCommand({
        name: requireStringField(params, "name"),
        ...(typeof params.projectRoot === "string"
          ? { projectRoot: params.projectRoot }
          : {}),
      });
    }
    case "skill.list":
      return runtime.catalog.skills(parseSkillListFilter(request.params));
    case "skill.describe":
    case "skill.read": {
      const params = requireRecord(request.params);
      return runtime.catalog.describeSkill({
        name: requireStringField(params, "name"),
        ...(typeof params.projectRoot === "string"
          ? { projectRoot: params.projectRoot }
          : {}),
      });
    }
    case "artifact.create":
      return runtime.artifacts.create(parseArtifactCreateInput(request.params));
    case "artifact.get":
      return runtime.artifacts.get(
        requireStringParam(request.params, "artifactId"),
      );
    case "artifact.delete":
      return runtime.artifacts.delete(
        requireStringParam(request.params, "artifactId"),
      );

    case "agentRegistrations.list":
      requireAgentRegistrationAdmin(options);
      requireExternalAgentsEnabled(runtime);
      return runtime.admin.agentRegistrations.list();
    case "agentRegistrations.upsert": {
      requireAgentRegistrationAdmin(options);
      requireExternalAgentsEnabled(runtime);
      const params = requireRecord(request.params);
      return runtime.admin.agentRegistrations.upsert(
        requireRecord(params.registration) as unknown as Parameters<
          KodaXRuntime["admin"]["agentRegistrations"]["upsert"]
        >[0],
        {
          expectedConfigurationRevision:
            optionalExpectedConfigurationRevision(params),
          expectedManagementOwner: optionalExpectedManagementOwner(params),
        },
      );
    }
    case "agentRegistrations.setEnabled": {
      requireAgentRegistrationAdmin(options);
      requireExternalAgentsEnabled(runtime);
      const params = requireRecord(request.params);
      const claimOwner = optionalStringField(params, "claimOwner");
      if (claimOwner !== undefined && claimOwner.length === 0) {
        throw daemonError(
          "invalid_request",
          "Expected non-empty optional string param: claimOwner",
        );
      }
      return runtime.admin.agentRegistrations.setEnabled(
        requireStringField(params, "agentId"),
        requireBooleanField(params, "enabled"),
        {
          expectedConfigurationRevision:
            optionalExpectedConfigurationRevision(params),
          expectedManagementOwner: optionalExpectedManagementOwner(params),
          ...(claimOwner ? { claimOwner } : {}),
        },
      );
    }
    case "agentRegistrations.remove":
      requireAgentRegistrationAdmin(options);
      requireExternalAgentsEnabled(runtime);
      {
        const params = requireRecord(request.params);
        return runtime.admin.agentRegistrations.remove(
          requireStringField(params, "agentId"),
          {
            expectedConfigurationRevision:
              optionalExpectedConfigurationRevision(params),
            expectedManagementOwner: optionalExpectedManagementOwner(params),
          },
        );
      }
    case "agents.listDispatchable":
      return runtime.agents.listDispatchable(
        requireRecord(request.params) as unknown as Parameters<
          KodaXRuntime["agents"]["listDispatchable"]
        >[0],
      );
    case "agents.describe": {
      const params = requireRecord(request.params);
      return runtime.agents.describe(
        requireStringField(params, "agentId"),
        requireRecord(params.query) as unknown as Parameters<
          KodaXRuntime["agents"]["describe"]
        >[1],
      );
    }
    case "agents.preflight":
      return runtime.agents.preflight(
        requireRecord(request.params) as unknown as Parameters<
          KodaXRuntime["agents"]["preflight"]
        >[0],
      );
    case "agents.tree":
      return runtime.agents.tree(
        requireStringParam(request.params, "sessionId"),
      );
    case "agents.detail": {
      const params = requireRecord(request.params);
      return runtime.agents.detail(
        requireStringField(params, "sessionId"),
        requireStringField(params, "actorPath"),
      );
    }
    case "agents.spawn": {
      const params = requireRecord(request.params);
      const sessionId = requireStringField(params, "sessionId");
      const actorInput = requireRecord(params.input);
      const actorKind = optionalStringField(actorInput, "kind") ?? "native";
      const credentialBinding = optionalRecord(params.credential);
      assertDaemonAgentCredentialBinding(actorKind, credentialBinding);
      const credentialAccessFactory = bindTrustedAgentCredentialAccessFactory({
        binding: credentialBinding,
        sessionId,
        reverseBridge,
      });
      return runtime.agents.spawn(
        sessionId,
        actorInput as unknown as Parameters<
          KodaXRuntime["agents"]["spawn"]
        >[1],
        credentialAccessFactory === undefined
          ? undefined
          : {
              providerCredentialAccessFactory: credentialAccessFactory,
            } as RuntimeAgentOperationOptions & {
              readonly providerCredentialAccessFactory: CodingActorCredentialAccessFactory;
            },
      );
    }
    case "agents.send": {
      const params = requireRecord(request.params);
      const classification = optionalStringField(params, "classification");
      if (
        classification !== undefined &&
        classification !== "public" &&
        classification !== "internal" &&
        classification !== "sensitive"
      )
        throw daemonError(
          "invalid_params",
          "Invalid Agent message classification.",
        );
      await runtime.agents.send(
        requireStringField(params, "sessionId"),
        requireStringField(params, "actorPath"),
        requireStringField(params, "content"),
        classification,
      );
      return { ok: true };
    }
    case "agents.followup": {
      const params = requireRecord(request.params);
      const expectedRevision = optionalIntegerField(params, "expectedRevision");
      const sessionId = requireStringField(params, "sessionId");
      const actorPath = requireStringField(params, "actorPath");
      const credentialBinding = optionalRecord(params.credential);
      const detail = await runtime.agents.detail(sessionId, actorPath);
      if (detail.actor.currentTurnId === undefined || credentialBinding !== undefined) {
        assertDaemonAgentCredentialBinding(detail.actor.kind, credentialBinding);
      }
      const credentialAccessFactory = bindTrustedAgentCredentialAccessFactory({
        binding: credentialBinding,
        sessionId,
        reverseBridge,
      });
      return runtime.agents.followup(
        sessionId,
        actorPath,
        requireStringField(params, "objective"),
        {
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          ...(credentialAccessFactory === undefined
            ? {}
            : { providerCredentialAccessFactory: credentialAccessFactory }),
          requireCredentialForNewTurn: true,
        } as RuntimeAgentFollowupOptions & {
          readonly providerCredentialAccessFactory?: CodingActorCredentialAccessFactory;
          readonly requireCredentialForNewTurn: true;
        },
      );
    }
    case "agents.interrupt": {
      const params = requireRecord(request.params);
      await runtime.agents.interrupt(
        requireStringField(params, "sessionId"),
        requireStringField(params, "actorPath"),
        optionalStringField(params, "reason"),
      );
      return { ok: true };
    }
    case "agents.output": {
      const params = requireRecord(request.params);
      return runtime.agents.output(
        requireStringField(params, "sessionId"),
        requireStringField(params, "actorPath"),
        optionalStringField(params, "turnId"),
      );
    }
    case "agents.events": {
      const params = requireRecord(request.params);
      return runtime.agents.events(
        requireStringField(params, "sessionId"),
        optionalIntegerField(params, "afterSequence"),
      );
    }
    case "agents.wait": {
      const params = requireRecord(request.params);
      return runtime.agents.wait(
        requireStringField(params, "sessionId"),
        optionalIntegerField(params, "afterSequence"),
        optionalIntegerField(params, "timeoutMs"),
        { signal: requestSignal },
      );
    }
    case "session.create":
      return runtime.sessions.create(
        optionalRecord(request.params) as RuntimeCreateSessionInput | undefined,
      );
    case "session.load":
      return runtime.sessions.load(
        requireStringParam(request.params, "sessionId"),
        runtimeReadOptions(request.params, requestSignal),
      );
    case "session.list":
      return runtime.sessions.list(
        optionalRecord(request.params) as RuntimeSessionFilter | undefined,
      );
    case "session.status":
      return runtime.sessions.status(
        requireStringParam(request.params, "sessionId"),
      );
    case "session.transcript": {
      const transcript = await runtime.sessions.transcript(
        requireStringParam(request.params, "sessionId"),
        runtimeReadOptions(request.params, requestSignal),
      );
      if (
        transcript !== null &&
        Buffer.byteLength(JSON.stringify(transcript), "utf8") >
          LEGACY_TRANSCRIPT_WIRE_BUDGET_BYTES
      ) {
        throw daemonError(
          "invalid_request",
          "Transcript is too large for the legacy endpoint; use session.transcript.page and session.transcript.entryChunk.",
        );
      }
      return transcript;
    }
    case "session.transcript.page":
      return runtime.sessions.transcriptPage(
        requireRecord(request.params) as unknown as RuntimeTranscriptPageInput,
        runtimeReadOptions(request.params, requestSignal),
      );
    case "session.transcript.entryChunk":
      return runtime.sessions.transcriptEntryChunk(
        requireRecord(
          request.params,
        ) as unknown as RuntimeTranscriptEntryChunkInput,
        runtimeReadOptions(request.params, requestSignal),
      );
    case "session.transcript.search":
      return runtime.sessions.transcriptSearch(
        requireRecord(
          request.params,
        ) as unknown as RuntimeTranscriptSearchInput,
        runtimeReadOptions(request.params, requestSignal),
      );
    case "session.conversation": {
      const history = await runtime.sessions.conversation(
        requireStringParam(request.params, "sessionId"),
        runtimeReadOptions(request.params, requestSignal),
      );
      if (
        history !== null
        && Buffer.byteLength(JSON.stringify(history), "utf8")
          > LEGACY_TRANSCRIPT_WIRE_BUDGET_BYTES
      ) {
        throw daemonError(
          "invalid_request",
          "Conversation history is too large for the direct endpoint; use session.conversation.page and session.conversation.entryChunk.",
        );
      }
      return history;
    }
    case "session.conversation.page":
      return runtime.sessions.conversationPage(
        requireRecord(request.params) as unknown as RuntimeConversationHistoryPageInput,
        runtimeReadOptions(request.params, requestSignal),
      );
    case "session.conversation.entryChunk":
      return runtime.sessions.conversationEntryChunk(
        requireRecord(request.params) as unknown as RuntimeConversationHistoryEntryChunkInput,
        runtimeReadOptions(request.params, requestSignal),
      );
    case "session.observe": {
      const subscriptionId = createSubscriptionId();
      const sessionId = requireStringParam(request.params, "sessionId");
      const observation = await runtime.sessions.observe(
        sessionId,
        (event) =>
          notify(
            subscriptionId,
            augmentRuntimeEventRequirements(event, runRequirementSource),
          ),
        runtimeReadOptions(request.params, requestSignal),
      );
      if (requestSignal.aborted) {
        observation.close();
        throw daemonError(
          "read_cancelled",
          "Runtime Session observation was cancelled.",
        );
      }
      rememberSubscription(subscriptionId, observation);
      void observation.invalidated
        .then((invalidation) => {
          try {
            options.notify?.(
              createRuntimeDaemonNotification("observation.invalidated", {
                subscriptionId,
                sessionId,
                invalidation,
              }),
            );
          } finally {
            closeSubscription(subscriptionId);
          }
        })
        .catch((error: unknown) => {
          emitKodaXDiagnostic({
            source: "runtime.daemon.server",
            level: "error",
            message:
              `Failed to deliver Session observation invalidation for ${sessionId}.`,
            detail: error,
          });
        });
      return {
        subscriptionId,
        snapshot: augmentObservationRunRequirements(
          observation.snapshot,
          runRequirementSource,
        ),
      };
    }
    case "session.diagnostics":
      return runtime.sessions.diagnostics(
        requireRecord(
          request.params,
        ) as unknown as RuntimeSessionDiagnosticsInput,
      );
    case "session.fork":
      return runtime.sessions.fork(
        requireRecord(request.params) as unknown as RuntimeForkSessionInput,
      );
    case "session.notice.append":
      return runtime.sessions.appendNotice(
        requireRecord(request.params) as unknown as RuntimeAppendNoticeInput,
      );
    case "session.rewind":
      return runtime.sessions.rewind(
        requireRecord(request.params) as unknown as RuntimeRewindSessionInput,
      );
    case "session.active_entry.set":
    case "session.activeEntry.set":
      return runtime.sessions.setActiveEntry(
        requireRecord(request.params) as unknown as RuntimeSetActiveEntryInput,
      );
    case "session.compact": {
      const params = requireRecord(request.params);
      const credentialBinding = optionalRecord(params.credential);
      if (credentialBinding === undefined) {
        return runtime.sessions.compact(
          params as unknown as RuntimeCompactSessionInput,
        );
      }
      if (credentialBinding.mode !== "scoped") {
        throw daemonError(
          "client_upgrade_required",
          "Manual compaction requires a scoped v2 credential binding.",
        );
      }
      if (request.operation === undefined) {
        throw daemonError(
          "operation_required",
          "Credential-bound compaction requires a stable operation envelope.",
        );
      }
      const sessionId = requireStringField(params, "sessionId");
      const compactProvider = optionalStringField(params, "provider");
      const boundProviders = requireStringArrayField(credentialBinding, "providers");
      if (compactProvider !== undefined && !boundProviders.includes(compactProvider)) {
        throw daemonError(
          "credential_unavailable",
          "Manual compaction Provider is outside the scoped credential binding.",
        );
      }
      const providerCredentialAccess = bindTrustedScopedCredentialAccess({
        binding: credentialBinding,
        sessionId,
        target: {
          kind: "operation",
          operation: "session.compact",
          operationId: request.operation.operationId,
        },
        reverseBridge,
      });
      return runtime.sessions.compact({
        ...params,
        sessionId,
        providerCredentialAccess,
      } as unknown as RuntimeCompactSessionInput);
    }
    case "session.archive":
      await runtime.sessions.archive(
        requireStringParam(request.params, "sessionId"),
      );
      return { ok: true };
    case "session.unarchive":
      await runtime.sessions.unarchive(
        requireStringParam(request.params, "sessionId"),
      );
      return { ok: true };
    case "session.delete":
      await runtime.sessions.delete(
        requireStringParam(request.params, "sessionId"),
      );
      return { ok: true };
    case "session.settings.get":
      return runtime.sessions.getSettings(
        requireStringParam(request.params, "sessionId"),
      );
    case "session.settings.getVersioned":
      return runtime.sessions.getSettingsVersioned(
        requireStringParam(request.params, "sessionId"),
      );
    case "session.autoMode.getStats":
      return runtime.sessions.getAutoModeStats(
        requireStringParam(request.params, "sessionId"),
      );
    case "session.settings.update": {
      if (options.requireOperationEnvelope === true) {
        throw daemonError(
          "client_upgrade_required",
          "Shared daemon session settings require session.settings.updateVersioned.",
        );
      }
      const params = requireRecord(request.params);
      return runtime.sessions.updateSettings(
        requireStringField(params, "sessionId"),
        requireRecord(params.patch) as unknown as RuntimeSessionSettingsPatch,
      );
    }
    case "session.settings.updateVersioned": {
      const params = requireRecord(request.params);
      return runtime.sessions.updateSettingsVersioned(
        requireStringField(params, "sessionId"),
        requireRecord(params.patch) as unknown as RuntimeSessionSettingsPatch,
        { expectedRevision: requireIntegerField(params, "expectedRevision") },
      );
    }

    case "run.start": {
      const params = requireRecord(request.params);
      const sessionId = requireStringField(params, "sessionId");
      const trustedRunId = `run_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      const trustedInput = (await bindTrustedRunInput({
        params,
        sessionId,
        trustedRunId,
        principalId,
        clientName,
        clientVersion,
        operationId: request.operation?.operationId,
        reverseBridge,
      })) as unknown as RuntimeStartRunInput;
      const handle = await runtime.runs.start(trustedInput);
      runResults.remember(handle.runId, handle.result);
      return {
        runId: handle.runId,
        sessionId: handle.sessionId,
        ...(handle.turnId !== undefined ? { turnId: handle.turnId } : {}),
      };
    }
    case "run.input.submit": {
      const params = requireRecord(request.params);
      const sessionId = requireStringField(params, "sessionId");
      const afterRunId = requireStringField(params, "afterRunId");
      const delivery = requireStringField(params, "delivery");
      const afterRun = await runtime.runs.get(afterRunId);
      if (afterRun.sessionId !== sessionId) {
        throw daemonError(
          "conflict",
          `Runtime continuation target ${afterRunId} does not belong to session ${sessionId}.`,
        );
      }
      const queuesBehindActorDurabilityRepair =
        delivery === "after_turn"
        && afterRun.phase === "unknown"
        && afterRun.lifecycleError?.code === "actor_settlement_not_persisted";
      if (
        !isActiveRuntimeRunPhase(afterRun.phase)
        && !queuesBehindActorDurabilityRepair
      ) {
        return {
          accepted: false,
          delivery,
          sessionId,
          afterRunId,
          reason: "stale_run",
        };
      }
      if (delivery === "interrupt") {
        if (afterRun.phase === "queued") {
          return {
            accepted: false,
            delivery,
            sessionId,
            afterRunId,
            reason: "stale_run",
          };
        }
        if (params.credential !== undefined || params.hostTools !== undefined) {
          throw daemonError(
            "invalid_params",
            "Interrupt input cannot replace active-run credential or host-tool bindings.",
          );
        }
        const trustedInputId = `input_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
        return runtime.runs.submitInput({
          ...params,
          sessionId,
          afterRunId,
          delivery: "interrupt",
          trustedInputId,
          origin: {
            principalId,
            ...(clientName !== undefined ? { clientName } : {}),
            ...(clientVersion !== undefined ? { clientVersion } : {}),
            ...(request.operation?.operationId !== undefined
              ? { operationId: request.operation.operationId }
              : {}),
          },
        } as unknown as RuntimeSubmitInput);
      }
      const trustedRunId = `run_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      const trustedInput = (await bindTrustedRunInput({
        params,
        sessionId,
        trustedRunId,
        principalId,
        clientName,
        clientVersion,
        operationId: request.operation?.operationId,
        reverseBridge,
      })) as unknown as RuntimeSubmitInput;
      const result = await runtime.runs.submitInput(trustedInput);
      if (result.accepted && result.delivery === "after_turn") {
        const pending = runtime.runs.await(result.runId);
        runResults.remember(result.runId, pending);
      }
      return result;
    }
    case "run.get":
      return augmentRunRequirements(
        await runtime.runs.get(requireStringParam(request.params, "runId")),
        runRequirementSource,
      );
    case "run.list":
      return (
        await runtime.runs.list(
          optionalRecord(request.params) as RuntimeRunFilter | undefined,
        )
      ).map((status) => augmentRunRequirements(status, runRequirementSource));
    case "run.await": {
      const runId = requireStringParam(request.params, "runId");
      const result = runResults.get(runId);
      if (result) return result;
      return runtime.runs.await(runId);
    }
    case "run.abort":
      return runtime.runs.abort(requireStringParam(request.params, "runId"));
    case "run.model.set": {
      return setRunModel(runtime, request.params);
    }
    case "run.setModel": {
      return setRunModel(runtime, request.params);
    }
    case "run.provider.set": {
      const params = requireRecord(request.params);
      await runtime.runs.setProvider(
        requireStringField(params, "runId"),
        requireStringField(params, "provider"),
      );
      return { ok: true };
    }
    case "run.setProvider": {
      const params = requireRecord(request.params);
      await runtime.runs.setProvider(
        requireStringField(params, "runId"),
        requireStringField(params, "provider"),
      );
      return { ok: true };
    }
    case "run.reasoning.set": {
      return setRunReasoning(runtime, request.params);
    }
    case "run.setReasoning": {
      return setRunReasoning(runtime, request.params);
    }

    case "event.subscribe": {
      const params = optionalRecord(request.params) ?? {};
      const filter = optionalRecord(params.filter) as
        RuntimeEventFilter | undefined;
      await assertAdmittedEventScope(runtime, filter);
      const subscriptionId = createSubscriptionId();
      const subscription = runtime.events.subscribe(
        filter as RuntimeEventFilter,
        (event: RuntimeEvent) => {
          notify(
            subscriptionId,
            augmentRuntimeEventRequirements(event, runRequirementSource),
          );
        },
      );
      rememberSubscription(subscriptionId, subscription);
      return { subscriptionId };
    }
    case "event.unsubscribe":
      return {
        ok: closeSubscription(
          requireStringParam(request.params, "subscriptionId"),
        ),
      };
    case "event.replay": {
      const filter = optionalRecord(request.params) as
        RuntimeEventReplayFilter | undefined;
      await assertAdmittedEventScope(runtime, filter);
      return filterReplayForClientCapabilities(
        await runtime.events.replay(filter as RuntimeEventReplayFilter),
        getClientCapabilities(),
      ).map((event) =>
        augmentRuntimeEventRequirements(event, runRequirementSource),
      );
    }

    case "permission.list":
    case "permission.listPending": {
      const filter = optionalRecord(request.params) as
        RuntimePermissionFilter | undefined;
      await assertAdmittedSessionId(runtime, filter?.sessionId);
      return runtime.permissions.listPending(filter);
    }
    case "permission.request": {
      const input = requireRecord(
        request.params,
      ) as unknown as RuntimePermissionRequestInput;
      await assertAdmittedSessionId(runtime, input.sessionId);
      return runtime.permissions.request(input);
    }
    case "permission.respond": {
      const params = requireRecord(request.params);
      const runId = optionalStringField(params, "runId");
      return runtime.permissions.respond(
        requireStringField(params, "requestId"),
        requireRecord(params.decision) as unknown as RuntimePermissionDecision,
        runId !== undefined ? { runId } : undefined,
      );
    }
    case "permission.grants.list":
      return runtime.permissions.listGrants();
    case "permission.grants.revoke": {
      const params = requireRecord(request.params);
      return runtime.permissions.revokeGrant(
        requireStringField(params, "grantId"),
        requireIntegerField(params, "expectedRevision"),
      );
    }
    case "user_input.listPending": {
      const filter = optionalRecord(request.params) as
        | {
            readonly sessionId?: string;
            readonly runId?: string;
          }
        | undefined;
      await assertAdmittedSessionId(runtime, filter?.sessionId);
      return runtime.userInputs.listPending(filter);
    }
    case "user_input.respond": {
      const params = requireRecord(request.params);
      const expectedRevision = optionalIntegerField(params, "expectedRevision");
      const runId = optionalStringField(params, "runId");
      return runtime.userInputs.respond(
        requireStringField(params, "requestId"),
        params.answer,
        expectedRevision !== undefined || runId !== undefined
          ? {
              ...(expectedRevision !== undefined ? { expectedRevision } : {}),
              ...(runId !== undefined ? { runId } : {}),
            }
          : undefined,
      );
    }
    case "user_input.dismiss": {
      const params = requireRecord(request.params);
      const expectedRevision = optionalIntegerField(params, "expectedRevision");
      const runId = optionalStringField(params, "runId");
      return runtime.userInputs.dismiss(
        requireStringField(params, "requestId"),
        expectedRevision !== undefined || runId !== undefined
          ? {
              ...(expectedRevision !== undefined ? { expectedRevision } : {}),
              ...(runId !== undefined ? { runId } : {}),
            }
          : undefined,
      );
    }
    case "credential.register": {
      const params = requireRecord(request.params);
      return reverseBridge.registerCredential({
        leaseId: requireStringField(params, "leaseId"),
        providers: requireStringArrayField(params, "providers"),
        ...(optionalIntegerField(params, "brokerVersion") !== undefined
          ? {
              brokerVersion: requireCredentialBrokerVersion(
                optionalIntegerField(params, "brokerVersion")!,
              ),
            }
          : {}),
        ...(optionalStringField(params, "expiresAt") !== undefined
          ? { expiresAt: optionalStringField(params, "expiresAt")! }
          : {}),
      });
    }
    case "credential.get":
      return reverseBridge.getCredential(
        requireStringParam(request.params, "leaseId"),
      );
    case "credential.revoke":
      return reverseBridge.revokeCredential(
        requireStringParam(request.params, "leaseId"),
      );
    case "credential.supply": {
      const params = requireRecord(request.params);
      const ok = reverseBridge.supplyCredential({
        requestId: requireStringField(params, "requestId"),
        ...(optionalStringField(params, "credential") !== undefined
          ? { credential: optionalStringField(params, "credential") }
          : {}),
        ...(optionalStringField(params, "error") !== undefined
          ? { error: optionalStringField(params, "error") }
          : {}),
      });
      return { ok };
    }
    case "host_tool.register": {
      const params = requireRecord(request.params);
      return reverseBridge.registerHostTools({
        leaseId: requireStringField(params, "leaseId"),
        tools: parseRuntimeHostToolDescriptors(params.tools),
      });
    }
    case "host_tool.get":
      return reverseBridge.getHostTools(
        requireStringParam(request.params, "leaseId"),
      );
    case "host_tool.invocation.get":
      return reverseBridge.getHostToolInvocation(
        requireStringParam(request.params, "invocationId"),
      );
    case "host_tool.revoke":
      return reverseBridge.revokeHostTools(
        requireStringParam(request.params, "leaseId"),
      );
    case "host_tool.complete": {
      const params = requireRecord(request.params);
      const ok = reverseBridge.completeHostTool({
        invocationId: requireStringField(params, "invocationId"),
        ...(params.result !== undefined
          ? {
              result: requireRecord(params.result) as unknown as {
                readonly content: string;
                readonly structuredContent?: unknown;
              },
            }
          : {}),
        ...(optionalStringField(params, "error") !== undefined
          ? { error: optionalStringField(params, "error") }
          : {}),
      });
      return { ok };
    }

    case "workflow.list":
      return runtime.workflows.list(
        optionalRecord(request.params) as RuntimeWorkflowFilter | undefined,
      );
    case "workflow.get":
      return runtime.workflows.get(requireStringParam(request.params, "runId"));
    case "workflow.subscribe": {
      const params = optionalRecord(request.params) ?? {};
      const filter = optionalRecord(params.filter) as
        RuntimeWorkflowFilter | undefined;
      const subscriptionId = createSubscriptionId();
      const subscription = runtime.workflows.subscribe(
        filter ?? {},
        (event) => {
          notify(subscriptionId, event);
        },
      );
      rememberSubscription(subscriptionId, subscription);
      return { subscriptionId };
    }
    case "workflow.unsubscribe":
      return {
        ok: closeSubscription(
          requireStringParam(request.params, "subscriptionId"),
        ),
      };
    case "workflow.pause":
      return runtime.workflows.pause(
        requireStringParam(request.params, "runId"),
      );
    case "workflow.resume":
      return runtime.workflows.resume(
        requireStringParam(request.params, "runId"),
      );
    case "workflow.stop":
      return runtime.workflows.stop(
        requireStringParam(request.params, "runId"),
      );

    case "learning.list":
      return bindRuntimeLearningClient(runtime.learning, principalId).list(
        optionalRecord(request.params) as Parameters<
          KodaXRuntime["learning"]["list"]
        >[0],
      );
    case "learning.get":
      return bindRuntimeLearningClient(runtime.learning, principalId).get(
        requireStringParam(request.params, "nameOrSlug"),
      );
    case "learning.snapshot":
      return bindRuntimeLearningClient(
        runtime.learning,
        principalId,
      ).getSnapshot();
    case "learning.events":
      return bindRuntimeLearningClient(runtime.learning, principalId).events(
        optionalIntegerField(
          optionalRecord(request.params) ?? {},
          "afterRevision",
        ),
      );
    case "learning.acknowledge":
      await bindRuntimeLearningClient(
        runtime.learning,
        principalId,
      ).acknowledge(requireStringParam(request.params, "nameOrSlug"));
      return { ok: true };
    case "learning.snooze": {
      const params = requireRecord(request.params);
      await bindRuntimeLearningClient(runtime.learning, principalId).snooze(
        requireStringField(params, "nameOrSlug"),
        requireStringField(params, "until"),
      );
      return { ok: true };
    }
    case "learning.reject":
    case "learning.disable":
    case "learning.rollback":
    case "learning.review":
    case "learning.trust": {
      const learning = bindRuntimeLearningClient(runtime.learning, principalId);
      const nameOrSlug = requireStringParam(request.params, "nameOrSlug");
      if (request.method === "learning.reject")
        await learning.reject(nameOrSlug);
      else if (request.method === "learning.disable")
        await learning.disable(nameOrSlug);
      else if (request.method === "learning.rollback")
        await learning.rollback(nameOrSlug);
      else if (request.method === "learning.review")
        await learning.review(nameOrSlug);
      else await learning.trust(nameOrSlug);
      return { ok: true };
    }
    case "learning.promote": {
      const params = requireRecord(request.params);
      const scope = requireStringField(params, "scope");
      if (scope !== "user")
        throw daemonError(
          "invalid_params",
          "Learning promotion scope must be user.",
        );
      await bindRuntimeLearningClient(runtime.learning, principalId).promote(
        requireStringField(params, "nameOrSlug"),
        scope,
      );
      return { ok: true };
    }

    case "context.budget.get":
      requireContextDiagnosticsCapability(getClientCapabilities());
      await assertAdmittedSessionId(
        runtime,
        optionalStringField(optionalRecord(request.params) ?? {}, "sessionId"),
      );
      return latestRuntimeDiagnosticPayload(
        runtime,
        "context.budget.snapshot",
        optionalRecord(request.params),
      );
    case "tool.exposure.preview":
      requireContextDiagnosticsCapability(getClientCapabilities());
      await assertAdmittedSessionId(
        runtime,
        optionalStringField(optionalRecord(request.params) ?? {}, "sessionId"),
      );
      return latestRuntimeDiagnosticPayload(
        runtime,
        "tool.exposure.planned",
        optionalRecord(request.params),
      );
    case "provider.cache.diagnostics.get":
      requireContextDiagnosticsCapability(getClientCapabilities());
      await assertAdmittedSessionId(
        runtime,
        optionalStringField(optionalRecord(request.params) ?? {}, "sessionId"),
      );
      return latestRuntimeDiagnosticPayload(
        runtime,
        "provider.cache.diagnostics",
        optionalRecord(request.params),
      );

    default:
      throw daemonError(
        "method_not_found",
        `Runtime daemon method is not implemented: ${request.method}`,
      );
  }
}

async function bindTrustedRunInput(input: {
  readonly params: Record<string, unknown>;
  readonly sessionId: string;
  readonly trustedRunId: string;
  readonly principalId: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly operationId?: string;
  readonly reverseBridge: RuntimeDaemonReverseBridge;
}): Promise<Record<string, unknown>> {
  const credentialBinding = optionalRecord(input.params.credential);
  const hostToolBinding = optionalRecord(input.params.hostTools);
  const scopedCredentialAccess = credentialBinding?.mode === "scoped"
    ? bindTrustedScopedCredentialAccess({
        binding: credentialBinding,
        sessionId: input.sessionId,
        target: {
          kind: "run",
          runId: input.trustedRunId,
          ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
        },
        reverseBridge: input.reverseBridge,
      })
    : undefined;
  const providerCredential = credentialBinding === undefined || scopedCredentialAccess !== undefined
    ? undefined
    : await input.reverseBridge.acquireCredential({
        leaseId: requireStringField(credentialBinding, "leaseId"),
        provider: requireStringField(credentialBinding, "provider"),
        sessionId: input.sessionId,
        runId: input.trustedRunId,
      });
  const hostToolLeaseId =
    hostToolBinding === undefined
      ? undefined
      : requireStringField(hostToolBinding, "leaseId");
  if (hostToolLeaseId !== undefined) {
    rejectHostToolNameCollisions(input.reverseBridge, hostToolLeaseId);
  }
  const hostToolRuntime =
    hostToolBinding === undefined
      ? undefined
      : input.reverseBridge.createHostToolRuntime({
          leaseId: hostToolLeaseId,
          sessionId: input.sessionId,
          runId: input.trustedRunId,
        });
  const activeRuntime = getActiveExtensionRuntime();
  const extensionRuntime =
    hostToolRuntime === undefined
      ? undefined
      : activeRuntime === null
        ? hostToolRuntime
        : mergeExtensionRuntimeContracts(hostToolRuntime, activeRuntime);
  const transportOptions = optionalRecord(input.params.options) ?? {};
  const transportContext = optionalRecord(transportOptions.context);
  const safeTransportOptions =
    transportContext === undefined
      ? transportOptions
      : {
          ...transportOptions,
          context: Object.fromEntries(
            Object.entries(transportContext).filter(
              ([key]) => key !== "configHome" && key !== "memoryIdentity",
            ),
          ),
        };
  return {
    ...input.params,
    sessionId: input.sessionId,
    trustedRunId: input.trustedRunId,
    origin: {
      principalId: input.principalId,
      ...(input.clientName !== undefined
        ? { clientName: input.clientName }
        : {}),
      ...(input.clientVersion !== undefined
        ? { clientVersion: input.clientVersion }
        : {}),
      ...(input.operationId !== undefined
        ? { operationId: input.operationId }
        : {}),
    },
    ...(providerCredential !== undefined ? { providerCredential } : {}),
    ...(scopedCredentialAccess !== undefined
      ? { providerCredentialAccess: scopedCredentialAccess }
      : {}),
    ...(credentialBinding !== undefined && scopedCredentialAccess === undefined
      ? {
          providerCredentialProvider: requireStringField(
            credentialBinding,
            "provider",
          ),
        }
      : {}),
    ...(input.params.options !== undefined || extensionRuntime !== undefined
      ? {
          options: {
            ...safeTransportOptions,
            ...(extensionRuntime === undefined ? {} : { extensionRuntime }),
          },
        }
      : {}),
  };
}

function rejectHostToolNameCollisions(
  reverseBridge: RuntimeDaemonReverseBridge,
  leaseId: string,
): void {
  const lease = reverseBridge.getHostTools(leaseId);
  if (lease === undefined) return; // createHostToolRuntime reports the missing lease.
  const registered = new Set(listTools());
  const collisions = lease.tools
    .map((tool) => tool.name)
    .filter((name) => registered.has(name))
    .sort();
  if (collisions.length > 0) {
    throw daemonError(
      "invalid_params",
      `Host tool names collide with registered tools and the run binding is rejected: ${collisions.join(
        ", ",
      )}.`,
    );
  }
}

function isActiveRuntimeRunPhase(phase: string): boolean {
  return (
    phase === "queued" ||
    phase === "running" ||
    phase === "waiting_agent" ||
    phase === "recovering" ||
    phase === "waiting_permission" ||
    phase === "waiting_user_input"
  );
}

function parseRuntimeClientCapabilities(
  value: unknown,
): RuntimeClientCapabilities {
  if (!isRecord(value)) return {};
  return {
    ...(value.richEvents === true ? { richEvents: true } : {}),
    ...(value.permissionPrompts === true ? { permissionPrompts: true } : {}),
    ...(value.configAdmin === true ? { configAdmin: true } : {}),
    ...(value.commandCatalog === true ? { commandCatalog: true } : {}),
    ...(value.skillCatalog === true ? { skillCatalog: true } : {}),
    ...(value.artifactUpload === true ? { artifactUpload: true } : {}),
    ...(value.contextDiagnostics === true ? { contextDiagnostics: true } : {}),
    ...(value.operationDeduplication === true
      ? { operationDeduplication: true }
      : {}),
  };
}

function runtimeDaemonCapabilities(
  overrides: Readonly<Record<string, unknown>> = {},
  externalAgents = false,
  externalAgentAdmin = false,
  ownsA2AConfigReconciler = false,
  controlJournal?: RuntimeControlJournal,
  reverseBridgeResume = false,
  durableHostToolInvocations = false,
  daemonManagement = false,
  orphanExitEnabled = false,
  runtimeEventCoalescing = false,
): Record<string, unknown> {
  const safeOverrides = { ...overrides };
  delete safeOverrides.externalAgents;
  delete safeOverrides.externalAgentAdmin;
  delete safeOverrides.a2aConfigReconciler;
  delete safeOverrides.actorControlPlane;
  delete safeOverrides.integrationConfigResilience;
  delete safeOverrides.managedRunDurability;
  delete safeOverrides.actorSettlementConvergence;
  delete safeOverrides.sessionEventJournal;
  delete safeOverrides.daemonClientInventory;
  delete safeOverrides.daemonOrphanExit;
  delete safeOverrides.daemonShutdownVerification;
  delete safeOverrides.runtimeEventCoalescing;
  delete safeOverrides.liveOutputSegments;
  delete safeOverrides.runtimeAutoModeGuardrail;
  delete safeOverrides.sandboxRuntime;
  delete safeOverrides.runLifecycleControl;
  const reverseBridgeLimits = runtimeDaemonReverseBridgeLimits();
  return {
    events: true,
    permissions: true,
    workflows: true,
    configAdmin: true,
    commandCatalog: true,
    skillCatalog: true,
    artifactUpload: true,
    contextDiagnostics: true,
    hardDispose: false,
    externalAgents,
    actorControlPlane: {
      version: 1,
      methodNamespace: "agents",
    },
    sandboxRuntime: sandboxRuntimeCapability(),
    managedRunDurability: {
      version: 1,
      initialInputBeforeExecution: true,
      completedTurnBeforeEvent: true,
      deliveredInputBeforeEvent: true,
      persistenceFailure: "fail_closed",
    },
    actorSettlementConvergence: {
      version: 2,
      rootFence: "fail_closed",
      sameOwnerRepair: "automatic",
      unknownAfterTurnQueue: true,
      terminal: "failed",
    },
    sessionEventJournal: {
      version: 1,
      sequenceScope: "session",
      cursor: "session_epoch_sequence",
      scopedAccessRequired: true,
    },
    liveOutputSegments: {
      version: 1,
      segmentIdentity: "provider_request",
      replacement: "explicit",
      rawJournal: "complete",
    },
    ...(runtimeEventCoalescing
      ? { runtimeEventCoalescing: { version: 1 } }
      : {}),
    runtimeAutoModeGuardrail: {
      version: 4,
      owner: "session-runtime",
      escalationCreatesPermission: true,
      fallbackPersistsEngine: false,
      defaultClassifierTimeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
      defaultSpeculativeWindowMs: DEFAULT_SPECULATIVE_WINDOW_MS,
      boundedClassifierInput: true,
      diagnosticsVersion: 1,
      permissionGrantSuggestions: true,
      concretePermissionMatchers: true,
      clientScopeExpansion: false,
    },
    ...(orphanExitEnabled
      ? {
          daemonOrphanExit: {
            version: 1,
            idleOnly: true,
            bootstrapGrace: true,
          },
        }
      : {}),
    ...(isCurrentProcessWindowsJobContained()
      ? {
          daemonShutdownVerification: {
            version: 1,
            durableOutcome: true,
            processContainment: "windows-job",
          },
        }
      : {}),
    ...(externalAgentAdmin
      ? {
          externalAgentAdmin: {
            version: 1,
            activation: true,
            conditionalMutations: true,
            managementOwner: true,
          },
        }
      : {}),
    ...(ownsA2AConfigReconciler
      ? {
          a2aConfigReconciler: { version: 1 },
        }
      : {}),
    ...(controlJournal !== undefined
      ? {
          operationDeduplication: {
            version: 1,
            retentionMs: Number.MAX_SAFE_INTEGER,
          },
          journalEpoch: controlJournal.journalEpoch,
          controlHealth: controlJournal.health,
        }
      : {}),
    sessionObservation: {
      version: 1,
      maxBufferedEvents: 256,
    },
    sessionAdmission: {
      version: 1,
      surfaces: CODER_DAEMON_SESSION_SURFACES,
      legacySurface: true,
      partnerDenied: true,
    },
    completeObservationSnapshot: {
      version: 1,
      transcriptRevision: true,
      managedTasks: true,
      queuedInputs: true,
    },
    connectionLifecycle: { version: 1 },
    runLifecycleControl: {
      version: 1,
      structuredStopReceipt: true,
      protocolCancellation: true,
      responseAcknowledgement: true,
    },
    typedRuntimeEvents: { version: 1 },
    daemonSafeRunInput: { version: 1 },
    integrationConfigResilience: {
      version: 1,
      isolatedFailure: true,
      legacySourceWatching: true,
      lastKnownGood: true,
      healthProjection: true,
    },
    ...(daemonManagement
      ? {
          daemonClientInventory: { version: 1 },
          daemonManagement: {
            version: 1,
            logicalClientCount: true,
            revisionedStop: true,
            ownerPolicy: true,
            ownerFenceState: true,
            reverseBridgeDrainingFence: true,
            backgroundWorkPreflight: true,
          },
        }
      : {}),
    sharedSessionSettings: {
      version: 1,
      keys: [
        "provider",
        "model",
        "effort",
        "thinking",
        "reasoningMode",
        "permissionMode",
        "executionCwd",
        "agentMode",
        "autoModeEngine",
        "autoModeClassifierModel",
        "autoModeTimeoutMs",
        "autoModeSpeculativeWindowMs",
      ],
    },
    ...(controlJournal !== undefined
      ? {
          durableRecoveryQueries: {
            version: 1,
            operationResult: true,
            hostToolInvocation: durableHostToolInvocations,
            permissionGrants: true,
            daemonPreflight: true,
            terminalAcknowledgement: false,
            terminalAcknowledgementOwner: "client",
          },
        }
      : {}),
    afterTurnInput: { version: 1 },
    interruptInput: { version: 1, availability: "per_run" },
    contextCompaction: {
      version: 3,
      alwaysOn: true,
      absoluteThreshold: true,
      contextIdentity: true,
      canonicalFinishedEvent: true,
      durableBeforeEvict: true,
      exactHistoryRecovery: true,
    },
    transcriptPaging: { version: 1, maxPageBytes: 512 * 1024 },
    transcriptSearch: {
      version: 1,
      defaultScope: "compacted",
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
    learningCenter: { version: 1 },
    skillLearningLoop: {
      version: 1,
      activation: "project_scoped_canary",
      immutableDecisions: true,
      recordGatedDiscovery: true,
      exactUseAttribution: true,
      rollback: true,
    },
    askUserTransport: { version: 1 },
    permissionCas: { version: 1 },
    providerCredentialBroker: {
      version: 2,
      registrationConnectionBound: !reverseBridgeResume,
      stableClientResume: reverseBridgeResume,
      runtimeRestartExpiresLease: true,
      credentialLifetime: "provider_request",
      lazyProviderResolution: true,
      providerAllowlist: true,
      operationTargets: ["run", "session.compact", "actor_turn", "workflow"],
      revocationAbortsPendingRequests: true,
      detachedWorkflowScope: "derived_revocable_lease",
      requestTimeoutMs: reverseBridgeLimits.callTimeoutMs,
    },
    effectiveConfig: {
      version: 1,
      credentialValues: false,
      sourceMetadata: true,
      scope: "integration:admin",
    },
    runBoundHostTools: {
      version: 2,
      materializedAgentTools: true,
      registrationConnectionBound: !reverseBridgeResume,
      stableClientResume: reverseBridgeResume,
      invocationStatusQuery: reverseBridgeResume,
      invocationReplay: false,
      invocationTimeoutMs: reverseBridgeLimits.callTimeoutMs,
      maxResultBytes: reverseBridgeLimits.maxResultBytes,
    },
    coderOwnerFencing: { version: 1 },
    crashOutcomeModel: { version: 2 },
    coderFeatureMatrix: {
      version: 1,
      managedRun: true,
      transcriptSessions: true,
      todoProjection: true,
      managedTasks: true,
      workflow: true,
      mcp: true,
      referenceExternalAgent: externalAgents,
      memory: true,
      runtimeArtifacts: true,
    },
    ...safeOverrides,
  };
}

function runtimeImplementsEventCoalescing(runtime: KodaXRuntime): boolean {
  const capability = runtime.capabilities?.runtimeEventCoalescing;
  return (
    isRecord(capability)
    && typeof capability.version === "number"
    && capability.version >= 1
  );
}

function publicOperationReceipt(
  receipt: ReturnType<RuntimeControlJournal["get"]> & {},
): Record<string, unknown> {
  if (!receipt) return {};
  return { ...receipt };
}

function requireExternalAgentsEnabled(runtime: KodaXRuntime): void {
  if (runtime.agents.enabled) return;
  throw daemonError(
    "method_not_found",
    "Runtime external agent executor plane is not enabled.",
  );
}

function requireAgentRegistrationAdmin(
  options: RuntimeDaemonDispatcherOptions,
): void {
  if (options.allowAgentRegistrationAdmin !== true) {
    throw daemonError(
      "permission_denied",
      "Runtime daemon host denied Agent registration administration.",
    );
  }
}

function filterReplayForClientCapabilities(
  events: readonly RuntimeEvent[],
  capabilities: RuntimeClientCapabilities,
): readonly RuntimeEvent[] {
  if (capabilities.contextDiagnostics === true) return events;
  return events.filter((event) => !isContextDiagnosticRuntimeEvent(event));
}

async function assertAdmittedSessionId(
  runtime: KodaXRuntime,
  sessionId: string | undefined,
): Promise<void> {
  if (sessionId !== undefined) await runtime.sessions.transcript(sessionId);
}

async function assertAdmittedEventScope(
  runtime: KodaXRuntime,
  filter: RuntimeEventFilter | RuntimeEventReplayFilter | undefined,
): Promise<void> {
  if (filter?.sessionId !== undefined) {
    await assertAdmittedSessionId(runtime, filter.sessionId);
    if (filter.runId !== undefined) {
      await runtime.events.replay({
        sessionId: filter.sessionId,
        runId: filter.runId,
        limit: 1,
      });
    }
    return;
  }
  if (filter?.runId !== undefined) {
    const [event] = await runtime.events.replay({ runId: filter.runId, limit: 1 });
    const sessionId = event?.sessionId
      ?? (await runtime.runs.get(filter.runId)).sessionId;
    await assertAdmittedSessionId(runtime, sessionId);
    return;
  }
  throw daemonError(
    "invalid_request",
    "Runtime event access must specify a Session or Run scope.",
  );
}

function augmentObservationRunRequirements(
  snapshot: RuntimeSessionObservationSnapshot,
  source: RuntimeRunRequirementSource | undefined,
): RuntimeSessionObservationSnapshot {
  return {
    ...snapshot,
    runs: snapshot.runs.map((status) => augmentRunRequirements(status, source)),
  };
}

function augmentStatusRunRequirements(
  value: unknown,
  source: RuntimeRunRequirementSource | undefined,
): unknown {
  if (!isRecord(value) || !Array.isArray(value.runs)) return value;
  return {
    ...value,
    runs: value.runs.map((status) =>
      isRuntimeRunStatus(status)
        ? augmentRunRequirements(status, source)
        : status,
    ),
  };
}

function augmentPreflightRunRequirements(
  value: RuntimeDaemonPreflight,
  source: RuntimeRunRequirementSource | undefined,
): RuntimeDaemonPreflight {
  return {
    ...value,
    activeRuns: value.activeRuns.map((status) =>
      augmentRunRequirements(status, source),
    ),
    queuedRuns: value.queuedRuns.map((status) =>
      augmentRunRequirements(status, source),
    ),
  };
}

function augmentRuntimeEventRequirements(
  event: RuntimeEvent,
  source: RuntimeRunRequirementSource | undefined,
): RuntimeEvent {
  if (!isRuntimeRunStatus(event.payload)) return event;
  return { ...event, payload: augmentRunRequirements(event.payload, source) };
}

type RuntimeRunRequirementSource = Pick<
  RuntimeDaemonReverseBridge,
  "getRunRequirements"
>;

function augmentRunRequirements(
  status: RuntimeRunStatus,
  source: RuntimeRunRequirementSource | undefined,
): RuntimeRunStatus {
  const requirements = source?.getRunRequirements(status.runId);
  if (requirements === undefined) return status;
  if (isTerminalRuntimeRunPhase(status.phase)) {
    return {
      ...status,
      requirements: {
        ...(requirements.credential !== undefined
          ? { credential: { ...requirements.credential, state: "terminal" } }
          : {}),
        ...(requirements.hostTools !== undefined
          ? { hostTools: { ...requirements.hostTools, state: "terminal" } }
          : {}),
      },
    };
  }
  return { ...status, requirements };
}

function isRuntimeRunStatus(value: unknown): value is RuntimeRunStatus {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.phase === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.provider === "string"
  );
}

function isTerminalRuntimeRunPhase(phase: RuntimeRunStatus["phase"]): boolean {
  return (
    phase === "completed" ||
    phase === "failed" ||
    phase === "cancelled" ||
    phase === "interrupted"
  );
}

function requireContextDiagnosticsCapability(
  capabilities: RuntimeClientCapabilities,
): void {
  if (capabilities.contextDiagnostics === true) return;
  throw daemonError(
    "unauthorized",
    "Runtime daemon client did not negotiate contextDiagnostics capability.",
  );
}

function isContextDiagnosticRuntimeEvent(
  value: unknown,
): value is RuntimeEvent {
  if (!isRecord(value)) return false;
  return (
    value.type === "context.budget.snapshot" ||
    value.type === "provider.cache.diagnostics" ||
    value.type === "tool.exposure.planned" ||
    value.type === "context.compaction.skipped"
  );
}

async function latestRuntimeDiagnosticPayload(
  runtime: KodaXRuntime,
  type: RuntimeEventType,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  const filter = (params ?? {}) as RuntimeDiagnosticFilter;
  if (type === "context.budget.snapshot") {
    return runtime.diagnostics.latestContextBudget(filter);
  }
  if (type === "tool.exposure.planned") {
    return runtime.diagnostics.latestToolExposure(filter);
  }
  if (type === "provider.cache.diagnostics") {
    return runtime.diagnostics.latestProviderCacheDiagnostic(filter);
  }
  return null;
}

async function setRunModel(
  runtime: KodaXRuntime,
  paramsValue: unknown,
): Promise<{ readonly ok: true }> {
  const params = requireRecord(paramsValue);
  await runtime.runs.setModel(
    requireStringField(params, "runId"),
    optionalStringField(params, "model"),
  );
  return { ok: true };
}

async function setRunReasoning(
  runtime: KodaXRuntime,
  paramsValue: unknown,
): Promise<{ readonly ok: true }> {
  const params = requireRecord(paramsValue);
  await runtime.runs.setReasoning(
    requireStringField(params, "runId"),
    optionalStringField(params, "reasoning") as Parameters<
      typeof runtime.runs.setReasoning
    >[1],
  );
  return { ok: true };
}

function listRuntimeModels(
  providerList: unknown,
  params: Record<string, unknown> | undefined,
): unknown {
  const providers = Array.isArray(providerList) ? providerList : [];
  const providerName =
    typeof params?.provider === "string" ? params.provider : undefined;
  if (providerName !== undefined) {
    const provider = providers.find(
      (item) => isRecord(item) && item.name === providerName,
    );
    if (!isRecord(provider)) {
      return { provider: providerName, models: [] };
    }
    return {
      provider: providerName,
      models: Array.isArray(provider.models) ? provider.models : [],
    };
  }
  return providers.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string") return [];
    return [
      {
        provider: item.name,
        models: Array.isArray(item.models) ? item.models : [],
      },
    ];
  });
}

function redactRuntimeConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactRuntimeConfig(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveConfigKey(key) ? "[redacted]" : redactRuntimeConfig(item),
    ]),
  );
}

function isSensitiveConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower === "key" ||
    lower.endsWith("key") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password")
  );
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value);
}

function requireRecordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return requireRecord(record[key]);
}

function parseModelListFilter(
  params: unknown,
): Parameters<KodaXRuntime["catalog"]["models"]>[0] {
  const record = optionalRecord(params);
  if (!record) return undefined;
  return typeof record.provider === "string"
    ? { provider: record.provider }
    : undefined;
}

function parseMcpToolListFilter(
  params: unknown,
): Parameters<KodaXRuntime["mcp"]["listTools"]>[0] {
  const record = optionalRecord(params);
  if (!record) return undefined;
  return {
    ...(typeof record.server === "string" ? { server: record.server } : {}),
    ...(typeof record.forceRefresh === "boolean"
      ? { forceRefresh: record.forceRefresh }
      : {}),
  };
}

function parseSkillListFilter(
  params: unknown,
): Parameters<KodaXRuntime["catalog"]["skills"]>[0] {
  const record = optionalRecord(params);
  if (!record) return undefined;
  return {
    ...(typeof record.projectRoot === "string"
      ? { projectRoot: record.projectRoot }
      : {}),
    ...(typeof record.userInvocableOnly === "boolean"
      ? { userInvocableOnly: record.userInvocableOnly }
      : {}),
  };
}

function parseArtifactCreateInput(
  params: unknown,
): Parameters<KodaXRuntime["artifacts"]["create"]>[0] {
  const record = requireRecord(params);
  const kind = record.kind;
  if (kind !== "image" && kind !== "file" && kind !== "video") {
    throw daemonError(
      "invalid_request",
      "Expected artifact kind: image | file | video",
    );
  }
  const artifactPath = requireStringField(record, "path");
  return {
    kind,
    path: artifactPath,
    ...(typeof record.mediaType === "string"
      ? { mediaType: record.mediaType }
      : {}),
    ...(typeof record.mimeType === "string"
      ? { mimeType: record.mimeType }
      : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(isRuntimeArtifactSource(record.source)
      ? { source: record.source }
      : {}),
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
  };
}

function isRuntimeArtifactSource(
  value: unknown,
): value is Parameters<KodaXRuntime["artifacts"]["create"]>[0]["source"] {
  return (
    value === "user-inline" ||
    value === "clipboard" ||
    value === "drag-drop" ||
    value === "file-picker"
  );
}

function parseRuntimeClientName(value: unknown): string | undefined {
  return isRecord(value) &&
    typeof value.name === "string" &&
    value.name.length > 0
    ? value.name
    : undefined;
}

function parseRuntimeClientVersion(value: unknown): string | undefined {
  return isRecord(value) &&
    typeof value.version === "string" &&
    value.version.length > 0
    ? value.version
    : undefined;
}

function requireCredentialBrokerVersion(value: number): 1 | 2 {
  if (value === 1 || value === 2) return value;
  throw daemonError("invalid_params", "Credential broker version must be 1 or 2.");
}

function runtimeDaemonClientSnapshot(
  daemonConnectionId: string,
  principalId: string,
  value: unknown,
): RuntimeDaemonClientSnapshot {
  const record = isRecord(value) ? value : {};
  const name = daemonClientDisplayField(
    record.name,
    RUNTIME_DAEMON_CLIENT_DISPLAY_LIMITS.name,
  );
  const title = daemonClientDisplayField(
    record.title,
    RUNTIME_DAEMON_CLIENT_DISPLAY_LIMITS.title,
  );
  const version = daemonClientDisplayField(
    record.version,
    RUNTIME_DAEMON_CLIENT_DISPLAY_LIMITS.version,
  );
  return {
    daemonConnectionId,
    principalId,
    ...(name !== undefined ? { name } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(version !== undefined ? { version } : {}),
    clientType: runtimeDaemonClientType(record.clientType),
    connectedAt: new Date().toISOString(),
  };
}

function bindTrustedScopedCredentialAccess(input: {
  readonly binding: Record<string, unknown>;
  readonly sessionId: string;
  readonly target: RuntimeScopedCredentialTarget;
  readonly reverseBridge: RuntimeDaemonReverseBridge;
}): ProviderCredentialLeaseAccess {
  const leaseId = requireStringField(input.binding, "leaseId");
  const providers = requireStringArrayField(input.binding, "providers");
  if (
    providers.length === 0
    || providers.some((provider) => provider.trim().length === 0)
    || new Set(providers).size !== providers.length
  ) {
    throw daemonError(
      "invalid_params",
      "Scoped credential binding Providers must be non-empty and unique.",
    );
  }
  const lease = input.reverseBridge.getCredential(leaseId);
  if (lease?.brokerVersion !== 2) {
    throw daemonError(
      "credential_unavailable",
      "Scoped credential binding requires an active v2 credential lease.",
    );
  }
  const leaseProviders = new Set(lease.providers);
  if (providers.some((provider) => !leaseProviders.has(provider))) {
    throw daemonError(
      "credential_unavailable",
      "Scoped credential binding exceeds the registered Provider allowlist.",
    );
  }
  return {
    allowedProviders: providers,
    signal: input.reverseBridge.credentialSignal(leaseId),
    isActive: () => input.reverseBridge.isCredentialActive(leaseId),
    acquire: (provider, purpose, signal, attribution) => input.reverseBridge.acquireScopedCredential({
      leaseId,
      provider,
      sessionId: input.sessionId,
      target: attributedCredentialTarget(input.target, attribution),
      purpose,
      signal,
    }),
  };
}

function attributedCredentialTarget(
  base: RuntimeScopedCredentialTarget,
  attribution: ProviderCredentialAttribution | undefined,
): RuntimeScopedCredentialTarget {
  if (attribution === undefined) return base;
  const parentRunId = base.kind === "run"
    ? base.runId
    : base.kind === "actor_turn" || base.kind === "workflow"
      ? base.parentRunId
      : undefined;
  if (attribution.kind === "actor_turn") {
    return {
      kind: "actor_turn",
      actorPath: attribution.actorPath,
      turnId: attribution.turnId,
      ...(parentRunId === undefined ? {} : { parentRunId }),
    };
  }
  return {
    kind: "workflow",
    workflowRunId: attribution.workflowRunId,
    ...(parentRunId === undefined ? {} : { parentRunId }),
  };
}

function bindTrustedAgentCredentialAccessFactory(input: {
  readonly binding: Record<string, unknown> | undefined;
  readonly sessionId: string;
  readonly reverseBridge: RuntimeDaemonReverseBridge;
}): CodingActorCredentialAccessFactory | undefined {
  if (input.binding === undefined) return undefined;
  const binding = input.binding;
  if (binding.mode !== "scoped") {
    throw daemonError(
      "client_upgrade_required",
      "Agent credential binding requires a scoped v2 credential lease.",
    );
  }
  const boundProviders = requireStringArrayField(binding, "providers");
  return ({ actorPath, turnId, providers }) => {
    if (
      !providers.includes("*")
      && boundProviders.some((provider) => !providers.includes(provider))
    ) {
      throw daemonError(
        "credential_unavailable",
        "Agent credential binding exceeds the admitted Actor Provider authority.",
      );
    }
    return bindTrustedScopedCredentialAccess({
      binding,
      sessionId: input.sessionId,
      target: { kind: "actor_turn", actorPath, turnId },
      reverseBridge: input.reverseBridge,
    });
  };
}

function assertDaemonAgentCredentialBinding(
  actorKind: string,
  binding: Record<string, unknown> | undefined,
): void {
  if (actorKind === "external") {
    if (binding !== undefined) {
      throw daemonError(
        "invalid_params",
        "External Agents use credentialRef and cannot bind Runtime Provider credentials.",
      );
    }
    return;
  }
  if (binding === undefined) {
    throw daemonError(
      "credential_unavailable",
      "Native, constructed, and workflow Agent turns require an explicit scoped credential binding.",
    );
  }
}

function daemonClientDisplayField(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ||
    UNSAFE_RUNTIME_DAEMON_CLIENT_DISPLAY_PATTERN.test(normalized)
    ? undefined
    : normalized.slice(0, limit);
}

function runtimeDaemonClientType(value: unknown): RuntimeDaemonClientType {
  return value === "app" ||
    value === "cli" ||
    value === "diagnostic" ||
    value === "automation"
    ? value
    : "unknown";
}

function requireStringArrayField(
  record: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw daemonError("invalid_request", `Expected string array param: ${key}`);
  }
  return value as string[];
}

function parseRuntimeHostToolDescriptors(
  value: unknown,
): readonly RuntimeHostToolDescriptor[] {
  if (!Array.isArray(value)) {
    throw daemonError(
      "invalid_request",
      "Expected host tool descriptors array.",
    );
  }
  return value.map((item) => {
    const record = requireRecord(item);
    const sideEffect = requireStringField(record, "sideEffect");
    if (
      sideEffect !== "none" &&
      sideEffect !== "idempotent" &&
      sideEffect !== "non_idempotent"
    ) {
      throw daemonError(
        "invalid_request",
        `Invalid host tool sideEffect: ${sideEffect}`,
      );
    }
    return {
      name: requireStringField(record, "name"),
      description: requireStringField(record, "description"),
      inputSchema: requireRecordField(record, "inputSchema"),
      sideEffect,
    };
  });
}

function selectCapabilityRuntimes(
  host: ExtensionRuntimeContract,
  base: ExtensionRuntimeContract,
  providerId: string,
  server?: string,
): readonly ExtensionRuntimeContract[] {
  if (providerId !== "mcp") return [base];
  if (server !== undefined) {
    const runtime = server === "host" ? host : base;
    return runtime.hasCapabilityProvider?.(providerId) === false ? [] : [runtime];
  }
  return [host, base].filter(
    (runtime) => runtime.hasCapabilityProvider?.(providerId) !== false,
  );
}

async function searchCapabilityRuntimeSnapshot(
  runtime: ExtensionRuntimeContract,
  providerId: string,
  query: string,
  options: Parameters<NonNullable<ExtensionRuntimeContract["searchCapabilitySnapshot"]>>[2],
): Promise<CapabilitySearchSnapshot> {
  if (runtime.searchCapabilitySnapshot !== undefined) {
    return runtime.searchCapabilitySnapshot(providerId, query, options);
  }
  return {
    items: await runtime.searchCapabilities(providerId, query, {
      ...options,
      limit: Number.MAX_SAFE_INTEGER,
    }),
    complete: false,
    freshness: "unknown",
  };
}

function mergeCapabilitySearchSnapshots(
  snapshots: readonly CapabilitySearchSnapshot[],
): CapabilitySearchSnapshot {
  const seenIds = new Set<string>();
  const items = snapshots.flatMap((snapshot) => snapshot.items).filter((item) => {
    const id = item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).id
      : undefined;
    if (typeof id !== "string") return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  const revisions = snapshots.map((snapshot) => snapshot.revision);
  const revision = snapshots.length === 1
    ? revisions[0]
    : revisions.every((value) => typeof value === "string")
      ? JSON.stringify(revisions)
      : undefined;
  const firstFreshness = snapshots[0]?.freshness;
  const freshness = firstFreshness === undefined
    ? "unknown"
    : snapshots.every((snapshot) => snapshot.freshness === firstFreshness)
      ? firstFreshness
      : "mixed";
  const failures = snapshots.flatMap((snapshot) => snapshot.failures ?? []);
  return {
    items,
    ...(revision !== undefined ? { revision } : {}),
    complete: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.complete),
    freshness,
    ...(failures.length > 0 ? { failures } : {}),
  };
}

function mergeExtensionRuntimeContracts(
  host: ExtensionRuntimeContract,
  base: ExtensionRuntimeContract,
): ExtensionRuntimeContract {
  return {
    hasCapabilityProvider(providerId) {
      return (
        host.hasCapabilityProvider?.(providerId) === true ||
        base.hasCapabilityProvider?.(providerId) === true
      );
    },
    async searchCapabilities(providerId, query, options) {
      const runtimes = selectCapabilityRuntimes(host, base, providerId, options?.server);
      const results = await Promise.all(
        runtimes.map((runtime) => runtime.searchCapabilities(providerId, query, options)),
      );
      const merged = results.flat();
      return merged.slice(0, options?.limit ?? merged.length);
    },
    async searchCapabilitySnapshot(providerId, query, options) {
      const runtimes = selectCapabilityRuntimes(host, base, providerId, options?.server);
      const snapshots = await Promise.all(runtimes.map((runtime) => (
        searchCapabilityRuntimeSnapshot(runtime, providerId, query, options)
      )));
      return mergeCapabilitySearchSnapshots(snapshots);
    },
    async describeCapability(providerId, capabilityId) {
      if (capabilityId.startsWith("host:")) {
        return host.describeCapability(providerId, capabilityId);
      }
      return base.describeCapability(providerId, capabilityId);
    },
    executeCapability(providerId, capabilityId, input) {
      return capabilityId.startsWith("host:")
        ? host.executeCapability(providerId, capabilityId, input)
        : base.executeCapability(providerId, capabilityId, input);
    },
    readCapability(providerId, capabilityId, options) {
      return base.readCapability(providerId, capabilityId, options);
    },
    getCapabilityPrompt(providerId, capabilityId, args) {
      return base.getCapabilityPrompt(providerId, capabilityId, args);
    },
    getCapabilityPromptContext(providerId) {
      return Promise.all([
        base.getCapabilityPromptContext(providerId),
        host.getCapabilityPromptContext(providerId),
      ]).then((contexts) => {
        const content = contexts
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
          .join("\n\n");
        return content.length > 0 ? content : undefined;
      });
    },
    ...(host.listRunTools !== undefined || base.listRunTools !== undefined
      ? {
          listRunTools(providerId: string) {
            const seen = new Set<string>();
            return [
              ...(host.listRunTools?.(providerId) ?? []),
              ...(base.listRunTools?.(providerId) ?? []),
            ].filter((definition) => {
              if (seen.has(definition.name)) return false;
              seen.add(definition.name);
              return true;
            });
          },
        }
      : {}),
    ...(base.getDefaults !== undefined
      ? { getDefaults: () => base.getDefaults!() }
      : {}),
    ...(base.bindController !== undefined
      ? { bindController: (controller) => base.bindController!(controller) }
      : {}),
    ...(base.hydrateSession !== undefined
      ? { hydrateSession: (sessionId) => base.hydrateSession!(sessionId) }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw daemonError("invalid_request", "Expected params to be an object.");
  }
  return value as Record<string, unknown>;
}

function requireStringParam(params: unknown, key: string): string {
  return requireStringField(requireRecord(params), key);
}

function requireStringField(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw daemonError("invalid_request", `Expected string param: ${key}`);
  }
  return value;
}

function requireBooleanField(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw daemonError("invalid_request", `Expected boolean param: ${key}`);
  }
  return value;
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw daemonError(
      "invalid_request",
      `Expected optional string param: ${key}`,
    );
  }
  return value;
}

function optionalExpectedConfigurationRevision(
  record: Record<string, unknown>,
): string | null | undefined {
  const value = record.expectedConfigurationRevision;
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length === 0) {
    throw daemonError(
      "invalid_request",
      "Expected optional string or null param: expectedConfigurationRevision",
    );
  }
  return value;
}

function optionalExpectedManagementOwner(
  record: Record<string, unknown>,
): string | null | undefined {
  const value = record.expectedManagementOwner;
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length === 0) {
    throw daemonError(
      "invalid_request",
      "Expected optional string or null param: expectedManagementOwner",
    );
  }
  return value;
}

function optionalIntegerField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw daemonError(
      "invalid_request",
      `Expected optional non-negative integer param: ${key}`,
    );
  }
  return value as number;
}

function runtimeReadOptions(
  value: unknown,
  signal: AbortSignal,
): RuntimeReadOptions {
  const timeoutMs = optionalIntegerField(requireRecord(value), "timeoutMs");
  return {
    signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function requireIntegerField(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = optionalIntegerField(record, key);
  if (value === undefined) {
    throw daemonError(
      "invalid_request",
      `Expected non-negative integer param: ${key}`,
    );
  }
  return value;
}

function daemonError(
  code: RuntimeDaemonErrorCode,
  message: string,
  data?: unknown,
): Error & { readonly code: RuntimeDaemonErrorCode; readonly data?: unknown } {
  const error = new Error(message) as Error & {
    code: RuntimeDaemonErrorCode;
    data?: unknown;
  };
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function createSubscriptionId(): string {
  return `sub_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function validateDaemonMethodValue(
  method: RuntimeDaemonMethod,
  kind: "params" | "result",
  value: unknown,
  code: "invalid_params" | "internal_error",
): void {
  const issues = validateRuntimeDaemonJsonSchema(
    RUNTIME_DAEMON_METHOD_SCHEMAS[method][kind],
    value,
    kind,
  );
  if (issues.length === 0) return;
  throw daemonError(
    code,
    kind === "params"
      ? `Invalid params for ${method}.`
      : `Runtime daemon produced an invalid result for ${method}.`,
    { issues },
  );
}

function serializeRuntimeDaemonMethodResult(
  method: RuntimeDaemonMethod,
  result: unknown,
): unknown {
  if (result === undefined) return null;
  if (
    method !== "run.await" ||
    !isRecord(result) ||
    !(result.error instanceof Error)
  ) {
    return result;
  }
  return {
    ...result,
    error: {
      name: result.error.name,
      message: result.error.message,
    },
  };
}

function normalizeRuntimeDaemonError(error: unknown): {
  readonly code: RuntimeDaemonErrorCode;
  readonly message: string;
  readonly data?: unknown;
} {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "revision_conflict"
  ) {
    const conflict = error as Error & {
      readonly expectedRevision?: number;
      readonly currentRevision?: number;
    };
    return {
      code: "conflict",
      message: error.message,
      data: {
        conflict: "revision_conflict",
        expectedRevision: conflict.expectedRevision,
        currentRevision: conflict.currentRevision,
      },
    };
  }
  if (error instanceof ExternalAgentRegistrationConflictError) {
    return {
      code: "conflict",
      message: error.message,
      data: { agentId: error.agentId, conflict: error.code },
    };
  }
  if (error instanceof Error) {
    const maybe = error as Error & {
      readonly code?: unknown;
      readonly data?: unknown;
    };
    const code =
      typeof maybe.code === "string" && isRuntimeDaemonErrorCode(maybe.code)
        ? maybe.code
        : "internal_error";
    return {
      code,
      message: error.message,
      ...(maybe.data !== undefined ? { data: maybe.data } : {}),
    };
  }
  return {
    code: "internal_error",
    message: String(error),
  };
}

function isRuntimeDaemonErrorCode(
  value: string,
): value is RuntimeDaemonErrorCode {
  return (
    value === "invalid_frame" ||
    value === "invalid_request" ||
    value === "invalid_params" ||
    value === "not_initialized" ||
    value === "method_not_found" ||
    value === "unauthorized" ||
    value === "permission_denied" ||
    value === "conflict" ||
    value === "not_found" ||
    value === "session_not_admitted" ||
    value === "cancelled" ||
    value === "overloaded" ||
    value === "client_upgrade_required" ||
    value === "operation_required" ||
    value === "operation_epoch_mismatch" ||
    value === "operation_id_reuse" ||
    value === "operation_interrupted" ||
    value === "operation_unknown" ||
    value === "control_history_untrusted" ||
    value === "resync_required" ||
    value === "read_timeout" ||
    value === "read_cancelled" ||
    value === "data_changed" ||
    value === "observation_invalidated" ||
    value === "runtime_changed" ||
    value === "data_corrupt" ||
    value === "version_incompatible" ||
    value === "credential_unavailable" ||
    value === "host_tool_unavailable" ||
    value === "host_tool_unknown" ||
    value === "internal_error"
  );
}
