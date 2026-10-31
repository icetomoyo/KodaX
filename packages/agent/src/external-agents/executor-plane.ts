import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { createMemoryAgentExecutorPlaneStore } from './memory-store.js';
import type {
  AgentCapabilityDeclaration,
  AgentCapabilityRequirements,
  AgentArtifactReference,
  AgentCredentialBroker,
  AgentDispatchabilitySnapshot,
  AgentExecutor,
  AgentExecutorEvent,
  AgentExecutorFactory,
  AgentExecutorFactoryContext,
  AgentExecutorPlane,
  AgentExecutorPlaneBackgroundErrorContext,
  AgentExecutorPlaneBackgroundErrorHandler,
  AgentExecutorPlaneStore,
  AgentExecutorTaskReference,
  AgentExecutorTaskSnapshot,
  AgentPreflightInput,
  AgentPreflightResult,
  AgentRegistrationEnabledMutationOptions,
  AgentRegistrationMutationOptions,
  AgentRegistrationService,
  AgentTaskCancellation,
  AgentTaskEvent,
  AgentTaskFilter,
  AgentTaskService,
  AgentTaskSnapshot,
  AgentTaskStartInput,
  AgentJsonValue,
  CreateAgentExecutorPlaneOptions,
  DispatchableAgentDescriptor,
  DispatchableAgentListing,
  DispatchableAgentQuery,
  ExternalAgentRegistration,
  ExternalAgentRegistrationSummary,
  LocalAgentTaskInput,
  LocalAgentTaskUpdate,
} from './types.js';

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected']);
const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;
const REGISTRATION_REVISION_HISTORY_LIMIT = 4_096;
const CAPABILITY_KEYS = [
  'streaming',
  'durableTasks',
  'inputRequired',
  'cancellation',
  'artifacts',
] as const satisfies readonly (keyof AgentCapabilityDeclaration)[];

const LOCAL_CAPABILITIES: AgentCapabilityDeclaration = {
  streaming: 'supported',
  durableTasks: 'supported',
  inputRequired: 'supported',
  cancellation: 'supported',
  artifacts: 'supported',
};

export class AgentStartUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentStartUncertainError';
  }
}

export class AgentCancellationUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCancellationUncertainError';
  }
}

interface PlaneRuntimeOptions {
  readonly factories: ReadonlyMap<string, AgentExecutorFactory>;
  readonly policy: CreateAgentExecutorPlaneOptions['policy'];
  readonly credentialBroker?: AgentCredentialBroker;
  readonly artifactPolicy?: CreateAgentExecutorPlaneOptions['artifactPolicy'];
  readonly onBackgroundError: AgentExecutorPlaneBackgroundErrorHandler;
  readonly store: AgentExecutorPlaneStore;
  readonly now: () => Date;
  readonly createTaskId: () => string;
  readonly createIdempotencyKey: () => string;
  readonly closeTimeoutMs: number;
}

interface EvaluationResult {
  readonly descriptor: DispatchableAgentDescriptor;
  readonly dispatchability: AgentDispatchabilitySnapshot;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneJsonSafeArray(
  value: readonly unknown[],
  path: string,
  ancestors: Set<object>,
  allowUndefinedObjectProperties: boolean,
): readonly AgentJsonValue[] {
  const result: AgentJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error(`${path}[${index}] must be JSON-safe.`);
    result.push(cloneJsonSafeValue(
      value[index], `${path}[${index}]`, ancestors, allowUndefinedObjectProperties,
    ));
  }
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new Error(`${path} must not contain non-index array properties.`);
  }
  return result;
}

function cloneJsonSafeObject(
  value: object,
  path: string,
  ancestors: Set<object>,
  allowUndefinedObjectProperties: boolean,
): Readonly<Record<string, AgentJsonValue>> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a JSON-safe plain object.`);
  }
  const result: Record<string, AgentJsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${path} must not contain symbol keys.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`${path}.${key} must be an enumerable JSON-safe value.`);
    }
    if (descriptor.value === undefined && allowUndefinedObjectProperties) continue;
    Object.defineProperty(result, key, {
      value: cloneJsonSafeValue(
        descriptor.value, `${path}.${key}`, ancestors, allowUndefinedObjectProperties,
      ),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function cloneJsonSafeValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  allowUndefinedObjectProperties: boolean,
): AgentJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must be JSON-safe.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new Error(`${path} must be JSON-safe.`);
  if (ancestors.has(value)) throw new Error(`${path} must be JSON-safe and acyclic.`);
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? cloneJsonSafeArray(value, path, ancestors, allowUndefinedObjectProperties)
      : cloneJsonSafeObject(value, path, ancestors, allowUndefinedObjectProperties);
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonSafe<T>(value: T, label: string, allowUndefined = false): T {
  return cloneJsonSafeValue(value, label, new Set(), allowUndefined) as unknown as T;
}

function isTerminal(state: AgentTaskSnapshot['state']): boolean {
  return TERMINAL_STATES.has(state);
}

function sanitizeText(value: string, secrets: readonly string[] = []): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret.length > 0) sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  return sanitized
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|client[_-]?secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function errorMessage(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeText(message || 'Unknown external agent error.', secrets);
}

function normalizedBackgroundError(error: unknown): Error {
  const normalized = new Error(errorMessage(error));
  normalized.name = error instanceof Error ? error.name : 'Error';
  return normalized;
}

function defaultBackgroundErrorHandler(
  error: Error,
  context: AgentExecutorPlaneBackgroundErrorContext,
): void {
  const identity = [context.agentId, context.configurationRevision, context.taskId]
    .filter((value) => value !== undefined)
    .join('/');
  process.emitWarning(
    `[${context.operation}${identity ? `:${identity}` : ''}] ${error.message}`,
    { code: 'KODAX_AGENT_EXECUTOR_BACKGROUND_ERROR', type: 'KodaXAgentExecutorWarning' },
  );
}

function descriptorFromRegistration(
  registration: ExternalAgentRegistration,
): DispatchableAgentDescriptor {
  return {
    agentId: registration.agentId,
    displayName: registration.displayName,
    ...(registration.description ? { description: registration.description } : {}),
    origin: 'external',
    protocol: registration.protocol,
    configurationRevision: registration.configurationRevision,
    skills: registration.skills ?? [],
    inputModalities: registration.inputModalities ?? [],
    outputModalities: registration.outputModalities ?? [],
    capabilities: registration.capabilities,
    effects: registration.effects,
  };
}

function summaryFromRegistration(
  registration: ExternalAgentRegistration,
): ExternalAgentRegistrationSummary {
  const diagnostics: string[] = [];
  if (!registration.enabled) diagnostics.push('disabled');
  if (registration.health?.status === 'unhealthy') diagnostics.push('unhealthy');
  if (registration.health?.diagnostic) diagnostics.push('health check reported a diagnostic');
  const health = registration.health
    ? {
        status: registration.health.status,
        checkedAt: registration.health.checkedAt,
        ...(registration.health.retryAfterMs !== undefined
          ? { retryAfterMs: registration.health.retryAfterMs }
          : {}),
      }
    : undefined;
  return clone({
    agentId: registration.agentId,
    displayName: registration.displayName,
    ...(registration.description ? { description: registration.description } : {}),
    ...(registration.managementOwner ? { managementOwner: registration.managementOwner } : {}),
    enabled: registration.enabled,
    executorId: registration.executorId,
    protocol: registration.protocol,
    configurationRevision: registration.configurationRevision,
    endpointIdentityHash: registration.endpointIdentityHash,
    credentialConfigured: registration.credentialRef !== undefined,
    capabilities: registration.capabilities,
    effects: registration.effects,
    ...(health ? { health } : {}),
    diagnostics,
  });
}

export class ExternalAgentRegistrationConflictError extends Error {
  readonly code = 'external_agent_registration_conflict' as const;

  constructor(readonly agentId: string) {
    super(`External agent registration revision or owner changed: ${agentId}.`);
    this.name = 'ExternalAgentRegistrationConflictError';
  }
}

function captureRegistration(input: ExternalAgentRegistration): ExternalAgentRegistration {
  const { executorConfig, ...registration } = input;
  if (executorConfig !== undefined
    && (executorConfig === null || typeof executorConfig !== 'object' || Array.isArray(executorConfig))) {
    throw new Error('External agent executorConfig must be a JSON-safe object.');
  }
  return clone({
    ...registration,
    ...(executorConfig === undefined ? {} : {
      executorConfig: cloneJsonSafe(executorConfig, 'External agent executorConfig', true),
    }),
  });
}

function captureExecutorReference(input: unknown): AgentExecutorTaskReference {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('External agent executor reference must be a JSON-safe object.');
  }
  const captured = cloneJsonSafe(input, 'External agent executor reference', true);
  const record = captured as Readonly<Record<string, unknown>>;
  if (typeof record.idempotencyKey !== 'string' || record.idempotencyKey.length === 0) {
    throw new Error('External agent executor reference idempotencyKey must not be empty.');
  }
  if (record.remoteTaskId !== undefined
    && (typeof record.remoteTaskId !== 'string' || record.remoteTaskId.length === 0)) {
    throw new Error('External agent executor reference remoteTaskId must not be empty.');
  }
  if (record.metadata !== undefined
    && (record.metadata === null || typeof record.metadata !== 'object' || Array.isArray(record.metadata))) {
    throw new Error('External agent executor reference metadata must be a JSON-safe object.');
  }
  return captured as AgentExecutorTaskReference;
}

function assertRegistration(input: ExternalAgentRegistration): void {
  if (!input.agentId.startsWith('external:') || input.agentId.length <= 'external:'.length) {
    throw new Error('External agent registration agentId must use the external: namespace.');
  }
  for (const [label, value] of [
    ['displayName', input.displayName],
    ['executorId', input.executorId],
    ['configurationRevision', input.configurationRevision],
    ['endpointIdentityHash', input.endpointIdentityHash],
  ] as const) {
    if (value.trim().length === 0) throw new Error(`External agent ${label} must not be empty.`);
  }
  if (input.maxConcurrency !== undefined && (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency <= 0)) {
    throw new Error('External agent maxConcurrency must be a positive integer.');
  }
  if (input.minimumBudget !== undefined && (!Number.isFinite(input.minimumBudget) || input.minimumBudget < 0)) {
    throw new Error('External agent minimumBudget must be a non-negative number.');
  }
  if (input.managementOwner !== undefined && input.managementOwner.trim().length === 0) {
    throw new Error('External agent managementOwner must not be empty.');
  }
}

function registrationMutationMatches(
  current: ExternalAgentRegistration | undefined,
  options: AgentRegistrationMutationOptions | undefined,
): boolean {
  const expectedRevision = options?.expectedConfigurationRevision;
  const revisionMatches = expectedRevision === undefined
    || (expectedRevision === null
      ? current === undefined
      : current?.configurationRevision === expectedRevision);
  const expectedOwner = options?.expectedManagementOwner;
  const ownerMatches = expectedOwner === undefined
    || (current?.managementOwner ?? null) === expectedOwner;
  return revisionMatches && ownerMatches;
}

function taskRegistrationKey(agentId: string, configurationRevision: string): string {
  return JSON.stringify([agentId, configurationRevision]);
}

function executorCacheKey(registration: ExternalAgentRegistration): string {
  return JSON.stringify([
    registration.executorId,
    registration.agentId,
    registration.configurationRevision,
  ]);
}

function taskSnapshotKey(task: AgentTaskSnapshot): string {
  return taskRegistrationKey(task.registration.agentId, task.registration.configurationRevision);
}

function sameExecutionRegistration(
  left: ExternalAgentRegistration,
  right: ExternalAgentRegistration,
): boolean {
  const {
    enabled: _leftEnabled,
    managementOwner: _leftOwner,
    health: _leftHealth,
    ...leftRoute
  } = left;
  const {
    enabled: _rightEnabled,
    managementOwner: _rightOwner,
    health: _rightHealth,
    ...rightRoute
  } = right;
  return isDeepStrictEqual(
    normalizeComparableValue(leftRoute),
    normalizeComparableValue(rightRoute),
  );
}

function normalizeComparableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeComparableValue);
  if (value === null || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ))) {
    if (entry !== undefined) normalized[key] = normalizeComparableValue(entry);
  }
  return normalized;
}

function executionRegistrationFingerprint(registration: ExternalAgentRegistration): string {
  // V8 serialization can change with array representation/JIT optimization
  // even for identical content. Revisions identify the normalized JSON route.
  const serialized = JSON.stringify(normalizeComparableValue(taskRouteRegistration(registration)));
  return createHash('sha256').update(serialized).digest('hex');
}

function taskRouteRegistration(
  registration: ExternalAgentRegistration,
): ExternalAgentRegistration {
  const {
    enabled: _enabled,
    managementOwner: _managementOwner,
    health: _health,
    ...route
  } = registration;
  return { ...route, enabled: true };
}

function registrationMatchesLegacyTask(
  registration: ExternalAgentRegistration,
  task: AgentTaskSnapshot,
): boolean {
  const captured = task.registration;
  return task.agentId === captured.agentId
    && registration.agentId === captured.agentId
    && registration.configurationRevision === captured.configurationRevision
    && registration.executorId === captured.executorId
    && registration.protocol === captured.protocol
    && registration.endpointIdentityHash === captured.endpointIdentityHash
    && isDeepStrictEqual(registration.capabilities, captured.capabilities)
    && isDeepStrictEqual(registration.effects, captured.effects);
}

function buildFactoryMap(
  factories: readonly AgentExecutorFactory[],
): ReadonlyMap<string, AgentExecutorFactory> {
  const result = new Map<string, AgentExecutorFactory>();
  for (const factory of factories) {
    if (result.has(factory.executorId)) {
      throw new Error(`Duplicate external agent executor factory: ${factory.executorId}`);
    }
    result.set(factory.executorId, factory);
  }
  return result;
}

function capabilityMismatchReasons(
  capabilities: AgentCapabilityDeclaration,
  required: AgentCapabilityRequirements | undefined,
): string[] {
  if (!required) return [];
  const reasons: string[] = [];
  for (const key of CAPABILITY_KEYS) {
    if (required[key] === true && capabilities[key] !== 'supported') {
      reasons.push(`required capability ${key} is ${capabilities[key]}`);
    }
  }
  return reasons;
}

function descriptorMismatchReasons(
  descriptor: DispatchableAgentDescriptor,
  query: DispatchableAgentQuery,
): string[] {
  const reasons = capabilityMismatchReasons(descriptor.capabilities, query.requiredCapabilities);
  if (query.actorId.trim().length === 0) reasons.push('actor identity is required');
  if (query.budget !== undefined && (!Number.isFinite(query.budget) || query.budget < 0)) {
    reasons.push('dispatch budget is invalid');
  }
  const skills = new Set(descriptor.skills);
  for (const skill of query.requiredSkills ?? []) {
    if (!skills.has(skill)) reasons.push(`required skill is unavailable: ${skill}`);
  }
  if (query.readOnly === true && (descriptor.effects.remote === 'write' || descriptor.effects.remote === 'unknown')) {
    reasons.push(`read-only dispatch rejects remote effect ${descriptor.effects.remote}`);
  }
  if (descriptor.origin === 'external' && descriptor.effects.workspace === 'direct') {
    reasons.push('external workspace effects must be none or proposal');
  }
  return reasons;
}

function localEvaluation(
  descriptor: DispatchableAgentDescriptor,
  query: DispatchableAgentQuery,
  now: string,
): EvaluationResult {
  const reasons = descriptorMismatchReasons(descriptor, query);
  return {
    descriptor,
    dispatchability: {
      status: reasons.length === 0 ? 'dispatchable' : 'unavailable',
      checkedAt: now,
      reasons,
    },
  };
}

function registrationSnapshot(
  registration: ExternalAgentRegistration,
): AgentTaskSnapshot['registration'] {
  return {
    agentId: registration.agentId,
    origin: 'external',
    executorId: registration.executorId,
    protocol: registration.protocol,
    configurationRevision: registration.configurationRevision,
    endpointIdentityHash: registration.endpointIdentityHash,
    capabilities: registration.capabilities,
    effects: registration.effects,
  };
}

function taskMatches(task: AgentTaskSnapshot, filter: AgentTaskFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.agentId !== undefined && task.agentId !== filter.agentId) return false;
  if (filter.parentTaskId !== undefined && task.parentTaskId !== filter.parentTaskId) return false;
  if (filter.workflowId !== undefined && task.workflowId !== filter.workflowId) return false;
  if (filter.runId !== undefined && task.runId !== filter.runId) return false;
  if (filter.state !== undefined) {
    const states = Array.isArray(filter.state) ? filter.state : [filter.state];
    if (!states.includes(task.state)) return false;
  }
  return true;
}

function eventType(event: AgentExecutorEvent): AgentTaskEvent['type'] {
  if (event.error !== undefined) return 'error';
  if (event.output !== undefined) return 'output';
  if (event.artifacts !== undefined) return 'artifact';
  if (event.usage !== undefined) return 'usage';
  if (event.progress !== undefined) return 'progress';
  return 'state';
}

class AgentExecutorPlaneRuntime {
  readonly #registrations = new Map<string, ExternalAgentRegistration>();
  readonly #registrationRevisionHistory = new Map<string, string>();
  readonly #taskRegistrationSnapshots = new Map<string, ExternalAgentRegistration>();
  readonly #tasks = new Map<string, AgentTaskSnapshot>();
  readonly #durableTaskStates = new Map<string, AgentTaskSnapshot['state']>();
  readonly #eventSequences = new Map<string, number>();
  readonly #executors = new Map<string, AgentExecutor>();
  readonly #executorRegistrations = new Map<string, ExternalAgentRegistration>();
  readonly #executorCreations = new Map<string, Promise<AgentExecutor>>();
  readonly #pendingExecutorDisposals = new Set<AgentExecutor>();
  readonly #executorDisposalPromises = new Map<AgentExecutor, Promise<void>>();
  readonly #executorOperationCounts = new Map<AgentExecutor, number>();
  readonly #executorOperationTails = new Set<Promise<void>>();
  readonly #eventPumpTails = new Set<Promise<void>>();
  readonly #eventPumpTasks = new Set<string>();
  readonly #taskExecutors = new Map<string, AgentExecutor>();
  readonly #startControllers = new Map<string, AbortController>();
  readonly #waiters = new Map<string, Set<{
    readonly resolve: (task: AgentTaskSnapshot) => void;
    readonly reject: (error: Error) => void;
  }>>();
  readonly #startTails = new Map<string, Promise<void>>();
  readonly #taskAdmissionTails = new Map<string, Promise<void>>();
  readonly #taskMutationTails = new Map<string, Promise<void>>();
  readonly #taskCancellationPromises = new Map<string, Promise<AgentTaskSnapshot>>();
  readonly #runtimeOperationTails = new Set<Promise<void>>();
  #registrationMutationTail: Promise<void> = Promise.resolve();
  #snapshotMutationTail: Promise<void> = Promise.resolve();
  #taskRegistrationSnapshotsNeedRewrite = false;
  #closed = false;
  #cleanupPromise: Promise<void> | undefined;

  constructor(private readonly options: PlaneRuntimeOptions) {}

  async initialize(): Promise<void> {
    this.assertSnapshotStoreHooksPaired();
    for (const loaded of await this.options.store.loadRegistrations()) {
      const registration = captureRegistration(loaded);
      assertRegistration(registration);
      if (this.#registrations.has(registration.agentId)) {
        throw new Error(`Duplicate durable external agent registration ID: ${registration.agentId}.`);
      }
      this.rememberExecutionRevision(registration);
      this.#registrations.set(registration.agentId, clone(registration));
    }
    for (const loaded of await this.options.store.loadTaskRegistrationSnapshots?.() ?? []) {
      const registration = captureRegistration(loaded);
      assertRegistration(registration);
      const normalized = taskRouteRegistration(registration);
      if (!isDeepStrictEqual(normalized, loaded)) {
        this.#taskRegistrationSnapshotsNeedRewrite = true;
      }
      const key = taskRegistrationKey(normalized.agentId, normalized.configurationRevision);
      const current = this.#taskRegistrationSnapshots.get(key);
      if (current && !sameExecutionRegistration(current, normalized)) {
        throw new Error('Durable external agent registration snapshot key is not immutable.');
      }
      this.#taskRegistrationSnapshots.set(key, clone(normalized));
    }
    for (const task of await this.options.store.loadTasks()) {
      if (this.#tasks.has(task.taskId)) {
        throw new Error(`Duplicate durable agent task ID: ${task.taskId}.`);
      }
      this.#tasks.set(task.taskId, clone(task));
      this.#durableTaskStates.set(task.taskId, task.state);
      const events = await this.options.store.loadEvents(task.taskId);
      this.#eventSequences.set(task.taskId, events.at(-1)?.seq ?? 0);
    }
    await this.reconcileTaskRegistrationSnapshots();
    await this.recoverNonTerminalTasks();
  }

  readonly registrations: AgentRegistrationService = {
    list: async () => {
      this.assertOpen();
      return [...this.#registrations.values()].map(summaryFromRegistration);
    },
    upsert: async (input, options) => {
      return this.withRuntimeOperation(() => this.upsertRegistration(input, options));
    },
    setEnabled: async (agentId, enabled, options) => {
      return this.withRuntimeOperation(
        () => this.setRegistrationEnabled(agentId, enabled, options),
      );
    },
    remove: async (agentId, options) => {
      return this.withRuntimeOperation(() => this.removeRegistration(agentId, options));
    },
  };

  readonly tasks: AgentTaskService = {
    start: async (input, signal) => {
      return this.withRuntimeOperation(async () => {
        const captured = cloneJsonSafe(input, 'Agent task start input', true);
        return this.startTaskSerialized(captured, signal);
      });
    },
    list: async (filter) => { this.assertOpen(); return this.listTasks(filter); },
    get: async (taskId) => { this.assertOpen(); return this.getTask(taskId); },
    events: async (taskId, cursor) => { this.assertOpen(); return this.listEvents(taskId, cursor); },
    wait: async (taskId, timeoutMs) => { this.assertOpen(); return this.waitTask(taskId, timeoutMs); },
    sendInput: async (taskId, input) => this.withRuntimeOperation(
      () => this.sendTaskInput(taskId, input),
    ),
    cancel: async (taskId, reason) => this.withRuntimeOperation(
      () => this.cancelTask(taskId, reason),
    ),
    reconcile: async (taskId) => this.withRuntimeOperation(() => this.reconcileTask(taskId)),
    recordLocal: async (input) => this.withRuntimeOperation(() => this.recordLocalTask(input)),
    updateLocal: async (taskId, update) => this.withRuntimeOperation(
      () => this.updateLocalTask(taskId, update),
    ),
  };

  async upsertRegistration(
    input: ExternalAgentRegistration,
    options?: AgentRegistrationMutationOptions,
  ): Promise<ExternalAgentRegistrationSummary> {
    const candidate = captureRegistration(input);
    const mutationOptions = options ? clone(options) : undefined;
    assertRegistration(candidate);
    const factory = this.options.factories.get(candidate.executorId);
    if (factory && factory.protocol !== candidate.protocol) {
      throw new Error(`Executor ${candidate.executorId} uses ${factory.protocol}, not ${candidate.protocol}.`);
    }
    const summary = await this.withRegistrationMutation(async () => {
      const current = this.#registrations.get(candidate.agentId);
      if (!registrationMutationMatches(current, mutationOptions)) {
        throw new ExternalAgentRegistrationConflictError(candidate.agentId);
      }
      if (current?.configurationRevision === candidate.configurationRevision
        && !sameExecutionRegistration(current, candidate)) {
        throw new Error('External agent configuration revision was reused for different execution content.');
      }
      this.assertExecutionRevisionAvailable(candidate);
      await this.assertTaskRegistrationSnapshotCompatible(candidate);
      const next = new Map(this.#registrations);
      next.set(candidate.agentId, clone(candidate));
      await this.persistRegistrations(next);
      this.#registrations.set(candidate.agentId, clone(candidate));
      this.rememberExecutionRevision(candidate);
      return summaryFromRegistration(candidate);
    });
    await this.disposeUnusedExecutors();
    return summary;
  }

  private async startTaskSerialized(
    input: AgentTaskStartInput,
    signal?: AbortSignal,
  ): Promise<AgentTaskSnapshot> {
    const previous = this.#startTails.get(input.agentId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#startTails.set(input.agentId, tail);
    let predecessorSettled = false;
    const releaseQueue = async (): Promise<void> => {
      release?.();
      if (this.#startTails.get(input.agentId) === tail) this.#startTails.delete(input.agentId);
      await this.disposeUnusedExecutors();
    };
    try {
      await waitForExternalStartStep(previous, signal);
      predecessorSettled = true;
      this.assertOpen();
      return await this.startTask(input, signal);
    } finally {
      if (predecessorSettled) {
        await releaseQueue();
      } else {
        void previous.then(releaseQueue).catch((error: unknown) => {
          this.reportBackgroundError(error, { operation: 'executor-dispose' });
        });
      }
    }
  }

  async removeRegistration(
    agentId: string,
    options?: AgentRegistrationMutationOptions,
  ): Promise<boolean> {
    const mutationOptions = options ? clone(options) : undefined;
    const removed = await this.withRegistrationMutation(async () => {
      const current = this.#registrations.get(agentId);
      if (!current || !registrationMutationMatches(current, mutationOptions)) return false;
      const next = new Map(this.#registrations);
      next.delete(agentId);
      await this.persistRegistrations(next);
      this.#registrations.delete(agentId);
      return true;
    });
    if (removed) await this.disposeUnusedExecutors();
    return removed;
  }

  async setRegistrationEnabled(
    agentId: string,
    enabled: boolean,
    options?: AgentRegistrationEnabledMutationOptions,
  ): Promise<ExternalAgentRegistrationSummary | undefined> {
    const mutationOptions = options ? clone(options) : undefined;
    return this.withRegistrationMutation(async () => {
      const current = this.#registrations.get(agentId);
      if (!current || !registrationMutationMatches(current, mutationOptions)) return undefined;
      const claimOwner = mutationOptions?.claimOwner;
      if (claimOwner !== undefined && claimOwner.trim().length === 0) {
        throw new Error('External agent claimOwner must not be empty.');
      }
      if (claimOwner !== undefined && current.managementOwner !== undefined
        && current.managementOwner !== claimOwner) {
        throw new Error(
          `External agent registration is owned by ${current.managementOwner}: ${agentId}.`,
        );
      }
      if (current.enabled === enabled
        && (claimOwner === undefined || current.managementOwner === claimOwner)) {
        return summaryFromRegistration(current);
      }
      const registration = {
        ...current,
        enabled,
        ...(claimOwner ? { managementOwner: claimOwner } : {}),
      };
      const next = new Map(this.#registrations);
      next.set(agentId, registration);
      await this.persistRegistrations(next);
      this.#registrations.set(agentId, registration);
      return summaryFromRegistration(registration);
    });
  }

  async listDispatchable(
    query: DispatchableAgentQuery,
    localAgents: readonly DispatchableAgentDescriptor[] = [],
  ): Promise<readonly DispatchableAgentListing[]> {
    this.assertOpen();
    const local = localAgents.map((descriptor) => localEvaluation(descriptor, query, this.nowIso()));
    const external = await Promise.all(
      [...this.#registrations.values()].map((registration) => this.evaluateRegistration(registration, query)),
    );
    return [...local, ...external]
      .filter((entry) => entry.dispatchability.status === 'dispatchable' || entry.dispatchability.status === 'degraded')
      .sort((left, right) => left.descriptor.agentId.localeCompare(right.descriptor.agentId))
      .map(clone);
  }

  async describe(
    agentId: string,
    query: DispatchableAgentQuery,
    localAgents: readonly DispatchableAgentDescriptor[] = [],
  ): Promise<DispatchableAgentListing | undefined> {
    this.assertOpen();
    const local = localAgents.find((descriptor) => descriptor.agentId === agentId);
    if (local) return clone(localEvaluation(local, query, this.nowIso()));
    const registration = this.#registrations.get(agentId);
    if (!registration) return undefined;
    return clone(await this.evaluateRegistration(registration, query));
  }

  async preflight(
    input: AgentPreflightInput,
    localAgents: readonly DispatchableAgentDescriptor[] = [],
  ): Promise<AgentPreflightResult> {
    this.assertOpen();
    const listing = await this.describe(input.agentId, input.query, localAgents);
    const reasons = listing ? [...listing.dispatchability.reasons] : ['agent is not registered'];
    if (
      listing
      && input.expectedConfigurationRevision !== undefined
      && listing.descriptor.configurationRevision !== input.expectedConfigurationRevision
    ) {
      reasons.push('configuration revision changed');
    }
    return {
      ok: listing !== undefined && reasons.length === 0,
      ...(listing ? { descriptor: listing.descriptor } : {}),
      dispatchability: listing?.dispatchability ?? {
        status: 'unavailable',
        checkedAt: this.nowIso(),
        reasons,
      },
      reasons,
    };
  }

  close(): Promise<void> {
    if (!this.#cleanupPromise) {
      const cleanup = this.closeRuntime();
      this.#cleanupPromise = cleanup;
      void cleanup.catch(() => {
        if (this.#cleanupPromise === cleanup) this.#cleanupPromise = undefined;
      });
    }
    return this.closeWithinDeadline(this.#cleanupPromise);
  }

  private async closeWithinDeadline(cleanup: Promise<void>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(
          `Agent executor plane close timed out after ${this.options.closeTimeoutMs} ms.`,
        ));
      }, this.options.closeTimeoutMs);
    });
    try {
      await Promise.race([cleanup, timedOut]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async closeRuntime(): Promise<void> {
    this.#closed = true;
    const closeError = new Error('Agent executor plane is closed.');
    for (const controller of this.#startControllers.values()) {
      controller.abort(closeError);
    }
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) waiter.reject(closeError);
    }
    this.#waiters.clear();
    await Promise.all([...this.#runtimeOperationTails]);
    await Promise.all([...this.#startTails.values()]);
    await Promise.allSettled([...this.#executorCreations.values()]);
    await Promise.all([...this.#executorOperationTails]);
    const executors = [...new Set([
      ...this.#executors.values(),
      ...this.#pendingExecutorDisposals,
      ...this.#taskExecutors.values(),
    ])];
    const registrations = new Map<AgentExecutor, ExternalAgentRegistration>();
    for (const [key, executor] of this.#executors) {
      const registration = this.#executorRegistrations.get(key);
      if (registration && !registrations.has(executor)) registrations.set(executor, registration);
    }
    this.#executors.clear();
    this.#executorRegistrations.clear();
    this.#taskExecutors.clear();
    await Promise.all(executors.map((executor) => {
      const registration = registrations.get(executor);
      return this.disposeExecutor(executor, {
        operation: 'executor-dispose',
        ...(registration ? {
          agentId: registration.agentId,
          configurationRevision: registration.configurationRevision,
        } : {}),
      });
    }));
    const retryable = [...this.#pendingExecutorDisposals];
    await Promise.all(retryable.map((executor) => this.disposeExecutor(executor, {
      operation: 'executor-dispose',
    })));
    if (this.#pendingExecutorDisposals.size > 0) {
      throw new Error(
        `${this.#pendingExecutorDisposals.size} external agent executor(s) could not be disposed.`,
      );
    }
    await Promise.all([...this.#eventPumpTails]);
  }

  private async evaluateRegistration(
    registration: ExternalAgentRegistration,
    query: DispatchableAgentQuery,
  ): Promise<EvaluationResult> {
    const reasons = descriptorMismatchReasons(descriptorFromRegistration(registration), query);
    if (!registration.enabled) reasons.push('registration is disabled');
    if (!this.options.factories.has(registration.executorId)) reasons.push('executor is unavailable');
    await this.appendCredentialReason(registration, reasons);
    this.appendHealthReasons(registration, reasons);
    this.appendResourceReasons(registration, query, reasons);
    await this.appendPolicyReasons(registration, query, reasons);
    const degraded = registration.health?.status === 'degraded';
    return {
      descriptor: descriptorFromRegistration(registration),
      dispatchability: {
        status: reasons.length > 0 ? 'unavailable' : degraded ? 'degraded' : 'dispatchable',
        checkedAt: this.nowIso(),
        reasons,
        ...(registration.health?.retryAfterMs !== undefined
          ? { retryAfterMs: registration.health.retryAfterMs }
          : {}),
      },
    };
  }

  private async appendCredentialReason(
    registration: ExternalAgentRegistration,
    reasons: string[],
  ): Promise<void> {
    const ref = registration.credentialRef;
    if (!ref) return;
    if (!this.options.credentialBroker) {
      reasons.push('credential broker is unavailable');
      return;
    }
    try {
      const available = await this.options.credentialBroker.isAvailable?.(ref);
      if (available === false) reasons.push('credential is unavailable');
    } catch {
      reasons.push('credential availability check failed');
    }
  }

  private appendHealthReasons(
    registration: ExternalAgentRegistration,
    reasons: string[],
  ): void {
    if (registration.health?.status === 'unhealthy') reasons.push('agent is unhealthy');
  }

  private appendResourceReasons(
    registration: ExternalAgentRegistration,
    query: DispatchableAgentQuery,
    reasons: string[],
  ): void {
    const active = [...this.#tasks.values()].filter(
      (task) => task.agentId === registration.agentId && !isTerminal(task.state),
    ).length;
    if (registration.maxConcurrency !== undefined && active >= registration.maxConcurrency) {
      reasons.push('agent concurrency limit reached');
    }
    if (registration.minimumBudget !== undefined && (query.budget ?? -1) < registration.minimumBudget) {
      reasons.push('dispatch budget is insufficient');
    }
    const allowed = registration.allowedDataClassifications;
    for (const classification of query.dataClassifications ?? []) {
      if (allowed !== undefined && !allowed.includes(classification)) {
        reasons.push(`data classification is not allowed: ${classification}`);
      }
    }
  }

  private async appendPolicyReasons(
    registration: ExternalAgentRegistration,
    query: DispatchableAgentQuery,
    reasons: string[],
  ): Promise<void> {
    try {
      const decision = await this.options.policy({ registration: clone(registration), query: clone(query) });
      if (!decision.allowed) reasons.push(...(decision.reasons ?? ['policy denied dispatch']));
    } catch {
      reasons.push('dispatch policy is unavailable');
    }
  }

  private async startTask(
    input: AgentTaskStartInput,
    callerSignal?: AbortSignal,
  ): Promise<AgentTaskSnapshot> {
    const query = this.queryFromTask(input);
    const preflight = await waitForExternalStartStep(this.preflight({
      agentId: input.agentId,
      query,
      ...(input.expectedConfigurationRevision
        ? { expectedConfigurationRevision: input.expectedConfigurationRevision }
        : {}),
    }), callerSignal);
    if (!preflight.ok) throw new Error(`Agent preflight failed: ${preflight.reasons.join('; ')}`);
    throwIfExternalStartAborted(callerSignal);
    const registration = this.requireRegistration(input.agentId);
    if (!registration.enabled) throw new Error('Agent registration was disabled during preflight.');
    if (preflight.descriptor?.configurationRevision !== registration.configurationRevision) {
      throw new Error('Agent configuration revision changed during preflight.');
    }
    const executor = await waitForExternalStartStep(
      this.executorForRegistration(registration),
      callerSignal,
    );
    throwIfExternalStartAborted(callerSignal);
    const taskId = input.taskId ?? this.options.createTaskId();
    if (this.#tasks.has(taskId)) throw new Error(`Agent task already exists: ${taskId}`);
    const enriched = { ...input, taskId, idempotencyKey: input.idempotencyKey ?? this.options.createIdempotencyKey() };
    await waitForExternalStartStep(
      this.assertExecutorPreflight(executor, enriched),
      callerSignal,
    );
    throwIfExternalStartAborted(callerSignal);
    const controller = new AbortController();
    const forwardCallerAbort = (): void => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
    if (callerSignal?.aborted) forwardCallerAbort();
    try {
      const task = await this.withTaskAdmission(taskId, async () => {
        // The serialized block is the admission linearization point. It freezes
        // and persists the route before the task, so a later disable affects only
        // new admissions and cannot rewrite already-admitted work.
        const task = await this.admitExternalTask(enriched, registration);
        if (task.state !== 'submitted') return task;
        if (this.#closed) return this.failAdmittedTaskOnClose(task);
        this.#taskExecutors.set(taskId, executor);
        this.#startControllers.set(taskId, controller);
        return task;
      });
      if (task.state !== 'submitted') return task;
      if (this.#startControllers.get(taskId) !== controller) {
        return this.failAdmittedTaskOnClose(task);
      }
      if (controller.signal.aborted) {
        return this.cancelAdmittedBeforeExternalStart(task, controller.signal.reason);
      }
      return await this.invokeExternalStart(task, enriched, executor, controller.signal);
    } finally {
      callerSignal?.removeEventListener('abort', forwardCallerAbort);
      if (this.#startControllers.get(taskId) === controller) {
        this.#startControllers.delete(taskId);
      }
    }
  }

  private async withTaskAdmission<T>(taskId: string, admit: () => Promise<T>): Promise<T> {
    if (this.#taskAdmissionTails.has(taskId)) throw new Error(`Agent task already exists: ${taskId}`);
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#taskAdmissionTails.set(taskId, tail);
    try {
      return await admit();
    } finally {
      release?.();
      if (this.#taskAdmissionTails.get(taskId) === tail) this.#taskAdmissionTails.delete(taskId);
    }
  }

  private async awaitTaskAdmission(taskId: string): Promise<void> {
    await this.#taskAdmissionTails.get(taskId);
    this.assertOpen();
  }

  private queryFromTask(input: AgentTaskStartInput): DispatchableAgentQuery {
    return {
      ...input.context,
      ...(input.requiredSkills ? { requiredSkills: input.requiredSkills } : {}),
      ...(input.requiredCapabilities ? { requiredCapabilities: input.requiredCapabilities } : {}),
      ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
    };
  }

  private async assertExecutorPreflight(
    executor: AgentExecutor,
    input: AgentTaskStartInput,
  ): Promise<void> {
    const result = await executor.preflight?.(clone(input));
    if (result && !result.ok) {
      throw new Error(`Executor preflight failed: ${(result.reasons ?? ['rejected']).join('; ')}`);
    }
  }

  private createSubmittedTask(
    input: AgentTaskStartInput & { readonly taskId: string; readonly idempotencyKey: string },
    registration: ExternalAgentRegistration,
  ): AgentTaskSnapshot {
    const now = this.nowIso();
    return {
      taskId: input.taskId,
      route: 'external',
      agentId: input.agentId,
      objective: input.objective,
      state: 'submitted',
      cancellation: 'none',
      registration: registrationSnapshot(registration),
      idempotencyKey: input.idempotencyKey,
      dispatchAttempt: 1,
      createdAt: now,
      updatedAt: now,
      ...(input.context.parentTaskId ? { parentTaskId: input.context.parentTaskId } : {}),
      ...(input.context.workflowId ? { workflowId: input.context.workflowId } : {}),
      ...(input.context.runId ? { runId: input.context.runId } : {}),
      ...(input.context.nodeId ? { nodeId: input.context.nodeId } : {}),
    };
  }

  private async invokeExternalStart(
    task: AgentTaskSnapshot,
    input: AgentTaskStartInput,
    executor: AgentExecutor,
    signal: AbortSignal,
  ): Promise<AgentTaskSnapshot> {
    let reference: AgentExecutorTaskReference;
    try {
      const returnedReference = await executor.start(clone(input), signal);
      try {
        reference = captureExecutorReference(returnedReference);
      } catch (error: unknown) {
        throw new AgentStartUncertainError(
          `Executor returned an invalid reference after remote start: ${errorMessage(error)}`,
        );
      }
    } catch (error: unknown) {
      const current = this.#tasks.get(task.taskId);
      const abortedDuringStart = signal.aborted;
      const state: AgentTaskSnapshot['state'] = abortedDuringStart
        ? 'unknown'
        : error instanceof AgentStartUncertainError
        ? 'unknown'
        : 'failed';
      const message = errorMessage(error);
      const failed: AgentTaskSnapshot = {
        ...(current ?? task),
        state,
        error: message,
        ...(abortedDuringStart
          ? {
              cancellation: 'unknown' as const,
              cancellationError: message,
            }
          : {}),
        updatedAt: this.nowIso(),
      };
      await this.saveTask(
        failed,
        abortedDuringStart ? 'cancellation' : 'error',
        { error: message },
      );
      return clone(failed);
    }

    let accepted: AgentTaskSnapshot = {
      ...(this.#tasks.get(task.taskId) ?? task),
      state: 'working',
      executorReference: reference,
      ...(reference.remoteTaskId ? { remoteTaskId: reference.remoteTaskId } : {}),
      updatedAt: this.nowIso(),
    };
    try {
      accepted = await this.mutateTask(task.taskId, 'state', (current) => (
        isTerminal(current.state)
          ? undefined
          : {
              ...current,
              state: 'working' as const,
              executorReference: reference,
              ...(reference.remoteTaskId ? { remoteTaskId: reference.remoteTaskId } : {}),
              updatedAt: this.nowIso(),
            }
      ));
      if (isTerminal(accepted.state)) return accepted;
      if (signal.aborted || accepted.cancellation === 'requested') {
        return this.cancelTask(
          accepted.taskId,
          typeof signal.reason === 'string' ? signal.reason : undefined,
        );
      }
      const remote = await executor.get(reference).catch(() => ({ state: 'working' as const }));
      const started = await this.mutateTask(task.taskId, 'state', (current) => (
        isTerminal(current.state) ? undefined : this.applyRemoteSnapshot(current, remote)
      ));
      if (!isTerminal(started.state)) {
        this.startEventPump(started.taskId, executor, reference);
      }
      return clone(started);
    } catch (error: unknown) {
      const persisted = this.#tasks.get(accepted.taskId);
      if (persisted && isTerminal(persisted.state)) throw error;
      return this.recoverAcceptedStart(accepted, reference, error);
    }
  }

  private async cancelAdmittedBeforeExternalStart(
    task: AgentTaskSnapshot,
    reason: unknown,
  ): Promise<AgentTaskSnapshot> {
    const message = errorMessage(reason ?? 'External Agent start was interrupted.');
    return this.mutateTask(task.taskId, 'cancellation', (current) => (
      isTerminal(current.state)
        ? undefined
        : {
            ...current,
            state: 'canceled' as const,
            cancellation: 'confirmed' as const,
            cancellationError: message,
            updatedAt: this.nowIso(),
          }
    ));
  }

  private async admitExternalTask(
    input: AgentTaskStartInput & { readonly taskId: string; readonly idempotencyKey: string },
    capturedRegistration: ExternalAgentRegistration,
  ): Promise<AgentTaskSnapshot> {
    return this.withRegistrationMutation(async () => this.withSnapshotMutation(async () => {
      if (this.#tasks.has(input.taskId)) {
        throw new Error(`Agent task already exists: ${input.taskId}`);
      }
      const registration = this.requireRegistration(input.agentId);
      if (!registration.enabled) {
        throw new Error('Agent registration was disabled during executor preflight.');
      }
      if (registration.health?.status === 'unhealthy') {
        throw new Error('Agent registration became unhealthy during executor preflight.');
      }
      if (registration.configurationRevision !== capturedRegistration.configurationRevision
        || !sameExecutionRegistration(registration, capturedRegistration)) {
        throw new Error('Agent configuration revision changed during executor preflight.');
      }
      await this.retainTaskRegistrationSnapshotLocked(capturedRegistration);
      const task = this.createSubmittedTask(input, capturedRegistration);
      try {
        await this.saveTask(task, 'submitted');
        return task;
      } catch (error: unknown) {
        if (!this.#tasks.has(task.taskId)) throw error;
        return this.failSubmittedTaskAfterEventFailure(task, error);
      }
    }));
  }

  /** Caller holds both registration and snapshot mutation tails. */
  private async failSubmittedTaskAfterEventFailure(
    task: AgentTaskSnapshot,
    eventError: unknown,
  ): Promise<AgentTaskSnapshot> {
    const message = `Task admission event persistence failed before remote start: ${errorMessage(eventError)}`;
    const failed: AgentTaskSnapshot = {
      ...task,
      state: 'failed',
      error: message,
      updatedAt: this.nowIso(),
    };
    try {
      await this.options.store.saveTask(failed);
    } catch (snapshotError: unknown) {
      const failure = Object.assign(new AggregateError(
        [eventError, snapshotError],
        `External agent task admission could not be finalized: ${task.taskId}.`,
      ), {
        code: 'external_agent_task_admission_incomplete' as const,
        taskId: task.taskId,
      });
      this.reportBackgroundError(failure, {
        operation: 'task-admission-event',
        taskId: task.taskId,
        agentId: task.agentId,
        configurationRevision: task.registration.configurationRevision,
      });
      throw failure;
    }
    this.#tasks.set(task.taskId, clone(failed));
    this.#durableTaskStates.set(task.taskId, failed.state);
    this.resolveWaiters(failed);
    const reportedErrors: unknown[] = [eventError];
    try {
      await this.releaseTaskRegistrationSnapshotLocked(failed);
    } catch (cleanupError: unknown) {
      reportedErrors.push(cleanupError);
    }
    this.reportBackgroundError(
      reportedErrors.length === 1
        ? eventError
        : new AggregateError(reportedErrors, 'Task admission failure cleanup also failed.'),
      {
        operation: 'task-admission-event',
        taskId: task.taskId,
        agentId: task.agentId,
        configurationRevision: task.registration.configurationRevision,
      },
    );
    await this.disposeUnusedExecutors();
    return clone(failed);
  }

  private async failAdmittedTaskOnClose(task: AgentTaskSnapshot): Promise<AgentTaskSnapshot> {
    const message = 'Agent executor plane closed before remote start.';
    const failed: AgentTaskSnapshot = {
      ...task,
      state: 'failed',
      error: message,
      updatedAt: this.nowIso(),
    };
    try {
      await this.saveTask(failed, 'error', { error: message });
    } catch (error: unknown) {
      const persisted = this.#tasks.get(task.taskId);
      if (!persisted || !isTerminal(persisted.state)) throw error;
      this.reportBackgroundError(error, {
        operation: 'task-admission-event',
        taskId: task.taskId,
        agentId: task.agentId,
        configurationRevision: task.registration.configurationRevision,
      });
      return clone(persisted);
    }
    return clone(failed);
  }

  private async recoverAcceptedStart(
    accepted: AgentTaskSnapshot,
    reference: AgentExecutorTaskReference,
    error: unknown,
  ): Promise<AgentTaskSnapshot> {
    const message = errorMessage(error);
    const latest = this.#tasks.get(accepted.taskId) ?? accepted;
    const unknown: AgentTaskSnapshot = {
      ...latest,
      state: 'unknown',
      executorReference: reference,
      ...(reference.remoteTaskId ? { remoteTaskId: reference.remoteTaskId } : {}),
      error: message,
      updatedAt: this.nowIso(),
    };
    try {
      await this.saveTask(unknown, 'error', { error: message });
      return clone(unknown);
    } catch (persistenceError: unknown) {
      const volatile = {
        ...unknown,
        error: `${message}; unable to persist recovery state: ${errorMessage(persistenceError)}`,
      };
      this.#tasks.set(accepted.taskId, clone(volatile));
      return clone(volatile);
    }
  }

  private startEventPump(
    taskId: string,
    executor: AgentExecutor,
    reference: NonNullable<AgentTaskSnapshot['executorReference']>,
  ): void {
    if (this.#eventPumpTasks.has(taskId)) return;
    this.#eventPumpTasks.add(taskId);
    void this.pumpEvents(taskId, executor, reference)
      .catch(async (error: unknown) => {
        if (this.#closed) return;
        const message = errorMessage(error);
        try {
          await this.mutateTask(taskId, 'error', (current) => (
            isTerminal(current.state)
              ? undefined
              : {
                  ...current,
                  state: 'unknown',
                  error: message,
                  updatedAt: this.nowIso(),
                }
          ), { error: message });
        } catch (recoveryError: unknown) {
          throw new AggregateError(
            [error, recoveryError],
            `External agent event pump failed: ${message}; recovery persistence also failed.`,
          );
        }
        const task = this.#tasks.get(taskId);
        this.reportBackgroundError(error, {
          operation: 'event-pump-recovery',
          taskId,
          ...(task ? {
            agentId: task.agentId,
            configurationRevision: task.registration.configurationRevision,
          } : {}),
        });
      })
      .catch((error: unknown) => {
        if (this.#closed) return;
        const task = this.#tasks.get(taskId);
        this.reportBackgroundError(error, {
          operation: 'event-pump-recovery',
          taskId,
          ...(task ? {
            agentId: task.agentId,
            configurationRevision: task.registration.configurationRevision,
          } : {}),
        });
      });
  }

  private async pumpEvents(
    taskId: string,
    executor: AgentExecutor,
    reference: NonNullable<AgentTaskSnapshot['executorReference']>,
  ): Promise<void> {
    await this.withExecutorOperation(executor, async () => {
      try {
        for await (const event of executor.events(reference)) {
          if (this.#closed) return;
          const next = await this.mutateTask(taskId, eventType(event), (current) => (
            isTerminal(current.state) ? undefined : this.applyExecutorEvent(current, event)
          ), event);
          if (isTerminal(next.state)) return;
        }
      } finally {
        // Mark the pump as consumed as soon as the event loop ends (executors such as
        // A2A legitimately close the stream on input-required) so a later sendInput
        // can restart it without waiting for executor-operation cleanup.
        this.#eventPumpTasks.delete(taskId);
      }
    }, 'event-pump');
  }

  private applyExecutorEvent(
    task: AgentTaskSnapshot,
    event: AgentExecutorEvent,
  ): AgentTaskSnapshot {
    return {
      ...task,
      ...(event.state ? { state: event.state } : {}),
      ...(event.progress ? { progress: event.progress } : {}),
      ...(event.output !== undefined ? { output: event.output } : {}),
      ...(event.error !== undefined ? { error: sanitizeText(event.error) } : {}),
      ...(event.artifacts ? { artifacts: this.withArtifactProvenance(task, event.artifacts) } : {}),
      ...(event.usage ? { usage: event.usage } : {}),
      updatedAt: this.nowIso(),
    };
  }

  private withArtifactProvenance(
    task: AgentTaskSnapshot,
    artifacts: readonly AgentArtifactReference[],
  ): readonly AgentArtifactReference[] {
    return artifacts.map((artifact) => ({
      ...artifact,
      producingAgentId: artifact.producingAgentId ?? task.agentId,
      ...(artifact.remoteTaskId ?? task.remoteTaskId
        ? { remoteTaskId: artifact.remoteTaskId ?? task.remoteTaskId }
        : {}),
    }));
  }

  private async listTasks(filter?: AgentTaskFilter): Promise<readonly AgentTaskSnapshot[]> {
    return [...this.#tasks.values()]
      .filter((task) => taskMatches(task, filter))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  private async getTask(taskId: string): Promise<AgentTaskSnapshot> {
    return clone(this.requireTask(taskId));
  }

  private async listEvents(taskId: string, cursor = 0): Promise<readonly AgentTaskEvent[]> {
    this.requireTask(taskId);
    return (await this.options.store.loadEvents(taskId))
      .filter((event) => event.seq > cursor)
      .map(clone);
  }

  private async waitTask(taskId: string, timeoutMs?: number): Promise<AgentTaskSnapshot> {
    const current = this.requireTask(taskId);
    if (isTerminal(current.state)) return clone(current);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error('Agent task wait timeoutMs must be positive.');
    }
    return new Promise<AgentTaskSnapshot>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = {
        resolve: (task: AgentTaskSnapshot): void => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(clone(task));
        },
        reject: (error: Error): void => {
          if (timer !== undefined) clearTimeout(timer);
          reject(error);
        },
      };
      const listeners = this.#waiters.get(taskId) ?? new Set<typeof waiter>();
      listeners.add(waiter);
      this.#waiters.set(taskId, listeners);
      if (timeoutMs === undefined) return;
      timer = setTimeout(() => {
        listeners.delete(waiter);
        if (listeners.size === 0) this.#waiters.delete(taskId);
        reject(new Error(`Agent task ${taskId} did not finish within ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  private async sendTaskInput(
    taskId: string,
    input: { readonly content: string },
  ): Promise<AgentTaskSnapshot> {
    await this.awaitTaskAdmission(taskId);
    const task = this.requireExternalTask(taskId);
    if (isTerminal(task.state)) throw new Error(`Agent task is already terminal: ${taskId}`);
    const { executor, reference } = await this.executorRoute(task);
    await this.withExecutorOperation(executor, () => executor.sendInput(reference, input));
    const updated = await this.mutateTask(taskId, 'state', (current) => (
      isTerminal(current.state)
        ? undefined
        : { ...current, state: 'working' as const, updatedAt: this.nowIso() }
    ));
    // Executors such as A2A end their event stream while the task waits for input, so
    // the original pump may be gone. Restart it (no-op while one is still consuming) to
    // keep advancing the lifecycle without a host-driven reconcile. This runs strictly
    // after the serialized state mutation so a concurrently draining pump has already
    // released its per-task marker.
    if (!isTerminal(updated.state)) this.startEventPump(taskId, executor, reference);
    return updated;
  }

  private cancelTask(taskId: string, reason?: string): Promise<AgentTaskSnapshot> {
    const pending = this.#taskCancellationPromises.get(taskId);
    if (pending) return pending;
    let shared: Promise<AgentTaskSnapshot>;
    shared = this.cancelTaskOnce(taskId, reason).finally(() => {
      if (this.#taskCancellationPromises.get(taskId) === shared) {
        this.#taskCancellationPromises.delete(taskId);
      }
    });
    this.#taskCancellationPromises.set(taskId, shared);
    return shared;
  }

  private async cancelTaskOnce(taskId: string, reason?: string): Promise<AgentTaskSnapshot> {
    await this.awaitTaskAdmission(taskId);
    const task = this.requireExternalTask(taskId);
    if (isTerminal(task.state)) return clone(task);
    if (task.registration.capabilities.cancellation === 'unsupported') {
      return this.mutateTask(taskId, 'cancellation', (current) => (
        isTerminal(current.state)
          ? undefined
          : { ...current, cancellation: 'unsupported' as const, updatedAt: this.nowIso() }
      ));
    }
    const requested = await this.mutateTask(taskId, 'cancellation', (current) => (
      isTerminal(current.state)
        ? undefined
        : { ...current, cancellation: 'requested' as const, updatedAt: this.nowIso() }
    ));
    if (isTerminal(requested.state)) return requested;
    const startController = this.#startControllers.get(taskId);
    if (startController && !requested.executorReference) {
      startController.abort(reason ?? `Agent task ${taskId} was canceled during start.`);
      return requested;
    }
    startController?.abort(reason ?? `Agent task ${taskId} was canceled during start.`);
    let remote: AgentExecutorTaskSnapshot;
    try {
      const { executor, reference } = await this.executorRoute(requested);
      remote = await this.withExecutorOperation(
        executor,
        () => executor.cancel(reference, reason),
      );
    } catch (error: unknown) {
      const message = errorMessage(error);
      return this.mutateTask(taskId, 'cancellation', (current) => (
        isTerminal(current.state)
          ? undefined
          : {
              ...current,
              cancellation: error instanceof AgentCancellationUncertainError
                ? 'unknown' as const
                : 'failed' as const,
              cancellationError: message,
              updatedAt: this.nowIso(),
            }
      ));
    }
    const cancellation: AgentTaskCancellation = remote.state === 'canceled'
      ? 'confirmed'
      : remote.state === 'unknown' ? 'unknown' : 'requested';
    return this.mutateTask(taskId, 'cancellation', (current) => (
      isTerminal(current.state)
        ? undefined
        : { ...this.applyRemoteSnapshot(current, remote), cancellation }
    ));
  }

  private async reconcileTask(taskId: string): Promise<AgentTaskSnapshot> {
    await this.awaitTaskAdmission(taskId);
    const task = this.requireExternalTask(taskId);
    if (isTerminal(task.state)) return clone(task);
    let remote: AgentExecutorTaskSnapshot;
    try {
      const { executor, reference } = await this.executorRoute(task);
      remote = await this.withExecutorOperation(executor, () => executor.reconcile(reference));
    } catch (error: unknown) {
      const message = errorMessage(error);
      return this.mutateTask(taskId, 'error', (current) => (
        isTerminal(current.state)
          ? undefined
          : { ...current, state: 'unknown' as const, error: message, updatedAt: this.nowIso() }
      ), { error: message });
    }
    return this.mutateTask(taskId, 'state', (current) => (
      isTerminal(current.state) ? undefined : this.applyRemoteSnapshot(current, remote)
    ));
  }

  private applyRemoteSnapshot(
    task: AgentTaskSnapshot,
    remote: AgentExecutorTaskSnapshot,
  ): AgentTaskSnapshot {
    return this.applyExecutorEvent(task, remote);
  }

  private async recordLocalTask(input: LocalAgentTaskInput): Promise<AgentTaskSnapshot> {
    return this.withRegistrationMutation(async () => {
      if (this.#tasks.has(input.taskId)) throw new Error(`Agent task already exists: ${input.taskId}`);
      const now = this.nowIso();
      const origin = input.origin ?? (input.agentId.startsWith('constructed:') ? 'constructed' : 'native');
      const task: AgentTaskSnapshot = {
        taskId: input.taskId,
        route: 'local',
        agentId: input.agentId,
        objective: input.objective,
        state: 'working',
        cancellation: 'none',
        registration: {
          agentId: input.agentId,
          origin,
          executorId: 'kodax-local-child',
          protocol: 'native',
          configurationRevision: input.configurationRevision,
          capabilities: LOCAL_CAPABILITIES,
          effects: { remote: 'none', workspace: 'proposal' },
        },
        idempotencyKey: `local:${input.taskId}`,
        dispatchAttempt: 1,
        createdAt: now,
        updatedAt: now,
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      };
      await this.saveTask(task, 'submitted');
      return clone(task);
    });
  }

  private async updateLocalTask(
    taskId: string,
    update: LocalAgentTaskUpdate,
  ): Promise<AgentTaskSnapshot> {
    const task = this.requireTask(taskId);
    if (task.route !== 'local') throw new Error(`Agent task is not local: ${taskId}`);
    return this.mutateTask(
      taskId,
      update.error ? 'error' : update.output ? 'output' : 'state',
      (current) => (
        isTerminal(current.state)
          ? undefined
          : {
              ...current,
              ...update,
              ...(update.error !== undefined ? { error: sanitizeText(update.error) } : {}),
              cancellation: update.state === 'canceled' ? 'confirmed' : current.cancellation,
              updatedAt: this.nowIso(),
            }
      ),
    );
  }

  private async mutateTask(
    taskId: string,
    type: AgentTaskEvent['type'],
    mutate: (current: AgentTaskSnapshot) => AgentTaskSnapshot | undefined,
    detail: AgentExecutorEvent = {},
  ): Promise<AgentTaskSnapshot> {
    const previous = this.#taskMutationTails.get(taskId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#taskMutationTails.set(taskId, tail);
    await previous;
    try {
      const current = this.requireTask(taskId);
      const next = mutate(current);
      if (!next) return clone(current);
      await this.saveTask(next, type, detail);
      return clone(next);
    } finally {
      release?.();
      if (this.#taskMutationTails.get(taskId) === tail) this.#taskMutationTails.delete(taskId);
    }
  }

  private async saveTask(
    task: AgentTaskSnapshot,
    type: AgentTaskEvent['type'],
    detail: AgentExecutorEvent = {},
  ): Promise<void> {
    const safeTask = clone(task);
    await this.options.store.saveTask(safeTask);
    this.#tasks.set(task.taskId, safeTask);
    this.#durableTaskStates.set(task.taskId, safeTask.state);
    const failures: unknown[] = [];
    try {
      await this.appendEvent(safeTask, type, detail);
    } catch (error: unknown) {
      failures.push(error);
    }
    if (isTerminal(safeTask.state)) {
      this.#taskExecutors.delete(task.taskId);
      this.resolveWaiters(safeTask);
      if (safeTask.route === 'external') {
        try {
          await this.releaseTaskRegistrationSnapshot(safeTask);
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      await this.disposeUnusedExecutors();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'External agent task persistence follow-up failed.');
    }
  }

  private async appendEvent(
    task: AgentTaskSnapshot,
    type: AgentTaskEvent['type'],
    detail: AgentExecutorEvent,
  ): Promise<void> {
    const seq = (this.#eventSequences.get(task.taskId) ?? 0) + 1;
    this.#eventSequences.set(task.taskId, seq);
    await this.options.store.appendEvent({
      taskId: task.taskId,
      seq,
      timestamp: this.nowIso(),
      type,
      state: task.state,
      cancellation: task.cancellation,
      ...(detail.progress ? { progress: detail.progress } : {}),
      ...(detail.output !== undefined ? { output: detail.output } : {}),
      ...(detail.error !== undefined ? { error: sanitizeText(detail.error) } : {}),
      ...(detail.artifacts ? { artifacts: this.withArtifactProvenance(task, detail.artifacts) } : {}),
      ...(detail.usage ? { usage: detail.usage } : {}),
    });
  }

  private resolveWaiters(task: AgentTaskSnapshot): void {
    const waiters = this.#waiters.get(task.taskId);
    if (!waiters) return;
    this.#waiters.delete(task.taskId);
    for (const waiter of waiters) waiter.resolve(task);
  }

  private async executorRoute(task: AgentTaskSnapshot): Promise<{
    readonly executor: AgentExecutor;
    readonly reference: NonNullable<AgentTaskSnapshot['executorReference']>;
  }> {
    const reference = task.executorReference ?? { idempotencyKey: task.idempotencyKey };
    const boundExecutor = this.#taskExecutors.get(task.taskId);
    if (boundExecutor) return { executor: boundExecutor, reference };
    const registration = this.#taskRegistrationSnapshots.get(taskSnapshotKey(task));
    if (!registration) {
      throw new Error('Captured executor revision is unavailable for this task.');
    }
    const executor = await this.executorForRegistration(registration);
    this.#taskExecutors.set(task.taskId, executor);
    return { executor, reference };
  }

  private async executorForRegistration(
    registration: ExternalAgentRegistration,
  ): Promise<AgentExecutor> {
    const key = executorCacheKey(registration);
    const cached = this.#executors.get(key);
    if (cached) return cached;
    const inFlight = this.#executorCreations.get(key);
    if (inFlight) return inFlight;
    const creation = this.createExecutorForRegistration(key, registration);
    this.#executorCreations.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.#executorCreations.get(key) === creation) this.#executorCreations.delete(key);
    }
  }

  private async createExecutorForRegistration(
    key: string,
    registration: ExternalAgentRegistration,
  ): Promise<AgentExecutor> {
    const factory = this.options.factories.get(registration.executorId);
    if (!factory) throw new Error(`External agent executor is unavailable: ${registration.executorId}`);
    const executor = await factory.create(clone(registration), this.factoryContext(registration));
    if (this.#closed) {
      await this.disposeExecutor(executor, {
        operation: 'executor-dispose',
        agentId: registration.agentId,
        configurationRevision: registration.configurationRevision,
      });
      throw new Error('Agent executor plane is closed.');
    }
    this.#executors.set(key, executor);
    this.#executorRegistrations.set(key, clone(registration));
    this.#pendingExecutorDisposals.delete(executor);
    return executor;
  }

  private withRuntimeOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#runtimeOperationTails.add(tail);
    const finish = (): void => {
      this.#runtimeOperationTails.delete(tail);
      release?.();
    };
    try {
      return operation().finally(finish);
    } catch (error: unknown) {
      finish();
      return Promise.reject(error);
    }
  }

  private async disposeUnusedExecutors(): Promise<void> {
    if (this.#closed || this.#executors.size === 0) return;
    const referenced = new Set(
      [...this.#registrations.values()].map(executorCacheKey),
    );
    for (const task of this.#tasks.values()) {
      const durableState = this.#durableTaskStates.get(task.taskId) ?? task.state;
      if (task.route !== 'external' || isTerminal(durableState)) continue;
      const registration = this.#taskRegistrationSnapshots.get(taskSnapshotKey(task));
      if (registration) referenced.add(executorCacheKey(registration));
    }
    const candidates = new Map<AgentExecutor, ExternalAgentRegistration>();
    for (const [key, executor] of this.#executors) {
      const registration = this.#executorRegistrations.get(key);
      if (!registration
        || referenced.has(key)
        || this.#startTails.has(registration.agentId)
        || this.#executorOperationCounts.has(executor)) continue;
      this.#executors.delete(key);
      this.#executorRegistrations.delete(key);
      if (!candidates.has(executor)) candidates.set(executor, registration);
    }
    const retained = new Set(this.#executors.values());
    const bound = new Set(this.#taskExecutors.values());
    for (const [executor, registration] of candidates) {
      if (retained.has(executor) || bound.has(executor)) continue;
      await this.disposeExecutor(executor, {
        operation: 'executor-dispose',
        agentId: registration.agentId,
        configurationRevision: registration.configurationRevision,
      });
    }
  }

  private async withExecutorOperation<T>(
    executor: AgentExecutor,
    operation: () => Promise<T>,
    lifecycle: 'request' | 'event-pump' = 'request',
  ): Promise<T> {
    this.assertOpen();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const tails = lifecycle === 'event-pump'
      ? this.#eventPumpTails
      : this.#executorOperationTails;
    tails.add(tail);
    this.#executorOperationCounts.set(
      executor,
      (this.#executorOperationCounts.get(executor) ?? 0) + 1,
    );
    try {
      return await operation();
    } finally {
      const remaining = (this.#executorOperationCounts.get(executor) ?? 1) - 1;
      if (remaining === 0) this.#executorOperationCounts.delete(executor);
      else this.#executorOperationCounts.set(executor, remaining);
      try {
        await this.disposeUnusedExecutors();
      } finally {
        tails.delete(tail);
        release?.();
      }
    }
  }

  private disposeExecutor(
    executor: AgentExecutor,
    context: AgentExecutorPlaneBackgroundErrorContext,
  ): Promise<void> {
    const inFlight = this.#executorDisposalPromises.get(executor);
    if (inFlight) return inFlight;
    this.#pendingExecutorDisposals.add(executor);
    const disposal = Promise.resolve()
      .then(() => executor.dispose())
      .then(() => {
        this.#pendingExecutorDisposals.delete(executor);
      })
      .catch((error: unknown) => {
        this.reportBackgroundError(error, context);
      })
      .finally(() => {
        if (this.#executorDisposalPromises.get(executor) === disposal) {
          this.#executorDisposalPromises.delete(executor);
        }
      });
    this.#executorDisposalPromises.set(executor, disposal);
    return disposal;
  }

  private reportBackgroundError(
    error: unknown,
    context: AgentExecutorPlaneBackgroundErrorContext,
  ): void {
    const normalized = normalizedBackgroundError(error);
    const reportHandlerFailure = (handlerError: unknown): void => {
      defaultBackgroundErrorHandler(new AggregateError(
        [normalized, normalizedBackgroundError(handlerError)],
        'External agent background error handler failed.',
      ), context);
    };
    try {
      const result = this.options.onBackgroundError(normalized, context);
      if (result !== undefined) void Promise.resolve(result).catch(reportHandlerFailure);
    } catch (handlerError: unknown) {
      reportHandlerFailure(handlerError);
    }
  }

  private factoryContext(registration: ExternalAgentRegistration): AgentExecutorFactoryContext {
    return {
      withCredential: async <T>(credentialRef: string, use: (credential: string) => Promise<T>) => {
        const broker = this.options.credentialBroker;
        if (!broker) throw new Error('Credential broker is unavailable.');
        return broker.withCredential(credentialRef, async (credential) => {
          try {
            return await use(credential);
          } catch (error: unknown) {
            throw new Error(errorMessage(error, [credential]));
          }
        });
      },
      authorizeArtifact: async (artifact) => {
        const decision = await this.options.artifactPolicy?.({
          registration: clone(registration),
          artifact: clone(artifact),
        });
        if (!decision?.allowed) {
          throw new Error(decision?.reason ?? 'Artifact materialization is not authorized by the host.');
        }
      },
    };
  }

  private async withRegistrationMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = this.#registrationMutationTail;
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#registrationMutationTail = tail;
    await previous;
    try {
      this.assertOpen();
      return await mutation();
    } finally {
      release?.();
      if (this.#registrationMutationTail === tail) this.#registrationMutationTail = Promise.resolve();
    }
  }

  private async withSnapshotMutation<T>(
    mutation: () => Promise<T>,
    allowClosed = false,
  ): Promise<T> {
    const previous = this.#snapshotMutationTail;
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#snapshotMutationTail = tail;
    await previous;
    try {
      if (!allowClosed) this.assertOpen();
      return await mutation();
    } finally {
      release?.();
      if (this.#snapshotMutationTail === tail) this.#snapshotMutationTail = Promise.resolve();
    }
  }

  private async assertTaskRegistrationSnapshotCompatible(
    registration: ExternalAgentRegistration,
  ): Promise<void> {
    await this.withSnapshotMutation(async () => {
      const current = this.#taskRegistrationSnapshots.get(taskRegistrationKey(
        registration.agentId,
        registration.configurationRevision,
      ));
      if (current && !sameExecutionRegistration(current, registration)) {
        throw new Error('External agent configuration revision was reused for different immutable content.');
      }
    });
  }

  /** Caller holds #snapshotMutationTail (and #registrationMutationTail). */
  private async retainTaskRegistrationSnapshotLocked(
    registration: ExternalAgentRegistration,
  ): Promise<void> {
    const normalized = taskRouteRegistration(registration);
    const key = taskRegistrationKey(normalized.agentId, normalized.configurationRevision);
    const current = this.#taskRegistrationSnapshots.get(key);
    if (current) {
      if (!sameExecutionRegistration(current, normalized)) {
        throw new Error('External agent configuration revision was reused for different immutable content.');
      }
      return;
    }
    const next = new Map(this.#taskRegistrationSnapshots);
    next.set(key, clone(normalized));
    await this.persistTaskRegistrationSnapshots(next);
    this.#taskRegistrationSnapshots.set(key, clone(normalized));
  }

  private async releaseTaskRegistrationSnapshot(task: AgentTaskSnapshot): Promise<void> {
    await this.withSnapshotMutation(
      () => this.releaseTaskRegistrationSnapshotLocked(task),
      true,
    );
  }

  /** Caller holds #snapshotMutationTail. */
  private async releaseTaskRegistrationSnapshotLocked(task: AgentTaskSnapshot): Promise<void> {
    const key = taskSnapshotKey(task);
    if (this.hasNonTerminalSnapshotReference(key)) return;
    const next = new Map(this.#taskRegistrationSnapshots);
    if (!next.delete(key)) return;
    await this.persistTaskRegistrationSnapshots(next);
    this.#taskRegistrationSnapshots.delete(key);
  }

  private hasNonTerminalSnapshotReference(key: string): boolean {
    return [...this.#tasks.values()].some((task) => {
      if (task.route !== 'external' || taskSnapshotKey(task) !== key) return false;
      const durableState = this.#durableTaskStates.get(task.taskId);
      return durableState === undefined || !isTerminal(durableState);
    });
  }

  private async persistTaskRegistrationSnapshots(
    registrations: ReadonlyMap<string, ExternalAgentRegistration>,
  ): Promise<void> {
    await this.options.store.saveTaskRegistrationSnapshots?.(
      [...registrations.values()].map(clone),
    );
  }

  private assertSnapshotStoreHooksPaired(): void {
    const hasLoad = this.options.store.loadTaskRegistrationSnapshots !== undefined;
    const hasSave = this.options.store.saveTaskRegistrationSnapshots !== undefined;
    if (hasLoad !== hasSave) {
      throw new Error('Agent executor plane store must implement both task registration snapshot hooks.');
    }
  }

  private assertExecutionRevisionAvailable(registration: ExternalAgentRegistration): void {
    const current = this.#registrationRevisionHistory.get(taskRegistrationKey(
      registration.agentId,
      registration.configurationRevision,
    ));
    if (current !== undefined && current !== executionRegistrationFingerprint(registration)) {
      throw new Error('External agent configuration revision was reused for different execution content.');
    }
  }

  private rememberExecutionRevision(registration: ExternalAgentRegistration): void {
    const key = taskRegistrationKey(registration.agentId, registration.configurationRevision);
    const fingerprint = executionRegistrationFingerprint(registration);
    const current = this.#registrationRevisionHistory.get(key);
    if (current !== undefined) {
      if (current !== fingerprint) {
        throw new Error('External agent configuration revision was reused for different execution content.');
      }
      return;
    }
    if (this.#registrationRevisionHistory.size >= REGISTRATION_REVISION_HISTORY_LIMIT) {
      const oldest = this.#registrationRevisionHistory.keys().next().value;
      if (oldest !== undefined) this.#registrationRevisionHistory.delete(oldest);
    }
    this.#registrationRevisionHistory.set(key, fingerprint);
  }

  private async persistRegistrations(
    registrations: ReadonlyMap<string, ExternalAgentRegistration>,
  ): Promise<void> {
    await this.options.store.saveRegistrations([...registrations.values()].map(clone));
  }

  private requireRegistration(agentId: string): ExternalAgentRegistration {
    const registration = this.#registrations.get(agentId);
    if (!registration) throw new Error(`External agent is not registered: ${agentId}`);
    return registration;
  }

  private requireTask(taskId: string): AgentTaskSnapshot {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error(`Agent task not found: ${taskId}`);
    return task;
  }

  private requireExternalTask(taskId: string): AgentTaskSnapshot {
    const task = this.requireTask(taskId);
    if (task.route !== 'external') throw new Error(`Agent task is not external: ${taskId}`);
    return task;
  }

  private nowIso(): string {
    return this.options.now().toISOString();
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error('Agent executor plane is closed.');
  }

  private async recoverNonTerminalTasks(): Promise<void> {
    for (const task of [...this.#tasks.values()]) {
      if (task.route !== 'external' || isTerminal(task.state)) continue;
      const registration = this.#taskRegistrationSnapshots.get(taskSnapshotKey(task));
      if (!registration) {
        await this.saveTask({ ...task, state: 'unknown', updatedAt: this.nowIso() }, 'state');
        continue;
      }
      await this.reconcileTask(task.taskId);
    }
  }

  private async reconcileTaskRegistrationSnapshots(): Promise<void> {
    await this.withSnapshotMutation(async () => {
      const next = new Map(this.#taskRegistrationSnapshots);
      const referenced = new Set<string>();
      const invalid = new Set<string>();
      for (const task of this.#tasks.values()) {
        if (task.route !== 'external' || isTerminal(task.state)) continue;
        const key = taskSnapshotKey(task);
        referenced.add(key);
        const stored = next.get(key);
        if (stored) {
          if (!registrationMatchesLegacyTask(stored, task)) invalid.add(key);
          continue;
        }
        const current = this.#registrations.get(task.agentId);
        if (current && registrationMatchesLegacyTask(current, task)) {
          next.set(key, taskRouteRegistration(current));
        }
      }
      for (const key of invalid) next.delete(key);
      for (const key of next.keys()) {
        if (!referenced.has(key)) next.delete(key);
      }
      for (const registration of next.values()) this.rememberExecutionRevision(registration);
      if (!this.#taskRegistrationSnapshotsNeedRewrite
        && isDeepStrictEqual([...next.entries()], [...this.#taskRegistrationSnapshots.entries()])) return;
      await this.persistTaskRegistrationSnapshots(next);
      this.#taskRegistrationSnapshotsNeedRewrite = false;
      this.#taskRegistrationSnapshots.clear();
      for (const [key, registration] of next) this.#taskRegistrationSnapshots.set(key, registration);
    });
  }
}

async function waitForExternalStartStep<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  throwIfExternalStartAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(externalStartAbortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function throwIfExternalStartAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw externalStartAbortError(signal);
}

function externalStartAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(errorMessage(signal.reason ?? 'External Agent start was interrupted.'));
}

function defaultTaskId(): string {
  return `agent-task-${randomUUID()}`;
}

function defaultIdempotencyKey(): string {
  return `agent-dispatch-${randomUUID()}`;
}

export async function createAgentExecutorPlane(
  options: CreateAgentExecutorPlaneOptions,
): Promise<AgentExecutorPlane> {
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) {
    throw new Error('Agent executor plane closeTimeoutMs must be a positive finite number.');
  }
  const runtime = new AgentExecutorPlaneRuntime({
    factories: buildFactoryMap(options.factories),
    policy: options.policy,
    credentialBroker: options.credentialBroker,
    artifactPolicy: options.artifactPolicy,
    onBackgroundError: options.onBackgroundError ?? defaultBackgroundErrorHandler,
    store: options.store ?? createMemoryAgentExecutorPlaneStore(),
    now: options.now ?? (() => new Date()),
    createTaskId: options.createTaskId ?? defaultTaskId,
    createIdempotencyKey: options.createIdempotencyKey ?? defaultIdempotencyKey,
    closeTimeoutMs,
  });
  await runtime.initialize();
  return {
    registrations: runtime.registrations,
    tasks: runtime.tasks,
    listDispatchable: (query, locals) => runtime.listDispatchable(query, locals),
    describe: (agentId, query, locals) => runtime.describe(agentId, query, locals),
    preflight: (input, locals) => runtime.preflight(input, locals),
    close: () => runtime.close(),
  };
}

export { createMemoryAgentExecutorPlaneStore } from './memory-store.js';
