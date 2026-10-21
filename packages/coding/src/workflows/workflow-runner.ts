/**
 * FEATURE_217 (v0.7.49) Phase D — Headless workflow orchestrator.
 *
 * Ties together: the approval gate, the coding agent backend (Phase B),
 * the durable run-graph writer, and the agent-layer `runWorkflow`
 * envelope. This is the REPL-agnostic core the `/workflow` command
 * (Phase D.2) drives; it is fully testable with a fake backend + temp
 * run dir + a stub approval callback.
 */

import {
  buildWorkflowOutcome,
  createWorkflowProcessTracker,
  runWorkflow,
} from '@kodax-ai/agent';
import { resolveWorkflowMaxConcurrency } from '@kodax-ai/llm';
import type {
  WorkflowAgentBackend,
  AgentMetadataValue,
  WorkflowApproval,
  WorkflowApprovalSummary,
  WorkflowEvent,
  WorkflowLimits,
  WorkflowMeta,
  WorkflowModule,
  WorkflowProcessEvent,
  WorkflowRunState,
  WorkflowOutcome,
} from '@kodax-ai/agent';

import { basename, dirname } from 'node:path';

import { createCodingWorkflowBackend, type WorkflowChildOptions } from './agent-adapter.js';
import { createNestedWorkflowResolver } from './nested-resolver.js';
import { createFsResultCache } from './result-cache.js';
import type { WorkflowHostPolicy } from './invocation-policy.js';
import {
  createRunGraphWriter,
  type WorkflowRunProcessMetadata,
  type WorkflowScriptSnapshotInput,
} from './run-graph.js';
import {
  workflowWorktreeBaseDir,
  sweepWorkflowRunWorktrees,
  pruneStaleWorkflowWorktrees,
  type WorktreeSweepDeps,
} from './worktree-sweep.js';
import { buildToolExecutionContext } from '../agent-runtime/tool-execution-context.js';
import { CodingActorSession } from '../agent-runtime/actor-runtime.js';
import type { KodaXEvents, KodaXOptions, KodaXToolExecutionContext } from '../types.js';

/** Default turn budget for one Workflow step Agent. */
const DEFAULT_MAX_ITERATIONS_PER_CHILD = 200;

// maxAgents (lifetime spawn cap) and tokenBudget are fixed system ceilings.
// The concurrency ceiling is resolved per-run via `resolveWorkflowMaxConcurrency`
// (SDK run-scoped → KODAX_WORKFLOW_MAX_CONCURRENCY env bridge → default 8) so an
// operator can tune how many child agents run at once without an env-only knob.
export const SYSTEM_WORKFLOW_LIMITS = {
  maxAgents: 64,
  tokenBudget: 200_000,
} as const;

export interface RunWorkflowModuleOptions {
  readonly module: WorkflowModule;
  readonly args: unknown;
  readonly runId: string;
  /** Directory for the durable run graph (run.json / events.jsonl / artifacts). */
  readonly runDir: string;
  /** Parent context — required when the backend is built internally. */
  readonly ctx?: KodaXToolExecutionContext;
  /** Per-run child options — required when the backend is built internally. */
  readonly childOptions?: WorkflowChildOptions;
  /** Pre-built backend (test seam). When omitted, built from ctx + childOptions. */
  readonly backend?: WorkflowAgentBackend;
  /** Approval gate. When omitted, the run auto-proceeds (SDK / headless). */
  readonly approval?: WorkflowApproval;
  /** Optional host/SDK ceilings. These may only lower manifest/system limits. */
  readonly hostPolicy?: WorkflowHostPolicy;
  readonly signal?: AbortSignal;
  /** Extra event sink (e.g. live UI), in addition to the durable writer. */
  readonly onEvent?: (event: WorkflowEvent) => void;
  /** Host/SDK process snapshot stream. */
  readonly onWorkflowProcessEvent?: (event: WorkflowProcessEvent) => void;
  readonly now?: () => number;
  readonly scriptSnapshot?: WorkflowScriptSnapshotInput;
  /** FEATURE_246 Part D (ADR-048): a prior run dir to seed the result cache from
   *  for same-session resume. Unchanged effects replay from it; only changed
   *  effects re-run live. */
  readonly resumeFromRunDir?: string;
  readonly processMetadata?: WorkflowRunProcessMetadata;
  /** Optional lifecycle gate, used by WorkflowRunManager pause/resume. */
  readonly beforeSpawn?: () => Promise<void>;
  /** Test seam: inject git/mtime for the worktree sweep (FEATURE_217 Layer 2/3). */
  readonly worktreeSweepDeps?: WorktreeSweepDeps;
}

export type RunWorkflowModuleOutcome =
  | { readonly kind: 'denied'; readonly summary: WorkflowApprovalSummary }
  | { readonly kind: 'completed'; readonly result: unknown; readonly state: WorkflowRunState }
  | { readonly kind: 'failed'; readonly error: Error; readonly state: WorkflowRunState };

/** Build the pre-run approval summary from a workflow module's metadata. */
export function buildApprovalSummary(
  module: WorkflowModule,
  hostPolicy?: WorkflowHostPolicy,
): WorkflowApprovalSummary {
  const meta = module.meta;
  const limits = clampWorkflowLimits(meta, hostPolicy);
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases ?? [],
    ...(meta.plannedAgents !== undefined ? { plannedAgents: meta.plannedAgents } : {}),
    maxAgents: limits.maxAgents ?? null,
    maxConcurrency: limits.maxConcurrency ?? null,
    tokenBudget: limits.tokenBudget ?? null,
    writesFiles: meta.readOnly !== true,
  };
}

function clampLimit(value: number | undefined, hardCap: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) return 1;
  return Math.min(value, hardCap);
}

function clampEffectiveLimit(
  manifestValue: number | undefined,
  hostValue: number | undefined,
  hardCap: number,
): number | undefined {
  const manifestLimit = clampLimit(manifestValue, hardCap);
  const hostLimit = clampLimit(hostValue, hardCap);
  if (manifestLimit === undefined) return hostLimit;
  if (hostLimit === undefined) return manifestLimit;
  return Math.min(manifestLimit, hostLimit);
}

/**
 * tokenBudget clamp — unlike the agent/concurrency count clamp (`clampLimit`,
 * which floors at 1), a tokenBudget of 0 / null / negative means "NO token
 * limit" (unbounded), the same as omitting the field. A host should be able to
 * express "unlimited" with an explicit value instead of relying on the field
 * being absent, which is fragile across multiple launch paths. Positive values
 * are floored to an integer and capped at the system ceiling.
 */
function clampTokenBudget(value: number | undefined, hardCap: number): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), hardCap);
}

function clampEffectiveTokenBudget(
  manifestValue: number | undefined,
  hostValue: number | undefined,
  hardCap: number,
): number | undefined {
  const manifestLimit = clampTokenBudget(manifestValue, hardCap);
  const hostLimit = clampTokenBudget(hostValue, hardCap);
  if (manifestLimit === undefined) return hostLimit;
  if (hostLimit === undefined) return manifestLimit;
  return Math.min(manifestLimit, hostLimit);
}

export function clampWorkflowLimits(
  meta: WorkflowMeta,
  hostPolicy?: WorkflowHostPolicy,
): WorkflowLimits {
  const maxAgents = clampEffectiveLimit(
    meta.maxAgents,
    hostPolicy?.maxAgents,
    SYSTEM_WORKFLOW_LIMITS.maxAgents,
  );
  // Concurrency always resolves to a concrete value: the configured cap (default
  // 8) is both the hard ceiling AND the default when neither the manifest nor the
  // host declares one — so an authored script that omits maxConcurrency can never
  // fan out unbounded (previously it fell through to Infinity, bounded only by the
  // 64-agent lifetime cap).
  const concurrencyCap = resolveWorkflowMaxConcurrency();
  const declaredConcurrency = [meta.maxConcurrency, hostPolicy?.maxConcurrency]
    .map((value) => clampLimit(value, concurrencyCap))
    .filter((value): value is number => value !== undefined);
  const maxConcurrency =
    declaredConcurrency.length === 0
      ? concurrencyCap
      : Math.min(concurrencyCap, ...declaredConcurrency);
  const tokenBudget = clampEffectiveTokenBudget(
    meta.tokenBudget,
    hostPolicy?.tokenBudget,
    SYSTEM_WORKFLOW_LIMITS.tokenBudget,
  );
  return {
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
}

function workflowResultSummary(value: unknown): string | undefined {
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

/**
 * Run a workflow module end-to-end: approval → runtime + backend +
 * durable run graph → terminal `run.json`. A workflow execution failure
 * surfaces as `{ kind: 'failed' }` and a denied approval as
 * `{ kind: 'denied' }`. Only a misconfiguration (no backend AND no
 * ctx+childOptions) throws — that is a programmer precondition error.
 */
export async function runWorkflowModule(
  opts: RunWorkflowModuleOptions,
): Promise<RunWorkflowModuleOutcome> {
  const limits = clampWorkflowLimits(opts.module.meta, opts.hostPolicy);
  const summary = buildApprovalSummary(opts.module, opts.hostPolicy);
  if (opts.approval) {
    const approved = await opts.approval(summary);
    if (!approved) return { kind: 'denied', summary };
  }

  const now = opts.now ?? (() => Date.now());

  // FEATURE_217 Layer 3 — reclaim worktrees orphaned by a previous hard kill
  // before this run starts allocating its own. Fail-soft, never blocks the run.
  // Git runs from the same cwd `toolWorktreeCreate` used (`executionCwd ?? gitRoot`)
  // so `git worktree list/remove` resolves the repo even when `gitRoot` is unset.
  const gitRoot = opts.ctx?.executionCwd ?? opts.ctx?.gitRoot;
  await pruneStaleWorkflowWorktrees(
    { workflowRunsRoot: dirname(opts.runDir), gitRoot },
    { now, ...opts.worktreeSweepDeps },
  );

  const writer = createRunGraphWriter(opts.runDir, { now });
  // FEATURE_246 resume telemetry — the resumed run id, derived from the prior run
  // dir (runDir === <baseDir>/<runId>). Threaded into BOTH the live tracker AND
  // run.json (below), so a snapshot reconstructed from persisted history also
  // reports the resume + per-agent origin. Absent on a fresh run.
  const resumedFromRunId =
    opts.resumeFromRunDir !== undefined ? basename(opts.resumeFromRunDir) : undefined;
  const processTracker = opts.onWorkflowProcessEvent
    ? createWorkflowProcessTracker({
        runId: opts.runId,
        workflowName: opts.module.meta.name,
        displayName: opts.processMetadata?.displayName ?? opts.module.meta.name,
        ...(opts.processMetadata?.goal !== undefined ? { goal: opts.processMetadata.goal } : {}),
        ...(opts.processMetadata?.source !== undefined ? { source: opts.processMetadata.source } : {}),
        ...(opts.processMetadata?.savedWorkflowName !== undefined
          ? { savedWorkflowName: opts.processMetadata.savedWorkflowName }
          : {}),
        ...(opts.processMetadata?.sourceRunId !== undefined
          ? { sourceRunId: opts.processMetadata.sourceRunId }
          : {}),
        ...(opts.processMetadata?.sourceWorkflowName !== undefined
          ? { sourceWorkflowName: opts.processMetadata.sourceWorkflowName }
          : {}),
        ...(opts.processMetadata?.revisionOf !== undefined
          ? { revisionOf: opts.processMetadata.revisionOf }
          : {}),
        ...(resumedFromRunId !== undefined ? { resumedFromRunId } : {}),
        ...(opts.processMetadata?.hostMetadata !== undefined
          ? { hostMetadata: { ...opts.processMetadata.hostMetadata } }
          : {}),
        ...(opts.module.meta.phases !== undefined ? { phases: opts.module.meta.phases } : {}),
        ...(limits.maxAgents !== undefined ? { maxAgents: limits.maxAgents } : {}),
        ...(opts.module.meta.plannedAgents !== undefined
          ? { plannedAgents: opts.module.meta.plannedAgents }
          : {}),
        ...(limits.tokenBudget !== undefined ? { tokenBudget: limits.tokenBudget } : {}),
        now: () => new Date(now()).toISOString(),
      })
    : undefined;
  const scriptSnapshot = opts.scriptSnapshot
    ? writer.writeScriptSnapshot(opts.scriptSnapshot)
    : undefined;
  const baseBackend = opts.backend ?? buildBackend(opts);
  const gatedBackend = opts.beforeSpawn
    ? withBeforeSpawn(baseBackend, opts.beforeSpawn)
    : baseBackend;
  // Route `wf.artifact` writes through the durable run-graph writer.
  const backend: WorkflowAgentBackend = {
    ...gatedBackend,
    writeArtifact: async (name, value) => writer.writeArtifact(name, value),
  };

  const startedAt = now();
  let outcome: Awaited<ReturnType<typeof runWorkflow>>;
  try {
    outcome = await runWorkflow(
      {
        runId: opts.runId,
        args: opts.args,
        backend,
        limits,
        ...(opts.signal ? { signal: opts.signal } : {}),
        summarizeResult: workflowResultSummary,
        // FEATURE_246 Part E: one-level nested wf.workflow(name, args) resolves
        // built-in + saved workflows for this run's project (cwd derived the
        // same way as the worktree gitRoot above).
        resolveWorkflowModule: createNestedWorkflowResolver(gitRoot ?? process.cwd()),
        // FEATURE_246 Part D (ADR-048): every run writes its content-addressed
        // result cache (so a later resume can replay it); on resume the cache is
        // seeded from the prior run dir.
        resultCache: createFsResultCache(
          opts.runDir,
          opts.resumeFromRunDir ? { readFrom: opts.resumeFromRunDir } : {},
        ),
        onEvent: (event) => {
          writer.onEvent(event);
          if (processTracker) {
            opts.onWorkflowProcessEvent?.(processTracker.applyEvent(event));
          }
          opts.onEvent?.(event);
        },
      },
      (wf) => opts.module.run(wf, opts.args),
    );
  } finally {
    // FEATURE_217 Layer 2 — reclaim any worktree still registered under this
    // run's base dir on every terminal path (success / failure / cancel),
    // covering aborted or spawn-without-wait children that skipped per-child
    // cleanup. Fail-soft.
    await sweepWorkflowRunWorktrees(
      { baseDir: workflowWorktreeBaseDir(opts.runDir), gitRoot },
      { now, ...opts.worktreeSweepDeps },
    );
  }

  const resultSummary = outcome.ok ? workflowResultSummary(outcome.result) : undefined;
  writer.writeRunJson({
    meta: opts.module.meta,
    args: opts.args,
    state: outcome.state,
    startedAt,
    endedAt: now(),
    ...(scriptSnapshot ? { scriptSnapshot } : {}),
    ...(resultSummary !== undefined ? { resultSummary } : {}),
    // Persist resumedFromRunId into run.json alongside any host processMetadata so a
    // snapshot reconstructed from disk (lifecycle-controller) reports the resume too.
    ...(opts.processMetadata !== undefined || resumedFromRunId !== undefined
      ? {
          processMetadata: {
            ...opts.processMetadata,
            ...(resumedFromRunId !== undefined ? { resumedFromRunId } : {}),
          },
        }
      : {}),
  });

  return outcome.ok
    ? { kind: 'completed', result: outcome.result, state: outcome.state }
    : { kind: 'failed', error: outcome.error, state: outcome.state };
}

function buildBackend(opts: RunWorkflowModuleOptions): WorkflowAgentBackend {
  if (!opts.ctx || !opts.childOptions) {
    throw new Error('runWorkflowModule requires either a backend or ctx + childOptions');
  }
  return createCodingWorkflowBackend({
    ctx: opts.ctx,
    childOptions: opts.childOptions,
    runId: opts.runId,
    defaultChildReadOnly: opts.module.meta.readOnly === true,
    kodaxAuthored: opts.processMetadata?.hostMetadata?.workflowAuthorship === 'kodax-generated',
  });
}

function withBeforeSpawn(
  backend: WorkflowAgentBackend,
  beforeSpawn: () => Promise<void>,
): WorkflowAgentBackend {
  return {
    ...backend,
    spawn: async (input) => {
      await beforeSpawn();
      return backend.spawn(input);
    },
  };
}

export interface RunWorkflowFromOptionsInput {
  readonly module: WorkflowModule;
  readonly args: unknown;
  readonly options: KodaXOptions;
  readonly runId: string;
  readonly runDir: string;
  readonly approval?: WorkflowApproval;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: WorkflowEvent) => void;
  readonly onWorkflowProcessEvent?: (event: WorkflowProcessEvent) => void;
  readonly now?: () => number;
  readonly scriptSnapshot?: WorkflowScriptSnapshotInput;
  /** FEATURE_246 Part D (ADR-048): prior run dir to seed the resume cache. */
  readonly resumeFromRunDir?: string;
  readonly processMetadata?: WorkflowRunProcessMetadata;
  readonly beforeSpawn?: () => Promise<void>;
}

/**
 * ADR-049: forward a single workflow child-agent terminal/summary event to the
 * REPL's per-agent digest hook. Coarse gate here (the four summary event types);
 * the REPL's `formatWorkflowAgentDigest` does the fine filtering (status, pending
 * summaries) so inline and slash `/workflow` digests stay identical.
 */
export function emitWorkflowAgentDigest(
  events: KodaXEvents | undefined,
  runId: string,
  event: WorkflowEvent,
): void {
  const hook = events?.onWorkflowAgentDigest;
  if (!hook) return;
  if (
    event.type === 'agent_completed' ||
    event.type === 'agent_unverified' ||
    event.type === 'agent_failed' ||
    event.type === 'agent_summary_updated'
  ) {
    hook({ runId, event });
  }
}

/**
 * High-level entry: build a tool-execution context + child options from
 * `KodaXOptions` (provider / model / extensionRuntime) and run the
 * workflow module. ctx construction stays inside `@kodax-ai/coding` — the
 * REPL passes plain `KodaXOptions` (from `createKodaXOptions`) rather than
 * reaching into run-loop internals.
 */
export async function runWorkflowFromOptions(
  input: RunWorkflowFromOptionsInput,
): Promise<RunWorkflowModuleOutcome> {
  const suppliedControl = input.options.context?.actorControl;
  const suppliedHost = input.options.context?.actorHost;
  if ((suppliedControl === undefined) !== (suppliedHost === undefined)) {
    throw new Error('Workflow Runtime requires actorControl and actorHost together.');
  }
  const ownedActorSession = suppliedControl || input.options.context?.actorSession ? undefined : new CodingActorSession({
    maxConcurrentThreadsPerSession: input.options.maxConcurrentThreadsPerSession,
    historyStorage: input.options.session?.storage,
  });
  const sessionOptions: KodaXOptions = ownedActorSession
    ? {
        ...input.options,
        context: { ...input.options.context, actorSession: ownedActorSession },
      }
    : input.options;
  const ctx = buildToolExecutionContext({
    options: sessionOptions,
    runtime: sessionOptions.extensionRuntime,
    managedProtocolPayloadRef: { current: undefined },
  });
  const parentControl = ctx.actorControl;
  const actorHost = ctx.actorHost;
  if (!parentControl || !actorHost) {
    throw new Error('Workflow execution requires the Runtime-owned Actor control plane.');
  }
  const ownerControl = await actorHost.createWorkflowOwner(parentControl.callerPath, input.runId);
  const ownerSignal = actorHost.workflowOwnerSignal(ownerControl.callerPath);
  const workflowSignal = combineAbortSignals(input.signal, ownerSignal);
  ctx.actorControl = ownerControl;
  ctx.actorHost = actorHost;
  const workflowOptions: KodaXOptions = {
    ...sessionOptions,
    context: { ...sessionOptions.context, actorControl: ownerControl, actorHost },
  };
  Object.assign(ctx, {
    // FEATURE_217 Layer B — workflow child worktrees nest under the run dir so
    // they are reclaimable and never pollute the user's project tree.
    workflowWorktreeBaseDir: workflowWorktreeBaseDir(input.runDir),
  });
  const childOptions: WorkflowChildOptions = {
    maxIterationsPerChild: DEFAULT_MAX_ITERATIONS_PER_CHILD,
    ...(workflowOptions.session?.storage !== undefined
      ? { historyStorage: workflowOptions.session.storage }
      : {}),
    parentRole: 'worker',
    // 'tool-dispatch' (not 'workflow') so write-capable children are NOT
    // silently dropped by `validateWriteBundles` — workflows dispatch
    // children through the same Actor child executor. Read-only children are
    // unaffected; the per-agent `readOnly` flag still controls write access.
    parentHarness: 'tool-dispatch',
    parentOptions: {
      provider: workflowOptions.provider,
      model: workflowOptions.modelOverride ?? workflowOptions.model,
      effort: workflowOptions.effort,
      reasoningMode: workflowOptions.reasoningMode,
      repoIntelligenceMode: workflowOptions.context?.repoIntelligenceMode,
      repoIntelligenceTrace: workflowOptions.context?.repoIntelligenceTrace,
      compaction: workflowOptions.compaction,
      contextDiagnostics: workflowOptions.context?.contextDiagnostics,
      permissionIntent: workflowOptions.context?.permissionIntent,
      disablePromptCache: workflowOptions.disablePromptCache,
      sandbox: workflowOptions.sandbox,
      extensionRuntime: workflowOptions.extensionRuntime,
      events: workflowOptions.events,
    },
    ...(input.options.guardrails ? { guardrails: input.options.guardrails } : {}),
    ...(ctx.planModeBlockCheck
      ? { planModeBlockCheck: ctx.planModeBlockCheck }
      : {}),
  };
  const onWorkflowProcessEvent =
    input.onWorkflowProcessEvent || input.options.events?.onWorkflowProcessEvent
      ? (event: WorkflowProcessEvent): void => {
          input.onWorkflowProcessEvent?.(event);
          workflowOptions.events?.onWorkflowProcessEvent?.(event);
        }
      : undefined;
  // ADR-049: alongside the aggregate process strip, forward each child agent's
  // terminal/summary event to the REPL so its digest lands in the transcript
  // (parity with the slash path + adaptive Agent completion). Preserves any caller
  // `input.onEvent` (the run-manager's snapshot tracking) by always calling it.
  const onEvent =
    input.onEvent || workflowOptions.events?.onWorkflowAgentDigest
      ? (event: WorkflowEvent): void => {
          input.onEvent?.(event);
          emitWorkflowAgentDigest(workflowOptions.events, input.runId, event);
        }
      : undefined;
  try {
    const moduleOutcome = await runWorkflowModule({
      module: input.module,
      args: input.args,
      runId: input.runId,
      runDir: input.runDir,
      ctx,
      childOptions,
      ...(input.approval ? { approval: input.approval } : {}),
      signal: workflowSignal,
      ...(onEvent ? { onEvent } : {}),
      ...(onWorkflowProcessEvent ? { onWorkflowProcessEvent } : {}),
      ...(workflowOptions.workflowHostPolicy ? { hostPolicy: workflowOptions.workflowHostPolicy } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.scriptSnapshot ? { scriptSnapshot: input.scriptSnapshot } : {}),
      ...(input.resumeFromRunDir ? { resumeFromRunDir: input.resumeFromRunDir } : {}),
      ...(input.processMetadata ? { processMetadata: input.processMetadata } : {}),
      ...(input.beforeSpawn ? { beforeSpawn: input.beforeSpawn } : {}),
    });
    const protocolOutcome = workflowProtocolOutcome(input.runId, moduleOutcome);
    await actorHost.settleWorkflowOwner(
      ownerControl.callerPath,
      protocolOwnerState(protocolOutcome),
      {
        output: JSON.stringify(protocolOutcome),
        structured: toAgentMetadata(protocolOutcome),
        artifacts: protocolOutcome.artifacts
          .map((artifact) => artifact.path ?? artifact.name)
          .filter(Boolean),
        ...(moduleOutcome.kind === 'failed' ? { error: moduleOutcome.error.message } : {}),
      },
    );
    return moduleOutcome;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const protocolOutcome = buildWorkflowOutcome({
      state: {
        runId: input.runId,
        status: ownerSignal.aborted ? 'stopped' : 'failed',
        totalSpawned: 0,
        results: [],
        events: [],
        artifacts: [],
      },
      error: failure,
    });
    try {
      await actorHost.settleWorkflowOwner(
        ownerControl.callerPath,
        protocolOwnerState(protocolOutcome),
        {
          output: JSON.stringify(protocolOutcome),
          structured: toAgentMetadata(protocolOutcome),
          error: failure.message,
        },
      );
    } catch (settlementError) {
      throw new AggregateError([failure, settlementError], 'Workflow execution and owner settlement failed.');
    }
    throw failure;
  } finally {
    await ownedActorSession?.close('workflow run finished');
  }
}

function workflowProtocolOutcome(
  runId: string,
  outcome: RunWorkflowModuleOutcome,
): WorkflowOutcome {
  if (outcome.kind === 'denied') {
    return buildWorkflowOutcome({
      state: {
        runId,
        status: 'stopped',
        totalSpawned: 0,
        results: [],
        events: [],
        artifacts: [],
      },
      summary: `Workflow ${runId} was declined.`,
    });
  }
  return buildWorkflowOutcome({
    state: outcome.state,
    ...(outcome.kind === 'completed'
      ? { summary: workflowResultSummary(outcome.result) }
      : { error: outcome.error }),
  });
}

function protocolOwnerState(
  outcome: WorkflowOutcome,
): 'completed' | 'failed' | 'interrupted' {
  if (outcome.status === 'failed') return 'failed';
  if (outcome.status === 'interrupted') return 'interrupted';
  return 'completed';
}

function combineAbortSignals(
  supplied: AbortSignal | undefined,
  owner: AbortSignal,
): AbortSignal {
  return supplied ? AbortSignal.any([supplied, owner]) : owner;
}

function toAgentMetadata(value: WorkflowOutcome): AgentMetadataValue {
  return JSON.parse(JSON.stringify(value)) as AgentMetadataValue;
}
