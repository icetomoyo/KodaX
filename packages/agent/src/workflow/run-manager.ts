/**
 * FEATURE_246 Part A0 (ADR-046) — neutral workflow run lifecycle manager.
 *
 * Domain-neutral run registry + lifecycle (pause / resume / stop), process-event
 * tracking, and terminal settle — lifted out of `@kodax-ai/coding` so any agent
 * (including non-coding SDK hosts) can host and manage workflow runs.
 *
 * It never knows HOW a run executes: the caller injects a `runFn` thunk that
 * receives lifecycle hooks (`onEvent` / `signal` / `beforeSpawn`) and returns a
 * caller-shaped outcome, plus a `classify` mapping that outcome to a neutral
 * terminal status and an `onError` that synthesizes a failure outcome. The
 * coding layer wires `runFn` to its `runWorkflowModule` / `runWorkflowFromOptions`
 * (backend + run-graph + worktrees); SDK hosts wire their own. Dependency arrows
 * therefore point only coding → agent — no cycle.
 */

import type { WorkflowEvent } from './events.js';
import {
  createWorkflowProcessTracker,
  isFinalWorkflowProcessStatus,
} from './process.js';
import { WorkflowAbortError } from './runtime.js';
import type {
  WorkflowProcessEvent,
  WorkflowProcessSnapshot,
  WorkflowProcessTracker,
  WorkflowProcessTrackerOptions,
} from './process.js';

export type ManagedWorkflowStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'stopped';

/** Provenance/display metadata for a run's process tracker. */
export type WorkflowProcessMetadata = Pick<
  WorkflowProcessTrackerOptions,
  | 'displayName'
  | 'goal'
  | 'source'
  | 'savedWorkflowName'
  | 'sourceRunId'
  | 'sourceWorkflowName'
  | 'revisionOf'
  | 'resumedFromRunId'
  | 'hostMetadata'
>;

export interface ManagedWorkflowSnapshot {
  readonly stop?: { readonly state: 'unknown' | 'confirmed' };
  readonly runId: string;
  readonly workflow: string;
  readonly status: ManagedWorkflowStatus;
  readonly totalSpawned: number;
  readonly eventCount: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly resultText?: string;
}

export interface ManagedWorkflowRun<TOutcome = unknown> {
  readonly runId: string;
  readonly done: Promise<TOutcome>;
  getSnapshot(): ManagedWorkflowSnapshot | undefined;
  getProcessSnapshot(): WorkflowProcessSnapshot | undefined;
}

/** Lifecycle hooks the manager injects into the caller's `runFn`. */
export interface ManagedRunHooks {
  /** Forward every workflow event so the manager can track spawn/progress. */
  readonly onEvent: (event: WorkflowEvent) => void;
  /** Abort signal owned by the manager (fires on stop()). */
  readonly signal: AbortSignal;
  /** Await before launching each agent so pause() can gate new spawns. */
  readonly beforeSpawn: () => Promise<void>;
}

/** Neutral terminal classification of a caller-shaped outcome. */
export interface ManagedRunClassification {
  readonly status: 'completed' | 'failed' | 'denied';
  readonly error?: Error;
  readonly resultText?: string;
}

export interface StartManagedRunInput<TOutcome> {
  readonly runId: string;
  /** Display name (usually the workflow's `meta.name`). */
  readonly workflow: string;
  readonly phases?: readonly string[];
  readonly maxAgents?: number;
  readonly plannedAgents?: number;
  readonly tokenBudget?: number;
  readonly processMetadata?: WorkflowProcessMetadata;
  readonly signal?: AbortSignal;
  /** Executes the run with the manager's lifecycle hooks injected. */
  readonly runFn: (hooks: ManagedRunHooks) => Promise<TOutcome>;
  /** Map the caller's terminal outcome to a neutral status for the snapshot. */
  readonly classify: (outcome: TOutcome) => ManagedRunClassification;
  /** Synthesize a caller-shaped outcome when `runFn` throws. */
  readonly onError: (error: unknown) => TOutcome;
}

export interface WorkflowRunManager {
  start<TOutcome>(input: StartManagedRunInput<TOutcome>): ManagedWorkflowRun<TOutcome>;
  list(): readonly ManagedWorkflowSnapshot[];
  get(runId: string): ManagedWorkflowSnapshot | undefined;
  subscribeWorkflowProcess(listener: (event: WorkflowProcessEvent) => void): () => void;
  getWorkflowProcessSnapshot(runId: string): WorkflowProcessSnapshot | undefined;
  listWorkflowProcessSnapshots(options?: {
    readonly activeOnly?: boolean;
    readonly limit?: number;
  }): readonly WorkflowProcessSnapshot[];
  pause(runId: string): boolean;
  resume(runId: string): boolean;
  stop(runId: string, reason?: string): boolean;
}

interface MutableRun {
  runId: string;
  workflow: string;
  status: ManagedWorkflowStatus;
  totalSpawned: number;
  eventCount: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
  resultText?: string;
  controller: AbortController;
  pauseWaiters: Array<() => void>;
  process: WorkflowProcessTracker;
  /** Detach the abort forwarder from the caller-owned `input.signal`, if any.
   *  Called on terminal settle so a long-lived host that shares one session
   *  signal across many runs does not accumulate one dead listener per run. */
  detachExternalAbort?: () => void;
}

function snapshot(run: MutableRun): ManagedWorkflowSnapshot {
  return {
    ...(run.controller.signal.aborted ? { stop: { state: isTerminalRunStatus(run.status) ? 'confirmed' as const : 'unknown' as const } } : {}),
    runId: run.runId,
    workflow: run.workflow,
    status: run.status,
    totalSpawned: run.totalSpawned,
    eventCount: run.eventCount,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.resultText !== undefined ? { resultText: run.resultText } : {}),
  };
}

function terminalStatus(
  status: ManagedRunClassification['status'],
  aborted: boolean,
): ManagedWorkflowStatus {
  if (aborted) return 'stopped';
  return status;
}

const isTerminalRunStatus = (status: ManagedWorkflowStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'denied' || status === 'stopped';

/** Cap on retained TERMINAL runs. Running / paused runs are never evicted. This
 *  bounds heap for a long-lived host (e.g. a benchmark harness) that starts many
 *  workflows in one process; recent runs stay queryable via get()/list(), and
 *  same-session resume reads the durable run dir on disk, not this in-memory Map. */
const MAX_RETAINED_TERMINAL_RUNS = 500;

export function createWorkflowRunManager(
  deps: { readonly now?: () => number } = {},
): WorkflowRunManager {
  const now = deps.now ?? (() => Date.now());
  const runs = new Map<string, MutableRun>();
  const subscribers = new Set<(event: WorkflowProcessEvent) => void>();
  const isoNow = (): string => new Date(now()).toISOString();

  const notifyProcess = (event: WorkflowProcessEvent): void => {
    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch {
        // Process subscribers are observers; a host panel must not break the run.
      }
    }
  };

  const waitIfPaused = async (run: MutableRun): Promise<void> => {
    while (run.status === 'paused' && !run.controller.signal.aborted) {
      await new Promise<void>((resolve) => run.pauseWaiters.push(resolve));
    }
    if (run.controller.signal.aborted) {
      // Throw the abort-typed error, not a bare Error: the runtime classifies a
      // terminal error as a stop only via `instanceof WorkflowAbortError`
      // (runtime.ts) — a plain Error would be recorded as `workflow_failed`
      // instead of `workflow_stopped` when a run is stopped while paused.
      throw new WorkflowAbortError('workflow stopped');
    }
  };

  const releasePauseWaiters = (run: MutableRun): void => {
    const waiters = run.pauseWaiters.splice(0);
    for (const resolve of waiters) resolve();
  };

  // Evict the oldest terminal runs once retention exceeds the cap, so a
  // long-lived process that starts many workflows does not accumulate their
  // MutableRun state indefinitely.
  const pruneTerminalRuns = (): void => {
    const terminal = [...runs.values()].filter((r) => isTerminalRunStatus(r.status));
    const excess = terminal.length - MAX_RETAINED_TERMINAL_RUNS;
    if (excess <= 0) return;
    terminal
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .slice(0, excess)
      .forEach((r) => runs.delete(r.runId));
  };

  const createRun = <TOutcome>(
    input: StartManagedRunInput<TOutcome>,
  ): MutableRun => {
    const controller = new AbortController();
    if (input.signal?.aborted) controller.abort(input.signal.reason);
    // Forward an external abort onto our controller. `{ once: true }` auto-removes
    // the listener only if the signal FIRES; on a normal completion the run must
    // remove it itself (see settle → detachExternalAbort) so a shared session
    // signal does not leak one listener per completed run.
    let detachExternalAbort: (() => void) | undefined;
    if (input.signal) {
      const signal = input.signal;
      const forwardAbort = (): void => { controller.abort(signal.reason); releasePauseWaiters(run); };
      signal.addEventListener('abort', forwardAbort, { once: true });
      detachExternalAbort = () => signal.removeEventListener('abort', forwardAbort);
    }
    const metadata = input.processMetadata;
    const run: MutableRun = {
      runId: input.runId,
      workflow: input.workflow,
      status: 'running',
      totalSpawned: 0,
      eventCount: 0,
      startedAt: now(),
      controller,
      pauseWaiters: [],
      ...(detachExternalAbort ? { detachExternalAbort } : {}),
      process: createWorkflowProcessTracker({
        runId: input.runId,
        workflowName: input.workflow,
        displayName: metadata?.displayName ?? input.workflow,
        ...(metadata?.goal !== undefined ? { goal: metadata.goal } : {}),
        ...(metadata?.source !== undefined ? { source: metadata.source } : {}),
        ...(metadata?.savedWorkflowName !== undefined
          ? { savedWorkflowName: metadata.savedWorkflowName }
          : {}),
        ...(metadata?.sourceRunId !== undefined ? { sourceRunId: metadata.sourceRunId } : {}),
        ...(metadata?.sourceWorkflowName !== undefined
          ? { sourceWorkflowName: metadata.sourceWorkflowName }
          : {}),
        ...(metadata?.revisionOf !== undefined ? { revisionOf: metadata.revisionOf } : {}),
        ...(metadata?.hostMetadata !== undefined ? { hostMetadata: { ...metadata.hostMetadata } } : {}),
        ...(input.phases !== undefined ? { phases: input.phases } : {}),
        ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
        ...(input.plannedAgents !== undefined ? { plannedAgents: input.plannedAgents } : {}),
        ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
        now: isoNow,
      }),
    };
    runs.set(input.runId, run);
    return run;
  };

  const settle = (run: MutableRun, classification: ManagedRunClassification): void => {
    run.status = terminalStatus(
      classification.status,
      run.controller.signal.aborted || run.status === 'stopped',
    );
    run.endedAt = now();
    if (classification.status === 'failed' && run.status !== 'stopped') {
      run.error = classification.error?.message;
    }
    if (classification.status === 'completed') {
      run.resultText = classification.resultText;
    }
    if (
      classification.status === 'failed' &&
      run.status !== 'stopped' &&
      !isFinalWorkflowProcessStatus(run.process.getSnapshot().status)
    ) {
      notifyProcess(run.process.setStatus('failed', classification.error?.message));
    } else if (classification.status === 'denied') {
      notifyProcess(run.process.setStatus('cancelled', 'workflow denied'));
    } else if (run.status === 'stopped' && run.process.getSnapshot().status !== 'cancelled') {
      notifyProcess(run.process.setStatus('cancelled', 'workflow stopped'));
    }
    releasePauseWaiters(run);
    // Remove the abort forwarder from the caller-owned signal now the run is
    // terminal — {once:true} only self-removes when the signal fires, so a run
    // that completes normally would otherwise leak its listener forever.
    run.detachExternalAbort?.();
    run.detachExternalAbort = undefined;
    pruneTerminalRuns();
  };

  // Settle to a terminal 'failed' status from a raw thrown value. Used to
  // guarantee a run never wedges in 'running' when a caller-injected
  // onError/classify callback throws (both are public-API injection points).
  const settleFailedFrom = (run: MutableRun, error: unknown): void =>
    settle(run, {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    });

  return {
    start: <TOutcome>(input: StartManagedRunInput<TOutcome>): ManagedWorkflowRun<TOutcome> => {
      const run = createRun(input);
      const hooks: ManagedRunHooks = {
        onEvent: (event) => {
          run.eventCount += 1;
          if (event.type === 'agent_spawned') run.totalSpawned += 1;
          notifyProcess(run.process.applyEvent(event));
        },
        signal: run.controller.signal,
        beforeSpawn: () => waitIfPaused(run),
      };
      // Invoke runFn EAGERLY (synchronously), not via Promise.resolve().then().
      // A deferred start adds a microtask before the run body begins, which
      // lets a caller that starts a run and then resolves it on a later tick
      // (e.g. a held-open run released after one await) call its release before
      // the body is even entered — the run then never completes. Match the
      // pre-A0 eager-start contract; the try/catch still routes a synchronous
      // throw through onError exactly like an async rejection.
      let started: Promise<TOutcome>;
      try {
        started = Promise.resolve(input.runFn(hooks));
      } catch (error: unknown) {
        // runFn threw synchronously — reject so it flows through the SAME single
        // `.catch(onError)` below as an async rejection. (Calling onError here in
        // an async thunk would invoke it twice when a throwing onError rejected
        // into that `.catch` as well.) `started` is consumed synchronously on the
        // next line, so no unhandled-rejection window opens.
        started = Promise.reject(error);
      }
      const done = started
        .catch((error: unknown) => input.onError(error))
        .then((outcome) => {
          settle(run, input.classify(outcome));
          return outcome;
        })
        .catch((error: unknown) => {
          // A caller-injected onError/classify threw (both are public-API
          // injection points). Guarantee the run still reaches a terminal
          // status instead of wedging in 'running' forever (which also keeps it
          // out of pruneTerminalRuns → unbounded Map growth), then re-throw so
          // `done` still rejects for the caller.
          if (!isTerminalRunStatus(run.status)) settleFailedFrom(run, error);
          throw error;
        });
      return {
        runId: run.runId,
        done,
        getSnapshot: () => snapshot(run),
        getProcessSnapshot: () => run.process.getSnapshot(),
      };
    },

    list: () => [...runs.values()].map(snapshot).sort((a, b) => b.startedAt - a.startedAt),

    get: (runId) => {
      const run = runs.get(runId);
      return run ? snapshot(run) : undefined;
    },

    subscribeWorkflowProcess: (listener) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    getWorkflowProcessSnapshot: (runId) => runs.get(runId)?.process.getSnapshot(),

    listWorkflowProcessSnapshots: (options) => {
      const snapshots = [...runs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((run) => run.process.getSnapshot())
        .filter((process) =>
          options?.activeOnly === true ? !isFinalWorkflowProcessStatus(process.status) : true,
        );
      return options?.limit === undefined ? snapshots : snapshots.slice(0, options.limit);
    },

    pause: (runId) => {
      const run = runs.get(runId);
      if (!run || run.status !== 'running' || run.controller.signal.aborted) return false;
      run.status = 'paused';
      notifyProcess(run.process.setStatus('paused', 'workflow paused'));
      return true;
    },

    resume: (runId) => {
      const run = runs.get(runId);
      if (!run || run.status !== 'paused' || run.controller.signal.aborted) return false;
      run.status = 'running';
      notifyProcess(run.process.setStatus('running', 'workflow resumed'));
      releasePauseWaiters(run);
      return true;
    },

    stop: (runId, reason) => {
      const run = runs.get(runId);
      if (!run || isTerminalRunStatus(run.status) || run.controller.signal.aborted) return false;
      run.controller.abort(reason);
      notifyProcess(run.process.setStatus(run.status === 'paused' ? 'paused' : 'running', 'Stop requested; waiting for owned work to settle.'));
      releasePauseWaiters(run);
      return true;
    },
  };
}

let defaultWorkflowRunManager: WorkflowRunManager | undefined;

export function getDefaultWorkflowRunManager(): WorkflowRunManager {
  defaultWorkflowRunManager ??= createWorkflowRunManager();
  return defaultWorkflowRunManager;
}
