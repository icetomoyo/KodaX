/**
 * FEATURE_217 (v0.7.49) — Workflow runtime: concurrency gate, agent cap,
 * budget accounting, event recording.
 *
 * The runtime is the orchestration engine. It wraps an injected
 * `WorkflowAgentBackend` with: a maxAgents lifetime cap, a maxConcurrency
 * in-flight gate (for spawnAgent / runAgent / parallel), token-budget accounting with
 * a hard stop before new spawns, abort handling, and an append-only event
 * log. It has zero `@kodax-ai/coding` dependency.
 */

import { createHash } from 'node:crypto';

import { resolveWorkflowMaxConcurrency } from '@kodax-ai/llm';

import type { WorkflowEvent, WorkflowEventType } from './events.js';
import { WorkflowEventRecorder } from './events.js';
import type {
  WorkflowApi,
  WorkflowArtifactRef,
  WorkflowBudget,
  WorkflowAgentBackend,
  WorkflowLimits,
  WorkflowLogEvent,
  WorkflowModule,
  WorkflowParallelOptions,
  WorkflowRunState,
  WorkflowRunStatus,
  WorkflowSpawnAgentInput,
  WorkflowSynthesizeInput,
  WorkflowSynthesis,
  WorkflowTaskHandle,
  WorkflowTaskResult,
  WorkflowTaskSummaryKind,
  WorkflowTaskSnapshot,
  WorkflowWaitOptions,
} from './types.js';

/** Resolve a saved/built-in workflow module by name for inline nested
 *  `wf.workflow(name, args)` (FEATURE_246 Part E). Injected by the host so the
 *  agent layer needs no coding/registry dependency. May be async (saved
 *  capsules load from disk). Returns undefined when no workflow has that name. */
export type WorkflowModuleResolver = (
  name: string,
) => Promise<WorkflowModule | undefined> | WorkflowModule | undefined;

/**
 * Content-addressed result cache for same-session resume (FEATURE_246 Part D,
 * ADR-048). Keyed by `<inputHash>#<occurrence>`; the value is the full
 * `WorkflowTaskResult`. Injected by the host (fs-backed, rooted at the run dir);
 * the agent layer stays fs-free. A seeded cache (prior run's results) makes a
 * re-run replay unchanged effects and run only what changed live.
 */
export interface WorkflowResultCache {
  get(key: string): WorkflowTaskResult | undefined;
  set(key: string, result: WorkflowTaskResult): void;
}

/** Stable key for a spawn input: SHA-256 over the canonicalized (sorted-key)
 *  input. Dependencies are captured because a dependent effect bakes the
 *  upstream result into its prompt. */
function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeForHash((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function hashSpawnInput(input: WorkflowSpawnAgentInput): string {
  const json = JSON.stringify(canonicalizeForHash(input));
  return createHash('sha256').update(json).digest('hex').slice(0, 24);
}

/** Thrown when the workflow's abort signal fires mid-run. */
export class WorkflowAbortError extends Error {
  constructor(message = 'Workflow aborted') {
    super(message);
    this.name = 'WorkflowAbortError';
  }
}

/** Thrown when a spawn would exceed the run's maxAgents lifetime cap. */
export class WorkflowLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowLimitError';
  }
}

/**
 * Upper bound on the number of items a single `wf.parallel` / `wf.pipeline` call
 * may take. Live concurrency is separately bounded by the resource scope and the
 * maxAgents lifetime cap; this guard only rejects an obviously-oversized array
 * up front with a clear message instead of letting it fail deep in the run.
 */
export const WORKFLOW_MAX_FANOUT_ITEMS = 4096;

function assertFanoutSize(method: string, count: number): void {
  if (count > WORKFLOW_MAX_FANOUT_ITEMS) {
    throw new WorkflowLimitError(
      `wf.${method} received ${count} items, exceeding the ${WORKFLOW_MAX_FANOUT_ITEMS}-item limit for a single call; split the work into smaller batches`,
    );
  }
}

/** Thrown when a new spawn would start after the token budget is exhausted. */
export class WorkflowBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowBudgetError';
  }
}

/** Thrown by wf.runAgent when the child reaches a non-completed status. */
export class WorkflowTaskFailedError extends Error {
  readonly taskId: string;
  readonly taskName: string;
  readonly taskStatus: WorkflowTaskResult['status'];

  constructor(result: WorkflowTaskResult) {
    const detail = result.finalText.trim();
    super(
      `workflow task ${result.name} (${result.taskId}) ${result.status}` +
        (detail ? `: ${boundedTaskEventSummary(detail)}` : ''),
    );
    this.name = 'WorkflowTaskFailedError';
    this.taskId = result.taskId;
    this.taskName = result.name;
    this.taskStatus = result.status;
  }
}

/**
 * Run-control errors that the lenient `parallel`/`pipeline` fault-isolation must
 * NOT swallow into a null item: they halt or tear down the whole run (abort) or
 * signal a structural cap/misconfiguration (agent/concurrency limit, token
 * budget). Only ordinary task failures become null (FEATURE_246 Part E).
 */
function isWorkflowRunControlError(error: unknown): boolean {
  return (
    error instanceof WorkflowAbortError ||
    error instanceof WorkflowLimitError ||
    error instanceof WorkflowBudgetError ||
    isAgentLimitReached(error)
  );
}

function isAgentLimitReached(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'agent_limit_reached';
}

const STOP_ACTIVE_TASK_TIMEOUT_MS = 250;
const CONCURRENCY_DEADLOCK_CHECK_MS = 50;
const MAX_TASK_EVENT_SUMMARY_CHARS = 4096;
type StopActiveTaskOutcome =
  | 'stopped'
  | 'timed-out'
  | { readonly error: string };

interface WorkflowResourceAcquireOptions {
  readonly deadlockCheckMs?: number;
  shouldRejectWait(): boolean;
  createRejection(): Error;
}

interface WorkflowPendingStep {
  resolve(): void;
  reject(error: Error): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedTaskEventSummary(text: string): string {
  return text.length > MAX_TASK_EVENT_SUMMARY_CHARS
    ? `${text.slice(0, MAX_TASK_EVENT_SUMMARY_CHARS).trimEnd()}...`
    : text;
}

function readPositiveLimit(
  limits: WorkflowLimits | undefined,
  key: keyof WorkflowLimits,
): number | undefined {
  const value = limits?.[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkflowLimitError(`workflow limit ${key} must be a positive integer`);
  }
  return value;
}

/**
 * tokenBudget accepts 0 / negative / non-finite as "unbounded" (undefined),
 * unlike the count limits (maxAgents/maxConcurrency) which require a positive
 * integer and throw otherwise. This lets an SDK host express "no token cap" with
 * an explicit 0 instead of relying on the field being absent (fragile across
 * launch paths). Matches the coding-layer clampTokenBudget.
 */
function readTokenBudgetLimit(limits: WorkflowLimits | undefined): number | undefined {
  const value = limits?.tokenBudget;
  if (value == null || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

/** Validate user-provided runtime limits for SDK consumers. */
export function normalizeWorkflowLimits(limits?: WorkflowLimits): WorkflowLimits {
  const maxAgents = readPositiveLimit(limits, 'maxAgents');
  const maxConcurrency = readPositiveLimit(limits, 'maxConcurrency');
  const tokenBudget = readTokenBudgetLimit(limits);
  return {
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
}

/** Protocol-local resource scope. It never admits work into the global scheduler. */
class WorkflowResourceScope {
  private available: number;
  private readonly waiters: WorkflowPendingStep[] = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(options?: WorkflowResourceAcquireOptions): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve, reject) => {
      const waiter: WorkflowPendingStep = {
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      };
      this.waiters.push(waiter);
      if (options?.deadlockCheckMs !== undefined) {
        timer = setTimeout(() => {
          if (!options.shouldRejectWait()) return;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter.reject(options.createRejection());
        }, options.deadlockCheckMs);
      }
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
    } else {
      this.available += 1;
    }
  }
}

/**
 * Run lazy thunks with a bounded number in flight, preserving result
 * order by index. Aborts launching new thunks once `signal` fires.
 */
async function runPool<T>(
  thunks: readonly (() => Promise<T>)[],
  concurrency: number,
  signal: AbortSignal | undefined,
): Promise<(T | null)[]> {
  const results: (T | null)[] = new Array(thunks.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw new WorkflowAbortError();
      const index = cursor;
      cursor += 1;
      if (index >= thunks.length) return;
      try {
        results[index] = await thunks[index]!();
      } catch (error) {
        // Fault isolation (FEATURE_246 Part E, harness parity): an ordinary
        // failed thunk becomes null so siblings continue and parallel() never
        // rejects. Run-control errors (abort / agent-cap / budget) still
        // propagate — they halt the whole run and must not be swallowed.
        if (isWorkflowRunControlError(error)) throw error;
        results[index] = null;
      }
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, thunks.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

/** Render a generic synthesis prompt from inputs + rubric. Domain-neutral. */
function buildSynthesisPrompt(input: WorkflowSynthesizeInput): string {
  const inputs = normalizeSynthesisInputs(input.inputs);
  const rubric = normalizeSynthesisRubric(input.rubric);
  const body = inputs
    .map(
      (item, i) =>
        `## Input ${i + 1}\n${typeof item === 'string' ? item : JSON.stringify(item, null, 2)}`,
    )
    .join('\n\n');
  return [
    'You are synthesizing the findings below into a single result.',
    '',
    `Rubric: ${rubric}`,
    '',
    body,
  ].join('\n');
}

function normalizeSynthesisRubric(rubric: unknown): string {
  if (typeof rubric === 'string' && rubric.trim().length > 0) return rubric;
  throw new TypeError('workflow synthesize rubric must be a non-empty string');
}

function normalizeSynthesisInputs(inputs: unknown): readonly unknown[] {
  if (Array.isArray(inputs)) return inputs;
  if (typeof inputs === 'string') return [inputs];
  if (typeof inputs === 'object' && inputs !== null) {
    return Object.entries(inputs).map(([name, value]) => ({ name, value }));
  }
  throw new TypeError('workflow synthesize inputs must be an array, string, or object');
}

export interface CreateWorkflowRuntimeOptions {
  readonly runId: string;
  readonly args?: unknown;
  readonly backend: WorkflowAgentBackend;
  readonly limits?: WorkflowLimits;
  readonly signal?: AbortSignal;
  /** Optional host/domain summarizer for the terminal workflow result. */
  readonly summarizeResult?: (result: unknown) => string | undefined;
  /** Sink for every run-graph event (durable writer / UI subscribe here). */
  readonly onEvent?: (event: WorkflowEvent) => void;
  /** Sink for free-text `wf.log(...)` progress lines. */
  readonly onLog?: (event: WorkflowLogEvent) => void;
  /** Resolver for one-level nested `wf.workflow(name, args)` (FEATURE_246 Part
   *  E). When omitted, `api.workflow` is not exposed. */
  readonly resolveWorkflowModule?: WorkflowModuleResolver;
  /** Content-addressed result cache for same-session resume (FEATURE_246 Part D,
   *  ADR-048). When provided, a successful `runAgent` whose input matches a
   *  cached entry returns the cached result instead of spawning. Seed it from a
   *  prior run's `results/` to resume. */
  readonly resultCache?: WorkflowResultCache;
}

export interface WorkflowRuntimeHandle {
  readonly api: WorkflowApi;
  getState(): WorkflowRunState;
}

interface InternalRuntime extends WorkflowRuntimeHandle {
  readonly recorder: WorkflowEventRecorder;
  setStatus(status: WorkflowRunStatus): void;
  stopActiveTasks(reason: string): Promise<readonly string[]>;
}

function buildRuntime(opts: CreateWorkflowRuntimeOptions): InternalRuntime {
  const recorder = new WorkflowEventRecorder(opts.onEvent);
  const limits = normalizeWorkflowLimits(opts.limits);
  const maxAgents = limits.maxAgents ?? Infinity;
  // Defence in depth: `clampWorkflowLimits` (coding layer) already resolves a
  // concrete cap, but any caller building a runtime with unset concurrency falls
  // back to the same resolved ceiling (default 8) rather than Infinity, so a
  // workflow can never fan out unbounded.
  const maxConcurrency = limits.maxConcurrency ?? resolveWorkflowMaxConcurrency();
  const tokenBudget = limits.tokenBudget ?? null;
  const concurrency = new WorkflowResourceScope(maxConcurrency);

  let totalSpawned = 0;
  let spentOutputTokens = 0;
  let status: WorkflowRunStatus = 'running';
  // FEATURE_246 Part D: per-inputHash call counter so two runAgent calls with
  // identical input map to distinct cache keys (<hash>#0, <hash>#1, ...).
  const occurrenceByHash = new Map<string, number>();
  const artifacts: WorkflowArtifactRef[] = [];
  const taskResults = new Map<string, WorkflowTaskResult>();
  const releaseByTask = new Map<string, () => void>();
  const taskNames = new Map<string, string>();
  const pendingTaskSummaries = new Map<string, string>();
  const activeTaskIds = new Set<string>();
  const terminalTaskIds = new Set<string>();
  let activeReleaseOperations = 0;
  let unsubscribeTaskSummaryUpdates: (() => void) | undefined;

  const closeTaskSummaryUpdates = (): void => {
    const unsubscribe = unsubscribeTaskSummaryUpdates;
    if (!unsubscribe) return;
    unsubscribeTaskSummaryUpdates = undefined;
    unsubscribe();
  };

  unsubscribeTaskSummaryUpdates = opts.backend.subscribeTaskSummaryUpdates?.((taskId, update) => {
    if (status !== 'running') return;
    const name = taskNames.get(taskId);
    const summary = update.summary
      ?? (update.summaryKind === 'digest-failed' ? pendingTaskSummaries.get(taskId) : undefined);
    recorder.emit('agent_summary_updated', {
      taskId,
      ...(name !== undefined ? { name } : {}),
      ...(summary !== undefined
        ? { summary: boundedTaskEventSummary(summary) }
        : {}),
      summaryKind: update.summaryKind,
      ...(update.usage !== undefined ? { usage: update.usage } : {}),
    });
    if (update.summaryKind === 'digest' || update.summaryKind === 'digest-failed') {
      pendingTaskSummaries.delete(taskId);
    }
  });

  const checkAbort = (): void => {
    if (opts.signal?.aborted) throw new WorkflowAbortError();
  };

  const checkBudget = (): void => {
    if (tokenBudget !== null && spentOutputTokens >= tokenBudget) {
      throw new WorkflowBudgetError(`tokenBudget cap (${tokenBudget}) exhausted`);
    }
  };

  const releaseTaskCapacity = (taskId: string): void => {
    const release = releaseByTask.get(taskId);
    if (!release) return;
    releaseByTask.delete(taskId);
    activeTaskIds.delete(taskId);
    release();
  };

  const checkAgentCap = (): void => {
    if (totalSpawned >= maxAgents) {
      throw new WorkflowLimitError(`maxAgents lifetime cap (${maxAgents}) reached`);
    }
  };

  const blockedByUnreleasedTasks = (): boolean =>
    Number.isFinite(maxConcurrency) &&
    activeTaskIds.size >= maxConcurrency &&
    activeReleaseOperations === 0;

  const doSpawn = async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle> => {
    checkAbort();
    checkBudget();
    checkAgentCap();
    await concurrency.acquire({
      deadlockCheckMs: Number.isFinite(maxConcurrency)
        ? CONCURRENCY_DEADLOCK_CHECK_MS
        : undefined,
      shouldRejectWait: blockedByUnreleasedTasks,
      createRejection: () =>
        new WorkflowLimitError(
          `maxConcurrency cap (${maxConcurrency}) is occupied by active spawned agents; ` +
            'wait or stop existing handles before launching more agents',
        ),
    });
    let acquired = true;
    let handle: WorkflowTaskHandle | undefined;
    try {
      checkAbort();
      checkBudget();
      checkAgentCap();
      for (;;) {
        try {
          handle = await opts.backend.spawn(input);
          break;
        } catch (error) {
          if (!isAgentLimitReached(error) || !opts.backend.waitForAgentCapacity) throw error;
          const canRetry = await opts.backend.waitForAgentCapacity(opts.signal);
          checkAbort();
          if (!canRetry) throw error;
        }
      }
      totalSpawned += 1;
      taskNames.set(handle.taskId, handle.name);
      activeTaskIds.add(handle.taskId);
      releaseByTask.set(handle.taskId, () => {
        if (!acquired) return;
        acquired = false;
        concurrency.release();
      });
      recorder.emit('agent_spawned', {
        taskId: handle.taskId,
        name: handle.name,
        ...(input.modelHint !== undefined ? { requestedTier: input.modelHint } : { requestedTier: 'inherited' }),
        ...(input.phase !== undefined ? { role: input.phase } : {}),
        ...(input.target !== undefined ? { externalTarget: input.target.agentId } : {}),
        // FEATURE_246 Part E: per-agent phase tag groups this agent under a
        // named phase in the progress display (harness `agent(..., {phase})`).
        ...(input.phase !== undefined ? { phase: input.phase } : {}),
      });
      return handle;
    } catch (error) {
      const spawnedHandle = handle;
      if (spawnedHandle) {
        activeTaskIds.delete(spawnedHandle.taskId);
        releaseByTask.delete(spawnedHandle.taskId);
        await Promise.race([
          Promise.resolve()
            .then(() => opts.backend.stop(spawnedHandle.taskId, 'workflow spawn failed'))
            .catch(() => undefined),
          delay(STOP_ACTIVE_TASK_TIMEOUT_MS),
        ]);
      }
      if (acquired) {
        acquired = false;
        concurrency.release();
      }
      throw error;
    }
  };

  const accrue = (result: WorkflowTaskResult): void => {
    spentOutputTokens += result.usage?.outputTokens ?? result.usage?.totalTokens ?? 0;
  };

  const isCompletedTaskStatus = (s: WorkflowTaskResult['status']): boolean =>
    s === 'completed' || s === 'completed_unverified';

  const terminalEventType = (s: WorkflowTaskResult['status']): WorkflowEventType =>
    s === 'stopped'
      ? 'agent_stopped'
      : s === 'failed'
        ? 'agent_failed'
        : s === 'completed_unverified'
          ? 'agent_unverified'
          : 'agent_completed';

  const summarizeTaskResult = (
    result: WorkflowTaskResult,
  ): { readonly text?: string; readonly kind: WorkflowTaskSummaryKind } | undefined => {
    const digest = result.digest?.trim();
    if (digest) {
      return { text: boundedTaskEventSummary(digest), kind: 'digest' };
    }
    const trimmed = result.finalText.trim();
    if (result.digestPending) {
      return {
        ...(trimmed ? { text: boundedTaskEventSummary(trimmed) } : {}),
        kind: 'pending',
      };
    }
    if (!trimmed) return undefined;
    // `digest-failed`: a digest was attempted but failed/timed out, so the UI
    // labels this deterministic excerpt as "smart summary unavailable" rather
    // than implying no digest was ever intended.
    return {
      text: boundedTaskEventSummary(trimmed),
      kind: result.digestFailed ? 'digest-failed' : 'excerpt',
    };
  };

  const emitTerminalTaskEvent = (
    taskId: string,
    type: WorkflowEventType,
    data: Record<string, unknown>,
  ): boolean => {
    if (terminalTaskIds.has(taskId)) return false;
    terminalTaskIds.add(taskId);
    recorder.emit(type, data);
    return true;
  };

  const stopBackendTask = async (
    taskId: string,
    reason: string,
  ): Promise<{ readonly error?: string; readonly stopTimedOut?: true }> => {
    const stop = Promise.resolve()
      .then(() => opts.backend.stop(taskId, reason))
      .then((): StopActiveTaskOutcome => 'stopped')
      .catch((error: unknown): StopActiveTaskOutcome => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    const timeout = delay(STOP_ACTIVE_TASK_TIMEOUT_MS).then(
      (): StopActiveTaskOutcome => 'timed-out',
    );
    const outcome = await Promise.race([stop, timeout]);
    if (typeof outcome === 'object') return { error: outcome.error };
    if (outcome === 'timed-out') return { stopTimedOut: true };
    return {};
  };

  const createAbortRace = (): {
    readonly promise: Promise<never>;
    dispose(): void;
  } | undefined => {
    if (!opts.signal) return undefined;
    let onAbort: (() => void) | undefined;
    const promise = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new WorkflowAbortError());
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
    return {
      promise,
      dispose: () => {
        if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      },
    };
  };

  const doWait = async (
    taskId: string,
    opts2: WorkflowWaitOptions | undefined,
  ): Promise<WorkflowTaskResult> => {
    const releasesCapacity = releaseByTask.has(taskId);
    if (releasesCapacity) activeReleaseOperations += 1;
    let abortRace: ReturnType<typeof createAbortRace>;
    try {
      checkAbort();
      abortRace = createAbortRace();
      const wait = opts.backend.wait(taskId, opts2);
      const result = abortRace ? await Promise.race([wait, abortRace.promise]) : await wait;
      const summary = isCompletedTaskStatus(result.status) ? summarizeTaskResult(result) : undefined;
      if (summary?.kind === 'pending' && summary.text !== undefined) {
        pendingTaskSummaries.set(result.taskId, summary.text);
      }
      if (emitTerminalTaskEvent(result.taskId, terminalEventType(result.status), {
        taskId: result.taskId,
        name: result.name,
        status: result.status,
        ...(result.status === 'failed' && result.finalText.trim()
          ? { error: boundedTaskEventSummary(result.finalText.trim()) }
          : {}),
        ...(result.provider !== undefined ? { provider: result.provider } : {}),
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.usage !== undefined
          ? { usage: result.usage }
          : {}),
        ...(result.digestUsage !== undefined ? { digestUsage: result.digestUsage } : {}),
        ...(result.requestedTier !== undefined ? { requestedTier: result.requestedTier } : {}),
        ...(result.tierOutcome !== undefined ? { tierOutcome: result.tierOutcome } : {}),
        ...(result.providerSource !== undefined ? { providerSource: result.providerSource } : {}),
        ...(result.modelSource !== undefined ? { modelSource: result.modelSource } : {}),
        ...(result.initialProvider !== undefined ? { initialProvider: result.initialProvider } : {}),
        ...(result.initialModel !== undefined ? { initialModel: result.initialModel } : {}),
        ...(result.finalProvider !== undefined ? { finalProvider: result.finalProvider } : {}),
        ...(result.finalModel !== undefined ? { finalModel: result.finalModel } : {}),
        ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}),
        ...(result.iterations !== undefined ? { iterations: result.iterations } : {}),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        ...(result.verification !== undefined ? { verification: result.verification } : {}),
        ...(result.limitReached === true ? { limitReached: true } : {}),
        ...(summary !== undefined
          ? {
              ...(summary.text !== undefined ? { summary: summary.text } : {}),
              summaryKind: summary.kind,
            }
          : {}),
      })) {
        taskResults.set(result.taskId, result);
        accrue(result);
      }
      return result;
    } catch (error) {
      if (releasesCapacity && !terminalTaskIds.has(taskId)) {
        const reason = error instanceof WorkflowAbortError
          ? 'workflow aborted'
          : 'workflow wait failed';
        const stopOutcome = await stopBackendTask(taskId, reason);
        emitTerminalTaskEvent(taskId, 'agent_stopped', {
          taskId,
          reason,
          ...(error instanceof Error ? { error: error.message } : {}),
          ...(stopOutcome.error !== undefined ? { stopError: stopOutcome.error } : {}),
          ...(stopOutcome.stopTimedOut ? { stopTimedOut: true } : {}),
        });
      }
      throw error;
    } finally {
      abortRace?.dispose();
      if (releasesCapacity) activeReleaseOperations -= 1;
      releaseTaskCapacity(taskId);
    }
  };

  // Run an agent through the same spawn/wait gate; doWait owns abort
  // propagation so runAgent and bare spawnAgent+wait behave consistently.
  const runAgentImpl = async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskResult> => {
    checkAbort();
    const handle = await doSpawn(input);
    const result = await doWait(handle.taskId, undefined);
    if (result.status === 'failed' || result.status === 'stopped') {
      throw new WorkflowTaskFailedError(result);
    }
    return result;
  };

  const budget: WorkflowBudget = {
    total: tokenBudget,
    spent: () => spentOutputTokens,
    remaining: () =>
      tokenBudget === null ? Infinity : Math.max(0, tokenBudget - spentOutputTokens),
  };

  const snapshotTask = (taskId: string): Promise<WorkflowTaskSnapshot> =>
    opts.backend.output(taskId);

  const api: WorkflowApi = {
    runId: opts.runId,
    args: opts.args,
    budget,

    phase: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      recorder.emit('phase_started', { name });
      try {
        return await fn();
      } finally {
        recorder.emit('phase_finished', { name });
      }
    },

    spawnAgent: (input) => doSpawn(input),

    runAgent: async (input) => {
      // FEATURE_246 Part D (ADR-048): content-addressed resume cache. A cache
      // hit returns the prior run's result verbatim and skips the spawn. It emits
      // a single lightweight `agent_replayed` telemetry event (so a host can
      // render "N/M replayed from cache") but no spawn/progress events — the
      // result is still returned instantly. The occurrence counter disambiguates
      // identical inputs; it advances even on a miss so keys stay stable across runs.
      const cache = opts.resultCache;
      let cacheKey: string | undefined;
      if (cache) {
        const hash = hashSpawnInput(input);
        const occurrence = occurrenceByHash.get(hash) ?? 0;
        occurrenceByHash.set(hash, occurrence + 1);
        cacheKey = `${hash}#${occurrence}`;
        const cached = cache.get(cacheKey);
        if (cached !== undefined) {
          taskResults.set(cached.taskId, cached);
          recorder.emit('agent_replayed', {
            taskId: cached.taskId,
            name: input.name,
            ...(input.phase !== undefined ? { phase: input.phase } : {}),
          });
          return cached;
        }
      }
      try {
        const result = await runAgentImpl(input);
        // Cache only successful results — a failed/stopped child must re-run live.
        if (cache && cacheKey !== undefined) cache.set(cacheKey, result);
        return result;
      } catch (error) {
        // Lenient failure (FEATURE_246 Part E, harness parity): a child that
        // ends failed/stopped resolves to null so scripts can `.filter(Boolean)`
        // instead of wrapping every call in try/catch. Abort and budget/agent-cap
        // limits still throw — they must tear down or halt the whole run.
        if (error instanceof WorkflowTaskFailedError) return null;
        throw error;
      }
    },

    wait: (taskId, waitOpts) => doWait(taskId, waitOpts),

    snapshot: snapshotTask,

    output: snapshotTask,

    send: async (taskId, content) => {
      await opts.backend.send(taskId, content);
      recorder.emit('agent_message_sent', { taskId });
    },

    stop: async (taskId, reason) => {
      const releasesCapacity = releaseByTask.has(taskId);
      if (releasesCapacity) activeReleaseOperations += 1;
      try {
        await opts.backend.stop(taskId, reason);
      } finally {
        if (releasesCapacity) activeReleaseOperations -= 1;
        releaseTaskCapacity(taskId);
        emitTerminalTaskEvent(taskId, 'agent_stopped', { taskId, reason });
      }
    },

    parallel: <T>(items: readonly (() => Promise<T>)[], parallelOpts?: WorkflowParallelOptions) => {
      checkAbort();
      assertFanoutSize('parallel', items.length);
      if (
        parallelOpts?.concurrency !== undefined &&
        (!Number.isInteger(parallelOpts.concurrency) || parallelOpts.concurrency <= 0)
      ) {
        throw new WorkflowLimitError('workflow parallel concurrency must be a positive integer');
      }
      const cap = Math.min(parallelOpts?.concurrency ?? maxConcurrency, maxConcurrency);
      return runPool(items, cap, opts.signal);
    },

    pipeline: (items, ...stages) => {
      checkAbort();
      assertFanoutSize('pipeline', items.length);
      const runnable = stages.filter(
        (stage): stage is (prev: unknown, item: unknown, index: number) => unknown =>
          typeof stage === 'function',
      );
      // No barrier between stages: every item advances its own chain as soon
      // as its previous stage resolves. Actual agent spawns inside stages stay
      // bounded by the shared Workflow resource scope (acquired in doSpawn), so
      // launching all item-chains at once does not exceed maxConcurrency.
      return Promise.all(
        items.map(async (item, index) => {
          try {
            let value: unknown = item;
            for (const stage of runnable) {
              checkAbort();
              value = await stage(value, item, index);
            }
            return value;
          } catch (error) {
            // Stage-level fault isolation: a throwing stage drops THIS item to
            // null and lets siblings continue. Run-control errors (abort /
            // agent-cap / budget) tear down the whole run, so they propagate
            // rather than be swallowed into a null item.
            if (isWorkflowRunControlError(error)) throw error;
            return null;
          }
        }),
      );
    },

    synthesize: async (input: WorkflowSynthesizeInput): Promise<WorkflowSynthesis> => {
      // Synthesis runs as a gated agent (counts toward maxAgents /
      // concurrency / budget and emits agent_spawned/completed events)
      // rather than a backend side-channel that bypasses the runtime.
      // FEATURE_246 Part D: intentionally NOT routed through the resume cache —
      // it is the terminal fold over the (possibly cached) findings and is
      // re-run fresh on each resume by design (ADR-048 known limitations).
      const result = await runAgentImpl({
        name: 'synthesize',
        prompt: buildSynthesisPrompt(input),
        readOnly: true,
      });
      recorder.emit('synthesis_completed');
      return { text: result.finalText };
    },

    // FEATURE_246 Part E: one-level nested workflow. Only exposed when the host
    // injected a resolver. The sub-workflow runs under THIS runtime (shared
    // concurrency / budget / abort / agent counter, via the spread api), so it
    // is bounded exactly like the parent. One level only: the sub-api's own
    // `workflow` throws, so a nested workflow calling workflow() fails loud.
    ...(opts.resolveWorkflowModule
      ? {
          workflow: async (name: string, subArgs?: unknown): Promise<unknown> => {
            checkAbort();
            const module = await opts.resolveWorkflowModule!(name);
            if (!module) {
              throw new Error(
                `workflow("${name}") not found — no saved or built-in workflow by that name`,
              );
            }
            const subApi: WorkflowApi = {
              ...api,
              args: subArgs,
              workflow: () => {
                throw new Error(
                  `nested workflow("${name}") cannot call workflow() — nesting is one level only`,
                );
              },
            };
            return module.run(subApi, subArgs);
          },
        }
      : {}),

    artifact: async (name, value): Promise<WorkflowArtifactRef> => {
      const ref = opts.backend.writeArtifact
        ? await opts.backend.writeArtifact(name, value)
        : { name };
      artifacts.push(ref);
      // FEATURE_298 T22 — the path lets process-snapshot consumers (Host
      // clients, /workflow show) preview the artifact content.
      recorder.emit('artifact_written', {
        name,
        ...(ref.path !== undefined ? { path: ref.path } : {}),
      });
      return ref;
    },

    log: (event) => {
      recorder.emit('workflow_log', {
        message: boundedTaskEventSummary(event.message),
        ...(event.data !== undefined ? { data: event.data } : {}),
      });
      opts.onLog?.(event);
    },
  };

  return {
    api,
    recorder,
    setStatus: (s) => {
      status = s;
      if (s !== 'running') closeTaskSummaryUpdates();
    },
    stopActiveTasks: async (reason: string): Promise<readonly string[]> => {
      const errors: string[] = [];
      const taskIds = [...activeTaskIds];
      await Promise.all(
        taskIds.map(async (taskId) => {
          let stopError: string | undefined;
          let stopTimedOut = false;
          const stop = Promise.resolve()
            .then(() => opts.backend.stop(taskId, reason))
            .then((): StopActiveTaskOutcome => 'stopped')
            .catch((error: unknown): StopActiveTaskOutcome => ({
              error: error instanceof Error ? error.message : String(error),
            }));
          const timeout = delay(STOP_ACTIVE_TASK_TIMEOUT_MS).then(
            (): StopActiveTaskOutcome => 'timed-out',
          );
          const outcome = await Promise.race([stop, timeout]);
          if (typeof outcome === 'object') {
            stopError = outcome.error;
            errors.push(`${taskId}: ${stopError}`);
          } else if (outcome === 'timed-out') {
            stopTimedOut = true;
            errors.push(`${taskId}: stop timed out after ${STOP_ACTIVE_TASK_TIMEOUT_MS}ms`);
          }
          releaseTaskCapacity(taskId);
          emitTerminalTaskEvent(taskId, 'agent_stopped', {
            taskId,
            reason,
            ...(stopError !== undefined ? { error: stopError } : {}),
            ...(stopTimedOut ? { stopTimedOut } : {}),
          });
        }),
      );
      return errors;
    },
    getState: (): WorkflowRunState => ({
      runId: opts.runId,
      status,
      totalSpawned,
      results: [...taskResults.values()],
      events: recorder.snapshot(),
      artifacts: [...artifacts],
    }),
  };
}

/**
 * Build a workflow runtime. The returned `api` is handed to a workflow
 * script; `getState()` returns an immutable snapshot of accumulated run
 * state. For the full run lifecycle (workflow_started/completed/failed
 * envelope) use `runWorkflow`.
 */
export function createWorkflowRuntime(opts: CreateWorkflowRuntimeOptions): WorkflowRuntimeHandle {
  const rt = buildRuntime(opts);
  return { api: rt.api, getState: rt.getState };
}

export type WorkflowRunOutcome<T> =
  | { readonly ok: true; readonly result: T; readonly state: WorkflowRunState }
  | { readonly ok: false; readonly error: Error; readonly state: WorkflowRunState };

/**
 * Run a workflow script end-to-end under a fresh runtime, wrapping it
 * with the workflow_started / workflow_completed|failed event envelope.
 * Never throws — failures surface as `{ ok: false, error }`.
 */
export async function runWorkflow<T>(
  opts: CreateWorkflowRuntimeOptions,
  script: (api: WorkflowApi, args: unknown) => Promise<T>,
): Promise<WorkflowRunOutcome<T>> {
  let rt: InternalRuntime | undefined;
  try {
    rt = buildRuntime(opts);
    rt.recorder.emit('workflow_started', { runId: opts.runId });
    const result = await script(rt.api, opts.args);
    const stopErrors = await rt.stopActiveTasks('workflow completed');
    rt.setStatus('completed');
    let resultSummary: string | undefined;
    let resultSummaryError: string | undefined;
    try {
      resultSummary = opts.summarizeResult?.(result);
    } catch (summaryError) {
      resultSummaryError = summaryError instanceof Error
        ? summaryError.message
        : String(summaryError);
    }
    const completionData: Record<string, unknown> = {
      ...(resultSummary !== undefined ? { resultSummary } : {}),
      ...(resultSummaryError !== undefined ? { resultSummaryError } : {}),
      ...(stopErrors.length > 0 ? { stopErrors } : {}),
    };
    rt.recorder.emit(
      'workflow_completed',
      Object.keys(completionData).length > 0 ? completionData : undefined,
    );
    return { ok: true, result, state: rt.getState() };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (rt) {
      const stopped = err instanceof WorkflowAbortError;
      const stopErrors = await rt.stopActiveTasks(stopped ? 'workflow stopped' : 'workflow failed');
      rt.setStatus(stopped ? 'stopped' : 'failed');
      if (stopped) {
        rt.recorder.emit(
          'workflow_stopped',
          stopErrors.length > 0 ? { stopErrors } : undefined,
        );
      } else {
        rt.recorder.emit('workflow_failed', {
          error: err.message,
          ...(stopErrors.length > 0 ? { stopErrors } : {}),
        });
      }
      return { ok: false, error: err, state: rt.getState() };
    }
    return {
      ok: false,
      error: err,
      state: {
        runId: opts.runId,
        status: 'failed',
        totalSpawned: 0,
        results: [],
        events: [],
        artifacts: [],
      },
    };
  }
}
