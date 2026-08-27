/**
 * Child Agent Executor — FEATURE_067
 *
 * Core execution engine for nested and Workflow child agents.
 * Read children share parent cwd; write children share parent cwd as well
 * (FEATURE_188 v0.7.42 dropped forced worktree — per-file `backups` Map is
 * the per-child rollback substrate; prompt-level peer coordination handles
 * concurrent conflict avoidance, see ADR-034).
 */

import { execFileSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import type {
  KodaXChildContextBundle,
  KodaXChildAgentResult,
  KodaXChildExecutionResult,
  KodaXChildFinding,
  KodaXChildRouteFacts,
  KodaXChildTierOutcome,
  KodaXChildRouteSource,
  KodaXActivityEventMeta,
  KodaXEvents,
  KodaXMessage,
  KodaXContextOptions,
  KodaXOptions,
  KodaXResult,
  KodaXToolEventMeta,
  KodaXToolExecutionContext,
  KodaXWireReasoningEffort,
} from './types.js';
import { resolveExecutionCwd, resolveExecutionPath } from './runtime-paths.js';
import { actorQueueId } from './agent-runtime/actor-queue.js';
import { countTokens } from './tokenizer.js';
import { resolveProvider } from './providers/index.js';
import { resolveModelHintTier } from './model-hint-routing.js';
import { invokeChildWithFallback } from './child-fallback.js';
import { createWorkflowWorktree, removeWorkflowWorktree } from './tools/worktree.js';
import { loadAgentsFiles, formatAgentsForPrompt } from './context/agents-loader.js';
import {
  parseBareInlineSlashReferences,
  parseInlineSkillReferences,
} from './skill-references.js';
import {
  buildStructuredOutputInstruction,
  buildStructuredOutputRepairPrompt,
  evaluateStructuredOutput,
} from './workflows/structured-output.js';
import { parsePatternDispositionEnvelope } from './orchestration/pattern-result.js';
import { parseActorTurnEvidenceRef } from './orchestration/pattern-strategy.js';
// FEATURE_120 v0.7.39 Step 0d (Option D) — generic fan-out lifted to
// @kodax-ai/agent (ADR-021). All coding-side concerns (read vs write,
// worktree isolation, briefing, role policy) stay below; the wrapper
// owns only bounded concurrency + abort + progress eventing.
import {
  calculateMaxContextInputTokens,
  getSkillRegistry,
  initializeSkillRegistry,
  runFanOut,
  type ISkillRegistry,
} from '@kodax-ai/agent';
import { normalizeReasoningEffortValue } from '@kodax-ai/llm';
// FEATURE_191 — specialist agent override resolution. `resolveConstructedAgent`
// returns `Agent | undefined`; the Actor adapter has already
// rejected unknown names before bundle construction, so a re-resolve here is
// expected to succeed for any bundle that carries `specialistName`.
// `getAllRegisteredTools` powers the complementary excludeTools computation
// (`KodaXOptions.context` has no `includeOnlyTools` API; the inverse subset
// is the YAGNI-compliant substitute per ADR-035 R11).
import {
  constructedAgentToolCeiling,
  resolveConstructedAgentEntry,
} from './construction/agent-resolver.js';
import { getAllRegisteredTools } from './tools/registry.js';
import {
  applyToolResultBatchGuardrail,
  ToolResultBatchCapacityError,
} from './tools/tool-result-policy.js';
import type {
  Agent,
  AgentCapabilities,
  GuardrailPermissionIntent,
  KodaXSessionStorage,
  WorkflowEventCorrelation,
} from '@kodax-ai/agent';
// FEATURE_093 (v0.7.24): lazy-load `runKodaX` to break the cycle
// `agent.ts → extensions/runtime.ts → tools/index.ts → tools/registry.ts
// → child-executor.ts → agent.ts`. The runtime import defers agent resolution
// until a child is actually spawned, by which point the parent module graph
// has fully initialised. No top-level `import ... from './agent.js'` or
// `typeof import('./agent.js')` references — both count as edges in madge.
type RunKodaXFn = (options: KodaXOptions, prompt: string) => Promise<KodaXResult>;
let _runKodaXCache: RunKodaXFn | undefined;
let _runKodaXLoadPromise: Promise<RunKodaXFn> | undefined;
async function getRunKodaX(): Promise<RunKodaXFn> {
  if (_runKodaXCache) return _runKodaXCache;
  if (!_runKodaXLoadPromise) {
    // The specifier MUST be a string literal inside import(). esbuild only
    // bundles dynamic imports whose argument is a literal; a computed
    // specifier (e.g. `const spec = './agent.js'; import(spec)`) is left as a
    // raw runtime import that resolves relative to the *bundle* location
    // (dist/kodax_cli.js → dist/agent.js, which does not exist) and breaks
    // every nested Agent turn in the packaged CLI. The dynamic import still
    // breaks the require cycle (FEATURE_093) because it defers agent-module
    // initialisation to first child spawn — esbuild wraps the inlined target
    // in a lazily-evaluated factory, so the literal does not re-introduce an
    // eager-eval cycle.
    const spec = './agent.js';
    // v0.7.26 Risk-6 fix — wrap the dynamic import in an explicit
    // error envelope. The cycle-break via dynamic-import is a deliberate
    // design choice (FEATURE_093), but if `./agent.js` ever fails to
    // resolve at runtime (broken build, moved export, circular-import
    // still tripping), the vanilla native error surfaces as a cryptic
    // "Cannot find module './agent.js'" deep inside a dispatch call.
    // Restate what went wrong + what the caller should check.
    _runKodaXLoadPromise = import('./agent.js')
      .then((agentModule: { runKodaX?: RunKodaXFn }) => {
        const runKodaX = agentModule.runKodaX;
        if (typeof runKodaX !== 'function') {
          throw new Error(
            `[child-executor] Agent module loaded but \`runKodaX\` export is missing or not a function. ` +
            `This indicates an API break in packages/coding/src/agent.ts. ` +
            `Check that \`export { runKodaX }\` is still present.`,
          );
        }
        _runKodaXCache = runKodaX;
        return runKodaX;
      })
      .catch((err: unknown) => {
        _runKodaXLoadPromise = undefined;
        if (err instanceof Error && err.message.startsWith('[child-executor]')) {
          throw err;
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[child-executor] Failed to lazy-load agent module (\`${spec}\`) for a nested Agent turn. ` +
          `This usually means the @kodax-ai/coding build is broken or out of date. ` +
          `Underlying cause: ${detail}`,
        );
      });
  }
  return _runKodaXLoadPromise;
}

const WORKFLOW_CHILD_DIGEST_SYSTEM_PROMPT = [
  'You are summarizing your own just-completed child-agent report for a parent workflow.',
  'Do not use tools. Do not continue investigation. Produce only the digest.',
].join('\n');

const WORKFLOW_CHILD_DIGEST_PROMPT = [
  'Create a short user-facing digest of your previous report for the parent workflow.',
  'Return only 2-4 bullet lines.',
  'Each bullet must be concrete: a finding, decision, risk, evidence pointer, unresolved question, or next action.',
  'Use the same natural language as the user request or your report.',
  'Do not include a title, table, generic preamble, or workflow handoff markers.',
].join('\n');

const WORKFLOW_CHILD_DIGEST_MAX_LINES = 4;

// Bound the best-effort self-distill so a rate-limited / slow digest cannot
// make a completed child appear stuck. Blocking paths keep a short window;
// async workflow digests can wait longer because child completion is already
// visible and the late summary is presentation-only.
const WORKFLOW_CHILD_DIGEST_BLOCKING_TIMEOUT_MS = 10_000;
const WORKFLOW_CHILD_DIGEST_ASYNC_TIMEOUT_MS = 45_000;
const CHILD_SKILL_SUPPORT_FILE_LINE_LIMIT = 40;

/* ---------- Public API ---------- */

/**
 * Predicate the parent REPL injects so the child executor can enforce plan-mode
 * constraints without `packages/coding` reverse-depending on `packages/repl`.
 *
 * The predicate MUST read the parent's permission mode lazily (e.g., through a
 * closure over a ref), so mid-run mode toggles propagate to in-flight child tool
 * calls. Returns the block reason (string) for tools/inputs that are currently
 * plan-mode-violating, or `null` when the call is allowed right now.
 */
export type PlanModeBlockCheck = (
  tool: string,
  input: Record<string, unknown>,
) => string | null;

export interface WorkflowChildDigestUpdate {
  readonly childId: string;
  readonly digest?: string;
  readonly digestFailed?: boolean;
  readonly totalTokensUsed: number;
  readonly digestTokensUsed?: number;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cacheReadTokens?: number;
  };
}

export interface ChildExecutorOptions {
  readonly maxParallel: number;
  readonly maxIterationsPerChild: number;
  readonly abortSignal?: AbortSignal;
  /** Parent-provided persistence capability for an isolated child-owned lineage. */
  readonly historyStorage?: KodaXSessionStorage;
  readonly parentOptions: Readonly<Partial<
    Pick<KodaXOptions, 'provider' | 'model' | 'effort' | 'reasoningMode' | 'extensionRuntime' | 'events' | 'compaction' | 'disablePromptCache' | 'sandbox'>
    & Pick<KodaXContextOptions, 'repoIntelligenceMode' | 'repoIntelligenceTrace' | 'contextDiagnostics' | 'shellExecution' | 'permissionIntent'>
  >>;
  readonly parentRole: string;
  readonly parentHarness: string;
  /**
   * FEATURE_217 (v0.7.49): set by the workflow agent backend to enable the
   * one-turn, no-tool self-distill digest for workflow-launched children.
   * Distinct from `parentHarness` because workflow children must keep
   * `parentHarness:'tool-dispatch'` so `validateWriteBundles` still admits
   * write children — the two concerns cannot share one field.
   */
  readonly workflowChild?: boolean;
  /**
   * Workflow child digest mode. `blocking` preserves FEATURE_217 behavior.
   * `async` returns the child result immediately and reports the digest through
   * `onWorkflowChildDigest`; worktree-isolated children still use blocking mode
   * so the digest runs before cleanup removes the worktree.
   */
  readonly workflowDigestMode?: 'blocking' | 'async';
  readonly onWorkflowChildDigest?: (update: WorkflowChildDigestUpdate) => void;
  readonly workflowCorrelation?: WorkflowEventCorrelation;
  /** User-facing child label for live telemetry surfaces. Defaults to bundle id. */
  readonly childActivityName?: string;
  /** Progress callback for REPL status display. Called when children start, progress, and complete. */
  readonly onProgress?: (status: string) => void;
  /**
   * FEATURE_074: Predicate provided by the parent REPL to evaluate plan-mode block
   * reasons at each child tool call. The predicate closes over parent state so
   * mid-run mode toggles propagate to in-flight children. When absent, children
   * run without plan-mode enforcement.
   */
  readonly planModeBlockCheck?: PlanModeBlockCheck;

  /**
   * FEATURE_092 phase 2b.7b slice D: parent-Runner guardrails forwarded into
   * each child's `Runner.run` via `KodaXOptions.guardrails`. The auto-mode
   * guardrail's mutable state (engine + denialTracker + circuitBreaker) is
   * shared by passing the SAME instance — preventing children from reaching
   * a fresh threshold and bypassing the parent's downgrade.
   */
  readonly guardrails?: readonly import('@kodax-ai/agent').Guardrail[];

  /** Runtime-minted principal inherited by the child runtime for recursive collaboration. */
  readonly actorControl?: import('@kodax-ai/agent').AgentActorClient;
  /** Exact non-root parent identity for nested live-context attribution. */
  readonly actorParentAgentId?: string;
  /** Exact admitted Actor Turn id used as the child run's live Turn identity. */
  readonly actorTurnId?: string;
  /** Trusted host bridge inherited beside the principal for nested Workflow owners. */
  readonly actorHost?: import('./types.js').KodaXActorHost;
  /** Prior Actor turns and committed mailbox facts projected into this turn. */
  readonly initialMessages?: readonly import('./types.js').KodaXMessage[];
  /** Runtime-minted ceiling applied after specialist/default tool resolution. */
  readonly actorCapabilities?: AgentCapabilities;
  /** Logical diagnostics identity when bundle ids are local to a Workflow backend. */
  readonly contextAgentId?: string;
  /** Logical diagnostics parent paired with contextAgentId. */
  readonly contextParentAgentId?: string;
}

function buildChildRunSession(
  options: ChildExecutorOptions,
  initialMessages?: readonly KodaXMessage[],
): KodaXOptions['session'] | undefined {
  if (!options.historyStorage) {
    return initialMessages && initialMessages.length > 0
      ? { initialMessages: [...initialMessages] }
      : undefined;
  }
  return {
    id: `worker-${randomUUID()}`,
    scope: 'managed-task-worker',
    storage: options.historyStorage,
    ...(initialMessages && initialMessages.length > 0
      ? { initialMessages: [...initialMessages] }
      : {}),
  };
}

function inheritRepoIntelligenceContext(
  options: ChildExecutorOptions,
): Partial<Pick<KodaXContextOptions, 'repoIntelligenceMode' | 'repoIntelligenceTrace'>> {
  const inherited: Partial<Pick<KodaXContextOptions, 'repoIntelligenceMode' | 'repoIntelligenceTrace'>> = {};
  if (options.parentOptions.repoIntelligenceMode !== undefined) {
    inherited.repoIntelligenceMode = options.parentOptions.repoIntelligenceMode;
  }
  if (options.parentOptions.repoIntelligenceTrace !== undefined) {
    inherited.repoIntelligenceTrace = options.parentOptions.repoIntelligenceTrace;
  }
  return inherited;
}

export async function executeChildAgents(
  bundles: readonly KodaXChildContextBundle[],
  parentCtx: KodaXToolExecutionContext,
  options: ChildExecutorOptions,
): Promise<KodaXChildExecutionResult> {
  if (bundles.length === 0) {
    return EMPTY_RESULT;
  }

  const readBundles = bundles.filter((b) => b.readOnly);
  const writeBundles = bundles.filter((b) => !b.readOnly);

  // Validate write bundles: only H2 Generator allowed
  const allowedWriteBundles = validateWriteBundles(
    writeBundles,
    options.parentRole,
    options.parentHarness,
  );

  const allBundles = [...readBundles, ...allowedWriteBundles];
  if (allBundles.length === 0) {
    return EMPTY_RESULT;
  }

  const results: KodaXChildAgentResult[] = [];
  const cancelledChildren: string[] = [];
  const report = options.onProgress ?? (() => {});

  report(`Starting ${allBundles.length} child tasks in parallel`);

  // FEATURE_120 v0.7.39 Step 0d — bounded-concurrency + abort + progress
  // events are owned by `runFanOut` (agent-layer, ADR-021). This call
  // preserves the previous semantics:
  //   - Promise.allSettled-style rejection capture → `result.results`
  //   - Pre-execution abort check → `result.cancelled`
  //   - Per-bundle progress callbacks adapted to the legacy string-based
  //     `onProgress` contract.
  // Note: `result.results` is in COMPLETION order (not bundle order). We
  // use the embedded bundle reference on each outcome, not array index,
  // to attribute crashes back to their bundle.
  const fanOut = await runFanOut<KodaXChildContextBundle, KodaXChildAgentResult>({
    bundles: allBundles,
    runOne: (bundle) =>
      bundle.readOnly
        ? executeReadChild(bundle, parentCtx, options)
        : executeWriteChild(bundle, parentCtx, options),
    maxParallel: options.maxParallel,
    abortSignal: options.abortSignal,
    onProgress: (event, ctx) => {
      if (event.kind === 'start') {
        report(`[${ctx.completedCount}/${ctx.totalCount}] Running: ${event.bundle.id}`);
      } else if (event.kind === 'item-done') {
        report(`[${ctx.completedCount}/${ctx.totalCount}] Done: ${event.bundle.id} → ${event.result.status}`);
      }
      // `item-failed` events are absorbed into the crash branch below —
      // the rejection's bundle.id was already surfaced via `start`, and
      // the synthesized `[Crash]` result will appear in `results`.
    },
  });

  for (const r of fanOut.results) {
    if (r.status === 'fulfilled') {
      results.push(r.value);
    } else {
      results.push(extractChildResult(r.bundle, `[Crash] ${r.reason.message}`, 'failed'));
    }
  }
  for (const b of fanOut.cancelled) {
    cancelledChildren.push(b.id);
  }

  return mergeChildResults(allBundles, results, cancelledChildren);
}

/* ---------- Specialist override helper (FEATURE_191) ---------- */

/**
 * Compute `(systemPromptOverride, excludeTools)` for a child given the
 * bundle's `specialistName`. When set, the specialist's instructions
 * replace the default child system prompt, and the excludeTools list
 * becomes the complement of the specialist's `tools` array (full tool
 * universe minus what the specialist whitelists). When unset, the
 * defaults the caller passes through are used.
 *
 * Resolution is best-effort: if the specialist was unregistered between
 * Actor admission and execution, the defaults fire as a fail-
 * safe — the child still runs, just without specialist overrides. This
 * matches the "specialist override is opportunistic, not load-bearing"
 * semantic of the FEATURE_191 design.
 */
interface SpecialistOverride {
  systemPromptOverride: string;
  excludeTools: readonly string[];
  /**
   * FEATURE_102 Phase 1 (v0.7.45): the specialist agent's explicit model /
   * provider, when its manifest declared them. The child-executor prefers
   * these over the parent's. This is the SAFE, explicit (user-authored) slice
   * of model routing — no capability auto-inference (that is billing-sensitive
   * and gated on the Phase 4 quality eval). Undefined when the specialist set
   * no model/provider → falls through to the parent default.
   */
  modelOverride?: string;
  providerOverride?: string;
  effortOverride?: KodaXWireReasoningEffort;
}

function buildChildPermissionIntent(
  bundle: KodaXChildContextBundle,
  inherited: GuardrailPermissionIntent | undefined,
): GuardrailPermissionIntent {
  const bindingConstraints = [
    ...(inherited?.bindingConstraints ?? []),
    ...bundle.constraints,
  ];
  return {
    ...inherited,
    delegatedObjective: bundle.objective,
    bindingConstraints,
    ...(bundle.scopeSummary !== undefined ? { scopeHint: bundle.scopeSummary } : {}),
    readOnly: inherited?.readOnly === true || bundle.readOnly,
  };
}

/** Tools that require a Runtime Actor principal or managed-protocol host. */
export const CHILD_COLLABORATION_TOOLS: readonly string[] = [
  'list_dispatchable_agents',
  'spawn_agent',
  'run_workflow',
  'send_message',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
  'agent_output',
  'emit_managed_protocol',
];

function restrictToolsForActor(
  excludedTools: readonly string[],
  capabilities: AgentCapabilities | undefined,
): readonly string[] {
  if (!capabilities) return excludedTools;
  const allowedTools = new Set(capabilities.tools);
  const allowAll = allowedTools.has('*');
  const excluded = new Set(excludedTools);
  for (const tool of getAllRegisteredTools()) {
    const outsideExplicitCeiling = !allowAll && !allowedTools.has(tool.name);
    const networkDenied = !capabilities.network
      && (tool.sideEffect === 'reads-network' || tool.sideEffect === 'mutates-network');
    const userInteractionDenied = !capabilities.canAskUser && tool.name === 'ask_user_question';
    if (outsideExplicitCeiling || networkDenied || userInteractionDenied) excluded.add(tool.name);
  }
  return [...excluded];
}

function restrictToolsForChildRuntime(
  excludedTools: readonly string[],
  capabilities: AgentCapabilities | undefined,
  actorControl: ChildExecutorOptions['actorControl'],
): readonly string[] {
  const restricted = restrictToolsForActor(excludedTools, capabilities);
  if (actorControl !== undefined) return restricted;
  return [...new Set([...restricted, ...CHILD_COLLABORATION_TOOLS])];
}

function childContextAgentId(
  bundle: KodaXChildContextBundle,
  options: ChildExecutorOptions,
): string {
  return options.contextAgentId ?? bundle.id;
}

function childContextParentAgentId(
  ctx: KodaXToolExecutionContext,
  options: ChildExecutorOptions,
): string | undefined {
  return options.contextParentAgentId
    ?? (options.actorControl !== undefined ? options.actorParentAgentId : ctx.currentAgentId);
}

function isChildToolVisible(
  name: string,
  excludedTools: readonly string[],
  ctx: KodaXToolExecutionContext,
): boolean {
  if (excludedTools.includes(name)) return false;
  const tool = getAllRegisteredTools().find((candidate) => candidate.name === name);
  if (!tool) return false;
  return ctx.toolVisibilityPolicy?.({
    name: tool.name,
    sideEffect: tool.sideEffect,
    planModeAllowed: tool.planModeAllowed === true,
  }) ?? true;
}

function isProviderAllowed(
  provider: string,
  capabilities: AgentCapabilities | undefined,
): boolean {
  return capabilities === undefined
    || capabilities.providers.includes('*')
    || capabilities.providers.includes(provider);
}

function assertChildProviderAllowed(
  provider: string,
  capabilities: AgentCapabilities | undefined,
): void {
  if (!isProviderAllowed(provider, capabilities)) {
    throw new Error(`Child Actor is not authorized to use provider ${provider}.`);
  }
}

interface ChildIsolationScope {
  readonly ctx: KodaXToolExecutionContext;
  readonly worktreePath?: string;
}

function readWorktreePath(raw: string): string {
  const data = JSON.parse(raw) as unknown;
  if (typeof data !== 'object' || data === null || !('path' in data)) {
    throw new Error('worktree_create returned an invalid payload');
  }
  const path = (data as { path?: unknown }).path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('worktree_create returned an invalid path');
  }
  return path;
}

async function prepareChildIsolationScope(
  bundle: KodaXChildContextBundle,
  parentCtx: KodaXToolExecutionContext,
): Promise<ChildIsolationScope> {
  if (bundle.isolation !== 'worktree') {
    return { ctx: parentCtx };
  }

  const raw = await createWorkflowWorktree(
    {
      description: `workflow-${bundle.id}`,
    },
    parentCtx,
  );
  const worktreePath = readWorktreePath(raw);
  return {
    ctx: {
      ...parentCtx,
      gitRoot: worktreePath,
      executionCwd: worktreePath,
    },
    worktreePath,
  };
}

function annotateWorktreeSummary(summary: string, scope: ChildIsolationScope): string {
  if (!scope.worktreePath) return summary;
  return [`[Workflow worktree: ${scope.worktreePath}]`, summary].join('\n');
}

async function cleanupChildIsolationScope(
  scope: ChildIsolationScope,
  parentCtx: KodaXToolExecutionContext,
): Promise<string | undefined> {
  if (!scope.worktreePath) return undefined;
  try {
    await removeWorkflowWorktree(scope.worktreePath, parentCtx);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Workflow worktree cleanup failed: ${message}]`;
  }
}

function appendCleanupWarning(
  result: KodaXChildAgentResult,
  cleanupWarning: string | undefined,
): KodaXChildAgentResult {
  if (!cleanupWarning) return result;
  return {
    ...result,
    summary: `${result.summary}\n${cleanupWarning}`,
  };
}

/**
 * FEATURE_217 Layer 1 — run a child body that yields its own result, then
 * ALWAYS reclaim the isolation worktree, attaching any cleanup warning to the
 * result. On an unexpected throw past the body's own guards the worktree is
 * still reclaimed before rethrowing, so a workflow worktree can never leak on
 * the per-child path. (The run-terminal sweep in `workflow-runner.ts` — Layer 2
 * — backstops aborted / spawn-without-wait children that skip this path.)
 */
async function withChildIsolationCleanup(
  scope: ChildIsolationScope,
  cleanupCtx: KodaXToolExecutionContext,
  body: () => Promise<KodaXChildAgentResult>,
): Promise<KodaXChildAgentResult> {
  let childResult: KodaXChildAgentResult;
  try {
    childResult = await body();
  } catch (error) {
    await cleanupChildIsolationScope(scope, cleanupCtx);
    throw error;
  }
  const cleanupWarning = await cleanupChildIsolationScope(scope, cleanupCtx);
  return appendCleanupWarning(childResult, cleanupWarning);
}

function readChildTokenUsage(result: KodaXResult): number {
  const candidate =
    result.usage?.totalTokens ??
    result.contextTokenSnapshot?.usage?.totalTokens ??
    result.contextTokenSnapshot?.currentTokens ??
    0;
  return Number.isFinite(candidate) && candidate > 0 ? candidate : 0;
}

interface WorkflowChildDigestResult {
  readonly digest?: string;
  readonly totalTokensUsed: number;
  readonly digestTokensUsed: number;
  readonly usage?: WorkflowChildDigestUpdate['usage'];
  /**
   * True when a digest was attempted for a workflow child but produced nothing
   * usable (LLM error, timeout, parent abort, or empty distillation). Lets the
   * transcript tell the user the smart summary was unavailable instead of
   * silently presenting a deterministic excerpt as the intended digest.
   */
  readonly attemptFailed?: boolean;
}

function normalizeWorkflowChildDigest(text: string): string | undefined {
  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/\[\/?workflow handoff\]/i.test(line))
    .filter((line) => !/^```/.test(line));
  if (lines.length === 0) return undefined;
  return lines.slice(0, WORKFLOW_CHILD_DIGEST_MAX_LINES).join('\n');
}

const WORKFLOW_PRESENTATION_MAX_CHARS = 4_096;
const PRESENTATION_DENIED_MARKER_RE = /(?:\[truncated|tool output truncated|full output saved to:|\[tool error\]|summary unavailable|digest failed)/i;
const PRESENTATION_PREPARATORY_RE = /^(?:i will|i'll|i need to|next i|let me)\b/i;

function hasTopLevelSummarySchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  if ((schema as { readonly type?: unknown }).type !== 'object') return false;
  const properties = (schema as { readonly properties?: unknown }).properties;
  const required = (schema as { readonly required?: unknown }).required;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return false;
  if (!Array.isArray(required) || !required.includes('summary')) return false;
  const summary = (properties as { readonly summary?: unknown }).summary;
  return typeof summary === 'object' && summary !== null && !Array.isArray(summary) &&
    (summary as { readonly type?: unknown }).type === 'string';
}

function normalizeReusableWorkflowSummary(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^```[a-z0-9_-]*$/i.test(line));
  const normalized = lines.join('\n');
  if (lines.length < 1 || lines.length > WORKFLOW_CHILD_DIGEST_MAX_LINES) return undefined;
  if (normalized.length > WORKFLOW_PRESENTATION_MAX_CHARS) return undefined;
  if (PRESENTATION_DENIED_MARKER_RE.test(normalized)) return undefined;
  if (PRESENTATION_PREPARATORY_RE.test(normalized)) return undefined;
  return normalized;
}

function reusableWorkflowSummary(
  bundle: KodaXChildContextBundle,
  structured: unknown,
  finalText: string,
): string | undefined {
  if (bundle.workflowOutputContract?.kodaxAuthored !== true) return undefined;
  const candidates: string[] = [];
  if (hasTopLevelSummarySchema(bundle.outputSchema) &&
      typeof structured === 'object' && structured !== null && !Array.isArray(structured)) {
    const summary = (structured as { readonly summary?: unknown }).summary;
    if (typeof summary === 'string') candidates.push(summary);
  }
  if (bundle.workflowOutputContract.terseResult) candidates.push(finalText);
  for (const candidate of candidates) {
    const normalized = normalizeReusableWorkflowSummary(candidate);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function shouldCreateWorkflowChildDigest(
  options: ChildExecutorOptions,
  result: KodaXResult,
  bundle?: KodaXChildContextBundle,
  structured?: unknown,
): boolean {
  return options.workflowChild === true &&
    options.abortSignal?.aborted !== true &&
    result.success === true &&
    result.interrupted !== true &&
    result.lastText.trim().length > 0 &&
    (bundle === undefined || reusableWorkflowSummary(bundle, structured, result.lastText) === undefined);
}

function deriveSkillRootFromSkillFile(skillFilePath: string): string {
  return skillFilePath.replace(/[\\/]+SKILL\.md$/i, '');
}

function extractPrefixedLine(content: string, prefix: string): string | undefined {
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith(prefix));
  return line?.trim().slice(prefix.length).trim() || undefined;
}

function extractListSection(
  content: string,
  heading: string,
  limit: number,
): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    return [];
  }

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (items.length > 0) break;
      continue;
    }
    if (!trimmed.startsWith('- ')) break;
    items.push(trimmed);
    if (items.length >= limit) break;
  }
  return items;
}

function buildActiveSkillResourceBriefing(
  skillInvocation: KodaXToolExecutionContext['skillInvocation'],
): string | undefined {
  if (!skillInvocation) {
    return undefined;
  }

  const root =
    extractPrefixedLine(skillInvocation.expandedContent, 'Skill root:')
    ?? deriveSkillRootFromSkillFile(skillInvocation.path);
  const supportRoots = extractListSection(
    skillInvocation.expandedContent,
    'Support roots:',
    12,
  );
  const supportFiles = extractListSection(
    skillInvocation.expandedContent,
    'Support file inventory:',
    CHILD_SKILL_SUPPORT_FILE_LINE_LIMIT,
  );

  const lines = [
    '## Active Skill Resources',
    `Parent task is using skill "${skillInvocation.name}". If this child needs skill support files, use these exact paths instead of broad home/workspace searches.`,
    `- Skill file: ${skillInvocation.path}`,
    root ? `- Skill root: ${root}` : undefined,
    supportRoots.length > 0 ? 'Support roots:' : undefined,
    ...supportRoots,
    supportFiles.length > 0 ? 'Selected support files:' : undefined,
    ...supportFiles,
    supportRoots.length > 0
      ? 'If a needed support file is not listed above, combine its relative path with the matching support root.'
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
}

async function resolveReferencedSkillRegistry(
  ctx: KodaXToolExecutionContext,
  projectRoot: string,
): Promise<ISkillRegistry> {
  if (ctx.skillRegistry) return ctx.skillRegistry;
  let registry = getSkillRegistry(projectRoot);
  if (registry.size === 0) {
    registry = await initializeSkillRegistry(projectRoot);
  }
  return registry;
}

async function buildReferencedSkillBriefing(
  objective: string,
  ctx: KodaXToolExecutionContext,
): Promise<string | undefined> {
  const references = [
    ...parseInlineSkillReferences(objective),
    ...parseBareInlineSlashReferences(objective),
  ].sort((left, right) => left.start - right.start);
  if (references.length === 0) return undefined;

  const childCwd = resolveExecutionCwd(ctx);
  const projectRoot = ctx.gitRoot ?? childCwd;
  const registry = await resolveReferencedSkillRegistry(ctx, projectRoot);
  const activeSkill = ctx.skillInvocation;
  const activeReferenced = activeSkill !== undefined && references.some(
    (reference) => reference.name === activeSkill.name,
  );
  const modelReferences = new Set<string>();
  for (const reference of references) {
    if (reference.name === activeSkill?.name) continue;
    if (reference.raw.startsWith('/skill:') || registry.has(reference.name)) {
      modelReferences.add(reference.name);
    }
  }
  if (!activeReferenced && modelReferences.size === 0) return undefined;

  return [
    activeReferenced ? '## Explicit User Skill Invocation' : undefined,
    activeReferenced
      ? `The host provided the active user-invoked Skill "${activeSkill?.name}" through structured Skill context. Follow that context directly and do not call the \`skill\` tool for it again.`
      : undefined,
    modelReferences.size > 0 ? '## Referenced Skills' : undefined,
    modelReferences.size > 0
      ? `The child objective mentions Skill reference(s): ${[...modelReferences].map((name) => `/skill:${name}`).join(', ')}.`
      : undefined,
    modelReferences.size > 0
      ? 'These references came through a model-authored child objective, not a direct user invocation. Invoke the `skill` tool before following them so model-invocation policy remains enforced.'
      : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n\n');
}

function shouldRunWorkflowDigestAsync(
  bundle: KodaXChildContextBundle,
  options: ChildExecutorOptions,
  result: KodaXResult,
  structured?: unknown,
): boolean {
  return options.workflowDigestMode === 'async' &&
    bundle.isolation !== 'worktree' &&
    options.onWorkflowChildDigest !== undefined &&
    shouldCreateWorkflowChildDigest(options, result, bundle, structured);
}

function selectContextDiagnosticEvents(
  events: KodaXEvents | undefined,
): KodaXEvents | undefined {
  if (events === undefined) return undefined;
  const selected: KodaXEvents = {
    ...(events.onContextBudgetSnapshot !== undefined
      ? { onContextBudgetSnapshot: events.onContextBudgetSnapshot }
      : {}),
    ...(events.onPromptCacheDiagnostics !== undefined
      ? { onPromptCacheDiagnostics: events.onPromptCacheDiagnostics }
      : {}),
    ...(events.onToolExposurePlanned !== undefined
      ? { onToolExposurePlanned: events.onToolExposurePlanned }
      : {}),
    ...(events.onContextCompactionSkipped !== undefined
      ? { onContextCompactionSkipped: events.onContextCompactionSkipped }
      : {}),
  };
  return Object.keys(selected).length > 0 ? selected : undefined;
}

async function createWorkflowChildDigest(
  input: {
    readonly runFn: RunKodaXFn;
    readonly result: KodaXResult;
    readonly provider: string;
    readonly model?: string;
    readonly effort?: KodaXWireReasoningEffort;
    readonly scopeCtx: KodaXToolExecutionContext;
    readonly bundle: KodaXChildContextBundle;
    readonly options: ChildExecutorOptions;
    readonly structured?: unknown;
    readonly timeoutMs: number;
  },
): Promise<WorkflowChildDigestResult> {
  const reusable = reusableWorkflowSummary(input.bundle, input.structured, input.result.lastText);
  if (reusable !== undefined) {
    return { digest: reusable, totalTokensUsed: 0, digestTokensUsed: 0 };
  }
  if (!shouldCreateWorkflowChildDigest(input.options, input.result, input.bundle, input.structured)) {
    return { totalTokensUsed: 0, digestTokensUsed: 0 };
  }
  // Abandon the digest on timeout or parent abort so the child's completion is
  // not blocked indefinitely by a slow self-distill turn.
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  input.options.abortSignal?.addEventListener('abort', onParentAbort);
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const diagnosticEvents = selectContextDiagnosticEvents(input.options.parentOptions.events);
    const digestRun = await input.runFn(
      {
        provider: input.provider,
        ...(input.model ? { model: input.model } : {}),
        effort: input.effort ?? input.options.parentOptions.effort,
        reasoningMode: input.options.parentOptions.reasoningMode,
        agentMode: 'sa',
        maxIter: 1,
        abortSignal: controller.signal,
        extensionRuntime: input.options.parentOptions.extensionRuntime,
        ...(diagnosticEvents !== undefined ? { events: diagnosticEvents } : {}),
        ...(input.options.parentOptions.compaction !== undefined
          ? { compaction: input.options.parentOptions.compaction }
          : {}),
        ...(input.options.parentOptions.disablePromptCache !== undefined
          ? { disablePromptCache: input.options.parentOptions.disablePromptCache }
          : {}),
        guardrails: input.options.guardrails,
        session: { initialMessages: input.result.messages },
        context: {
          gitRoot: input.scopeCtx.gitRoot,
          executionCwd: input.scopeCtx.executionCwd ?? input.scopeCtx.gitRoot,
          shellExecution: input.scopeCtx.shellExecution,
          assertReadablePath: input.scopeCtx.assertReadablePath,
          toolVisibilityPolicy: input.scopeCtx.toolVisibilityPolicy,
          skillRegistry: input.scopeCtx.skillRegistry,
          admitLearnedSkillInvocation: input.scopeCtx.admitLearnedSkillInvocation,
          skillScriptRunner: input.scopeCtx.skillScriptRunner,
          ...inheritRepoIntelligenceContext(input.options),
          ...(input.options.parentOptions.contextDiagnostics !== undefined
            ? { contextDiagnostics: input.options.parentOptions.contextDiagnostics }
            : {}),
          systemPromptOverride: WORKFLOW_CHILD_DIGEST_SYSTEM_PROMPT,
          excludeTools: getAllRegisteredTools().map((tool) => tool.name),
          contextIdentitySessionId:
            input.scopeCtx.contextIdentitySessionId ?? input.scopeCtx.sessionId,
          ownsContextRevision: false,
          currentAgentId: childContextAgentId(input.bundle, input.options),
          parentAgentId: childContextParentAgentId(input.scopeCtx, input.options),
        },
      },
      WORKFLOW_CHILD_DIGEST_PROMPT,
    );
    const digest = normalizeWorkflowChildDigest(digestRun.lastText);
    const totalTokensUsed = readChildTokenUsage(digestRun);
    const usage = digestRun.usage ? {
      inputTokens: digestRun.usage.inputTokens,
      outputTokens: digestRun.usage.outputTokens,
      totalTokens: digestRun.usage.totalTokens,
      ...(digestRun.usage.cachedReadTokens !== undefined
        ? { cacheReadTokens: digestRun.usage.cachedReadTokens }
        : {}),
    } : undefined;
    // An empty distillation counts as a failed attempt so the transcript is
    // honest about the smart summary being unavailable.
    return digest
      ? { digest, totalTokensUsed, digestTokensUsed: totalTokensUsed, ...(usage ? { usage } : {}) }
      : { totalTokensUsed, digestTokensUsed: totalTokensUsed, attemptFailed: true, ...(usage ? { usage } : {}) };
  } catch {
    // Digest generation is presentation-only. Keep the completed child result
    // for synthesis/audit; flag the failed attempt so the formatter labels the
    // deterministic excerpt fallback as "smart summary unavailable".
    return { totalTokensUsed: 0, digestTokensUsed: 0, attemptFailed: true };
  } finally {
    clearTimeout(timer);
    input.options.abortSignal?.removeEventListener('abort', onParentAbort);
  }
}

function scheduleWorkflowChildDigest(
  input: {
    readonly runFn: RunKodaXFn;
    readonly result: KodaXResult;
    readonly provider: string;
    readonly model?: string;
    readonly effort?: KodaXWireReasoningEffort;
    readonly scopeCtx: KodaXToolExecutionContext;
    readonly bundle: KodaXChildContextBundle;
    readonly options: ChildExecutorOptions;
    readonly structured?: unknown;
  },
): void {
  void createWorkflowChildDigest({
    ...input,
    timeoutMs: WORKFLOW_CHILD_DIGEST_ASYNC_TIMEOUT_MS,
  }).then((digest) => {
    try {
      input.options.onWorkflowChildDigest?.({
        childId: input.bundle.id,
        ...(digest.digest ? { digest: digest.digest } : {}),
        ...(digest.attemptFailed ? { digestFailed: true } : {}),
        ...(digest.digestTokensUsed > 0 ? { digestTokensUsed: digest.digestTokensUsed } : {}),
        ...(digest.usage ? { usage: digest.usage } : {}),
        totalTokensUsed: digest.totalTokensUsed,
      });
    } catch {
      // Digest callbacks are observers. A host panel must not change child
      // completion semantics after the child has already returned.
    }
  });
}

const STRUCTURED_OUTPUT_REPAIR_SYSTEM_PROMPT = [
  'You are re-formatting your own just-completed report into the JSON a parent workflow requires.',
  'Do not use tools. Do not continue investigation. Output only the JSON block.',
].join('\n');

const STRUCTURED_OUTPUT_REPAIR_TIMEOUT_MS = 15_000;

/**
 * FEATURE_246 Part B — resolve a child's structured output against its declared
 * `outputSchema`. Parses + validates the child's final text; on a hard miss
 * (no JSON / parse error / schema violation) runs ONE bounded repair turn that
 * re-asks for the JSON only (seeded with the child's transcript, no tools —
 * the same one-turn self-distill shape as the workflow digest). Best-effort:
 * returns the parsed object when available, else `undefined`. Never throws and
 * never changes the child's terminal status.
 */
async function resolveChildStructuredOutput(input: {
  readonly runFn: RunKodaXFn;
  readonly result: KodaXResult;
  readonly provider: string;
  readonly model?: string;
  readonly effort?: KodaXWireReasoningEffort;
  readonly scopeCtx: KodaXToolExecutionContext;
  readonly bundle: KodaXChildContextBundle;
  readonly options: ChildExecutorOptions;
}): Promise<unknown> {
  const schema = input.bundle.outputSchema;
  if (schema === undefined) return undefined;

  const first = evaluateStructuredOutput(input.result.lastText, schema);
  if (first.ok) {
    return input.bundle.structuredOutputContract === 'pattern-disposition-parse-only'
      ? parsePatternDispositionEnvelope(first.value)
      : first.value;
  }
  if (input.bundle.structuredOutputContract === 'pattern-disposition-parse-only') {
    return undefined;
  }

  // Only attempt repair for a child that genuinely completed; an aborted or
  // interrupted child must not trigger another LLM turn.
  if (
    input.options.abortSignal?.aborted === true ||
    input.result.success !== true ||
    input.result.interrupted === true
  ) {
    return first.value;
  }

  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  input.options.abortSignal?.addEventListener('abort', onParentAbort);
  const timer = setTimeout(() => controller.abort(), STRUCTURED_OUTPUT_REPAIR_TIMEOUT_MS);
  try {
    const diagnosticEvents = selectContextDiagnosticEvents(input.options.parentOptions.events);
    const repairRun = await input.runFn(
      {
        provider: input.provider,
        ...(input.model ? { model: input.model } : {}),
        effort: input.effort ?? input.options.parentOptions.effort,
        reasoningMode: input.options.parentOptions.reasoningMode,
        agentMode: 'sa',
        maxIter: 1,
        abortSignal: controller.signal,
        extensionRuntime: input.options.parentOptions.extensionRuntime,
        ...(diagnosticEvents !== undefined ? { events: diagnosticEvents } : {}),
        ...(input.options.parentOptions.compaction !== undefined
          ? { compaction: input.options.parentOptions.compaction }
          : {}),
        ...(input.options.parentOptions.disablePromptCache !== undefined
          ? { disablePromptCache: input.options.parentOptions.disablePromptCache }
          : {}),
        guardrails: input.options.guardrails,
        session: { initialMessages: input.result.messages },
        context: {
          gitRoot: input.scopeCtx.gitRoot,
          executionCwd: input.scopeCtx.executionCwd ?? input.scopeCtx.gitRoot,
          shellExecution: input.scopeCtx.shellExecution,
          assertReadablePath: input.scopeCtx.assertReadablePath,
          toolVisibilityPolicy: input.scopeCtx.toolVisibilityPolicy,
          skillRegistry: input.scopeCtx.skillRegistry,
          admitLearnedSkillInvocation: input.scopeCtx.admitLearnedSkillInvocation,
          skillScriptRunner: input.scopeCtx.skillScriptRunner,
          ...inheritRepoIntelligenceContext(input.options),
          ...(input.options.parentOptions.contextDiagnostics !== undefined
            ? { contextDiagnostics: input.options.parentOptions.contextDiagnostics }
            : {}),
          systemPromptOverride: STRUCTURED_OUTPUT_REPAIR_SYSTEM_PROMPT,
          excludeTools: getAllRegisteredTools().map((tool) => tool.name),
          agentScope: input.scopeCtx.agentScope,
          contextIdentitySessionId:
            input.scopeCtx.contextIdentitySessionId ?? input.scopeCtx.sessionId,
          ownsContextRevision: false,
          currentAgentId: childContextAgentId(input.bundle, input.options),
          parentAgentId: childContextParentAgentId(input.scopeCtx, input.options),
        },
      },
      buildStructuredOutputRepairPrompt(first.errors, schema),
    );
    const repaired = evaluateStructuredOutput(repairRun.lastText, schema);
    return repaired.value ?? first.value;
  } catch {
    return first.value;
  } finally {
    clearTimeout(timer);
    input.options.abortSignal?.removeEventListener('abort', onParentAbort);
  }
}

function resolveSpecialistOverride(
  bundle: KodaXChildContextBundle,
  defaultSystemPrompt: string,
  defaultExcludeTools: readonly string[],
  parentCtx: KodaXToolExecutionContext,
): SpecialistOverride {
  if (!bundle.specialistName) {
    return { systemPromptOverride: defaultSystemPrompt, excludeTools: defaultExcludeTools };
  }
  const specialistEntry = resolveConstructedAgentEntry(bundle.specialistName, parentCtx.agentScope);
  if (!specialistEntry) {
    // Defensive fail-safe — should not happen because the dispatch layer
    // already rejected unknown names. If it does (e.g. registry mutated
    // mid-flight), fall through to defaults rather than blocking the
    // child run.
    return { systemPromptOverride: defaultSystemPrompt, excludeTools: defaultExcludeTools };
  }
  const specialist: Agent = specialistEntry.agent;
  // FEATURE_102 Phase 1: surface the specialist's explicit model/provider.
  const modelProviderEffort: Pick<SpecialistOverride, 'modelOverride' | 'providerOverride' | 'effortOverride'> = {
    ...(specialist.model ? { modelOverride: specialist.model } : {}),
    ...(specialist.provider ? { providerOverride: specialist.provider } : {}),
    ...(specialist.effort ? { effortOverride: specialist.effort } : {}),
  };
  // Agent.instructions is `string | ((ctx) => string)`. Constructed agents
  // built by agent-resolver.buildAgentFromContent assign the literal
  // string straight through; the function variant is reserved for
  // platform-level dynamic prompts (built-in agents). Specialist override
  // therefore safely narrows to the string branch.
  const systemPromptOverride = typeof specialist.instructions === 'string'
    ? specialist.instructions
    : defaultSystemPrompt;

  // Complementary exclusion: KodaXOptions.context has no `includeOnlyTools`
  // API. Computing `allTools - (specialist.tools - defaultExcludeTools)`
  // is semantically equivalent to an allowlist intersected with the
  // caller's child-safety guard, without requiring a new option schema.
  const effectiveToolNames = constructedAgentToolCeiling(specialistEntry);
  if (effectiveToolNames === undefined) {
    // Specialist declared no tools — fall back to defaults so the child
    // still has the standard CHILD_EXCLUDE_TOOLS_BASE/READONLY guard
    // rather than an unrestricted toolset.
    return { systemPromptOverride, excludeTools: defaultExcludeTools, ...modelProviderEffort };
  }
  const specialistToolNames = new Set(effectiveToolNames ?? []);
  const alwaysExcluded = new Set(defaultExcludeTools);
  const allToolNames = getAllRegisteredTools().map(t => t.name);
  const excludeTools = allToolNames.filter(n => alwaysExcluded.has(n) || !specialistToolNames.has(n));
  return { systemPromptOverride, excludeTools, ...modelProviderEffort };
}

function normalizeChildEffort(
  effort: KodaXWireReasoningEffort | undefined,
): KodaXWireReasoningEffort | undefined {
  if (effort === undefined || effort.trim().length === 0) return undefined;
  const normalized = normalizeReasoningEffortValue(effort);
  return normalized === 'auto' ? undefined : normalized;
}

function resolveChildEffort(
  bundle: KodaXChildContextBundle,
  specialistEffort: KodaXWireReasoningEffort | undefined,
  parentEffort: KodaXWireReasoningEffort | undefined,
): KodaXWireReasoningEffort | undefined {
  const lockedEffort = normalizeChildEffort(specialistEffort);
  const dispatchEffort = normalizeChildEffort(bundle.effort);
  if (lockedEffort !== undefined && dispatchEffort !== undefined && dispatchEffort !== lockedEffort) {
    throw new Error(
      `specialist "${bundle.specialistName ?? 'unknown'}" locks effort "${lockedEffort}", ` +
      `but dispatch requested "${dispatchEffort}". Remove the dispatch effort or match the specialist effort.`,
    );
  }
  return lockedEffort ?? dispatchEffort ?? parentEffort;
}

interface ResolvedChildRoute {
  readonly provider: string;
  readonly model?: string;
  readonly facts: KodaXChildRouteFacts;
}

function resolveChildRoute(
  bundle: KodaXChildContextBundle,
  providerOverride: string | undefined,
  modelOverride: string | undefined,
  parentOptions: ChildExecutorOptions['parentOptions'],
  readOnly: boolean,
  hintTier: { readonly provider?: string; readonly model?: string } | undefined,
  resolvedEffort?: KodaXWireReasoningEffort,
): ResolvedChildRoute {
  const hasSelector = bundle.provider !== undefined || bundle.model !== undefined ||
    providerOverride !== undefined || modelOverride !== undefined;
  const requestedTier = bundle.modelHint ?? 'inherited';
  const tierOutcome: KodaXChildTierOutcome = bundle.modelHint === undefined
    ? 'inherited'
    : hasSelector
      ? 'shadowed-by-selector'
      : bundle.modelHint === 'balanced'
        ? 'balanced-parent'
        : bundle.modelHint === 'fast' && !readOnly
          ? 'fast-write-ineligible'
          : hintTier === undefined
            ? 'unconfigured'
            : 'applied';
  const providerSource: KodaXChildRouteSource = bundle.provider !== undefined
    ? 'explicit'
    : providerOverride !== undefined
      ? 'specialist'
      : hintTier?.provider !== undefined
        ? 'tier'
        : parentOptions.provider !== undefined
          ? 'parent'
          : 'default';
  const modelSource: Exclude<KodaXChildRouteSource, 'default'> | undefined = bundle.model !== undefined
    ? 'explicit'
    : modelOverride !== undefined
      ? 'specialist'
      : hintTier?.model !== undefined
        ? 'tier'
        : parentOptions.model !== undefined
          ? 'parent'
          : undefined;
  const provider = bundle.provider ?? providerOverride ?? hintTier?.provider ?? parentOptions.provider ?? 'anthropic';
  const model = bundle.model ?? modelOverride ?? hintTier?.model ?? parentOptions.model;
  return {
    provider,
    ...(model !== undefined ? { model } : {}),
    facts: {
      requestedTier,
      tierOutcome,
      providerSource,
      ...(modelSource ? { modelSource } : {}),
      initialProvider: provider,
      ...(model !== undefined ? { initialModel: model } : {}),
      ...(resolvedEffort !== undefined ? { resolvedEffort } : {}),
    },
  };
}

function resolveChildBriefingTokenBudget(
  providerName: string,
  model: string | undefined,
  systemPrompt: string,
  excludeTools: readonly string[],
): number {
  const provider = resolveProvider(providerName);
  const maxInputTokens = calculateMaxContextInputTokens(
    provider.getEffectiveContextWindow(model),
    provider.getEffectiveMaxOutputTokens(model),
  );
  const excluded = new Set(excludeTools);
  const activeTools = getAllRegisteredTools().filter((tool) => !excluded.has(tool.name));
  const fixedTokens = countTokens(systemPrompt) + countTokens(JSON.stringify(activeTools)) + 64;
  return Math.max(0, maxInputTokens - fixedTokens);
}

/* ---------- Read-only child execution ---------- */

async function executeReadChild(
  bundle: KodaXChildContextBundle,
  parentCtx: KodaXToolExecutionContext,
  options: ChildExecutorOptions,
): Promise<KodaXChildAgentResult> {
  const scope = await prepareChildIsolationScope(bundle, parentCtx);
  return withChildIsolationCleanup(scope, parentCtx, () =>
    runReadChildBody(bundle, scope, options),
  );
}

async function runReadChildBody(
  bundle: KodaXChildContextBundle,
  scope: ChildIsolationScope,
  options: ChildExecutorOptions,
): Promise<KodaXChildAgentResult> {
  const childEvents = buildChildEvents(
    bundle.id,
    options.onProgress,
    options.planModeBlockCheck,
    undefined,
    options.parentOptions.events,
    options.workflowCorrelation,
    options.childActivityName,
    options.maxIterationsPerChild,
    true,
  );

  // FEATURE_191 — specialist override switch (no-op when bundle.specialistName
  // is undefined; falls through to v0.7.42 defaults).
  // FEATURE_102 Phase 1 — also surfaces the specialist's explicit model/provider/effort.
  const { systemPromptOverride, excludeTools: specialistExcludeTools, modelOverride, providerOverride, effortOverride } =
    resolveSpecialistOverride(
      bundle,
      CHILD_AGENT_SYSTEM_PROMPT,
      CHILD_EXCLUDE_TOOLS_READONLY,
      scope.ctx,
    );
  const excludeTools = restrictToolsForChildRuntime(
    specialistExcludeTools,
    options.actorCapabilities,
    options.actorControl,
  );

  // FEATURE_102 P1-auto — model_hint routing applies only when the dispatcher
  // gave neither an explicit provider/model (P2) nor a specialist (P1).
  const hintTier =
    bundle.provider === undefined &&
    bundle.model === undefined &&
    providerOverride === undefined &&
    modelOverride === undefined
      ? resolveModelHintTier(bundle.modelHint, /* readOnly */ true)
      : undefined;

  const route = resolveChildRoute(
    bundle,
    providerOverride,
    modelOverride,
    options.parentOptions,
    true,
    hintTier,
  );
  const { provider, model } = route;
  assertChildProviderAllowed(provider, options.actorCapabilities);
  let briefing: string;
  try {
    briefing = await buildChildBriefing(
      bundle,
      scope.ctx,
      options.maxIterationsPerChild,
      resolveChildBriefingTokenBudget(provider, model, systemPromptOverride, excludeTools),
      {
        canSpawn: options.actorControl !== undefined
          && isChildToolVisible('spawn_agent', excludeTools, scope.ctx),
        canMessage: options.actorControl !== undefined
          && isChildToolVisible('send_message', excludeTools, scope.ctx),
      },
    );
  } catch (error) {
    return extractChildResult(
      bundle,
      error instanceof Error ? error.message : String(error),
      'failed',
      { actualIterations: 0, interrupted: false },
    );
  }

  let childResult: KodaXChildAgentResult;
  try {
    const childStartedAt = Date.now();
    const runFn = await getRunKodaX();
    const childSession = buildChildRunSession(options, options.initialMessages);
    const childEffort = resolveChildEffort(bundle, effortOverride, options.parentOptions.effort);
    let actualProvider = provider;
    let fallbackReason: string | undefined;
    const result = await invokeChildWithFallback(
      {
        provider,
        model,
        effort: childEffort,
        reasoningMode: options.parentOptions.reasoningMode,
        // The child stays on the direct runKodaX/Runner substrate. Preserve AMA
        // capability semantics only for Runtime Actor children so recursive
        // collaboration and future AMA-gated surfaces remain truthful.
        agentMode: options.actorControl ? 'ama' : 'sa',
        maxIter: options.maxIterationsPerChild,
        abortSignal: options.abortSignal,
        extensionRuntime: options.parentOptions.extensionRuntime,
        ...(options.parentOptions.compaction !== undefined
          ? { compaction: options.parentOptions.compaction }
          : {}),
        ...(options.parentOptions.disablePromptCache !== undefined
          ? { disablePromptCache: options.parentOptions.disablePromptCache }
          : {}),
        // FEATURE_092 phase 2b.7b slice D: forward parent-Runner guardrails so
        // child tool calls go through the SAME auto-mode classifier instance
        // (shared engine + denialTracker + circuitBreaker state).
        guardrails: options.guardrails,
        ...(childSession !== undefined ? { session: childSession } : {}),
        // FEATURE_221: a child of a white-labeled product inherits the parent's
        // selfManual so its own kodax_manual tool description is re-branded too
        // (children carry kodax_manual — it is not in CHILD_EXCLUDE_TOOLS).
        selfManual: scope.ctx.selfManual,
        // FEATURE_222 (R4): a child's skill tool must honor the SAME host
        // dynamic-context policy as the parent — otherwise a `disable:true` /
        // broker-mediated host is silently bypassed for every dispatched child.
        skillDynamicContext: scope.ctx.skillDynamicContext,
        sandbox: options.parentOptions.sandbox ?? scope.ctx.sandbox,
        context: {
          gitRoot: scope.ctx.gitRoot,
          executionCwd: scope.ctx.executionCwd ?? scope.ctx.gitRoot,
          shellExecution: scope.ctx.shellExecution,
          shellSandbox: scope.ctx.shellSandbox,
          trustedTextMutationHost: scope.ctx.trustedTextMutationHost,
          workspaceSandboxRoots: scope.ctx.workspaceSandboxRoots,
          permissionIntent: buildChildPermissionIntent(
            bundle,
            options.parentOptions.permissionIntent ?? scope.ctx.permissionIntent,
          ),
          assertReadablePath: scope.ctx.assertReadablePath,
          toolVisibilityPolicy: scope.ctx.toolVisibilityPolicy,
          skillRegistry: scope.ctx.skillRegistry,
          admitLearnedSkillInvocation: scope.ctx.admitLearnedSkillInvocation,
          skillScriptRunner: scope.ctx.skillScriptRunner,
          ...inheritRepoIntelligenceContext(options),
          ...(options.parentOptions.contextDiagnostics !== undefined
            ? { contextDiagnostics: options.parentOptions.contextDiagnostics }
            : {}),
          systemPromptOverride,
          excludeTools,
          agentScope: scope.ctx.agentScope,
          actorControl: options.actorControl,
          ...(options.actorControl !== undefined
            ? {
                actorQueueAgentId: actorQueueId(
                  scope.ctx.contextIdentitySessionId ?? scope.ctx.sessionId,
                  bundle.id,
                ),
              }
            : {}),
          contextIdentitySessionId:
            scope.ctx.contextIdentitySessionId ?? scope.ctx.sessionId,
          actorHost: options.actorHost,
          managedWorkBudget: scope.ctx.managedWorkBudget,
          // Propagate Actor identity/control so the child runtime can receive
          // messages and recursively collaborate within its inherited ceiling.
          currentAgentId: childContextAgentId(bundle, options),
          parentAgentId: childContextParentAgentId(scope.ctx, options),
          ...(options.actorTurnId !== undefined
            ? { liveTurn: { deliveryKind: 'initial' as const, turnId: options.actorTurnId } }
            : {}),
          ...(scope.ctx.skillInvocation ? { skillInvocation: scope.ctx.skillInvocation } : {}),
        },
        events: childEvents,
      },
      briefing,
      runFn,
      {
        onFallback: ({ fromProvider, toProvider, reason }) => {
          actualProvider = toProvider;
          fallbackReason = `${fromProvider} → ${toProvider}: ${reason}`;
          options.onProgress?.(`[fallback] ${bundle.id}: ${fallbackReason}`);
        },
        isProviderAllowed: (candidate) =>
          isProviderAllowed(candidate, options.actorCapabilities),
      },
    );

    const iterations = result.messages.filter((m) => m.role === 'assistant').length;
    const totalTokensUsed = readChildTokenUsage(result);
    const digestInput = {
      runFn,
      result,
      provider: actualProvider,
      ...(actualProvider === provider && model ? { model } : {}),
      ...(childEffort ? { effort: childEffort } : {}),
      scopeCtx: scope.ctx,
      bundle,
      options,
    };
    const structured = await resolveChildStructuredOutput(digestInput);
    const digestInputWithStructured = { ...digestInput, structured };
    const runDigestAsync = shouldRunWorkflowDigestAsync(bundle, options, result, structured);
    const digest = runDigestAsync
      ? { totalTokensUsed: 0, digestTokensUsed: 0 }
      : await createWorkflowChildDigest({
          ...digestInputWithStructured,
          timeoutMs: WORKFLOW_CHILD_DIGEST_BLOCKING_TIMEOUT_MS,
        });
    if (runDigestAsync) scheduleWorkflowChildDigest(digestInputWithStructured);
    const routeFacts: KodaXChildRouteFacts = {
      ...route.facts,
      ...(childEffort ? { resolvedEffort: childEffort } : {}),
      finalProvider: actualProvider,
      ...(actualProvider === provider && model ? { finalModel: model } : {}),
      ...(fallbackReason ? { fallbackReason } : {}),
      iterations,
      ...(result.usage ? {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.cachedReadTokens !== undefined
          ? { cacheReadTokens: result.usage.cachedReadTokens }
          : {}),
      } : {}),
      ...(digest.digestTokensUsed > 0 ? { digestTokens: digest.digestTokensUsed } : {}),
      durationMs: Date.now() - childStartedAt,
    };
    childResult = extractChildResult(
      bundle,
      annotateWorktreeSummary(result.lastText, scope),
      result.success ? 'completed' : 'failed',
      {
        actualIterations: iterations,
        interrupted: result.interrupted === true,
        limitReached: result.limitReached === true,
        totalTokensUsed: totalTokensUsed + digest.totalTokensUsed,
        digestTokensUsed: digest.digestTokensUsed,
        ...(digest.usage ? { digestUsage: digest.usage } : {}),
        sessionId: result.sessionId,
        artifactPaths: extractMutationArtifactPaths(result),
        digest: digest.digest,
        digestFailed: digest.attemptFailed,
        digestPending: runDigestAsync,
        provider: actualProvider,
        ...(actualProvider === provider && model ? { model } : {}),
        routeFacts,
        structured,
      },
    );
  } catch (error) {
    childResult = extractChildResult(
      bundle,
      error instanceof Error ? error.message : String(error),
      'failed',
      { actualIterations: 0, interrupted: false },
    );
  } finally {
    emitChildActivityEnd(
      bundle.id,
      options.parentOptions.events,
      options.workflowCorrelation,
      options.childActivityName,
    );
  }
  return childResult;
}

/* ---------- Write child execution ---------- */
// FEATURE_188 v0.7.42 (ADR-034) — write children no longer get an
// isolated git worktree. They share parent cwd + gitRoot, with a fresh
// per-child `backups` Map providing per-file rollback. Prompt-level
// peer-coordination (added to write-child briefing) handles concurrent
// conflict avoidance.

async function executeWriteChild(
  bundle: KodaXChildContextBundle,
  parentCtx: KodaXToolExecutionContext,
  options: ChildExecutorOptions,
): Promise<KodaXChildAgentResult> {
  // Child shares parent cwd + gitRoot. Fresh `backups` Map gives per-child
  // per-file rollback; AGENTS.md resolution uses the parent gitRoot.
  const baseCtx: KodaXToolExecutionContext = {
    ...parentCtx,
    backups: new Map(),
  };
  const scope = await prepareChildIsolationScope(bundle, baseCtx);
  return withChildIsolationCleanup(scope, baseCtx, () =>
    runWriteChildBody(bundle, scope, options),
  );
}

async function runWriteChildBody(
  bundle: KodaXChildContextBundle,
  scope: ChildIsolationScope,
  options: ChildExecutorOptions,
): Promise<KodaXChildAgentResult> {
  const childCtx = scope.ctx;
  const childEvents = buildChildEvents(
    bundle.id,
    options.onProgress,
    options.planModeBlockCheck,
    undefined,
    options.parentOptions.events,
    options.workflowCorrelation,
    options.childActivityName,
    options.maxIterationsPerChild,
    false,
  );
  // FEATURE_117 v2 (v0.7.38): write children inherit AGENTS.md mutation
  // policy. Read-only children stay on the bare `CHILD_AGENT_SYSTEM_PROMPT`
  // (they don't mutate, so project rules don't apply).
  // FEATURE_191 — specialist override switch on the write path. Same fail-safe
  // semantic as the read path: unknown specialist falls back to defaults.
  // FEATURE_102 Phase 1 — also surfaces the specialist's explicit model/provider/effort.
  const {
    systemPromptOverride: specialistSystemPrompt,
    excludeTools: specialistExcludeTools,
    modelOverride,
    providerOverride,
    effortOverride,
  } =
    resolveSpecialistOverride(
      bundle,
      CHILD_AGENT_SYSTEM_PROMPT,
      CHILD_EXCLUDE_TOOLS_BASE,
      childCtx,
    );
  // Project mutation rules remain the final authoritative block after any
  // specialist instructions.
  const systemPromptOverride = buildWriteSystemPrompt(
    childCtx.gitRoot ?? childCtx.executionCwd ?? process.cwd(),
    specialistSystemPrompt,
  );
  const excludeTools = restrictToolsForChildRuntime(
    specialistExcludeTools,
    options.actorCapabilities,
    options.actorControl,
  );

  // FEATURE_102 P1-auto — write children are NOT eligible for `fast`→cheap
  // (eval covered read-only only); `deep`→strong still applies. Same gate:
  // only when no explicit (P2) / specialist (P1) override is present.
  const hintTier =
    bundle.provider === undefined &&
    bundle.model === undefined &&
    providerOverride === undefined &&
    modelOverride === undefined
      ? resolveModelHintTier(bundle.modelHint, /* readOnly */ false)
      : undefined;

  const route = resolveChildRoute(
    bundle,
    providerOverride,
    modelOverride,
    options.parentOptions,
    false,
    hintTier,
  );
  const { provider, model } = route;
  assertChildProviderAllowed(provider, options.actorCapabilities);
  let briefing: string;
  try {
    briefing = await buildChildBriefing(
      bundle,
      childCtx,
      options.maxIterationsPerChild,
      resolveChildBriefingTokenBudget(provider, model, systemPromptOverride, excludeTools),
      {
        canSpawn: options.actorControl !== undefined
          && isChildToolVisible('spawn_agent', excludeTools, childCtx),
        canMessage: options.actorControl !== undefined
          && isChildToolVisible('send_message', excludeTools, childCtx),
      },
    );
  } catch (error) {
    return extractChildResult(
      bundle,
      error instanceof Error ? error.message : String(error),
      'failed',
      { actualIterations: 0, interrupted: false },
    );
  }

  let childResult: KodaXChildAgentResult;
  try {
    const childStartedAt = Date.now();
    const runFn = await getRunKodaX();
    const childSession = buildChildRunSession(options, options.initialMessages);
    const childEffort = resolveChildEffort(bundle, effortOverride, options.parentOptions.effort);
    let actualProvider = provider;
    let fallbackReason: string | undefined;
    const result = await invokeChildWithFallback(
      {
        provider,
        model,
        effort: childEffort,
        reasoningMode: options.parentOptions.reasoningMode,
        // The child stays on the direct runKodaX/Runner substrate. Preserve AMA
        // capability semantics only for Runtime Actor children so recursive
        // collaboration and future AMA-gated surfaces remain truthful.
        agentMode: options.actorControl ? 'ama' : 'sa',
        maxIter: options.maxIterationsPerChild,
        abortSignal: options.abortSignal,
        extensionRuntime: options.parentOptions.extensionRuntime,
        ...(options.parentOptions.compaction !== undefined
          ? { compaction: options.parentOptions.compaction }
          : {}),
        ...(options.parentOptions.disablePromptCache !== undefined
          ? { disablePromptCache: options.parentOptions.disablePromptCache }
          : {}),
        // FEATURE_092 phase 2b.7b slice D: forward parent-Runner guardrails so
        // child tool calls go through the SAME auto-mode classifier instance
        // (shared engine + denialTracker + circuitBreaker state).
        guardrails: options.guardrails,
        ...(childSession !== undefined ? { session: childSession } : {}),
        // FEATURE_221: write children inherit the parent's white-label product
        // so their own kodax_manual description is re-branded too.
        selfManual: childCtx.selfManual,
        // FEATURE_222 (R4): write children inherit the parent's skill
        // dynamic-context policy so their skill tool is equally gated.
        skillDynamicContext: childCtx.skillDynamicContext,
        sandbox: options.parentOptions.sandbox ?? childCtx.sandbox,
        context: {
          gitRoot: childCtx.gitRoot,
          executionCwd: childCtx.executionCwd ?? childCtx.gitRoot,
          shellExecution: childCtx.shellExecution,
          shellSandbox: childCtx.shellSandbox,
          trustedTextMutationHost: childCtx.trustedTextMutationHost,
          workspaceSandboxRoots: childCtx.workspaceSandboxRoots,
          permissionIntent: buildChildPermissionIntent(
            bundle,
            options.parentOptions.permissionIntent ?? childCtx.permissionIntent,
          ),
          assertReadablePath: childCtx.assertReadablePath,
          toolVisibilityPolicy: childCtx.toolVisibilityPolicy,
          skillRegistry: childCtx.skillRegistry,
          admitLearnedSkillInvocation: childCtx.admitLearnedSkillInvocation,
          skillScriptRunner: childCtx.skillScriptRunner,
          ...inheritRepoIntelligenceContext(options),
          ...(options.parentOptions.contextDiagnostics !== undefined
            ? { contextDiagnostics: options.parentOptions.contextDiagnostics }
            : {}),
          systemPromptOverride,
          excludeTools,
          agentScope: childCtx.agentScope,
          actorControl: options.actorControl,
          ...(options.actorControl !== undefined
            ? {
                actorQueueAgentId: actorQueueId(
                  childCtx.contextIdentitySessionId ?? childCtx.sessionId,
                  bundle.id,
                ),
              }
            : {}),
          contextIdentitySessionId:
            childCtx.contextIdentitySessionId ?? childCtx.sessionId,
          actorHost: options.actorHost,
          managedWorkBudget: childCtx.managedWorkBudget,
          // FEATURE_123 v0.7.44 — write children share the same peer-
          // routing surface as read children (same agentId + registry
          // propagation rules).
          currentAgentId: childContextAgentId(bundle, options),
          parentAgentId: childContextParentAgentId(childCtx, options),
          ...(options.actorTurnId !== undefined
            ? { liveTurn: { deliveryKind: 'initial' as const, turnId: options.actorTurnId } }
            : {}),
          ...(childCtx.skillInvocation ? { skillInvocation: childCtx.skillInvocation } : {}),
        },
        events: childEvents,
      },
      briefing,
      runFn,
      {
        onFallback: ({ fromProvider, toProvider, reason }) => {
          actualProvider = toProvider;
          fallbackReason = `${fromProvider} -> ${toProvider}: ${reason}`;
          options.onProgress?.(
            `[fallback] ${bundle.id}: ${fromProvider} → ${toProvider} (${reason})`,
          );
        },
        isProviderAllowed: (candidate) =>
          isProviderAllowed(candidate, options.actorCapabilities),
      },
    );

    const iterations = result.messages.filter((m) => m.role === 'assistant').length;
    const totalTokensUsed = readChildTokenUsage(result);
    const digestInput = {
      runFn,
      result,
      provider: actualProvider,
      ...(actualProvider === provider && model ? { model } : {}),
      ...(childEffort ? { effort: childEffort } : {}),
      scopeCtx: childCtx,
      bundle,
      options,
    };
    const structured = await resolveChildStructuredOutput(digestInput);
    const digestInputWithStructured = { ...digestInput, structured };
    const runDigestAsync = shouldRunWorkflowDigestAsync(bundle, options, result, structured);
    const digest = runDigestAsync
      ? { totalTokensUsed: 0, digestTokensUsed: 0 }
      : await createWorkflowChildDigest({
          ...digestInputWithStructured,
          timeoutMs: WORKFLOW_CHILD_DIGEST_BLOCKING_TIMEOUT_MS,
        });
    if (runDigestAsync) scheduleWorkflowChildDigest(digestInputWithStructured);
    const routeFacts: KodaXChildRouteFacts = {
      ...route.facts,
      ...(childEffort ? { resolvedEffort: childEffort } : {}),
      finalProvider: actualProvider,
      ...(actualProvider === provider && model ? { finalModel: model } : {}),
      ...(fallbackReason ? { fallbackReason } : {}),
      iterations,
      ...(result.usage ? {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.cachedReadTokens !== undefined
          ? { cacheReadTokens: result.usage.cachedReadTokens }
          : {}),
      } : {}),
      ...(digest.digestTokensUsed > 0 ? { digestTokens: digest.digestTokensUsed } : {}),
      durationMs: Date.now() - childStartedAt,
    };
    childResult = extractChildResult(
      bundle,
      annotateWorktreeSummary(result.lastText, scope),
      result.success ? 'completed' : 'failed',
      {
        actualIterations: iterations,
        interrupted: result.interrupted === true,
        limitReached: result.limitReached === true,
        totalTokensUsed: totalTokensUsed + digest.totalTokensUsed,
        digestTokensUsed: digest.digestTokensUsed,
        ...(digest.usage ? { digestUsage: digest.usage } : {}),
        sessionId: result.sessionId,
        artifactPaths: extractMutationArtifactPaths(result),
        digest: digest.digest,
        digestFailed: digest.attemptFailed,
        digestPending: runDigestAsync,
        provider: actualProvider,
        ...(actualProvider === provider && model ? { model } : {}),
        routeFacts,
        structured,
      },
    );
  } catch (error) {
    childResult = extractChildResult(
      bundle,
      error instanceof Error ? error.message : String(error),
      'failed',
      { actualIterations: 0, interrupted: false },
    );
  } finally {
    emitChildActivityEnd(
      bundle.id,
      options.parentOptions.events,
      options.workflowCorrelation,
      options.childActivityName,
    );
  }
  return childResult;
}

/* ---------- Structured briefing ---------- */

async function buildChildBriefing(
  bundle: KodaXChildContextBundle,
  ctx: KodaXToolExecutionContext,
  maxIter: number,
  maxBriefingTokens: number,
  collaboration: {
    readonly canSpawn: boolean;
    readonly canMessage: boolean;
  },
): Promise<string> {
  // v0.7.26 NEW-2 — give the child agent explicit cwd / git root /
  // platform context. Without this block, the child's LLM has to guess
  // its working directory (it doesn't inherit the parent's system
  // prompt) and routinely `cd`s into invented paths, causing 200
  // iterations of ENOENT bash failures before timeout and an empty
  // result that surfaces to the parent as a mysterious "child failed".
  const childCwd = resolveExecutionCwd(ctx);
  const childGitRoot = ctx.gitRoot;
  const platform = os.platform();
  const platformLabel =
    platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform;
  const shellHint = platform === 'win32'
    ? 'Shell defaults: Windows. Use: dir, move, copy, del, type. Avoid Unix-only tools like `head`, `tail`, `rm`, `cp`, `mv`.'
    : 'Shell defaults: Unix. Use: ls, mv, cp, rm, cat, head, tail.';
  const activeSkillResourceBriefing = buildActiveSkillResourceBriefing(ctx.skillInvocation);
  const referencedSkillBriefing = await buildReferencedSkillBriefing(
    bundle.objective,
    ctx,
  );

  const parts: string[] = [
    `# Child Agent Task`,
    ``,
    `You are a focused sub-agent executing a specific task in parallel with siblings.`,
    `Complete this task efficiently — every iteration the parent waits on adds end-to-end latency. You have a hard limit of ${maxIter} iterations.`,
    ``,
    `## Environment`,
    `Working Directory: ${childCwd}`,
    ...(bundle.isolation === 'worktree'
      ? ['Workflow Isolation: dedicated git worktree requested by the workflow coordinator.']
      : []),
    ...(childGitRoot && childGitRoot !== childCwd ? [`Git Root: ${childGitRoot}`] : []),
    `Platform: ${platformLabel} (${os.release()})`,
    shellHint,
    `All relative paths in your tool calls (read/write/edit/bash) resolve against the Working Directory above. Do NOT \`cd\` into invented paths — the working directory is fixed for the duration of this task, and each \`bash\` call runs in a fresh subprocess so a \`cd\` would not persist across calls anyway.`,
    ``,
    `## Objective`,
    bundle.objective,
    ...(referencedSkillBriefing ? [``, referencedSkillBriefing] : []),
    ``,
    `## Scope`,
    bundle.scopeSummary ?? 'No specific scope summary supplied.',
    ...(activeSkillResourceBriefing ? [``, activeSkillResourceBriefing] : []),
    ``,
    `## Constraints`,
    ...(bundle.constraints.length > 0
      ? bundle.constraints.map((constraint) => `- Binding constraint: ${constraint}`)
      : []),
    bundle.readOnly
      ? '- This is a READ-ONLY task. Do NOT modify any files — the parent dispatched this child specifically for investigation, and a sibling write-child (or the parent itself) will handle any mutations the findings imply.'
      : '- You may modify files within the scope listed above.',
    ...(collaboration.canSpawn
      ? [
          `- You may use the Runtime-bound collaboration tools to spawn direct children when parallel work materially improves speed or quality. Descendants share the same root concurrency, budget, and capability ceilings.`,
        ]
      : []),
    ...(collaboration.canMessage
      ? [
          ``,
          `## Runtime Collaboration`,
          `You can send short messages to other in-flight agents with \`send_message\`: use a canonical peer path for a sibling, \`parent\` for your direct parent, or \`*\` to broadcast. Send only information that would change another agent's plan.`,
          `Forwarding: each received \`<agent-message>\` carries a Runtime-generated \`id\`. Pass it as \`forwarded_message_id\` only when intentionally forwarding that message; Runtime rejects cycles and caps forwarding depth.`,
        ]
      : []),
    ...(bundle.readOnly
      ? []
      : [
          ``,
          // FEATURE_188 v0.7.42 (ADR-034) — write children share parent
          // cwd with siblings, so peer-coordination is prompt-enforced.
          `## Coordination with peers`,
          `Only modify the exact files or generated outputs assigned in the Objective and Scope. In shared isolation, your edits are immediately visible to the parent and siblings; they must not touch or reapply your write set while you work.`,
          `Other agents may be working in parallel in this same repository. Before making any file modification, briefly check whether your target path could be touched by a peer (e.g. the coordinator dispatched another sibling whose scope overlaps yours, or the user mentioned a parallel thread). If you cannot confidently rule out a conflict, STOP and report back to the coordinator with what you observed rather than proceeding with the edit. The coordinator will resolve the conflict or hand you an updated scope.`,
        ]),
    ``,
    `## Execution Strategy (use parallel tool calls)`,
    `- Open broad: scope-scan turn emits parallel \`glob\` for structure + \`grep\` for key patterns + \`read\` on the obvious entry files, all in one response.`,
    `- Iterate narrow: deep-read on files identified by the scope scan, again emitting multiple reads in parallel per turn.`,
    `- Synthesize early: stop investigating once the evidence is sufficient to answer the objective. Extra iterations waste tokens and delay the parent's synthesis.`,
    `- Signal completion with a text-only response (no tool calls). Any final tool call re-opens the turn and forces another LLM round without giving the parent new information.`,
  ];

  const footer = [
    ``,
    `## Output Format`,
    `When done, provide a concise text summary:`,
    ...(bundle.readOnly ? [] : [`- Exact files or generated outputs changed`]),
    `- Key findings (file:line references)`,
    `- Severity assessment (if applicable)`,
    `- Specific recommendations`,
    `Do NOT call any more tools in your final response.`,
  ];

  // FEATURE_246 Part B — when the workflow requested a structured result, the
  // schema instruction comes LAST so it is the final framing the child reads.
  if (bundle.outputSchema !== undefined) {
    footer.push(``, buildStructuredOutputInstruction(bundle.outputSchema));
  }

  if (bundle.evidenceRefs.length > 0) {
    const evidenceHeading = [``, `## Known Evidence`];
    const fixedTokens = countTokens([...parts, ...evidenceHeading, ...footer].join('\n'));
    const evidenceBudget = Math.max(0, maxBriefingTokens - fixedTokens);
    const evidence: Array<{ id: string; toolName: string; content: string }> = [];

    for (const [index, ref] of bundle.evidenceRefs.entries()) {
      evidence.push({
        id: `child-evidence-${index}`,
        toolName: 'child_task_summary',
        content: await resolveEvidenceRef(ref, ctx),
      });
    }

    const admitted = await applyToolResultBatchGuardrail(evidence, ctx, {
      aggregateInlineTokens: evidenceBudget,
    });
    parts.push(...evidenceHeading, ...admitted.entries.map((item) => item.content));
  }

  parts.push(...footer);
  const briefing = parts.join('\n');
  const briefingTokens = countTokens(briefing);
  if (briefingTokens > maxBriefingTokens) {
    throw new ToolResultBatchCapacityError(briefingTokens, maxBriefingTokens);
  }
  return briefing;
}

/**
 * Valid `evidenceRefs[]` prefixes. Source of truth is `resolveEvidenceRef` below
 * (each branch handles one prefix); keep this list in sync with it.
 */
export const WORKFLOW_EVIDENCE_REF_PREFIXES = ['file:', 'diff:', 'finding:', 'task_id:'] as const;

/**
 * FEATURE_246 (review): validate an agent's `evidenceRefs` at SPAWN time, in the
 * real runtime — not only in the generator's smoke dry-run. A ref with no valid
 * prefix (the classic mistake `evidenceRefs: ["baseline"]`, where an agent NAME is
 * used instead of `task_id:<that agent's result.taskId>`) otherwise passes static
 * + runtime type checks and then resolves to a "(unknown)" briefing fragment — the
 * child silently loses the intended context and the workflow author never finds
 * out. Throwing here turns that silent quality loss into a loud spawn-time error
 * the Worker sees as a tool error and can correct. Enforced on every path
 * (generator + inline run_workflow).
 */
export function assertValidWorkflowEvidenceRefs(
  agentName: string,
  evidenceRefs: readonly string[] | undefined,
  // FEATURE_246 (review A1): the set of task ids already spawned in this run. When
  // provided, a `task_id:<id>` ref whose id was never spawned is rejected loudly at
  // spawn — matching the generator smoke's assertKnownTaskId. Without it (repair
  // bundles / unit tests) only the prefix/empty checks run. Otherwise a bogus id
  // (e.g. an agent NAME, or a typo) passes and resolves to a "(not found)" briefing
  // fragment — the child silently loses the intended sibling context.
  knownTaskIds?: ReadonlySet<string>,
): void {
  for (const ref of evidenceRefs ?? []) {
    if (!WORKFLOW_EVIDENCE_REF_PREFIXES.some((prefix) => ref.startsWith(prefix))) {
      throw new Error(
        `wf.runAgent("${agentName}") evidenceRefs entry "${ref}" is not a valid evidence reference. ` +
          'Use one of: file:<path>, diff:<path>, finding:<text>, task_id:<id>. ' +
          "To pass another agent's output, use \"task_id:\" + that agent's result.taskId — not its name.",
      );
    }
    if (ref.startsWith('task_id:')) {
      const taskId = ref.slice('task_id:'.length).trim();
      if (taskId.length === 0) {
        throw new Error(`wf.runAgent("${agentName}") evidenceRefs contains an empty "task_id:" reference.`);
      }
      if (knownTaskIds !== undefined && !knownTaskIds.has(taskId)) {
        throw new Error(
          `wf.runAgent("${agentName}") evidenceRefs references unknown workflow task id "${taskId}". ` +
            'Pass the taskId from a prior result/handle (result.taskId from wf.runAgent, or handle.taskId ' +
            'from wf.spawnAgent) of an agent spawned earlier in this run — not an agent name or a guessed id.',
        );
      }
    }
  }
}

/**
 * Exported for unit testing of the `evidence_refs[]` resolution contract
 * (FEATURE_199 + pre-existing `file:` / `diff:` / `finding:` regression
 * coverage). Not part of the SDK public surface — callers in production
 * still hit it only through `buildChildBriefing`. Keep the implementation
 * private semantics intact: every branch must produce a visible briefing
 * fragment, no silent fallthrough.
 */
export async function resolveEvidenceRef(
  ref: string,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (ref.startsWith('file:')) {
    const filePath = ref.slice(5);
    try {
      const content = await fsPromises.readFile(resolveExecutionPath(filePath, ctx), 'utf-8');
      return `### ${filePath}\n\`\`\`\n${content}\n\`\`\``;
    } catch {
      return `- ${ref} (could not read file)`;
    }
  }
  if (ref.startsWith('diff:')) {
    const filePath = ref.slice(5);
    try {
      const diff = execFileSync('git', [
        'diff',
        'HEAD',
        '--',
        resolveExecutionPath(filePath, ctx),
      ], {
        cwd: resolveExecutionCwd(ctx),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
        windowsHide: true,
      });
      return diff.length > 0
        ? `### diff: ${filePath}\n\`\`\`diff\n${diff}\n\`\`\``
        : `- ${ref} (no changes)`;
    } catch {
      return `- ${ref} (could not get diff)`;
    }
  }
  if (ref.startsWith('finding:')) {
    return `- **Known fact**: ${ref.slice(8)}`;
  }
  if (ref.startsWith('agent-turn:')) {
    if (!ctx.actorControl) {
      return '- [evidence_refs error] agent-turn: requires Actor control.';
    }
    let target;
    try {
      target = parseActorTurnEvidenceRef(ref);
    } catch (error) {
      return `- [evidence_refs error] ${error instanceof Error ? error.message : String(error)}`;
    }
    if (target === undefined) {
      return '- [evidence_refs error] invalid agent-turn reference.';
    }
    let output;
    try {
      output = ctx.actorControl.output(target.actorPath, target.turnId);
    } catch {
      return `- ${ref} (not visible or not controlled by this Agent)`;
    }
    if (output.state === 'running' || output.state === 'accepted') {
      return `- ${ref} (turn still running; wait for its terminal event before forwarding output)`;
    }
    const FENCE = '```';
    let body = output.output ?? output.error ?? '(no final text recorded)';
    if (body.includes(FENCE)) body = body.replace(/```/g, '`\u200b`\u200b`');
    return `### agent-turn:${target.actorPath}#turn=${target.turnId} (${output.state})\n${FENCE}\n${body}\n${FENCE}`;
  }
  if (ref.startsWith('agent:')) {
    const actorPath = ref.slice('agent:'.length).trim();
    if (!actorPath || !ctx.actorControl) {
      return '- [evidence_refs error] agent: requires a visible canonical actor path.';
    }
    let output;
    try {
      output = ctx.actorControl.output(actorPath);
    } catch {
      return `- agent:${actorPath} (not visible or not controlled by this Agent)`;
    }
    if (output.state === 'running' || output.state === 'accepted') {
      return `- agent:${actorPath} (turn still running; wait for its terminal event before forwarding output)`;
    }
    const FENCE = '```';
    let body = output.output ?? output.error ?? '(no final text recorded)';
    if (body.includes(FENCE)) {
      body = body.replace(/```/g, '`\u200b`\u200b`');
    }
    return `### agent: ${actorPath} (${output.state})\n${FENCE}\n${body}\n${FENCE}`;
  }
  // FEATURE_199 (v0.7.44) — unknown prefix → visible error instead of
  // silent fallthrough. Pre-F199 this returned `- ${ref}` verbatim,
  // which made `path:packages/x` (typo for `file:`) / `diff packages/x`
  // (missing colon) / `file: packages/x` (stray whitespace) appear in
  // the child briefing as a useless literal string while the parent LLM
  // believed it had forwarded the evidence. The error string surfaces
  // the failure to the parent on the next turn (it appears in the
  // dispatch tool_result that wraps the child summary) so the Worker
  // can self-correct the prefix.
  return `- [evidence_refs error] unrecognized prefix in "${ref}" — valid prefixes: file:, diff:, finding:, agent-turn:, agent:`;
}

/* ---------- Child events (progress visibility) ---------- */

/**
 * Focused system prompt for child agents — replaces the full system prompt entirely.
 * Mirrors Claude Code's DEFAULT_AGENT_PROMPT: lightweight, task-focused, no AMA overhead.
 * KodaX-specific: emphasizes parallel tool calls and structured output.
 *
 * Read-only children use this verbatim. Write children get an additional
 * mutation-policy section appended via `buildWriteSystemPrompt` (FEATURE_117).
 */
export const CHILD_AGENT_SYSTEM_PROMPT = [
  'You are a focused sub-agent executing a specific task assigned by a parent agent.',
  'Use the available tools to complete the task fully. Do not gold-plate, but do not leave it half-done.',
  '',
  '## Tool Use — Prefer Parallel Calls',
  '',
  'When multiple tool calls are independent of each other, emit them all in the SAME response. The execution engine runs non-bash tools concurrently via Promise.all, so serial calls add real wall-clock latency the parent waits on.',
  '',
  'Concrete rules:',
  '- For module exploration or change review, lead with pull-tools (`module_context` / `symbol_context` / `changed_scope` / `changed_diff_bundle`) — each replaces several read+grep calls so the same investigation finishes in fewer turns.',
  '- For single-file lookup or byte-exact verification, use `glob` + `grep` + targeted `read`.',
  '- When you need multiple independent tool calls (pull-tools, reads, or greps), emit them all in one response. Only serialize when a later call genuinely depends on an earlier result (e.g., you need a file path from grep before you can read it).',
  '- Open broad with a parallel fan-out covering the obvious scope axes, then narrow on follow-up turns. Prefer a few targeted calls over many tiny sequential probes.',
  '',
  '## Execution Guidelines',
  '- Focus on the objective described in the user message. Do not deviate.',
  '- Write your final report in the same natural language as the objective you were given, so it reaches the user in their language. Keep code, file paths, and quoted evidence in their source language.',
  '- When you have sufficient evidence, stop investigating and synthesize your findings.',
  '- Your final response MUST be text only — the parent reads your text directly as the dispatch result, and a final tool call would re-open the turn and force another LLM round without giving the parent new information.',
  '',
  '## Output Format',
  'Respond with a concise report covering:',
  '- Key findings with specific file:line references',
  '- Severity or priority assessment (if applicable)',
  '- Concrete recommendations',
  '',
  'Keep the report focused — the parent will relay it to the user.',
].join('\n');

/**
 * FEATURE_117 v2 (v0.7.38, 2026-05-09) — write-child mutation context.
 *
 * Read-only children get `CHILD_AGENT_SYSTEM_PROMPT` verbatim — they only
 * navigate code, so AGENTS.md mutation policy is irrelevant. Write children
 * (H2 Generator / Worker fan-out) actually edit files and would silently
 * violate project rules ("NEVER use `any`", forbidden imports, coding-style
 * conventions) unless the project's AGENTS.md is in their system prompt.
 *
 * The original FEATURE_117 design ("strip read-path context") was inverted
 * after Phase 3 fact-check showed `systemPromptOverride` already short-
 * circuits `buildSystemPrompt` for ALL children — there was nothing to
 * strip. The real gap is the opposite direction: write children silently
 * skip the project rules. This helper restores them only for the write
 * path.
 *
 * Cost: AGENTS.md is loaded once via `loadAgentsFiles` (mtime-cached by
 * FEATURE_149 Phase 1.2), formatted, and appended to the override.
 * Anthropic `cache_control: ephemeral` covers the system prompt block,
 * so the AGENTS.md tokens are billed once per ~5 min cache window
 * regardless of fan-out size.
 *
 * Returns the base prompt unchanged when no AGENTS.md exists.
 */
function buildWriteSystemPrompt(
  gitRoot: string,
  baseSystemPrompt: string = CHILD_AGENT_SYSTEM_PROMPT,
): string {
  // Sync — `loadAgentsFiles` reads via `readFileSync` and the helper has no
  // async I/O. Kept synchronous so the single mtime-stat-and-cache walk
  // does not pay an unnecessary microtask boundary on every write-child
  // spawn (FEATURE_119 H2 fan-out can dispatch 4-8 children in one wave).
  const agentsFiles = loadAgentsFiles({ cwd: gitRoot, projectRoot: gitRoot });
  const formatted = formatAgentsForPrompt(agentsFiles);
  if (!formatted) return baseSystemPrompt;

  // `formatted` already has its own `# Project Context` H1 + `## … Rules`
  // H2s + `---` dividers. Don't re-wrap with another H2 (`## Mutation
  // Policy`) — the heading hierarchy would invert (H2 → H1 inside) and
  // muddle the structure for the LLM. Just prepend a short framing
  // sentence so the child knows these rules apply to its mutations.
  return [
    baseSystemPrompt,
    '',
    'Project rules apply to your mutations. Follow them as the parent agent would:',
    formatted,
  ].join('\n');
}

/**
 * Tools excluded from child agents at API level (LLM never sees these definitions).
 * Mirrors Claude Code's filterToolsForAgent: no user interaction or parent-only
 * permission controls. Recursive collaboration remains available through the
 * Runtime Actor control surface.
 *
 * Exported for unit-testing the security contract. Treat as read-only at runtime.
 */
export const CHILD_EXCLUDE_TOOLS_BASE: readonly string[] = [
  'ask_user_question',      // Children cannot prompt the user
  'worktree_create',        // Worktree lifecycle managed by parent
  'worktree_remove',        // Worktree lifecycle managed by parent
  'exit_plan_mode',         // Plan-mode exit requires user UI; only the parent REPL wires the callback
];

/** Additional tools excluded for read-only children (no file mutations). */
const CHILD_EXCLUDE_TOOLS_READONLY: readonly string[] = [
  ...CHILD_EXCLUDE_TOOLS_BASE,
  'write',
  'edit',
  'multi_edit',
  'insert_after_anchor',
  'undo',
];

/** Tools blocked at execution time for every child agent. */
const CHILD_BLOCKED_TOOLS_BASE = new Set<string>(CHILD_EXCLUDE_TOOLS_BASE);

/** Runtime no-write floor for read-only children and read-only specialists. */
const CHILD_BLOCKED_TOOLS_READONLY = new Set<string>(CHILD_EXCLUDE_TOOLS_READONLY);

function childActivityEventMeta(
  childId: string,
  workflowCorrelation?: WorkflowEventCorrelation,
  childName?: string,
): KodaXActivityEventMeta {
  return {
    ...(workflowCorrelation !== undefined ? { workflowCorrelation } : {}),
    childAgentId: childId,
    childAgentName: childName ?? childId,
    liveOnly: true,
  };
}

function emitChildActivityEnd(
  childId: string,
  parentEvents?: KodaXEvents,
  workflowCorrelation?: WorkflowEventCorrelation,
  childName?: string,
): void {
  parentEvents?.onChildActivityEnd?.(
    childActivityEventMeta(childId, workflowCorrelation, childName),
  );
}

/**
 * @param planModeBlockCheck FEATURE_074: parent-injected predicate that returns the
 *   block reason for currently-plan-mode-violating tool calls, or `null` when allowed.
 *   The predicate closes over live parent state, so mid-run mode toggles propagate.
 */
export function buildChildEvents(
  childId: string,
  onProgress?: (status: string) => void,
  planModeBlockCheck?: PlanModeBlockCheck,
  _retiredProgressBridge?: unknown,
  parentEvents?: KodaXEvents,
  workflowCorrelation?: WorkflowEventCorrelation,
  childName?: string,
  // Real per-child iteration cap (`options.maxIterationsPerChild`). Seeds
  // the progress-line denominator so it shows the true ceiling from the
  // start instead of a hardcoded guess. `onIterationStart` overwrites it
  // every turn, but seeding from the real value removes the latent trap of
  // a stale default surfacing if a caller ever passes a non-200 cap.
  initialMaxIterations = 200,
  readOnly = false,
): KodaXEvents | undefined {
  let iterationCount = 0;
  let maxIterations = initialMaxIterations;
  let lastProgressTime = 0;
  const blockedTools = readOnly ? CHILD_BLOCKED_TOOLS_READONLY : CHILD_BLOCKED_TOOLS_BASE;
  const PROGRESS_THROTTLE_MS = 150; // Limit updates to ~6/sec per child

  const throttledProgress = (msg: string, force = false): void => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressTime < PROGRESS_THROTTLE_MS) return;
    lastProgressTime = now;
    onProgress(msg);
  };
  const activityEventMeta = (
    meta?: KodaXActivityEventMeta,
    options: { readonly liveOnly?: boolean } = {},
  ): KodaXActivityEventMeta | undefined => {
    const correlatedWorkflow = workflowCorrelation ?? meta?.workflowCorrelation;
    const next: KodaXActivityEventMeta = {
      ...(meta ?? {}),
      ...(correlatedWorkflow !== undefined ? { workflowCorrelation: correlatedWorkflow } : {}),
      ...(meta?.childAgentId !== undefined ? { childAgentId: meta.childAgentId } : { childAgentId: childId }),
      ...(meta?.childAgentName !== undefined ? { childAgentName: meta.childAgentName } : { childAgentName: childName ?? childId }),
      ...(meta?.parentToolId !== undefined ? { parentToolId: meta.parentToolId } : {}),
      ...(options.liveOnly !== undefined ? { liveOnly: options.liveOnly } : {}),
    };
    return next.workflowCorrelation === undefined
      && next.childAgentId === undefined
      && next.childAgentName === undefined
      && next.parentToolId === undefined
      && next.liveOnly === undefined
      ? undefined
      : next;
  };

  const toolEventMeta = (
    meta?: KodaXToolEventMeta,
    options: { readonly liveOnly?: boolean } = {},
  ): KodaXToolEventMeta | undefined => {
    const activityMeta = activityEventMeta(meta, options);
    const next: KodaXToolEventMeta = {
      ...(activityMeta ?? {}),
      ...(meta?.toolId !== undefined ? { toolId: meta.toolId } : {}),
    };
    return next.toolId === undefined
      && next.workflowCorrelation === undefined
      && next.childAgentId === undefined
      && next.childAgentName === undefined
      && next.parentToolId === undefined
      && next.liveOnly === undefined
      ? undefined
      : next;
  };

  return {
    ...(workflowCorrelation ? { workflowCorrelation } : {}),
    onOutputSegmentStart: (segment, meta) => {
      parentEvents?.onOutputSegmentStart?.(
        segment,
        activityEventMeta(meta, { liveOnly: true }),
      );
    },
    onTextDelta: (text, meta) => {
      parentEvents?.onTextDelta?.(text, activityEventMeta(meta, { liveOnly: true }));
    },
    onThinkingDelta: (text, meta) => {
      parentEvents?.onThinkingDelta?.(text, activityEventMeta(meta, { liveOnly: true }));
    },
    onThinkingEnd: (thinking, meta) => {
      parentEvents?.onThinkingEnd?.(thinking, activityEventMeta(meta, { liveOnly: true }));
    },
    onStreamEnd: (meta) => {
      parentEvents?.onStreamEnd?.(activityEventMeta(meta, { liveOnly: true }));
    },
    onProviderRateLimit: (attempt, maxRetries, delayMs, meta) => {
      parentEvents?.onProviderRateLimit?.(
        attempt,
        maxRetries,
        delayMs,
        activityEventMeta(meta, { liveOnly: true }),
      );
    },
    onRetryAfter: (payload, meta) => {
      parentEvents?.onRetryAfter?.(
        payload,
        activityEventMeta(meta, { liveOnly: true }),
      );
    },
    onRetry: (reason, attempt, maxAttempts, meta) => {
      parentEvents?.onRetry?.(
        reason,
        attempt,
        maxAttempts,
        activityEventMeta(meta, { liveOnly: true }),
      );
    },
    onProviderRecovery: (event, meta) => {
      parentEvents?.onProviderRecovery?.(
        event,
        activityEventMeta(meta, { liveOnly: true }),
      );
    },
    // Child compaction is observable but remains context-owned. The child
    // runtime supplies its stable context identity through live attribution;
    // deliberately do not forward onCompactedMessages, which is a persistence
    // mutation callback owned by the child's own runtime rather than the root.
    onCompactStart: (meta) => {
      parentEvents?.onCompactStart?.(activityEventMeta(meta, { liveOnly: true }));
    },
    onCompactStats: (info) => {
      parentEvents?.onCompactStats?.(info);
    },
    onCompact: (estimatedTokens, meta) => {
      parentEvents?.onCompact?.(
        estimatedTokens,
        activityEventMeta(meta, { liveOnly: true }),
      );
    },
    onContextCompactionFinished: (event) => {
      parentEvents?.onContextCompactionFinished?.(event);
    },
    onContextBudgetSnapshot: (event) => {
      parentEvents?.onContextBudgetSnapshot?.(event);
    },
    onPromptCacheDiagnostics: (event) => {
      parentEvents?.onPromptCacheDiagnostics?.(event);
    },
    onToolExposurePlanned: (event) => {
      parentEvents?.onToolExposurePlanned?.(event);
    },
    onContextCompactionSkipped: (event) => {
      parentEvents?.onContextCompactionSkipped?.(event);
    },
    onCompactEnd: (meta, result) => {
      parentEvents?.onCompactEnd?.(
        activityEventMeta(meta, { liveOnly: true }),
        result,
      );
    },
    // Block parent-only tools, then enforce live plan mode. Runtime Actor
    // collaboration tools remain available within the inherited capability ceiling.
    // planModeBlockCheck reads parent state at call time, so mid-run mode toggles
    // (common: user flips plan ↔ accept-edits mid-stream) propagate immediately.
    beforeToolExecute: async (
      tool: string,
      input: Record<string, unknown>,
      meta?: KodaXToolEventMeta,
    ) => {
      if (blockedTools.has(tool)) {
        return `[Tool Error] ${tool}: Not available in child agent context.`;
      }
      if (planModeBlockCheck) {
        const reason = planModeBlockCheck(tool, input);
        if (reason) {
          return `${reason} You are a child agent inheriting plan-mode constraints. Complete investigation and return findings as text — the parent agent will request user approval for any implementation.`;
        }
      }
      if (!parentEvents?.beforeToolExecute) return true;
      return parentEvents.beforeToolExecute(tool, input, toolEventMeta(meta));
    },
    // Silently update counter; tool use line will include it.
    onIterationStart: (iter: number, maxIter: number) => {
      iterationCount = iter;
      maxIterations = maxIter;
      // FEATURE_177: feed iteration into snapshot. Not throttled — one
      // event per iteration is at most a few times per second and we
      // want the snapshot iteration count to be exact, not approximate.
    },
    // Combined progress: "sec-coding [3/200] → read src/foo.ts" (throttled)
    onIterationEnd: (info) => {
      parentEvents?.onIterationEnd?.({ ...info, scope: 'worker' });
    },
    // Combined progress: child [iteration/max] -> tool name (throttled).
    onToolUseStart: (tool, meta) => {
      parentEvents?.onToolUseStart?.(tool, toolEventMeta({
        ...(meta?.toolId !== undefined ? { toolId: meta.toolId } : { toolId: tool.id }),
        ...(meta?.workflowCorrelation !== undefined ? { workflowCorrelation: meta.workflowCorrelation } : {}),
      }, { liveOnly: true }));
      const inputHint = tool.input
        ? (typeof tool.input === 'object'
          ? (tool.input as Record<string, unknown>).path
            ?? (tool.input as Record<string, unknown>).pattern
            ?? (tool.input as Record<string, unknown>).command
            ?? ''
          : '')
        : '';
      const hintStr = typeof inputHint === 'string' ? inputHint.slice(0, 60) : '';
      const hint = hintStr ? ` ${hintStr}` : '';
      throttledProgress(`${childId} [${iterationCount}/${maxIterations}] → ${tool.name}${hint}`);
      // FEATURE_177: feed tool-call breadcrumb into snapshot. Independent
      // of the REPL throttle — breadcrumbs are bounded by the
      // ring-buffer cap, so emitting one per tool call cannot grow the
      // snapshot unbounded.
    },
    onToolInputDelta: (toolName, partialJson, meta) => {
      parentEvents?.onToolInputDelta?.(
        toolName,
        partialJson,
        toolEventMeta(meta, { liveOnly: true }),
      );
    },
    onToolProgress: (update, meta) => {
      parentEvents?.onToolProgress?.(
        update,
        toolEventMeta({
          ...(meta?.toolId !== undefined ? { toolId: meta.toolId } : { toolId: update.id }),
          ...(meta?.workflowCorrelation !== undefined ? { workflowCorrelation: meta.workflowCorrelation } : {}),
        }, { liveOnly: true }),
      );
    },
    onToolResult: (result, meta) => {
      parentEvents?.onToolResult?.(result, toolEventMeta({
        ...(meta?.toolId !== undefined ? { toolId: meta.toolId } : { toolId: result.id }),
        ...(meta?.workflowCorrelation !== undefined ? { workflowCorrelation: meta.workflowCorrelation } : {}),
      }, { liveOnly: true }));
    },
    onToolExecutionStart: (tool, meta) => {
      parentEvents?.onToolExecutionStart?.(tool, toolEventMeta(meta, { liveOnly: true }));
    },
    onToolExecutionEnd: (tool, meta) => {
      parentEvents?.onToolExecutionEnd?.(tool, toolEventMeta(meta, { liveOnly: true }));
    },
    ...(parentEvents?.askUser
      ? { askUser: (options, meta) => parentEvents.askUser!(options, toolEventMeta(meta, { liveOnly: true })) }
      : {}),
    ...(parentEvents?.askUserMulti
      ? { askUserMulti: (options, meta) => parentEvents.askUserMulti!(options, toolEventMeta(meta, { liveOnly: true })) }
      : {}),
    ...(parentEvents?.askUserInput
      ? { askUserInput: (options, meta) => parentEvents.askUserInput!(options, toolEventMeta(meta, { liveOnly: true })) }
      : {}),
  };
}

/* ---------- Result extraction ---------- */

interface ExtractChildResultMeta {
  readonly actualIterations?: number;
  readonly interrupted?: boolean;
  readonly limitReached?: boolean;
  readonly totalTokensUsed?: number;
  readonly digestTokensUsed?: number;
  readonly digestUsage?: WorkflowChildDigestUpdate['usage'];
  readonly sessionId?: string;
  readonly artifactPaths?: readonly string[];
  readonly digest?: string;
  readonly digestFailed?: boolean;
  readonly digestPending?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly routeFacts?: KodaXChildRouteFacts;
  readonly structured?: unknown;
}

function extractMutationArtifactPaths(result: KodaXResult): readonly string[] {
  const mutationKinds = new Set(['file_modified', 'file_created', 'file_deleted']);
  return [
    ...new Set(
      (result.artifactLedger ?? [])
        .filter((entry) => mutationKinds.has(entry.kind))
        .map((entry) => entry.target)
        .filter((target) => target.trim().length > 0),
    ),
  ];
}

function extractChildResult(
  bundle: KodaXChildContextBundle,
  summary: string,
  status: KodaXChildAgentResult['status'],
  meta: ExtractChildResultMeta = {},
): KodaXChildAgentResult {
  return {
    childId: bundle.id,
    fanoutClass: bundle.fanoutClass,
    status,
    disposition: status === 'completed' ? 'valid' : 'needs-more-evidence',
    summary,
    evidenceRefs: bundle.evidenceRefs,
    contradictions: [],
    actualIterations: meta.actualIterations,
    ...(meta.totalTokensUsed !== undefined && meta.totalTokensUsed > 0
      ? { totalTokensUsed: meta.totalTokensUsed }
      : {}),
    ...(meta.digestTokensUsed !== undefined && meta.digestTokensUsed > 0
      ? { digestTokensUsed: meta.digestTokensUsed }
      : {}),
    ...(meta.digestUsage ? { digestUsage: meta.digestUsage } : {}),
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    ...(meta.artifactPaths !== undefined && meta.artifactPaths.length > 0
      ? { artifactPaths: [...meta.artifactPaths] }
      : {}),
    ...(meta.digest ? { digest: meta.digest } : {}),
    ...(meta.digestFailed ? { digestFailed: true } : {}),
    ...(meta.digestPending ? { digestPending: true } : {}),
    ...(meta.provider ? { provider: meta.provider } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.routeFacts ? { routeFacts: meta.routeFacts } : {}),
    ...(meta.structured !== undefined ? { structured: meta.structured } : {}),
    interrupted: meta.interrupted,
    ...(meta.limitReached ? { limitReached: true } : {}),
  };
}

/* ---------- Result merging (anchored incremental) ---------- */

function mergeChildResults(
  bundles: readonly KodaXChildContextBundle[],
  results: readonly KodaXChildAgentResult[],
  cancelledChildren: readonly string[],
): KodaXChildExecutionResult {
  const bundleMap = new Map(bundles.map((b) => [b.id, b]));
  const resultByChildId = new Map(results.map((r) => [r.childId, r]));

  // Findings follow dispatch (bundle) order, not completion order. `results`
  // intentionally stays in completion order for crash attribution, but
  // consumers read `mergedFindings` positionally against the order they
  // requested — so we re-align here. Without this, parallel children that
  // finish out of order produce nondeterministic finding ordering.
  const mergedFindings: KodaXChildFinding[] = bundles
    .map((b) => resultByChildId.get(b.id))
    .filter(
      (r): r is KodaXChildAgentResult =>
        r !== undefined && (r.status === 'completed' || r.summary.length > 0),
    )
    .map((r) => ({
      childId: r.childId,
      objective: bundleMap.get(r.childId)?.objective ?? '',
      evidence: [r.summary, ...r.evidenceRefs],
      artifacts: r.artifactPaths ?? [],
    }));

  const mergedArtifacts = [
    ...new Set(results.flatMap((r) => r.artifactPaths ?? [])),
  ];
  const totalTokensUsed = results.reduce(
    (sum, result) => sum + (result.totalTokensUsed ?? 0),
    0,
  );

  return {
    results,
    mergedFindings,
    mergedArtifacts,
    totalTokensUsed,
    cancelledChildren: [...cancelledChildren],
  };
}

/* ---------- Validation ---------- */

function validateWriteBundles(
  writeBundles: readonly KodaXChildContextBundle[],
  parentRole: string,
  parentHarness: string,
): readonly KodaXChildContextBundle[] {
  if (writeBundles.length === 0) return [];

  // Worker (V2 AMA single-loop primary) is the sole caller allowed to
  // execute write-capable child bundles. The Actor runtime adapter and
  // Workflow adapter both mark this audited path with
  // `parentHarness === 'tool-dispatch'`.
  //
  // Rejected bundles return the executor's ordinary empty result; callers
  // convert that into an explicit failed Actor turn instead of executing an
  // unauthorized write path.
  if (parentRole !== 'worker') {
    return [];
  }
  if (parentHarness !== 'tool-dispatch') {
    return [];
  }

  return writeBundles;
}

/* ---------- Constants ---------- */

const EMPTY_RESULT: KodaXChildExecutionResult = {
  results: [],
  mergedFindings: [],
  mergedArtifacts: [],
  totalTokensUsed: 0,
  cancelledChildren: [],
};
