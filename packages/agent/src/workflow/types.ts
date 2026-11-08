/**
 * FEATURE_217 (v0.7.49) — Dynamic Workflow Harness Runtime: public types.
 *
 * Domain-neutral workflow orchestration surface. A workflow *script*
 * coordinates (decompose / fan-out / loop / wait / stop / verify /
 * synthesize); it never touches files or shell directly. The actual
 * agent execution is delegated to an injected `WorkflowAgentBackend`
 * (the coding layer provides the real one in Phase B; tests inject a
 * fake). This keeps `@kodax-ai/agent` free of any `@kodax-ai/coding`
 * dependency (ADR-021 layer independence).
 */

/** Lifecycle status of a single workflow-spawned agent. */
export type WorkflowTaskStatus =
  | 'running'
  | 'completed'
  | 'completed_unverified'
  | 'failed'
  | 'stopped';

/** Routing hint for which provider/model tier the child should use. */
export type WorkflowModelHint = 'fast' | 'balanced' | 'deep';

/** Isolation policy for a spawned agent. `shared-cwd` is the default
 *  (FEATURE_188); `worktree` is opt-in for high-risk parallel writes. */
export type WorkflowIsolation = 'shared-cwd' | 'worktree';

/**
 * Machine-checkable postconditions for a workflow child task. The agent
 * package only defines the contract; concrete backends decide which evidence
 * they can verify.
 */
export interface WorkflowTaskVerification {
  readonly enforcement?: 'hard' | 'warn';
  readonly requiresMutation?: boolean;
  readonly requiredChangedPaths?: readonly string[];
  /** Read-tool paths that must be observed before accepting a review verdict. */
  readonly requiredReadPaths?: readonly string[];
  readonly minFinalTextChars?: number;
  readonly rejectPreparatoryFinalText?: boolean;
}

export interface WorkflowTaskVerificationResult {
  readonly ok: boolean;
  readonly enforcement?: 'hard' | 'warn';
  readonly reasons: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly mutationToolCalls?: readonly string[];
  readonly mutationEvidence?: boolean;
  readonly readPaths?: readonly string[];
}

export interface WorkflowAgentTarget {
  readonly agentId: string;
  readonly expectedConfigurationRevision?: string;
}

export interface WorkflowSpawnAgentInput {
  /** Human-readable label for the agent — surfaces in events / UI. */
  readonly name: string;
  /**
   * Optional progress-group tag (FEATURE_246 Part E). When set, this agent is
   * grouped under a phase of that name in the progress display — the per-agent
   * equivalent of wrapping a block in `wf.phase(name, fn)`, matching the harness
   * `agent(..., { phase })`. The phase group is created on first use. Agents
   * with no `phase` fall under the currently-active `wf.phase(...)` block (if any).
   */
  readonly phase?: string;
  /** The task prompt handed to the child agent. */
  readonly prompt: string;
  /** Compact scope summary copied into the child briefing without retyping the diff. */
  readonly scopeSummary?: string;
  /** Binding constraints/interfaces the child cannot discover locally. */
  readonly constraints?: readonly string[];
  /** When true, the child runs with a read-only tool whitelist. */
  readonly readOnly?: boolean;
  /** Route to a registered specialist agent (FEATURE_191). */
  readonly subagentType?: string;
  /** Route through the shared dispatchable-agent catalog (FEATURE_258). */
  readonly target?: WorkflowAgentTarget;
  /**
   * Per-agent model TIER (FEATURE_120 model_hint). The script expresses semantic
   * intent — 'fast' (cheap), 'deep' (strong), 'balanced' (default) — NOT a
   * concrete model name: the authoring model has no cognition of which
   * providers/models a given operator has configured. The operator maps the
   * tiers to concrete models via env (KODAX_FAST/DEEP_PROVIDER/MODEL); when a
   * tier is unconfigured the child inherits the parent provider/model. 'fast'
   * applies to read-only children
   * only (write/codegen stays on the parent tier — a quality guard).
   */
  readonly modelHint?: WorkflowModelHint;
  /** Isolation policy; defaults to `shared-cwd`. */
  readonly isolation?: WorkflowIsolation;
  /** Per-child reasoning effort hint (e.g. 'low' | 'medium' | 'high' | 'max').
   *  The backend maps it onto the child's reasoning resolver; omit to inherit
   *  the parent/default effort. Opaque string so the agent layer needs no
   *  coding effort-enum dependency. */
  readonly effort?: string;
  /** Evidence refs (`task_id:<id>` etc.) seeded into the child context. */
  readonly evidenceRefs?: readonly string[];
  /** Optional machine-checkable postconditions for this child task. */
  readonly verification?: WorkflowTaskVerification;
  /**
   * Optional JSON Schema (FEATURE_246 Part B). When set, the child is asked to
   * end with a fenced JSON block matching the schema; the backend parses and
   * validates it (with one bounded repair turn on a hard miss) and returns the
   * parsed object on `WorkflowTaskResult.structured`. Orthogonal to
   * `verification` (which checks side-effects, not return shape). Carried as an
   * opaque value so the agent layer needs no JSON-Schema dependency.
   */
  readonly outputSchema?: unknown;
  /** Register concise finalText for digest reuse; trusted host provenance is checked separately. */
  readonly terseResult?: boolean;
}

/** Returned by `spawnAgent` — the child is in-flight, not yet complete. */
export interface WorkflowTaskHandle {
  readonly taskId: string;
  readonly name: string;
}

export interface WorkflowTaskUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
}

export type WorkflowTaskSummaryKind = 'digest' | 'excerpt' | 'digest-failed' | 'pending';

export interface WorkflowTaskSummaryEventUpdate {
  readonly summary?: string;
  readonly summaryKind: WorkflowTaskSummaryKind;
  readonly usage?: WorkflowTaskUsage;
}

/** Terminal result of a spawned agent (from `wait` / `runAgent`). */
export interface WorkflowTaskResult {
  readonly taskId: string;
  readonly name: string;
  readonly status: WorkflowTaskStatus;
  readonly finalText: string;
  /** Schema-validated structured result (FEATURE_246 Part B), present when the
   *  spawn carried `outputSchema` and a JSON value was parsed from the child's
   *  output. The workflow script consumes it directly (e.g. `result.structured`). */
  readonly structured?: unknown;
  /** Durable artifacts produced by this Agent turn. */
  readonly artifacts?: readonly string[];
  /** Short user-facing digest, separate from the full finalText used for synthesis/audit. */
  readonly digest?: string;
  /** True when a digest was attempted but failed (error/timeout/empty); the UI then labels the excerpt fallback. */
  readonly digestFailed?: boolean;
  /** True when a digest was scheduled asynchronously and may arrive via `agent_summary_updated`. */
  readonly digestPending?: boolean;
  /** Task postcondition check, when a backend evaluated one. */
  readonly verification?: WorkflowTaskVerificationResult;
  /** True when the child exhausted its iteration budget before completing. */
  readonly limitReached?: boolean;
  /** Best-known provider/model used by the child, for host correlation only. */
  readonly provider?: string;
  readonly model?: string;
  /** Requested semantic tier and how the local runtime resolved it. */
  readonly requestedTier?: WorkflowModelHint | 'inherited';
  readonly tierOutcome?:
    | 'applied'
    | 'balanced-parent'
    | 'fast-write-ineligible'
    | 'unconfigured'
    | 'shadowed-by-selector'
    | 'inherited';
  readonly providerSource?: 'explicit' | 'specialist' | 'tier' | 'parent' | 'default';
  readonly modelSource?: 'explicit' | 'specialist' | 'tier' | 'parent';
  readonly initialProvider?: string;
  readonly initialModel?: string;
  readonly finalProvider?: string;
  readonly finalModel?: string;
  readonly fallbackReason?: string;
  readonly resolvedEffort?: string;
  readonly iterations?: number;
  readonly durationMs?: number;
  readonly digestUsage?: WorkflowTaskUsage;
  readonly usage?: WorkflowTaskUsage;
}

/** Point-in-time snapshot of a (possibly still-running) agent. */
export interface WorkflowTaskSnapshot {
  readonly taskId: string;
  readonly name: string;
  readonly status: WorkflowTaskStatus;
  readonly lastText?: string;
}

export interface WorkflowWaitOptions {
  readonly timeoutMs?: number;
}

export interface WorkflowParallelOptions {
  /** In-flight cap for this parallel block; clamped by workflow
   *  maxConcurrency. */
  readonly concurrency?: number;
}

export interface WorkflowSynthesizeInput {
  readonly inputs: readonly unknown[] | string | Record<string, unknown>;
  readonly rubric: string;
}

export interface WorkflowSynthesis {
  readonly text: string;
}

export interface WorkflowArtifactRef {
  readonly name: string;
  readonly path?: string;
}

export interface WorkflowLogEvent {
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Token budget accounting. The runtime hard-stops before launching a new
 * agent once completed children have exhausted the configured budget.
 */
export interface WorkflowBudget {
  /** Configured token budget, or null when unbounded. */
  readonly total: number | null;
  /** Tokens accounted across completed agents so far. */
  spent(): number;
  /** `max(0, total - spent())`, or Infinity when unbounded. */
  remaining(): number;
}

export interface WorkflowLimits {
  /** Total agents spawnable across the whole run lifetime. */
  readonly maxAgents?: number;
  /** Maximum simultaneously in-flight agents (via runAgent / parallel). */
  readonly maxConcurrency?: number;
  /** Token budget. New spawns stop once completed usage exhausts it. */
  readonly tokenBudget?: number;
}

/**
 * The surface a workflow script consumes. The script never gets raw
 * fs/shell — all effects route through agent tools behind the backend.
 */
export interface WorkflowApi {
  /** Host-side cancellation; restricted scripts receive only the RPC facade. */
  readonly signal?: AbortSignal;
  readonly runId: string;
  readonly args: unknown;
  readonly budget: WorkflowBudget;

  /** Group operations under a named phase (emits phase_started/finished). */
  phase<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Start a child agent; returns immediately with a handle. */
  spawnAgent(input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle>;
  /** spawnAgent + wait convenience; returns the terminal result, or `null` if
   *  the child ended failed/stopped (FEATURE_246 Part E lenient failure — the
   *  harness `agent()` semantics, so scripts can `.filter(Boolean)` instead of
   *  wrapping every call in try/catch). Abort and budget/agent-cap limits still
   *  throw. */
  runAgent(input: WorkflowSpawnAgentInput): Promise<WorkflowTaskResult | null>;
  /** Await a spawned agent's terminal result. */
  wait(taskId: string, opts?: WorkflowWaitOptions): Promise<WorkflowTaskResult>;
  /** Snapshot a (possibly running) agent. */
  snapshot(taskId: string): Promise<WorkflowTaskSnapshot>;
  /** Snapshot a (possibly running) agent.
   *  @deprecated Prefer `snapshot(taskId)`; `output` is kept as a compatibility alias. */
  output(taskId: string): Promise<WorkflowTaskSnapshot>;
  /** Send a message to a running Agent through its Actor mailbox. */
  send(taskId: string, content: string): Promise<void>;
  /** Stop a running agent (graceful abort). */
  stop(taskId: string, reason: string): Promise<void>;
  /** Run lazy thunks concurrently under the concurrency gate. Thunks
   *  MUST be `() => Promise<T>` (not already-started promises) so the
   *  runtime can bound concurrency. A thunk that throws (or whose agent fails)
   *  resolves to `null` in the result array — the call itself never rejects, so
   *  `.filter(Boolean)` before use (FEATURE_246 Part E, harness parity). Abort
   *  still tears down the whole run. */
  parallel<T>(
    items: readonly (() => Promise<T>)[],
    opts?: WorkflowParallelOptions,
  ): Promise<(T | null)[]>;
  /**
   * Stream items through ordered stages with NO barrier between stages: an
   * item advances to stage N+1 as soon as its own stage N resolves,
   * independent of other items (wall-clock = slowest single chain, not
   * sum-of-slowest-per-stage). Each stage receives `(prev, item, index)`
   * where `prev` is the previous stage's result (the original item at
   * stage 1). A stage that throws drops that item to `null` and skips its
   * remaining stages; results preserve input order. Agent spawns inside
   * stages stay bounded by the workflow `maxConcurrency` gate. Optional:
   * the restricted-script bootstrap always provides it; SDK consumers get
   * it from the runtime. */
  pipeline?(
    items: readonly unknown[],
    ...stages: readonly ((prev: unknown, item: unknown, index: number) => unknown)[]
  ): Promise<unknown[]>;
  /** Synthesize across inputs. Runs as a gated agent through the runtime
   *  (spawn → wait), so it counts toward maxAgents / concurrency / budget
   *  and emits run-graph events — it is NOT a backend side-channel. */
  synthesize(input: WorkflowSynthesizeInput): Promise<WorkflowSynthesis>;
  /**
   * Run another saved/built-in workflow inline as a sub-step (FEATURE_246 Part E,
   * harness parity). Resolves the module by name via the host-injected resolver
   * and runs it under THIS run's runtime — sharing the same concurrency cap,
   * agent counter, token budget, and abort signal. **One level only**: calling
   * `workflow(...)` from inside a nested workflow throws. Returns whatever the
   * sub-workflow's `run` returns. Optional: present when a resolver is wired
   * (the restricted-script bootstrap provides it; SDK consumers may omit). */
  workflow?(name: string, args?: unknown): Promise<unknown>;
  /** Persist a named artifact. */
  artifact(name: string, value: unknown): Promise<WorkflowArtifactRef>;
  /** Emit a free-text progress log event. */
  log(event: WorkflowLogEvent): void;
}

/** Metadata a workflow declares (name, description, default caps). */
export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  /** Best-effort expected child-agent count for progress UI; not a hard cap. */
  readonly plannedAgents?: number;
  readonly maxAgents?: number;
  readonly maxConcurrency?: number;
  readonly tokenBudget?: number;
  /** True when the workflow only ever spawns read-only agents (no file
   *  writes) — surfaced in the approval prompt. */
  readonly readOnly?: boolean;
  /** Declared phase names, for the approval prompt preview. */
  readonly phases?: readonly string[];
}

/** Summary shown to the user before a workflow's first run. */
export interface WorkflowApprovalSummary {
  readonly name: string;
  readonly description: string;
  readonly phases: readonly string[];
  readonly plannedAgents?: number;
  readonly maxAgents: number | null;
  readonly maxConcurrency: number | null;
  readonly tokenBudget: number | null;
  /** Whether the workflow may write files (false for read-only workflows). */
  readonly writesFiles: boolean;
}

/** Approval gate — returns true to proceed, false to cancel the run. */
export type WorkflowApproval = (
  summary: WorkflowApprovalSummary,
) => boolean | Promise<boolean>;

/** A workflow's entry function: coordinates agents via the `WorkflowApi`. */
export type WorkflowRun<TArgs = unknown, TResult = unknown> = (
  wf: WorkflowApi,
  args: TArgs,
) => Promise<TResult>;

/** A self-contained workflow: metadata + entry function. Built-in
 *  workflows (Phase C) and saved `.kodax/workflows/*.ts` (Phase E) both
 *  materialize to this shape. */
export interface WorkflowModule<TArgs = unknown, TResult = unknown> {
  readonly meta: WorkflowMeta;
  readonly run: WorkflowRun<TArgs, TResult>;
}

/** Injected execution backend over the host's Runtime-owned Actor plane. */
export interface WorkflowAgentBackend {
  spawn(input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle>;
  /** Wait until the global Actor scheduler can admit a step. False means no slot can ever exist. */
  waitForAgentCapacity?(signal?: AbortSignal): Promise<boolean>;
  wait(taskId: string, opts?: WorkflowWaitOptions): Promise<WorkflowTaskResult>;
  output(taskId: string): Promise<WorkflowTaskSnapshot>;
  send(taskId: string, content: string): Promise<void>;
  stop(taskId: string, reason: string): Promise<void>;
  /** Optional late summary stream for presentation-only async digests. */
  subscribeTaskSummaryUpdates?(
    listener: (taskId: string, update: WorkflowTaskSummaryEventUpdate) => void,
  ): () => void;
  /** Optional durable artifact writer (Phase D wires the run graph).
   *  `wf.synthesize` is NOT a backend method — it runs as a gated agent
   *  through `spawn`/`wait` so it counts toward the runtime's caps. */
  writeArtifact?(name: string, value: unknown): Promise<WorkflowArtifactRef>;
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type WorkflowOutcomeStatus = 'completed' | 'partial' | 'failed' | 'interrupted';

export interface WorkflowOutcomeResult {
  readonly taskId: string;
  readonly name: string;
  readonly status: WorkflowTaskStatus;
  readonly summary: string;
  readonly structured?: unknown;
  readonly artifacts: readonly string[];
  readonly usage?: WorkflowTaskUsage;
}

export interface WorkflowOutcomeError {
  readonly taskId?: string;
  readonly name?: string;
  readonly message: string;
}

export interface WorkflowOutcomeUsage extends WorkflowTaskUsage {
  readonly totalSpawned: number;
}

/** Stable terminal payload exposed through the Workflow protocol owner's Agent output. */
export interface WorkflowOutcome {
  readonly runId: string;
  readonly status: WorkflowOutcomeStatus;
  readonly summary: string;
  readonly results: readonly WorkflowOutcomeResult[];
  readonly artifacts: readonly WorkflowArtifactRef[];
  readonly coverage: readonly string[];
  readonly unresolved: readonly string[];
  readonly errors: readonly WorkflowOutcomeError[];
  readonly usage: WorkflowOutcomeUsage;
}

/** Immutable snapshot of a workflow run's accumulated state. */
export interface WorkflowRunState {
  readonly runId: string;
  readonly status: WorkflowRunStatus;
  readonly totalSpawned: number;
  readonly results: readonly WorkflowTaskResult[];
  readonly events: readonly import('./events.js').WorkflowEvent[];
  readonly artifacts: readonly WorkflowArtifactRef[];
}
