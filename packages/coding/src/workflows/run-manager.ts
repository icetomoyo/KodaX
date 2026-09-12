/**
 * FEATURE_246 Part A0b (ADR-046) — coding adapter over the neutral agent-layer
 * workflow run manager.
 *
 * The lifecycle core (registry / pause / resume / stop / process tracking /
 * settle) now lives in `@kodax-ai/agent` (`createWorkflowRunManager`). This
 * adapter preserves the coding-facing API (`start` / `startFromOptions` driven
 * by `RunWorkflowModuleOptions` / `KodaXOptions` + durable run dirs) by building
 * the agent manager's injected `runFn` from `runWorkflowModule` /
 * `runWorkflowFromOptions`, and augments the neutral snapshot with the
 * coding-specific `runDir`. Dependency arrows point coding → agent only.
 */

import {
  createWorkflowRunManager as createAgentWorkflowRunManager,
  getDefaultWorkflowRunManager as getDefaultAgentWorkflowRunManager,
} from '@kodax-ai/agent';
import type {
  ManagedRunClassification,
  ManagedRunHooks,
  ManagedWorkflowSnapshot as AgentManagedWorkflowSnapshot,
  WorkflowMeta,
  WorkflowProcessEvent,
  WorkflowProcessSnapshot,
  WorkflowRunManager as AgentWorkflowRunManager,
  WorkflowRunState,
} from '@kodax-ai/agent';

import {
  clampWorkflowLimits,
  runWorkflowFromOptions,
  runWorkflowModule,
  type RunWorkflowFromOptionsInput,
  type RunWorkflowModuleOptions,
  type RunWorkflowModuleOutcome,
} from './workflow-runner.js';
import type { WorkflowHostPolicy } from './invocation-policy.js';
import type { WorkflowRunProcessMetadata } from './run-graph.js';

export type { ManagedWorkflowStatus } from '@kodax-ai/agent';

/** Coding snapshot = the neutral agent snapshot plus the durable run dir. */
export interface ManagedWorkflowSnapshot extends AgentManagedWorkflowSnapshot {
  readonly runDir: string;
}

export interface ManagedWorkflowRun {
  readonly runId: string;
  readonly done: Promise<RunWorkflowModuleOutcome>;
  readonly getSnapshot?: () => ManagedWorkflowSnapshot | undefined;
  readonly getProcessSnapshot?: () => WorkflowProcessSnapshot | undefined;
}

export interface WorkflowRunManager {
  start(opts: RunWorkflowModuleOptions): ManagedWorkflowRun;
  startFromOptions(input: RunWorkflowFromOptionsInput): ManagedWorkflowRun;
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

function resultText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const synthesis = record.synthesis;
  if (typeof synthesis === 'string' && synthesis.trim().length > 0) return synthesis;
  if (typeof synthesis === 'object' && synthesis !== null) {
    const text = (synthesis as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim().length > 0) return text;
  }
  for (const key of ['summary', 'report', 'text', 'result']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

function classifyOutcome(outcome: RunWorkflowModuleOutcome): ManagedRunClassification {
  if (outcome.kind === 'completed') {
    const text = resultText(outcome.result);
    return text !== undefined ? { status: 'completed', resultText: text } : { status: 'completed' };
  }
  if (outcome.kind === 'denied') return { status: 'denied' };
  return { status: 'failed', error: outcome.error };
}

function failedOutcome(runId: string, error: unknown): RunWorkflowModuleOutcome {
  const err = error instanceof Error ? error : new Error(String(error));
  const state: WorkflowRunState = {
    runId,
    status: 'failed',
    totalSpawned: 0,
    results: [],
    events: [],
    artifacts: [],
  };
  return { kind: 'failed', error: err, state };
}

interface StartManagedParams {
  readonly runId: string;
  readonly runDir: string;
  readonly meta: WorkflowMeta;
  readonly hostPolicy: WorkflowHostPolicy | undefined;
  readonly processMetadata: WorkflowRunProcessMetadata | undefined;
  readonly signal: AbortSignal | undefined;
}

/** Prune the runDir map once it grows past this — the agent manager evicts the
 *  oldest terminal runs at its own (lower) cap, so this only removes stragglers
 *  it no longer tracks. Keeps the coding-side map from leaking run-dir strings. */
const MAX_RETAINED_RUN_DIRS = 1000;

export function createWorkflowRunManager(
  deps: { readonly now?: () => number } = {},
  agent: AgentWorkflowRunManager = createAgentWorkflowRunManager(deps),
): WorkflowRunManager {
  const runDirs = new Map<string, string>();

  const withRunDir = (
    snap: AgentManagedWorkflowSnapshot | undefined,
  ): ManagedWorkflowSnapshot | undefined =>
    snap ? { ...snap, runDir: runDirs.get(snap.runId) ?? '' } : undefined;

  const startManaged = (
    params: StartManagedParams,
    exec: (hooks: ManagedRunHooks) => Promise<RunWorkflowModuleOutcome>,
  ): ManagedWorkflowRun => {
    runDirs.set(params.runId, params.runDir);
    if (runDirs.size > MAX_RETAINED_RUN_DIRS) {
      const live = new Set(agent.list().map((snap) => snap.runId));
      for (const id of runDirs.keys()) {
        if (id !== params.runId && !live.has(id)) runDirs.delete(id);
      }
    }
    const limits = clampWorkflowLimits(params.meta, params.hostPolicy);
    const agentRun = agent.start<RunWorkflowModuleOutcome>({
      runId: params.runId,
      workflow: params.meta.name,
      ...(params.meta.phases !== undefined ? { phases: params.meta.phases } : {}),
      ...(limits.maxAgents !== undefined ? { maxAgents: limits.maxAgents } : {}),
      ...(params.meta.plannedAgents !== undefined ? { plannedAgents: params.meta.plannedAgents } : {}),
      ...(limits.tokenBudget !== undefined ? { tokenBudget: limits.tokenBudget } : {}),
      ...(params.processMetadata !== undefined ? { processMetadata: params.processMetadata } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      runFn: exec,
      classify: classifyOutcome,
      onError: (error) => failedOutcome(params.runId, error),
    });
    return {
      runId: agentRun.runId,
      done: agentRun.done,
      getSnapshot: () => withRunDir(agentRun.getSnapshot()),
      getProcessSnapshot: () => agentRun.getProcessSnapshot(),
    };
  };

  return {
    start: (opts) =>
      startManaged(
        {
          runId: opts.runId,
          runDir: opts.runDir,
          meta: opts.module.meta,
          hostPolicy: opts.hostPolicy,
          processMetadata: opts.processMetadata,
          signal: opts.signal,
        },
        (hooks) =>
          runWorkflowModule({
            ...opts,
            signal: hooks.signal,
            beforeSpawn: hooks.beforeSpawn,
            onEvent: (event) => {
              hooks.onEvent(event);
              opts.onEvent?.(event);
            },
          }),
      ),

    startFromOptions: (input) =>
      startManaged(
        {
          runId: input.runId,
          runDir: input.runDir,
          meta: input.module.meta,
          hostPolicy: input.options.workflowHostPolicy,
          processMetadata: { ...input.processMetadata, hostMetadata: {
            ...input.processMetadata?.hostMetadata,
            ownerSessionId: input.options.session?.id ?? '',
            ownerRunId: input.options.context?.runtimeRunId ?? '',
          } },
          signal: input.signal ?? input.options.abortSignal,
        },
        (hooks) =>
          runWorkflowFromOptions({
            ...input,
            signal: hooks.signal,
            beforeSpawn: hooks.beforeSpawn,
            onEvent: (event) => {
              hooks.onEvent(event);
              input.onEvent?.(event);
            },
          }),
      ),

    list: () => agent.list().map((snap) => ({ ...snap, runDir: runDirs.get(snap.runId) ?? '' })),
    get: (runId) => withRunDir(agent.get(runId)),
    subscribeWorkflowProcess: (listener) => agent.subscribeWorkflowProcess(listener),
    getWorkflowProcessSnapshot: (runId) => agent.getWorkflowProcessSnapshot(runId),
    listWorkflowProcessSnapshots: (options) => agent.listWorkflowProcessSnapshots(options),
    pause: (runId) => agent.pause(runId),
    resume: (runId) => agent.resume(runId),
    stop: (runId, reason) => agent.stop(runId, reason),
  };
}

let defaultWorkflowRunManager: WorkflowRunManager | undefined;

/** UI control is scoped to the Session that admitted the workflow. */
export function requestSessionWorkflowStop(
  manager: WorkflowRunManager, sessionId: string, runId: string, reason = 'stopped by user',
): { runId: string; accepted: boolean; state: 'unknown' | 'confirmed' } {
  if (!sessionId || manager.getWorkflowProcessSnapshot(runId)?.hostMetadata?.ownerSessionId !== sessionId) {
    throw Object.assign(new Error(JSON.stringify({ code: 'forbidden', denialSource: 'session_scope',
      runId, remediation: 'Stop the workflow from the Session that owns it.' })),
    { code: 'forbidden', denialSource: 'session_scope' });
  }
  const accepted = manager.stop(runId, reason);
  return { runId, accepted, state: manager.get(runId)?.stop?.state ?? 'unknown' };
}

export function getDefaultWorkflowRunManager(): WorkflowRunManager {
  defaultWorkflowRunManager ??= createWorkflowRunManager({}, getDefaultAgentWorkflowRunManager());
  return defaultWorkflowRunManager;
}
