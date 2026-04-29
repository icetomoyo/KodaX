/**
 * Runner-driven AMA path — FEATURE_084 (v0.7.26).
 *
 * Runner-based replacement for the legacy `runManagedTask` state machine.
 *
 *   - Scout → {Generator (H1) | Planner (H2)} → Evaluator →
 *     {accept | revise → Generator | replan → Planner | blocked}.
 *   - Env flag `KODAX_MANAGED_TASK_RUNTIME=legacy` restores the legacy
 *     path (deleted after Shard 6d-b but preserved as a code search
 *     reference through git history).
 *
 * **Parity coverage (as of v0.7.26 release):**
 *   - Checkpoint detection + per-role write (FEATURE_071) — `_internal/managed-task/checkpoint.ts`
 *   - Budget tracking (per-harness caps + 90%-threshold extension dialog) — `_internal/managed-task/budget.ts`
 *   - Observer events: managed-task status / phase / child fan-out / iteration end / context-token snapshot
 *   - Mutation tracker integration — populated by tool wrappers, surfaced via `recordMutationForTool`
 *   - Session continuity — `options.session.initialMessages` threaded into `Runner.run`'s `runnerInput`
 *   - Role prompts — `_internal/managed-task/role-prompt.ts` restores the full v0.7.22 prompt surface
 *     (decision summary, contract, metadata, verification, tool-policy, evidence strategies,
 *     dispatch_child_task guidance, H0/H1/H2 framework, handoff/verdict/contract block specs)
 *   - Tool observability — Runner `toolObserver` forwards `onToolCall` / `onToolResult`
 *     / `beforeToolExecute` / `onToolProgress`, and per-call `reportToolProgress` injection
 *   - Compaction — `_internal/managed-task/compaction.ts` wraps `intelligentCompact` behind
 *     Runner's `compactionHook`; fires `onCompactStart` / `onCompactStats` / `onCompact` / `onCompactEnd`
 *   - Cost tracking — `CostTracker` per run, `events.getCostReport` populated
 *   - Thinking blocks — preserved on assistant messages (Anthropic extended-thinking contract)
 *   - Sanitize pipeline — `_internal/managed-task/sanitize.ts` strips leaked fences / control markers
 */

import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXTextBlock,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax/ai';
import { KODAX_ESCALATED_MAX_OUTPUT_TOKENS } from '@kodax/ai';
// CAP-012: per-session cost tracker. Import via the substrate re-export
// shim (`agent-runtime/middleware/cost-tracker.ts`) instead of reaching
// directly into `@kodax/ai`, so AMA and SA share one declared substrate
// surface. Runtime implementation is identical (the shim re-exports the
// same `@kodax/ai` symbols); the difference is documented sharing — any
// future cost-tracker substrate wrapper added there is automatically
// picked up by AMA.
import {
  createCostTracker,
  formatCostReport,
  getSummary as getCostSummary,
  recordUsage as recordCostUsage,
  type CostTracker,
} from '../agent-runtime/middleware/cost-tracker.js';
import { KODAX_MAX_MAXTOKENS_RETRIES } from '../constants.js';
import type {
  Agent,
  Handoff,
  RunnableTool,
  RunnerLlmResult,
  RunnerToolContext,
  RunnerToolResult,
} from '@kodax/core';
import {
  EVALUATOR_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  PLANNER_AGENT_NAME,
  Runner,
  SCOUT_AGENT_NAME,
} from '@kodax/core';

import { resolveProvider } from '../providers/index.js';
import {
  buildAutoRepoIntelligenceContext,
  bucketProviderPayloadSize,
  cleanupIncompleteToolCalls,
  describeTransientProviderRetry,
  emitResilienceDebug,
  estimateProviderPayloadBytes,
  saveSessionSnapshot,
  validateAndFixToolHistory,
} from '../agent.js';
import {
  ProviderRecoveryCoordinator,
  StableBoundaryTracker,
  classifyResilienceError,
  resolveResilienceConfig,
  telemetryBoundary,
  telemetryClassify,
  telemetryDecision,
  telemetryRecovery,
} from '../resilience/index.js';
import { waitForRetryDelay } from '../retry-handler.js';
import {
  emitContract,
  emitHandoff,
  emitScoutVerdict,
  emitVerdict,
  resolveHandoffTarget,
  type ProtocolEmitterMetadata,
} from '../agents/protocol-emitters.js';
import { toolBash } from '../tools/bash.js';
import { toolEdit } from '../tools/edit.js';
import { toolMultiEdit } from '../tools/multi-edit.js';
import { toolExitPlanMode } from '../tools/exit-plan-mode.js';
import { toolGlob } from '../tools/glob.js';
import { toolGrep } from '../tools/grep.js';
import { toolRead } from '../tools/read.js';
import { toolWrite } from '../tools/write.js';
import { toolDispatchChildTask } from '../tools/dispatch-child-tasks.js';
// M1 parity (v0.7.26) — repo-intel + MCP handlers required to give Planner
// the same inspection surface it had under v0.7.22's
// `buildManagedWorkerToolPolicy('planner')` allow-list.
import { toolRepoOverview } from '../tools/repo-overview.js';
import { toolChangedScope } from '../tools/changed-scope.js';
import { toolChangedDiff, toolChangedDiffBundle } from '../tools/changed-diff.js';
import { toolMcpSearch } from '../tools/mcp-search.js';
import { toolMcpDescribe } from '../tools/mcp-describe.js';
import { toolMcpCall } from '../tools/mcp-call.js';
import { toolMcpReadResource } from '../tools/mcp-read-resource.js';
import { toolMcpGetPrompt } from '../tools/mcp-get-prompt.js';
import { getToolDefinition, MCP_TOOL_NAMES } from '../tools/registry.js';
import type {
  KodaXEvents,
  KodaXHarnessProfile,
  KodaXJsonValue,
  KodaXManagedProtocolPayload,
  KodaXManagedTask,
  KodaXManagedTaskPhase,
  KodaXOptions,
  KodaXReasoningMode,
  KodaXResult,
  KodaXRoleRoundSummary,
  KodaXTaskContract,
  KodaXTaskEvidenceArtifact,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskRoleAssignment,
  KodaXTaskRoutingDecision,
  KodaXTaskStatus,
  KodaXTaskToolPolicy,
  KodaXTaskVerificationContract,
  KodaXToolExecutionContext,
  ManagedMutationTracker,
} from '../types.js';
import type { ReasoningPlan } from '../reasoning.js';
import {
  applyFollowupEscalationToOptions,
  buildAmaControllerDecision,
  buildPromptOverlay,
  reasoningModeToDepth,
  resolveReasoningMode,
  resolveRoleReasoning,
  type ReasoningRole,
} from '../reasoning.js';
import type { ManagedTaskBudgetController } from './_internal/managed-task/budget.js';
import {
  buildManagedStatusBudgetFields,
  incrementManagedBudgetUsage,
  maybeRequestAdditionalWorkBudget,
} from './_internal/managed-task/budget.js';
import type {
  ManagedTaskCheckpoint,
  ValidatedCheckpoint,
} from './_internal/managed-task/checkpoint.js';
import {
  deleteCheckpoint,
  findValidCheckpoint,
  getGitHeadCommit,
  writeCheckpoint,
} from './_internal/managed-task/checkpoint.js';
import {
  getManagedTaskSurface,
  getManagedTaskWorkspaceRoot,
} from './_internal/managed-task/workspace.js';
import {
  buildManagedTaskArtifactRecords,
  getManagedSkillArtifactPaths,
  mergeEvidenceArtifacts,
  writeManagedSkillArtifacts,
  writeManagedTaskArtifacts,
  writeManagedTaskSnapshotArtifacts,
} from './_internal/managed-task/artifacts.js';
import { attachManagedTaskRepoIntelligence } from './_internal/managed-task/repo-intelligence.js';
import {
  buildManagedWorkerToolPolicy,
  DOCS_ONLY_WRITE_PATH_PATTERNS,
  enforceShellWriteBoundary,
  enforceWritePathBoundary,
  inferScoutMutationIntent,
  matchesShellPattern,
  SHELL_WRITE_PATTERNS,
  type ScoutMutationIntent,
} from './_internal/managed-task/tool-policy.js';
import {
  createVerificationScorecard,
  type ScorecardVerdictDirective,
} from './_internal/managed-task/scorecard.js';
import { applyCurrentDiffReviewRoutingFloor } from './_internal/managed-task/review-routing.js';
import {
  SUSPICIOUS_LAST_TEXT_PREVIEW_LIMIT,
  detectScoutSuspiciousSignals,
} from './_internal/managed-task/scout-signals.js';
import { createRolePrompt } from './_internal/managed-task/role-prompt.js';
import type { ManagedRolePromptContext } from './_internal/managed-task/role-prompt-types.js';
import {
  attemptProtocolTextFallback,
  getEmitToolNameForRole,
} from './_internal/managed-task/parse-helpers.js';
import { getManagedBlockNameForRole } from '../managed-protocol.js';
import {
  MANAGED_CONTROL_PLANE_MARKERS,
  sanitizeEvaluatorPublicAnswer,
  sanitizeManagedStreamingText,
  sanitizeManagedUserFacingText,
} from './_internal/managed-task/sanitize.js';
import { buildManagedTaskCompactionHook } from './_internal/managed-task/compaction.js';
import { createToolResultTruncationGuardrail } from '../tools/tool-result-truncation-guardrail.js';
import { buildPromptMessageContent } from '../input-artifacts.js';
// CAP-003/004/005/006/007: shared event emit helpers. Both SA (substrate
// frame) and AMA (this runner-driven path) fire through the same
// surface so the contract for each event lives in exactly one place.
import {
  emitComplete,
  emitError,
  emitProviderRateLimit,
  emitSessionStart,
  emitStreamEnd,
  isVisibleToolName,
} from '../agent-runtime/event-emitter.js';
// CAP-008: shared initial-messages resolver. Three-tier fallback
// (inline → storage.load → empty) for AMA frame entry; SA already
// uses this from `run-substrate.ts`.
import { resolveInitialMessages } from '../agent-runtime/middleware/auto-resume.js';
// CAP-010: shared tri-state permission gate. AMA's
// `toolObserver.beforeTool` delegates to this so the extension
// `tool:before` hook fires on AMA path (pre-FEATURE_100 only SA hit
// it).
import { getToolExecutionOverride } from '../agent-runtime/permission-gate.js';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../constants.js';
// CAP-048: shared tool-execution-context builder. Centralizes
// FEATURE_074 (set_permission_mode NOT forwarded) and FEATURE_067
// (onChildProgress undefined) invariants so AMA and SA can't drift.
import { buildToolExecutionContext } from '../agent-runtime/tool-execution-context.js';
import path from 'node:path';
import os from 'node:os';
import { resolveExecutionCwd } from '../runtime-paths.js';
import { mkdir } from 'node:fs/promises';

/**
 * Env-flag check. `KODAX_MANAGED_TASK_RUNTIME=runner` enables the Runner-
 * driven path. Case-insensitive match.
 */
export function isRunnerDrivenRuntimeEnabled(): boolean {
  const value = process.env.KODAX_MANAGED_TASK_RUNTIME?.trim().toLowerCase();
  return value === 'runner';
}

// =============================================================================
// Role instructions — self-contained strings (no ManagedRolePromptContext).
// Kept minimal deliberately: enough to steer the LLM through the protocol
// without reproducing the full legacy `createRolePrompt` surface.
// =============================================================================

/**
 * Fallback role instructions — used when `buildRunnerAgentChain` is invoked
 * without a full prompt context (e.g. unit tests asserting the agent
 * topology). The real runtime path (`runManagedTaskViaRunner`) always
 * provides a `RolePromptContextFactory`, which routes through
 * `createRolePrompt` for the full v0.7.22-parity role prompt (decision
 * summary, contract, metadata, verification, tool-policy, evidence
 * strategies, dispatch_child_task guidance, H0/H1/H2 framework,
 * handoff/verdict/contract block specs, shared closing rules).
 */
const SCOUT_INSTRUCTIONS_FALLBACK = [
  'You are Scout, the AMA entry role. Analyse the user task, then choose a harness tier:',
  '  - H0_DIRECT: trivial lookup / factual / review — Scout answers directly, no handoff',
  '  - H1_EXECUTE_EVAL: execution task, small scope — hand off to Generator, Evaluator verifies',
  '  - H2_PLAN_EXECUTE_EVAL: larger task, needs structured plan — hand off to Planner first',
  '',
  'You may call these tools to gather context: read, grep, glob, bash, dispatch_child_task.',
  '',
  'When ready, call `emit_scout_verdict` exactly once with `confirmed_harness` set.',
].join('\n');

const PLANNER_INSTRUCTIONS_FALLBACK = [
  'You are Planner (H2 role). Call `emit_contract` exactly once with summary, success_criteria, ',
  'required_evidence, constraints. You may call: read, grep, glob.',
].join('\n');

const GENERATOR_INSTRUCTIONS_FALLBACK = [
  'You are Generator (H1/H2 execution role). Execute the task and call `emit_handoff` exactly ',
  'once with status/summary/evidence/followup. You may call: read, grep, glob, bash, write, ',
  'edit, dispatch_child_task.',
].join('\n');

const EVALUATOR_INSTRUCTIONS_FALLBACK = [
  'You are Evaluator (H1/H2 verifier). Call `emit_verdict` exactly once with status ',
  '(accept|revise|blocked). You may call: read, grep, glob, bash (read-only verification ',
  'preferred).',
].join('\n');

/**
 * Factory that resolves the `ManagedRolePromptContext` for a given role
 * from the current recorder state. Called by the dynamic `instructions`
 * closure on every agent invocation, so Scout's post-emit skillMap /
 * scope reach downstream role prompts in real time.
 */
export type RolePromptContextFactory = (
  role: KodaXTaskRole,
  recorder: VerdictRecorder,
) => ManagedRolePromptContext | undefined;

/**
 * Optional prompt context plumbed into `buildRunnerAgentChain`. When
 * present, the chain builder uses `createRolePrompt` to produce a full
 * v0.7.22-parity role prompt for every turn. When absent (test paths),
 * the fallback constants above are used instead.
 */
export interface RunnerChainPromptContext {
  /** Original user task. Becomes `rolePromptContext.originalTask`. */
  readonly prompt: string;
  /**
   * Routing decision. Legacy callers / tests pass a static
   * `KodaXTaskRoutingDecision` captured at chain construction. The
   * runtime path passes a `() => KodaXTaskRoutingDecision` thunk so the
   * Generator / Evaluator see the post-Scout plan (M4 parity) instead of
   * the stale pre-Scout decision captured when the agent graph was
   * frozen. Without the thunk, a plan=H2 + Scout=H1 run leaks H2-only
   * prompt guidance into H1 workers.
   */
  readonly decision: KodaXTaskRoutingDecision | (() => KodaXTaskRoutingDecision);
  /** Optional structured task metadata. */
  readonly metadata?: Record<string, KodaXJsonValue>;
  /**
   * Optional static tool policy. Kept for tests / topology-only call sites
   * that don't need per-role policy. When both `toolPolicy` and
   * `toolPolicyFactory` are absent, the prompt's "## Tool Policy" section
   * is omitted (matches legacy behavior when a role falls through to
   * `undefined` in `buildManagedWorkerToolPolicy`).
   */
  readonly toolPolicy?: KodaXTaskToolPolicy;
  /**
   * P1 parity — per-role tool policy factory. Called lazily at each
   * Runner invocation so the Generator branch can see Scout's mutation
   * intent (which is only known after Scout emits). Without this, every
   * managed worker's prompt drops the "## Tool Policy" section. See
   * `buildManagedWorkerToolPolicy` for the switch body.
   */
  readonly toolPolicyFactory?: (
    role: KodaXTaskRole,
    recorder: VerdictRecorder,
  ) => KodaXTaskToolPolicy | undefined;
  /** Optional role-context factory for skillMap / scoutScope / childWriteReviewPrompt injection. */
  readonly contextFactory?: RolePromptContextFactory;
  /**
   * Pre-computed repo-intelligence context block (Repository Overview /
   * Changed Scope / Active Module / Impact / Fallback Guidance /
   * Premium Context sections). Built once per `runManagedTaskViaRunner`
   * entry via `buildAutoRepoIntelligenceContext` and prepended to every
   * role's system prompt so Scout/Planner/Generator/Evaluator see repo
   * context from turn 1.
   */
  readonly repoIntelligenceContext?: string;
}

/**
 * Shard 6d-T: render Scout's skill map as an appended "Execution
 * Obligations" block. Mirrors legacy `task-engine.ts` behaviour where
 * Scout's skillMap.{skillSummary, executionObligations, ambiguities}
 * was surfaced to Generator as a concrete obligation list before
 * execution. Without this block, `skillMap.executionObligations` is
 * parsed into `scoutDecision.skillMap` but never reaches the model
 * doing the work.
 *
 * Passing `includeVerification: true` additionally surfaces
 * `verificationObligations` — used by Evaluator, whose QA plan
 * legacy also branched on Scout's verification guidance.
 */
function renderScoutSkillMapBlock(
  recorder: VerdictRecorder,
  { includeVerification }: { includeVerification: boolean },
): string | undefined {
  const skillMap = recorder.scout?.payload.scout?.skillMap;
  if (!skillMap) return undefined;
  const exec = skillMap.executionObligations ?? [];
  const verify = skillMap.verificationObligations ?? [];
  const ambig = skillMap.ambiguities ?? [];
  const hasExec = exec.length > 0;
  const hasVerify = includeVerification && verify.length > 0;
  const hasAmbig = ambig.length > 0;
  if (!skillMap.skillSummary && !hasExec && !hasVerify && !hasAmbig) {
    return undefined;
  }
  const lines = ['', '=== Scout Skill Map (required obligations) ==='];
  if (skillMap.skillSummary) {
    lines.push(`skill_summary: ${skillMap.skillSummary}`);
  }
  if (hasExec) {
    lines.push('execution_obligations:');
    for (const item of exec) lines.push(`- ${item}`);
  }
  if (hasVerify) {
    lines.push('verification_obligations:');
    for (const item of verify) lines.push(`- ${item}`);
  }
  if (hasAmbig) {
    lines.push('ambiguities_to_resolve:');
    for (const item of ambig) lines.push(`- ${item}`);
  }
  lines.push(
    'You must address every obligation above. If any obligation cannot be met, ',
    'surface it in your emit payload (`followup` for Generator, `reason` for Evaluator).',
  );
  return lines.join('\n');
}

/**
 * Resolve the system prompt for a role. When the full `promptContext`
 * (prompt + decision) is present, delegate to `createRolePrompt` for the
 * v0.7.22-parity prompt (decision summary, contract, metadata,
 * verification, tool-policy, evidence strategies, dispatch_child_task
 * guidance, H0/H1/H2 framework, handoff/verdict/contract block specs).
 * Otherwise fall back to the minimal static constants — keeps test
 * fixtures that call `buildRunnerAgentChain(ctx, {})` working.
 */
function resolveRoleInstructions(
  role: KodaXTaskRole,
  agentName: string,
  fallback: string,
  recorder: VerdictRecorder,
  promptContext: RunnerChainPromptContext | undefined,
  verification: KodaXTaskVerificationContract | undefined,
): string {
  if (!promptContext) {
    // Legacy minimal-instructions path for tests / topology-only calls.
    // Still append the skillMap block if Scout has emitted one, so
    // downstream roles get Scout's execution obligations even in the
    // fallback path.
    if (role === 'generator') {
      const block = renderScoutSkillMapBlock(recorder, { includeVerification: false });
      return block ? `${fallback}\n${block}` : fallback;
    }
    if (role === 'evaluator') {
      const skillBlock = renderScoutSkillMapBlock(recorder, { includeVerification: true });
      const runtimeBlock = renderRuntimeVerificationBlock(verification);
      let out = fallback;
      if (skillBlock) out += `\n${skillBlock}`;
      if (runtimeBlock) out += `\n${runtimeBlock}`;
      return out;
    }
    return fallback;
  }
  const ctx = promptContext.contextFactory
    ? promptContext.contextFactory(role, recorder)
    : { originalTask: promptContext.prompt };
  // P1 parity — resolve per-role tool policy at invocation time so the
  // Generator branch can see Scout's mutation intent. Falls back to the
  // static `toolPolicy` for tests / topology-only paths.
  const toolPolicy = promptContext.toolPolicyFactory
    ? promptContext.toolPolicyFactory(role, recorder)
    : promptContext.toolPolicy;
  // M4 parity — resolve routing decision lazily. When the caller supplies
  // a thunk, the Generator / Evaluator see the post-Scout decision
  // (`applyScoutDecisionToPlan` output) rather than the pre-Scout
  // snapshot. Tests pass a static decision for topology checks.
  const decision = typeof promptContext.decision === 'function'
    ? promptContext.decision()
    : promptContext.decision;
  const basePrompt = createRolePrompt(
    role,
    promptContext.prompt,
    decision,
    verification,
    toolPolicy,
    agentName,
    promptContext.metadata,
    ctx,
    undefined, // workerId — unused by createRolePrompt body
    false, // isTerminalAuthority — Runner-driven path always runs with Evaluator
  );
  // FEATURE_086: prepend the pre-computed repo-intelligence context
  // block so every role sees repo overview /
  // changed scope / active module / impact metadata from turn 1. Legacy
  // `runKodaX` injected this via `buildAutoRepoIntelligenceContext` inside
  // `buildReasoningExecutionState`; the Runner-driven path (FEATURE_084
  // Shard 6d-L) routed around `runKodaX` and lost the injection.
  const repoBlock = promptContext.repoIntelligenceContext?.trim();
  return repoBlock
    ? `${repoBlock}\n\n${basePrompt}`
    : basePrompt;
}

/**
 * Shard 6d-S: render `verification.runtime` into an Evaluator-facing
 * block listing the startup command, ready signal, base URL, declared
 * UI flows, API checks, DB checks, and fixtures. Legacy
 * `buildRuntimeExecutionGuide` wrote an equivalent markdown file to
 * `runtime-execution.md`; the Runner path also needs to surface the
 * same obligations inline so the Evaluator actively probes the runtime
 * instead of writing a verdict from static file reads. Without this
 * block, `taskVerification.runtime` is persisted to
 * `runtime-contract.json` but never reaches the model making the
 * accept/revise/blocked call.
 */
function renderRuntimeVerificationBlock(
  verification: KodaXTaskVerificationContract | undefined,
): string | undefined {
  const runtime = verification?.runtime;
  if (!runtime) return undefined;
  const hasAny = Boolean(
    runtime.startupCommand
      || runtime.readySignal
      || runtime.baseUrl
      || (runtime.uiFlows?.length ?? 0) > 0
      || (runtime.apiChecks?.length ?? 0) > 0
      || (runtime.dbChecks?.length ?? 0) > 0
      || (runtime.fixtures?.length ?? 0) > 0,
  );
  if (!hasAny) return undefined;
  const lines = ['', '=== Runtime Verification Contract ==='];
  if (runtime.cwd) lines.push(`- cwd: ${runtime.cwd}`);
  if (runtime.startupCommand) lines.push(`- startup_command: ${runtime.startupCommand}`);
  if (runtime.readySignal) lines.push(`- ready_signal: ${runtime.readySignal}`);
  if (runtime.baseUrl) lines.push(`- base_url: ${runtime.baseUrl}`);
  if (runtime.env && Object.keys(runtime.env).length > 0) {
    lines.push(`- env_keys: ${Object.keys(runtime.env).join(', ')}`);
  }
  if (runtime.uiFlows?.length) {
    lines.push('ui_flows (execute with bash via the app\'s own test harness; capture evidence):');
    runtime.uiFlows.forEach((flow, idx) => lines.push(`  ${idx + 1}. ${flow}`));
  }
  if (runtime.apiChecks?.length) {
    lines.push('api_checks (curl / wget / app-specific CLI):');
    runtime.apiChecks.forEach((check, idx) => lines.push(`  ${idx + 1}. ${check}`));
  }
  if (runtime.dbChecks?.length) {
    lines.push('db_checks (psql / sqlite / equivalent):');
    runtime.dbChecks.forEach((check, idx) => lines.push(`  ${idx + 1}. ${check}`));
  }
  if (runtime.fixtures?.length) {
    lines.push('fixtures:');
    runtime.fixtures.forEach((fixture, idx) => lines.push(`  ${idx + 1}. ${fixture}`));
  }
  lines.push(
    'Before accepting, start the runtime (if declared), wait for the ready signal, and ',
    'exercise every declared flow/check. Reject (status=revise or blocked) if any check ',
    'cannot be executed or fails.',
  );
  return lines.join('\n');
}

/**
 * Shard 6d-S: derive `completionContractStatus` from the final verdict.
 * Keys are criterion ids (from `verification.criteria`) plus synthetic
 * `ui_flow:<n>` / `api_check:<n>` / `db_check:<n>` keys for the runtime
 * contract entries. Status maps 1:1 from verdict status:
 *   - 'accept'   → 'ready'
 *   - 'revise'   → 'incomplete'
 *   - 'blocked'  → 'blocked'
 *   - no verdict → 'missing' (every declared check is unverified)
 * Returns undefined when no verification contract is declared — matches
 * legacy's absent-field semantics so downstream consumers stay opt-in.
 */
function buildCompletionContractStatus(
  verification: KodaXTaskVerificationContract | undefined,
  verdictStatus: 'accept' | 'revise' | 'blocked' | undefined,
): Record<string, 'ready' | 'incomplete' | 'blocked' | 'missing'> | undefined {
  if (!verification) return undefined;
  const criteria = verification.criteria ?? [];
  const runtime = verification.runtime;
  const uiFlows = runtime?.uiFlows ?? [];
  const apiChecks = runtime?.apiChecks ?? [];
  const dbChecks = runtime?.dbChecks ?? [];
  if (criteria.length === 0 && uiFlows.length === 0 && apiChecks.length === 0 && dbChecks.length === 0) {
    return undefined;
  }
  const status: 'ready' | 'incomplete' | 'blocked' | 'missing' =
    verdictStatus === 'accept'
      ? 'ready'
      : verdictStatus === 'blocked'
        ? 'blocked'
        : verdictStatus === 'revise'
          ? 'incomplete'
          : 'missing';
  const out: Record<string, 'ready' | 'incomplete' | 'blocked' | 'missing'> = {};
  for (const criterion of criteria) out[criterion.id] = status;
  uiFlows.forEach((_flow, idx) => {
    out[`ui_flow:${idx + 1}`] = status;
  });
  apiChecks.forEach((_check, idx) => {
    out[`api_check:${idx + 1}`] = status;
  });
  dbChecks.forEach((_check, idx) => {
    out[`db_check:${idx + 1}`] = status;
  });
  return out;
}

// =============================================================================
// Verdict recorder — observes emit tool calls to reconstruct the final
// KodaXResult.managedTask payload from the Runner chain.
// =============================================================================

export interface VerdictRecorder {
  scout?: ProtocolEmitterMetadata;
  contract?: ProtocolEmitterMetadata;
  handoff?: ProtocolEmitterMetadata;
  verdict?: ProtocolEmitterMetadata;
}

/**
 * Role-mapping for `onManagedTaskStatus` emissions. Each emit tool
 * corresponds to a role that has just finished its turn.
 */
const SLOT_TO_ROLE: Record<'scout' | 'contract' | 'handoff' | 'verdict', KodaXTaskRole> = {
  scout: 'scout',
  contract: 'planner',
  handoff: 'generator',
  verdict: 'evaluator',
};

/**
 * Context needed to fire the 90%-threshold budget-extension dialog on
 * Evaluator revise. Mirrors the legacy payload shape at task-engine.ts:
 * ~6000 (inside the revise branch of executeManagedTaskRound).
 */
interface BudgetExtensionContext {
  readonly events: KodaXEvents | undefined;
  readonly originalTask: string;
  readonly roundRef: { current: number };
  readonly maxRoundsRef: { current: number };
  readonly budgetApprovalRef: { current: boolean };
  // Shard 6d-U: plan + degraded-continue + harness refs so the verdict
  // emitter wrapper can guard against H1→H2 upgrade attempts that exceed
  // `plan.decision.upgradeCeiling`. When denied, we redirect handoff
  // back to Generator (continue at current harness) and flip
  // `degradedContinueRef.current = true` so the runtime payload surfaces
  // the degraded continue state to REPL / CLI consumers.
  readonly planRef: { current: ReasoningPlan | undefined };
  readonly degradedContinueRef: { current: boolean };
  readonly harnessRef: { current: KodaXHarnessProfile };
  /**
   * v0.7.26 Risk-2 fix — per-harness Evaluator revise counter. Mirrors
   * legacy `h1CheckedDirectRevisesUsed`: H1 allows at most 1 same-harness
   * revise before the wrapper auto-converts a second revise into either
   * an H2 escalation (if `upgradeCeiling >= H2`) or an accept-with-
   * followup (if upgradeCeiling blocks further escalation). Without this
   * cap, the Runner-driven handoff topology allows Evaluator → Generator
   * → Evaluator → ... up to `MAX_ROUNDS_BY_HARNESS[H1] = 6` rounds,
   * which in the Scout-confusion loop the user reported keeps spinning
   * for 3-4 revise cycles before budget exhaustion.
   */
  readonly reviseCountByHarnessRef: {
    current: Map<KodaXHarnessProfile, number>;
  };
}

/**
 * Risk-2 policy constants. H1 allows 1 same-harness revise before the
 * wrapper escalates or converts — matches legacy
 * `h1CheckedDirectRevisesUsed` semantics.
 */
const H1_MAX_SAME_HARNESS_REVISES = 1;

/**
 * Shard 6d-U: harness ordering from low to high. Used to compare a
 * requested next_harness against `upgradeCeiling`. Mirrors legacy
 * `HARNESS_TIER_ORDER` (task-engine.ts constant used by the routing
 * coordinator).
 */
const HARNESS_TIER_ORDER: Record<KodaXHarnessProfile, number> = {
  H0_DIRECT: 0,
  H1_EXECUTE_EVAL: 1,
  H2_PLAN_EXECUTE_EVAL: 2,
};

function isUpgradeBeyondCeiling(
  requested: KodaXHarnessProfile,
  ceiling: KodaXHarnessProfile,
): boolean {
  return HARNESS_TIER_ORDER[requested] > HARNESS_TIER_ORDER[ceiling];
}

/**
 * Wrap a protocol emitter so every successful execution records its
 * `ProtocolEmitterMetadata` into the per-run recorder AND fires a
 * managed-task status observer event. The wrapped tool otherwise behaves
 * identically to the base tool.
 *
 * On Evaluator `revise`, if the cumulative budget usage crosses 90% of the
 * current cap, fire `maybeRequestAdditionalWorkBudget` to ask the user
 * whether to extend. `approved` bumps the budget by
 * `GLOBAL_WORK_BUDGET_INCREMENT`; `denied` / `skipped` leave it unchanged
 * (the Runner keeps running since budget is advisory; the user has been
 * informed). Mirrors legacy task-engine.ts behaviour at ~line 6000.
 */
function wrapEmitterWithRecorder(
  base: RunnableTool,
  slot: 'scout' | 'contract' | 'handoff' | 'verdict',
  recorder: VerdictRecorder,
  observer: ObserverBridge,
  budget?: ManagedTaskBudgetController,
  budgetExtension?: BudgetExtensionContext,
  // M5 (v0.7.26) — Scout regained full write/edit/multi_edit tools
  // for v0.7.22 parity. The H0 path is fine (Scout is the final
  // author), but on H1/H2 Scout SHOULD keep its hands off the
  // filesystem and hand off a clean slate to Generator. If Scout
  // wrote anyway, the Evaluator's diff later on will mix Scout's
  // changes with Generator's, confusing verification. These two
  // closures give the scout-slot wrapper observable access to the
  // mutation tracker + event sink so it can flag the situation at
  // emit time with a user-visible status event + server-side log.
  mutationTracker?: ManagedMutationTracker,
  events?: KodaXEvents,
): RunnableTool {
  return {
    ...base,
    execute: async (input, ctx): Promise<RunnerToolResult> => {
      if (budget) incrementManagedBudgetUsage(budget, 1);
      let result = await base.execute(input, ctx);
      if (!result.isError && result.metadata) {
        // Shard 6d-U: guard against H1→H2 upgrade attempts that exceed
        // `plan.decision.upgradeCeiling`. When the Evaluator issues
        // `revise + next_harness=H2` but the plan only permits H1, we
        // rewrite the emitter's `handoffTarget` from Planner back to
        // Generator (continue at the current harness) and flip the
        // degraded-continue ref so the final managed-task runtime carries
        // `degradedContinue: true`. Mirrors legacy's
        // `denyHarnessUpgrade → degradedContinue` branch.
        if (slot === 'verdict' && budgetExtension) {
          const emitterMeta = result.metadata as unknown as ProtocolEmitterMetadata;
          const verdictPayload = emitterMeta.payload?.verdict;
          const requested = verdictPayload?.nextHarness;
          const ceiling = budgetExtension.planRef.current?.decision.upgradeCeiling;
          if (
            verdictPayload?.status === 'revise'
            && requested
            && ceiling
            && isUpgradeBeyondCeiling(requested, ceiling)
          ) {
            budgetExtension.degradedContinueRef.current = true;
            // Rewrite handoff target back to Generator so the next turn
            // continues execution under the current harness rather than
            // pivoting to Planner. Both the recorder copy and the result
            // returned to the Runner must carry the redirected target.
            const redirectedMetadata: ProtocolEmitterMetadata = {
              ...emitterMeta,
              handoffTarget: GENERATOR_AGENT_NAME,
            };
            result = { ...result, metadata: redirectedMetadata as unknown as Record<string, unknown> };
          }

          // v0.7.26 Risk-2 fix — H1 same-harness revise cap. Without
          // this, Evaluator can emit `revise` repeatedly up to
          // `MAX_ROUNDS_BY_HARNESS[H1] = 6`, which manifested in user
          // reports as the Scout → Generator → Evaluator death loop.
          // Legacy capped H1 at 1 same-harness revise via
          // `h1CheckedDirectRevisesUsed`; we do the same here.
          //
          // Policy when cap is exceeded:
          //   - upgradeCeiling permits H2 → auto-rewrite the verdict
          //     into an H2 escalation (nextHarness=H2, handoffTarget
          //     restored to Planner). User sees a planner turn added
          //     rather than another revise cycle.
          //   - upgradeCeiling blocks upgrade → auto-convert to accept:
          //     status=accept, followups prepended with Evaluator's
          //     reason so the remaining concern is visible to the user.
          //     Flip degradedContinue so the runtime surfaces the
          //     "accepted under cap" state. The accept is NOT silent —
          //     the reason line is the first followup.
          const currentHarness = budgetExtension.harnessRef.current;
          const updatedEmitterMeta = result.metadata as unknown as ProtocolEmitterMetadata;
          const updatedVerdict = updatedEmitterMeta.payload?.verdict;
          if (
            updatedVerdict?.status === 'revise'
            && currentHarness === 'H1_EXECUTE_EVAL'
          ) {
            const revisesSoFar = budgetExtension.reviseCountByHarnessRef.current.get(currentHarness) ?? 0;
            if (revisesSoFar >= H1_MAX_SAME_HARNESS_REVISES) {
              const ceilingForUpgrade = budgetExtension.planRef.current?.decision.upgradeCeiling;
              const canEscalateToH2 =
                ceilingForUpgrade
                && !isUpgradeBeyondCeiling('H2_PLAN_EXECUTE_EVAL', ceilingForUpgrade);
              if (canEscalateToH2) {
                // Auto-escalate: rewrite the verdict to an H2 revise so
                // the Planner picks up the flow. The existing handoff
                // routing (verdict → Planner for replan) kicks in.
                const escalationReason = `Auto-escalated to H2 after H1 revise cap reached. Original reason: ${updatedVerdict.reason ?? '(none)'}`;
                const escalatedMetadata: ProtocolEmitterMetadata = {
                  ...updatedEmitterMeta,
                  payload: {
                    ...updatedEmitterMeta.payload,
                    verdict: {
                      ...updatedVerdict,
                      nextHarness: 'H2_PLAN_EXECUTE_EVAL',
                      reason: escalationReason,
                    },
                  },
                  handoffTarget: PLANNER_AGENT_NAME,
                };
                result = { ...result, metadata: escalatedMetadata as unknown as Record<string, unknown> };
              } else {
                // Convert to accept-with-followup. Preserve Evaluator's
                // reason as the leading followup line so the user sees
                // what the Evaluator still wanted fixed.
                const pendingConcern = updatedVerdict.reason
                  ? `Pending concern from Evaluator (accepted under H1 revise cap): ${updatedVerdict.reason}`
                  : 'Pending concern from Evaluator (accepted under H1 revise cap): revise reason not provided.';
                const followupsList = [pendingConcern, ...(updatedVerdict.followups ?? [])];
                const convertedMetadata: ProtocolEmitterMetadata = {
                  ...updatedEmitterMeta,
                  payload: {
                    ...updatedEmitterMeta.payload,
                    verdict: {
                      ...updatedVerdict,
                      status: 'accept',
                      followups: followupsList,
                      nextHarness: undefined,
                    },
                  },
                  isTerminal: true,
                  handoffTarget: undefined,
                };
                budgetExtension.degradedContinueRef.current = true;
                result = { ...result, metadata: convertedMetadata as unknown as Record<string, unknown> };
              }
            } else {
              // First same-harness revise — increment counter, pass
              // through unchanged. The increment happens AFTER the
              // comparison so the first revise is allowed.
              budgetExtension.reviseCountByHarnessRef.current.set(
                currentHarness,
                revisesSoFar + 1,
              );
            }
          }
        }
        recorder[slot] = result.metadata as unknown as ProtocolEmitterMetadata;
        // M5 (v0.7.26) — Scout pre-handoff write warning. Scout's tool
        // set includes write/edit/multi_edit for H0_DIRECT parity with
        // v0.7.22. But on H1/H2 handoffs, any Scout-era write bleeds
        // into the Evaluator's diff view and muddles the verification
        // contract ("did Generator do X? unclear, because X was half-
        // done before Generator started"). Fire a status event +
        // debug log so the user / REPL can see this happened, and
        // downstream telemetry can count it.
        if (slot === 'scout' && mutationTracker && mutationTracker.files.size > 0) {
          const scoutHarness = recorder.scout?.payload.scout?.confirmedHarness;
          if (scoutHarness && scoutHarness !== 'H0_DIRECT') {
            const paths = [...mutationTracker.files.keys()];
            const preview = paths.slice(0, 5).join(', ') + (paths.length > 5 ? `, +${paths.length - 5} more` : '');
            const handoffTo = scoutHarness === 'H1_EXECUTE_EVAL' ? 'Generator' : 'Planner';
            events?.onManagedTaskStatus?.({
              agentMode: 'ama',
              harnessProfile: scoutHarness,
              currentRound: 1,
              maxRounds: 1,
              upgradeCeiling: scoutHarness,
              note: `Scout wrote ${paths.length} file${paths.length === 1 ? '' : 's'} before handing off to ${handoffTo}`,
              detailNote: `Scout pre-handoff mutations (may show up in Evaluator diff alongside ${handoffTo} output): ${preview}`,
            });
            emitResilienceDebug('[m5:scout-pre-handoff-writes]', {
              harness: scoutHarness,
              count: paths.length,
              paths: paths.slice(0, 20),
            });
          }
        }
        // When Scout's verdict picks a non-H0 harness, extend the budget
        // accordingly so downstream roles have headroom. Mirrors the
        // legacy behavior of upgrading the budget controller on Scout
        // harness commitment.
        if (slot === 'scout' && budget) {
          const scoutHarness = recorder.scout?.payload.scout?.confirmedHarness;
          if (scoutHarness && scoutHarness !== budget.currentHarness) {
            budget.currentHarness = scoutHarness;
            budget.totalBudget = Math.max(budget.totalBudget, BUDGET_CAP_BY_HARNESS[scoutHarness]);
          }
        }
        // M4 parity (v0.7.26) — propagate Scout's decision back into the
        // plan so downstream Generator / Evaluator prompts see the
        // post-Scout harness / routing notes / prompt overlay. Without
        // this, a plan=H2 but Scout=H1 run leaves H2-only prompt
        // guidance leaking into the H1 workers. Mirrors legacy's
        // `applyScoutDecisionToPlan` (task-engine.ts:6569) which runs
        // right after `runManagedScoutStage`.
        if (slot === 'scout' && budgetExtension?.planRef.current) {
          const scoutPayload = recorder.scout?.payload.scout;
          if (scoutPayload?.confirmedHarness) {
            budgetExtension.planRef.current = applyScoutDecisionToPlanRunner(
              budgetExtension.planRef.current,
              {
                confirmedHarness: scoutPayload.confirmedHarness,
                harnessRationale: scoutPayload.harnessRationale,
                summary: scoutPayload.summary,
              },
            );
          }
        }
        observer.onRoleEmit(SLOT_TO_ROLE[slot], recorder);
        // 90%-threshold budget-extension dialog. Legacy only triggered this
        // on Evaluator revise; the Runner-driven path now fires it after
        // every role emit (scout/contract/handoff/verdict). Reason: in a
        // single Runner.run chain the whole Scout → Planner → Generator →
        // Evaluator flow shares one budget counter, so by the time the
        // Evaluator emits a verdict the cap may already be exhausted —
        // never giving the user a chance to approve more headroom. Firing
        // after each role emit catches the 90% crossing at the earliest
        // boundary.
        //
        // `maybeRequestAdditionalWorkBudget` is itself idempotent when
        // already above threshold or under it (returns 'skipped'), so
        // calling it per emit is cheap in the common case. The per-harness
        // `additionalUnits` parameter matches the user's tiered mechanism
        // (H0 → +100 small top-up, H1/H2 → +200 legacy-parity top-up).
        if (budget && budgetExtension) {
          observer.notifyBudgetApprovalRequest();
          // Risk-3: when Evaluator explicitly flags a budget request via
          // its verdict payload, bypass the 90% auto-threshold so the
          // user sees the dialog immediately (with Evaluator's reason
          // as the summary) rather than waiting for cumulative usage
          // to cross the default gate.
          const evaluatorBudgetRequest = slot === 'verdict'
            ? recorder.verdict?.payload.verdict?.budgetRequest
            : undefined;
          const extensionSummary = evaluatorBudgetRequest
            ? `Evaluator requested more budget: ${evaluatorBudgetRequest}`
            : slot === 'verdict'
              ? (recorder.verdict?.payload.verdict?.reason ?? 'Evaluator requested another pass')
              : slot === 'handoff'
                ? (recorder.handoff?.payload.handoff?.summary ?? 'Generator handoff in progress')
                : slot === 'contract'
                  ? (recorder.contract?.payload.contract?.summary ?? 'Planner contract in progress')
                  : (recorder.scout?.payload.scout?.summary ?? 'Scout investigation in progress');
          const decision = await maybeRequestAdditionalWorkBudget(
            budgetExtension.events,
            budget,
            {
              summary: extensionSummary,
              currentRound: budgetExtension.roundRef.current,
              maxRounds: budgetExtension.maxRoundsRef.current,
              originalTask: budgetExtension.originalTask,
              additionalUnits: BUDGET_EXTENSION_BY_HARNESS[budget.currentHarness],
              force: Boolean(evaluatorBudgetRequest),
            },
          );
          budgetExtension.budgetApprovalRef.current = false;
          if (decision === 'approved') {
            budgetExtension.maxRoundsRef.current += 1;
          } else if (decision === 'denied' && slot === 'verdict') {
            const verdictPayload = recorder.verdict?.payload.verdict;
            if (verdictPayload?.status === 'revise') {
              // Shard 6d-U: user explicitly denied a budget extension on
              // revise — continue at current budget cap but flag
              // `degradedContinue` so the caller can render the warning.
              // Note: `skipped` means "didn't need to ask" (no
              // callback / under 90% / already bumped at this tier) and
              // does NOT constitute degradation.
              budgetExtension.degradedContinueRef.current = true;
            }
          }
        }
      }
      return result;
    },
  };
}

/**
 * Base budget cap per harness tier, in LLM-turn units. Scout/Planner/
 * Generator/Evaluator each consume one unit per emit; coding tools consume
 * one unit per invocation (via `incrementManagedBudgetUsage`).
 *
 * H0 default bumped from the legacy 50 → 100 because even a modest review
 * task easily burns 30 file reads + 15 grep scans + a few bash inspections
 * before Scout can commit a verdict. H1/H2 stay at 200 (the
 * `DEFAULT_MANAGED_WORK_BUDGET` baseline) — those tiers get the budget-extension
 * dialog at 90% utilization so a long task can top up as needed rather
 * than front-load a huge base cap.
 */
const BUDGET_CAP_BY_HARNESS: Record<KodaXHarnessProfile, number> = {
  H0_DIRECT: 100,
  H1_EXECUTE_EVAL: 200,
  H2_PLAN_EXECUTE_EVAL: 200,
};

/**
 * Extension size per harness tier. When the budget-extension dialog fires
 * at the 90% threshold and the user approves, the budget grows by this
 * many units. H0 gets a smaller +100 bump (short exploration tasks) while
 * H1/H2 get +200 (long multi-role runs).
 */
const BUDGET_EXTENSION_BY_HARNESS: Record<KodaXHarnessProfile, number> = {
  H0_DIRECT: 100,
  H1_EXECUTE_EVAL: 200,
  H2_PLAN_EXECUTE_EVAL: 200,
};

// =============================================================================
// Observer bridge — hooks into options.events.onManagedTaskStatus
// =============================================================================

/**
 * Display-name mapping for each role. The REPL UI renders this as the
 * status-line label (e.g. "[Scout] Thinking..."). Keys are lowercase role
 * ids; values are the capitalised titles the legacy path used.
 */
const ROLE_TO_TITLE: Record<KodaXTaskRole, string> = {
  scout: 'Scout',
  planner: 'Planner',
  generator: 'Generator',
  evaluator: 'Evaluator',
  direct: 'Direct',
};

/**
 * Max-rounds hint for progress reporting. The Runner.run inner loop caps
 * per-agent tool iterations at `MAX_TOOL_LOOP_ITERATIONS` (20); `maxRounds`
 * here reflects the *role-chain* length upper bound per harness tier.
 * Consumers use it purely for "round i of N" display — the actual cap is
 * enforced by the LLM loop + budget controller, not by this number.
 */
const MAX_ROUNDS_BY_HARNESS: Record<KodaXHarnessProfile, number> = {
  H0_DIRECT: 1, // Scout direct answer
  H1_EXECUTE_EVAL: 6, // Scout + Gen + Eval (+ up to 3 revise cycles)
  H2_PLAN_EXECUTE_EVAL: 8, // Scout + Planner + Gen + Eval (+ up to 4 revise cycles)
};

export interface ObserverBridge {
  readonly preflight: () => void;
  readonly onRoleEmit: (role: KodaXTaskRole, recorder: VerdictRecorder) => void;
  readonly completed: (signal: KodaXResult['signal'], reason?: string) => void;
  readonly notifyBudgetApprovalRequest: () => void;
  // Shard 6d-Q (v0.7.22 parity): fire a status event when a child task
  // dispatch starts so the REPL's AmaWorkStrip can render
  // "Scout/Generator fanning out ${class} × ${count}" badge.
  readonly notifyChildFanout: (
    fanoutClass: 'finding-validation' | 'evidence-scan' | 'module-triage',
    count?: number,
  ) => void;
}

/**
 * Shard 6d-R: derive a per-role evidence entry at emit time. Legacy
 * `task-engine.ts` kept an append-only `evidence.entries[]` list so
 * downstream consumers (`buildManagedTaskRoundHistory`, resume flow,
 * REPL transcript dump) could reconstruct per-round role history.
 *
 * Status mapping:
 *   - scout / planner / direct → 'completed' (always terminal for their turn)
 *   - generator → derived from handoff.status (ready→completed,
 *                 incomplete→running, blocked→blocked)
 *   - evaluator → derived from verdict.status (accept→completed,
 *                 revise→running, blocked→blocked)
 *
 * Signal + reason are only populated on the final-emitter roles
 * (evaluator/direct) because those are the only turns that carry a
 * user-observable `COMPLETE | BLOCKED | DECIDE` signal.
 */
function buildEvidenceEntryForRoleEmit(args: {
  readonly role: KodaXTaskRole;
  readonly round: number;
  readonly recorder: VerdictRecorder;
  readonly sessionId: string | undefined;
}): KodaXTaskEvidenceEntry {
  const { role, round, recorder, sessionId } = args;
  let status: KodaXTaskStatus = 'completed';
  let summary: string | undefined;
  let signal: KodaXTaskEvidenceEntry['signal'];
  let signalReason: string | undefined;
  if (role === 'scout') {
    summary = recorder.scout?.payload.scout?.summary;
  } else if (role === 'planner') {
    summary = recorder.contract?.payload.contract?.summary;
  } else if (role === 'generator') {
    const handoff = recorder.handoff?.payload.handoff;
    summary = handoff?.summary;
    if (handoff?.status === 'blocked') status = 'blocked';
    else if (handoff?.status === 'incomplete') status = 'running';
  } else if (role === 'evaluator') {
    const verdict = recorder.verdict?.payload.verdict;
    summary = verdict?.reason;
    if (verdict?.status === 'blocked') {
      status = 'blocked';
      signal = 'BLOCKED';
      signalReason = verdict.reason;
    } else if (verdict?.status === 'revise') {
      status = 'running';
    } else if (verdict?.status === 'accept') {
      signal = 'COMPLETE';
      signalReason = verdict.reason;
    }
  } else if (role === 'direct') {
    // H0_DIRECT: Scout answered directly — treat as a completed direct turn.
    summary = recorder.scout?.payload.scout?.summary;
    signal = 'COMPLETE';
  }
  return {
    assignmentId: role,
    role,
    status,
    title: ROLE_TO_TITLE[role],
    round,
    summary,
    sessionId,
    signal,
    signalReason,
  };
}

/**
 * Emit `KodaXManagedTaskStatusEvent` with the full field set legacy
 * consumers (REPL UI, CLI JSON events, observability) depend on.
 *
 * Fields populated:
 *   - agentMode / harnessProfile — static for the run (harness updated on
 *     Scout emit)
 *   - phase / activeWorkerId / activeWorkerTitle — the canonical trio
 *   - currentRound / maxRounds — progress indicator
 *   - upgradeCeiling — same as harness (Runner path does not observe
 *     mid-run ceiling changes beyond Scout commitment)
 *   - globalWorkBudget / budgetUsage / budgetApprovalRequired — via
 *     `buildManagedStatusBudgetFields`
 *   - note / detailNote — short status label + optional long-form detail
 *     (detailNote comes from the recorder's most-recent payload summary
 *     when available)
 *   - persistToHistory — `true` for terminal events (completed / blocked)
 *     and `false` for transient progress ticks (REPL ledger contract)
 *   - events[] — inline live-event list, currently one entry per observer
 *     tick so the REPL ticker has something to render
 */
/**
 * M4 parity (v0.7.26) — 1:1 port of legacy
 * `task-engine.ts::applyScoutDecisionToPlan` (line 564). Updates the plan
 * in place once Scout emits its `confirmedHarness` so downstream role
 * prompts / tool-policy / budget controller see the post-Scout decision
 * instead of the stale pre-Scout snapshot. Without this, a plan=H2 but
 * Scout=H1 run leaks H2-only prompt guidance into the H1 workers.
 *
 * Critical nuance: Scout overriding the topology ceiling (its own
 * confirmed harness > `topologyCeiling`) is honoured without clamping —
 * Scout has strictly more information than the pre-Scout regex heuristic
 * (FEATURE_061). `upgradeCeiling` is lifted to match so the budget
 * controller + mid-run escalation see a consistent state.
 */
const RUNNER_HARNESS_ORDER: readonly KodaXHarnessProfile[] = [
  'H0_DIRECT',
  'H1_EXECUTE_EVAL',
  'H2_PLAN_EXECUTE_EVAL',
];
function getRunnerHarnessRank(harness: KodaXHarnessProfile): number {
  return RUNNER_HARNESS_ORDER.indexOf(harness);
}

function applyScoutDecisionToPlanRunner(
  plan: ReasoningPlan,
  scoutPayload:
    | {
        confirmedHarness?: KodaXHarnessProfile;
        harnessRationale?: string;
        summary?: string;
      }
    | undefined,
): ReasoningPlan {
  const confirmedHarness = scoutPayload?.confirmedHarness;
  if (!confirmedHarness) {
    return plan;
  }
  const topologyCeiling = plan.decision.topologyCeiling ?? plan.decision.upgradeCeiling;
  const scoutOverrodeCeiling = topologyCeiling
    ? getRunnerHarnessRank(confirmedHarness) > getRunnerHarnessRank(topologyCeiling)
    : false;
  const ceilingNote = scoutOverrodeCeiling
    ? `Scout overrode topology ceiling ${topologyCeiling} → ${confirmedHarness}: ${scoutPayload.harnessRationale ?? 'task complexity requires escalation'}.`
    : undefined;
  if (
    confirmedHarness === plan.decision.harnessProfile
    && !scoutPayload.summary
    && !ceilingNote
  ) {
    return plan;
  }
  const decision: KodaXTaskRoutingDecision = {
    ...plan.decision,
    harnessProfile: confirmedHarness,
    upgradeCeiling: scoutOverrodeCeiling
      ? confirmedHarness
      : plan.decision.upgradeCeiling,
    reason: scoutPayload.summary
      ? `${plan.decision.reason} Scout confirmed ${confirmedHarness}: ${scoutPayload.summary}`
      : plan.decision.reason,
    routingNotes: [
      ...(plan.decision.routingNotes ?? []),
      ...(scoutPayload.summary ? [`Scout decision: ${scoutPayload.summary}`] : []),
      ...(ceilingNote ? [ceilingNote] : []),
    ],
  };
  const amaControllerDecision = buildAmaControllerDecision(decision);
  return {
    ...plan,
    decision,
    amaControllerDecision,
    promptOverlay: buildPromptOverlay(
      decision,
      plan.providerPolicy?.routingNotes,
      plan.providerPolicy,
      amaControllerDecision,
    ),
  };
}

/**
 * H3 routing-note builder. Emitted once before Scout's preflight so the
 * REPL work-strip can label the task's routing context (review target,
 * review scale, routing override reason). The
 * Runner-driven path doesn't have `repoRoutingSignals` in plan (those
 * were computed by the legacy planner earlier); we fall back to the
 * decision fields plan surfaces directly.
 */
function buildRunnerRoutingNote(plan: ReasoningPlan): string {
  const detailParts: string[] = [];
  const decision = plan.decision;
  const reviewScale = decision.reviewScale ? ` (${decision.reviewScale})` : '';
  if (decision.reviewTarget) {
    detailParts.push(`${decision.reviewTarget}${reviewScale}`);
  }
  if (decision.routingSource && decision.routingSource !== 'model') {
    detailParts.push(`routing=${decision.routingSource}`);
  }
  if (decision.routingAttempts && decision.routingAttempts > 1) {
    detailParts.push(`attempts=${decision.routingAttempts}`);
  }
  return detailParts.length > 0
    ? `AMA routing · ${detailParts.join(' · ')}`
    : 'AMA routing';
}

function buildObserverBridge(
  events: KodaXEvents | undefined,
  harnessRef: { current: KodaXHarnessProfile },
  rolesRef: { emitted: KodaXTaskRole[] },
  budget: ManagedTaskBudgetController,
  roundRef: { current: number },
  maxRoundsRef: { current: number },
  budgetApprovalRef: { current: boolean },
  entriesRef: { items: KodaXTaskEvidenceEntry[] },
  sessionIdRef: { current: string | undefined },
  checkpointWriter?: (role: KodaXTaskRole) => void,
): ObserverBridge {
  const emit = (partial: {
    phase: KodaXManagedTaskPhase;
    activeWorkerId?: string;
    activeWorkerTitle?: string;
    note?: string;
    detailNote?: string;
    persistToHistory?: boolean;
  }): void => {
    if (!events?.onManagedTaskStatus) return;
    const harness = harnessRef.current;
    events.onManagedTaskStatus({
      agentMode: 'ama',
      harnessProfile: harness,
      currentRound: roundRef.current,
      maxRounds: maxRoundsRef.current,
      upgradeCeiling: harness,
      ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
      ...partial,
    });
  };
  return {
    preflight: () =>
      emit({
        phase: 'preflight',
        activeWorkerId: 'scout',
        activeWorkerTitle: ROLE_TO_TITLE.scout,
        note: 'Scout analyzing task complexity',
        persistToHistory: false,
      }),
    onRoleEmit: (role, recorder) => {
      // Once Scout has confirmed a harness tier, keep it as the reference.
      const scoutHarness = recorder.scout?.payload.scout?.confirmedHarness;
      if (scoutHarness) {
        harnessRef.current = scoutHarness;
        maxRoundsRef.current = Math.max(
          maxRoundsRef.current,
          MAX_ROUNDS_BY_HARNESS[scoutHarness],
        );
      }
      rolesRef.emitted.push(role);
      roundRef.current += 1;
      const detail =
        role === 'scout'
          ? recorder.scout?.payload.scout?.summary
          : role === 'planner'
            ? recorder.contract?.payload.contract?.summary
            : role === 'generator'
              ? recorder.handoff?.payload.handoff?.summary
              : recorder.verdict?.payload.verdict?.reason;
      // Shard 6d-R: accumulate `evidence.entries[]` per-turn. Mirrors legacy
      // `task-engine.ts` behaviour where each role completion appended a
      // `KodaXTaskEvidenceEntry` to the managed task's evidence bundle so
      // downstream consumers (`buildManagedTaskRoundHistory`, the REPL's
      // transcript dump, resume flow) could reconstruct per-round history.
      entriesRef.items.push(
        buildEvidenceEntryForRoleEmit({
          role,
          round: roundRef.current,
          recorder,
          sessionId: sessionIdRef.current,
        }),
      );
      emit({
        // Emit `worker` (not `round`) so the REPL's
        // `isForegroundManagedStreamingStatus` recognizes this as an
        // active worker turn and routes onProviderRecovery / onRetry into
        // the managed foreground layer (legacy task-engine.ts:~3752 also
        // emits `phase: 'worker'` per role activation). Without this,
        // `managedForegroundOwnerRef.current.workerId` is never set and
        // recovery / retry messages render below the user prompt instead
        // of inline with the worker output.
        phase: 'worker',
        activeWorkerId: role,
        activeWorkerTitle: ROLE_TO_TITLE[role],
        note: `${ROLE_TO_TITLE[role]} completed a turn`,
        detailNote: detail,
        persistToHistory: false,
      });
      if (checkpointWriter) checkpointWriter(role);
    },
    completed: (signal, reason) =>
      emit({
        phase: 'completed',
        note: signal === 'BLOCKED' ? 'Task blocked' : 'Task completed',
        detailNote: reason,
        persistToHistory: true,
      }),
    notifyBudgetApprovalRequest: () => {
      budgetApprovalRef.current = true;
      emit({
        phase: 'round',
        note: 'Awaiting budget extension approval',
        persistToHistory: false,
      });
    },
    notifyChildFanout: (fanoutClass, count) => {
      if (!events?.onManagedTaskStatus) return;
      // v0.7.26 parity (C2): do NOT set activeWorkerId:'child' here.
      // FEATURE_067 already learned (types.ts:1170) that an activeWorkerId
      // transition to 'child' triggers a foreground worker switch in the
      // REPL, which clears all live tool calls for the actual worker that
      // dispatched the children. Keep the active worker unchanged; use
      // `childFanoutClass` + `childFanoutCount` purely as decoration.
      events.onManagedTaskStatus({
        agentMode: 'ama',
        harnessProfile: harnessRef.current,
        currentRound: roundRef.current,
        maxRounds: maxRoundsRef.current,
        upgradeCeiling: harnessRef.current,
        phase: 'worker',
        childFanoutClass: fanoutClass,
        childFanoutCount: count ?? 1,
        note: `Dispatching ${fanoutClass} child task`,
        persistToHistory: false,
        ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
      });
    },
  };
}

// =============================================================================
// Tool wrapping: coding handler → RunnableTool
// =============================================================================

const WRITE_ONLY_TOOL_NAMES = new Set(['write', 'edit', 'insert_after_anchor']);

/**
 * Mirror of the legacy `beforeToolExecute` mutation-tracking branch in
 * task-engine.ts:~3907. Populates `ctx.mutationTracker` with files +
 * totalOps when a write/edit tool runs (or bash executes a destructive
 * command). Idempotent — missing tracker is a no-op.
 */
function recordMutationForTool(
  tracker: ManagedMutationTracker | undefined,
  toolName: string,
  input: Record<string, unknown>,
): void {
  if (!tracker) return;
  const normalized = toolName.toLowerCase();
  if (WRITE_ONLY_TOOL_NAMES.has(normalized) || normalized === 'bash') {
    const filePath = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : undefined;
    if (filePath) {
      const oldLen = typeof input.old_string === 'string' ? input.old_string.split('\n').length : 0;
      const newLen = typeof input.new_string === 'string' ? input.new_string.split('\n').length : 0;
      const contentLen = typeof input.content === 'string' ? input.content.split('\n').length : 0;
      const linesDelta = contentLen || Math.abs(newLen - oldLen) || 1;
      tracker.files.set(filePath, (tracker.files.get(filePath) ?? 0) + linesDelta);
      tracker.totalOps += 1;
    } else if (normalized === 'bash') {
      const cmd = typeof input.command === 'string' ? input.command : '';
      if (/\b(git\s+(add|commit|push|merge|rebase|reset)|npm\s+(publish|install)|rm\s|mv\s|cp\s)/i.test(cmd)) {
        tracker.totalOps += 1;
      }
    }
  }
}

function wrapCodingToolAsRunnable(
  definition: KodaXToolDefinition,
  handler: (
    input: Record<string, unknown>,
    ctx: KodaXToolExecutionContext,
  ) => Promise<string>,
  baseCtx: KodaXToolExecutionContext,
  budget?: ManagedTaskBudgetController,
  events?: KodaXEvents,
): RunnableTool {
  return {
    ...definition,
    execute: async (
      input: Record<string, unknown>,
      runnerCtx?: RunnerToolContext,
    ): Promise<RunnerToolResult> => {
      if (budget) incrementManagedBudgetUsage(budget, 1);
      recordMutationForTool(baseCtx.mutationTracker, definition.name, input);
      // Attach reportToolProgress per-call so async-generator
      // tools (dispatch_child_task) can surface their internal progress via
      // KodaXEvents.onToolProgress → REPL transcript. Mirrors
      // `agent.ts:1345-1353` (ctxWithProgress wrapping).
      const toolCallId = runnerCtx?.toolCallId;
      const ctxForCall: KodaXToolExecutionContext = events?.onToolProgress && toolCallId
        ? {
          ...baseCtx,
          reportToolProgress: (message: string) => {
            events.onToolProgress?.({ id: toolCallId, message });
          },
        }
        : baseCtx;
      try {
        const content = await handler(input, ctxForCall);
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `[Tool Error] ${definition.name}: ${message}`, isError: true };
      }
    },
  };
}

/**
 * Shell commands that mutate the filesystem / git state. Super-set of the
 * legacy `SHELL_WRITE_PATTERNS` allow-list (tool-policy.ts:110) so
 * verification-only roles (Evaluator) can still use `bash` for read-only
 * checks (ls, cat, git diff, etc.) without silently gaining write
 * capability.
 *
 * v0.7.26 H4 parity — the first group mirrors legacy exactly:
 *   - PowerShell verbs (Set-Content / Add-Content / Out-File / Tee-Object /
 *     Copy-Item / Move-Item / Rename-Item / Remove-Item / New-Item /
 *     Clear-Content)
 *   - Unix basic (rm / mv / cp / del / erase / touch / mkdir / rmdir /
 *     rename / ren)
 *   - Script exec (sed -i / perl -pi / python -c / node -e)
 *   - Redirect (> / >> outside of 2>&1 / &1 forms)
 * The second group extends legacy with v0.7.26 safety patterns:
 *   - chmod / chown
 *   - git write verbs (add / commit / push / merge / rebase / reset /
 *     checkout <ref> / rm)
 *   - package-manager install/publish/update verbs (npm / pnpm / yarn)
 *
 * Matches on leading command-word boundary — `rm /tmp/foo` blocks
 * but `node rm-stub.js` does not.
 */
/**
 * v0.7.26 extensions to legacy `SHELL_WRITE_PATTERNS`. Legacy only guarded
 * classic filesystem-mutating shells; these cover state-changing shells
 * that surfaced as risks after FEATURE_084 landed. `SHELL_WRITE_PATTERNS`
 * (imported from `tool-policy.ts`) is applied first; these extensions
 * apply second so the combined set is a strict super-set.
 */
const SHELL_MUTATION_EXTENSIONS: readonly string[] = [
  '\\bchmod\\s',
  '\\bchown\\s',
  '\\bgit\\s+(?:add|commit|push|merge|rebase|reset|checkout\\s+[^-]|rm)',
  '\\bnpm\\s+(?:install|publish|update|rm)',
  '\\bpnpm\\s+(?:install|publish|update|rm)',
  '\\byarn\\s+(?:add|publish|remove)',
];

/**
 * Wrap a bash tool so verification-only roles (Scout / Evaluator) cannot
 * execute shell commands that mutate the filesystem or git state.
 *
 * P2 parity — reuses the same `SHELL_WRITE_PATTERNS` set the Generator
 * docs-scoped / review-only guard uses, so all three roles share a
 * single source of truth. The v0.7.26 safety extensions sit on top of
 * the legacy set — never narrower.
 *
 * Mirrors legacy `createToolPolicyHook` behaviour at task-engine.ts
 * ~1915 which blocked `SHELL_WRITE_PATTERNS` on read-only role tool
 * policies. Non-bash tools pass through unchanged.
 */
function wrapReadOnlyBash(bashTool: RunnableTool, roleTitle: string): RunnableTool {
  return {
    ...bashTool,
    execute: async (input, ctx): Promise<RunnerToolResult> => {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      if (command) {
        // Shared super-set: legacy SHELL_WRITE_PATTERNS + v0.7.26 safety
        // extensions. Using the shared set here (instead of calling
        // enforceShellWriteBoundary, which carries the Generator-flavored
        // "docs-only" message) lets Scout / Evaluator keep their own
        // "verification-only" blocking message — matches legacy
        // createToolPolicyHook branching.
        if (
          matchesShellPattern(command, SHELL_WRITE_PATTERNS)
          || matchesShellPattern(command, SHELL_MUTATION_EXTENSIONS)
        ) {
          // v0.7.26: Scout no longer uses this wrapper (Scout has full
          // tools per v22 parity); only Evaluator reaches here. Evaluator
          // IS verification-only by architectural design — its job is to
          // spot-check the Generator handoff, not mutate state. The
          // block message names that role semantic + the read-intent
          // hint for `python -c` / `node -e` so the LLM reaches for
          // `read` / `grep` instead of re-trying shell.
          const isReadIntent = /^python\s+-c|^node\s+-e/.test(command);
          const hint = isReadIntent
            ? 'If you only need to inspect a file, use the `read` or `grep` tool instead — both go around the shell.'
            : 'If mutation is genuinely required by the verification contract, flag it in the verdict reason instead of performing it here.';
          return {
            content:
              `[Managed Task ${roleTitle}] Shell command blocked because this role is verification-only. ${hint} Blocked command: ${command.slice(0, 120)}`,
            isError: true,
          };
        }
      }
      return bashTool.execute(input, ctx);
    },
  };
}

/**
 * Shard 6d-j + 6d-M — Generator write / shell mutation boundary.
 *
 * Mirrors the legacy `createToolPolicyHook` behaviour (task-engine.ts
 * ~1891) for the runner-driven Generator:
 *   - `'review-only'` → Generator write/edit blocked; destructive shell
 *     commands blocked (review tasks must not mutate state).
 *   - `'docs-scoped'` → Generator write/edit gated against
 *     `DOCS_ONLY_WRITE_PATH_PATTERNS` (docs/*.md / CHANGELOG /
 *     FEATURE_LIST / etc.); destructive shell commands blocked.
 *   - `'open'` (default) → tools pass through unchanged.
 *
 * Shard 6d-M replaces the earlier "Scout self-declares `mutation_intent`"
 * pattern with `inferScoutMutationIntent` — we classify intent from
 * Scout's emitted `scope` + `reviewFilesOrAreas` + the routing
 * `primaryTask` (Issue 119 inference). Scout's LLM payload is no longer
 * consulted for this boundary; its scope list is the evidence.
 *
 * The wrappers close over the shared `VerdictRecorder` + plan ref and
 * read intent lazily at invocation time — `buildRunnerAgentChain`
 * constructs Generator before Scout has run, so the intent is not yet
 * available when the Agent graph is frozen. `planRef.current` holds the
 * reasoning plan (if any) so the guard can read `primaryTask`.
 */
function resolveGeneratorMutationIntent(
  recorder: VerdictRecorder,
  planRef: { current: ReasoningPlan | undefined },
): ScoutMutationIntent {
  const scoutPayload = recorder.scout?.payload.scout;
  if (!scoutPayload) return 'open';
  return inferScoutMutationIntent(
    { scope: scoutPayload.scope, reviewFilesOrAreas: scoutPayload.reviewFilesOrAreas },
    planRef.current?.decision.primaryTask,
    scoutPayload.confirmedHarness,
  );
}

function wrapGeneratorWriteWithMutationGuard(
  writeOrEdit: RunnableTool,
  recorder: VerdictRecorder,
  planRef: { current: ReasoningPlan | undefined },
): RunnableTool {
  return {
    ...writeOrEdit,
    execute: async (input, ctx): Promise<RunnerToolResult> => {
      const intent = resolveGeneratorMutationIntent(recorder, planRef);
      if (intent === 'review-only') {
        return {
          content:
            `[Managed Task Generator] Tool "${writeOrEdit.name}" blocked — `
            + 'Scout-scoped review task: Generator must not write.',
          isError: true,
        };
      }
      if (intent === 'docs-scoped') {
        const blocked = enforceWritePathBoundary(
          writeOrEdit.name,
          input,
          DOCS_ONLY_WRITE_PATH_PATTERNS,
          'Generator',
        );
        if (blocked) {
          return { content: blocked, isError: true };
        }
      }
      return writeOrEdit.execute(input, ctx);
    },
  };
}

function wrapGeneratorBashWithMutationGuard(
  bashTool: RunnableTool,
  recorder: VerdictRecorder,
  planRef: { current: ReasoningPlan | undefined },
): RunnableTool {
  return {
    ...bashTool,
    execute: async (input, ctx): Promise<RunnerToolResult> => {
      const intent = resolveGeneratorMutationIntent(recorder, planRef);
      if (intent === 'docs-scoped' || intent === 'review-only') {
        const command = typeof input.command === 'string' ? input.command : '';
        const blocked = enforceShellWriteBoundary(command, 'Generator');
        if (blocked) {
          return { content: blocked, isError: true };
        }
      }
      return bashTool.execute(input, ctx);
    },
  };
}

/**
 * Shard 6d-Q: wrap the dispatch_child_task async-generator tool as a
 * Runner-compatible tool.
 *
 * Differences from coding tools handled by `wrapCodingToolAsRunnable`:
 *   - The handler is `AsyncGenerator<ToolProgress, string, void>`. The
 *     Runner loop does not consume progress events directly; we drive
 *     the generator here, forward progress notes through
 *     `ctx.reportToolProgress` on the parent exec context (best-effort),
 *     and return only the final string.
 *   - `dispatch_child_task` enforces `ctx.managedProtocolRole` for role
 *     gating (Scout: read-only only; Planner/Evaluator: blocked;
 *     Generator: full). The Runner path does not set
 *     `managedProtocolRole` on the base ctx, so each role-specific
 *     wrapper injects the right role on the per-call ctx. Also captures
 *     any write worktrees into `childWriteWorktreePathsRef` so the
 *     Evaluator diff injection parity (FEATURE_067 v2) is preserved.
 */
function wrapDispatchChildTaskForRole(
  definition: KodaXToolDefinition,
  baseCtx: KodaXToolExecutionContext,
  role: 'scout' | 'generator',
  budget: ManagedTaskBudgetController | undefined,
  childWriteWorktreePathsRef: { current: Map<string, string> },
  observer: ObserverBridge,
  events?: KodaXEvents,
): RunnableTool {
  return {
    ...definition,
    execute: async (
      input: Record<string, unknown>,
      runnerCtx?: RunnerToolContext,
    ): Promise<RunnerToolResult> => {
      if (budget) incrementManagedBudgetUsage(budget, 1);
      // Fire a fanout status event so the REPL's
      // AmaWorkStrip can render a "Scout/Generator fanning out" badge.
      // Best-effort — Runner tool loop runs each tool_use serially, so
      // per-call count=1 reflects the current invocation; the downstream
      // UI aggregates by `childFanoutClass`.
      observer.notifyChildFanout('evidence-scan');
      // v0.7.26 parity (C2): inject per-call reportToolProgress so the
      // child-task yield stages (ctx.reportToolProgress?.(note) inside
      // toolDispatchChildTask) surface through KodaXEvents.onToolProgress
      // keyed on the current tool_use id. Without this, async-generator
      // progress updates vanish — the REPL's "Running: ..." line never
      // updates. Mirrors the same injection wrapCodingToolAsRunnable
      // already does.
      const toolCallId = runnerCtx?.toolCallId;
      const progressHook = events?.onToolProgress && toolCallId
        ? (message: string) => events.onToolProgress?.({ id: toolCallId, message })
        : undefined;
      // Shallow clone so the managedProtocolRole + registerChildWriteWorktrees
      // callback are local to this invocation. The base ctx stays pristine
      // for parallel dispatches.
      const perCallCtx: KodaXToolExecutionContext = {
        ...baseCtx,
        managedProtocolRole: role,
        reportToolProgress: progressHook,
        registerChildWriteWorktrees: (worktreePaths) => {
          for (const [id, p] of worktreePaths) {
            childWriteWorktreePathsRef.current.set(id, p);
          }
        },
      };
      try {
        const gen = toolDispatchChildTask(input, perCallCtx);
        // Drain the generator. Intermediate yields are surfaced via
        // `ctx.reportToolProgress` (bound above to onToolProgress), so
        // the REPL transcript updates live.
        let next = await gen.next();
        while (!next.done) {
          next = await gen.next();
        }
        const finalValue = typeof next.value === 'string' ? next.value : '';
        return { content: finalValue };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `[Tool Error] ${definition.name}: ${message}`, isError: true };
      }
    },
  };
}

interface CodingToolBundle {
  readonly read: RunnableTool;
  readonly grep: RunnableTool;
  readonly glob: RunnableTool;
  readonly bash: RunnableTool;
  readonly write: RunnableTool;
  readonly edit: RunnableTool;
  /** P2a (v0.7.26) — batched-edit tool for single-file skeleton-fill flows. */
  readonly multiEdit: RunnableTool;
  /** FEATURE_074 parity — exit_plan_mode approval tool (Generator only). */
  readonly exitPlanMode: RunnableTool;
  /** M1 parity (v0.7.26) — repo-intel + MCP surface restored to Planner.
   * v0.7.22's `buildManagedWorkerToolPolicy('planner')` exposed
   * `changed_scope`, `repo_overview`, `changed_diff_bundle`, `read`,
   * `grep`, `glob`, and all MCP_TOOL_NAMES as an allow-list. The initial
   * Runner-driven Planner only carried `read/grep/glob`, so H2 Planner
   * couldn't read repo-overview or scoped diffs and was forced to draft
   * contracts from Scout memory alone. These fields re-wire the same
   * inventory. Each field is undefined when the corresponding tool
   * isn't registered (optional capability / missing MCP runtime) so the
   * bundle stays usable in test fixtures that don't register them. */
  readonly repoOverview?: RunnableTool;
  readonly changedScope?: RunnableTool;
  readonly changedDiff?: RunnableTool;
  readonly changedDiffBundle?: RunnableTool;
  readonly mcp: readonly RunnableTool[];
}

function buildCodingToolBundle(
  baseCtx: KodaXToolExecutionContext,
  budget?: ManagedTaskBudgetController,
  events?: KodaXEvents,
): CodingToolBundle {
  const read = getToolDefinition('read');
  const grep = getToolDefinition('grep');
  const glob = getToolDefinition('glob');
  const bash = getToolDefinition('bash');
  const write = getToolDefinition('write');
  const edit = getToolDefinition('edit');
  const multiEdit = getToolDefinition('multi_edit');
  const exitPlanMode = getToolDefinition('exit_plan_mode');
  if (!read || !grep || !glob || !bash || !write || !edit || !multiEdit || !exitPlanMode) {
    throw new Error(
      'Runner-driven path: expected core tools (read/grep/glob/bash/write/edit/multi_edit/exit_plan_mode) to be registered',
    );
  }
  // M1 parity (v0.7.26) — optionally wrap repo-intel + MCP tools so
  // Planner can be given the same inspection allow-list it had under
  // v0.7.22's `buildManagedWorkerToolPolicy('planner')`. Each tool is
  // only wrapped when its definition is registered — test fixtures that
  // bootstrap a minimal registry should still work.
  const repoOverviewDef = getToolDefinition('repo_overview');
  const changedScopeDef = getToolDefinition('changed_scope');
  const changedDiffDef = getToolDefinition('changed_diff');
  const changedDiffBundleDef = getToolDefinition('changed_diff_bundle');
  const mcpHandlers: Record<string, (input: Record<string, unknown>, ctx: KodaXToolExecutionContext) => Promise<string>> = {
    mcp_search: toolMcpSearch,
    mcp_describe: toolMcpDescribe,
    mcp_call: toolMcpCall,
    mcp_read_resource: toolMcpReadResource,
    mcp_get_prompt: toolMcpGetPrompt,
  };
  const mcp: RunnableTool[] = MCP_TOOL_NAMES.reduce<RunnableTool[]>((acc, name) => {
    const def = getToolDefinition(name);
    const handler = mcpHandlers[name];
    if (def && handler) {
      acc.push(wrapCodingToolAsRunnable(def, handler, baseCtx, budget, events));
    }
    return acc;
  }, []);

  return {
    read: wrapCodingToolAsRunnable(read, toolRead, baseCtx, budget, events),
    grep: wrapCodingToolAsRunnable(grep, toolGrep, baseCtx, budget, events),
    glob: wrapCodingToolAsRunnable(glob, toolGlob, baseCtx, budget, events),
    bash: wrapCodingToolAsRunnable(bash, toolBash, baseCtx, budget, events),
    write: wrapCodingToolAsRunnable(write, toolWrite, baseCtx, budget, events),
    edit: wrapCodingToolAsRunnable(edit, toolEdit, baseCtx, budget, events),
    multiEdit: wrapCodingToolAsRunnable(multiEdit, toolMultiEdit, baseCtx, budget, events),
    exitPlanMode: wrapCodingToolAsRunnable(exitPlanMode, toolExitPlanMode, baseCtx, budget, events),
    repoOverview: repoOverviewDef
      ? wrapCodingToolAsRunnable(repoOverviewDef, toolRepoOverview, baseCtx, budget, events)
      : undefined,
    changedScope: changedScopeDef
      ? wrapCodingToolAsRunnable(changedScopeDef, toolChangedScope, baseCtx, budget, events)
      : undefined,
    changedDiff: changedDiffDef
      ? wrapCodingToolAsRunnable(changedDiffDef, toolChangedDiff, baseCtx, budget, events)
      : undefined,
    changedDiffBundle: changedDiffBundleDef
      ? wrapCodingToolAsRunnable(changedDiffBundleDef, toolChangedDiffBundle, baseCtx, budget, events)
      : undefined,
    mcp,
  };
}

// =============================================================================
// Runtime Agent chain: Scout / Planner / Generator / Evaluator
// =============================================================================

export interface RunnerAgentChain {
  readonly scout: Agent;
  readonly planner: Agent;
  readonly generator: Agent;
  readonly evaluator: Agent;
}

const NULL_OBSERVER: ObserverBridge = {
  preflight: () => undefined,
  onRoleEmit: () => undefined,
  completed: () => undefined,
  notifyBudgetApprovalRequest: () => undefined,
  notifyChildFanout: () => undefined,
};

/**
 * Build the full runtime agent chain. Each agent carries:
 *   - self-contained role instructions (no legacy prompt context)
 *   - role-appropriate coding tools
 *   - the recorder-wrapped emit tool
 *   - handoff topology matching @kodax/coding/agents/coding-agents.ts:
 *       Scout → Gen (H1) | Planner (H2)
 *       Planner → Gen
 *       Generator → Evaluator
 *       Evaluator → Gen (revise) | Planner (replan)
 *
 * Uses the same closure-before-freeze pattern as `coding-agents.ts` to
 * build the handoff graph despite cyclic references.
 */
export function buildRunnerAgentChain(
  ctx: KodaXToolExecutionContext,
  recorder: VerdictRecorder,
  observer: ObserverBridge = NULL_OBSERVER,
  budget?: ManagedTaskBudgetController,
  budgetExtension?: BudgetExtensionContext,
  // Shard 6d-M: plan ref lets the Generator mutation-intent guards read
  // `plan.decision.primaryTask` at tool-invocation time (the plan is
  // resolved before Runner.run, but the agent chain is frozen earlier).
  planRef: { current: ReasoningPlan | undefined } = { current: undefined },
  // Shard 6d-S: task verification contract surfaces runtime obligations
  // (startup command, ready signal, UI flows, API/DB checks) into the
  // Evaluator prompt so the model actually probes the runtime instead
  // of writing a verdict from static file reads.
  verification?: KodaXTaskVerificationContract,
  // Shard 6d-Q: shared ref so Scout/Generator dispatch_child_task invocations
  // can register write worktree paths for Evaluator diff injection
  // (FEATURE_067 v2 parity). The caller owns the map; the Runner-internal
  // wrappers only append.
  childWriteWorktreePathsRef: { current: Map<string, string> } = { current: new Map() },
  // Full role-prompt context (original task, decision,
  // metadata, tool policy, skill / scope factory). When provided, every
  // role's `instructions` resolves through `createRolePrompt` — the
  // v0.7.22 prompt surface (decision summary, contract, metadata,
  // verification contract, tool policy, evidence strategies,
  // dispatch_child_task guidance, H0/H1/H2 quality framework,
  // handoff/verdict/contract block specs, shared closing rules). When
  // absent (test paths), the fallback minimal instructions are used.
  promptContext?: RunnerChainPromptContext,
  // Events bus so coding-tool wrappers can attach
  // `reportToolProgress` per tool_use call. Without this wiring,
  // async-generator tools (dispatch_child_task) fire progress events
  // that vanish silently — the REPL transcript's "Running: ..." line
  // never updates mid-run.
  events?: KodaXEvents,
): RunnerAgentChain {
  const codingTools = buildCodingToolBundle(ctx, budget, events);
  const dispatchDefinition = getToolDefinition('dispatch_child_task');
  if (!dispatchDefinition) {
    throw new Error('dispatch_child_task tool not registered — tools/registry.ts bootstrap failure');
  }
  const scoutDispatch = wrapDispatchChildTaskForRole(
    dispatchDefinition,
    ctx,
    'scout',
    budget,
    childWriteWorktreePathsRef,
    observer,
    events,
  );
  const generatorDispatch = wrapDispatchChildTaskForRole(
    dispatchDefinition,
    ctx,
    'generator',
    budget,
    childWriteWorktreePathsRef,
    observer,
    events,
  );

  // M5 (v0.7.26) — only the scout slot needs the mutation-tracker /
  // events channel to surface "Scout wrote files before handing off"
  // warnings. The other slots don't need that wiring.
  const scoutEmit = wrapEmitterWithRecorder(
    emitScoutVerdict,
    'scout',
    recorder,
    observer,
    budget,
    undefined,
    ctx.mutationTracker,
    events,
  );
  const contractEmit = wrapEmitterWithRecorder(emitContract, 'contract', recorder, observer, budget);
  const handoffEmit = wrapEmitterWithRecorder(emitHandoff, 'handoff', recorder, observer, budget);
  const verdictEmit = wrapEmitterWithRecorder(emitVerdict, 'verdict', recorder, observer, budget, budgetExtension);

  type WritableAgent = { -readonly [K in keyof Agent]: Agent[K] };

  // Dynamic role instructions. Every agent's `instructions`
  // closure resolves on each Runner invocation so Scout's post-emit
  // skillMap / scoutScope reach downstream prompts. When `promptContext`
  // is provided, each role gets the full v0.7.22 prompt surface via
  // `createRolePrompt` (decision summary + contract + metadata +
  // verification + tool policy + evidence strategies + dispatch_child_task
  // guidance + H0/H1/H2 quality framework + handoff/verdict/contract
  // block specs + shared closing rules). Tests that don't pass a
  // `promptContext` continue to see the minimal static fallback.
  const scout: WritableAgent = {
    name: SCOUT_AGENT_NAME,
    instructions: () => resolveRoleInstructions(
      'scout',
      SCOUT_AGENT_NAME,
      SCOUT_INSTRUCTIONS_FALLBACK,
      recorder,
      promptContext,
      verification,
    ),
    tools: [
      scoutEmit,
      codingTools.read,
      codingTools.grep,
      codingTools.glob,
      // v0.7.26 Scout-tool-restoration: legacy v0.7.22 gave Scout the
      // full default tool set (`_internal/prompts/tool-policy.ts:232`
      // returned `undefined` for Scout so `buildManagedWorkerToolPolicy`
      // emitted no restrictions; Scout ran via the SA-mode entry with
      // unwrapped bash/write/edit). The three-level H0/H1/H2 quality
      // framework was enforced by prompt ONLY — tools layer deliberately
      // didn't police it. FEATURE_084 regressed this: Scout's bash got
      // wrapped with `wrapReadOnlyBash` and write/edit were dropped,
      // which broke H0_DIRECT execution for any task involving writes
      // (LLM sees "verification-only" block, concludes it is read-only,
      // loops or escalates to dispatch_child_task which is also
      // read-only). Restore the v22 surface.
      codingTools.bash,
      codingTools.write,
      codingTools.edit,
      // P2a (v0.7.26) — Scout H0_DIRECT execution benefits from
      // skeleton+multi_edit just as much as Generator does. Unwrapped
      // for parity with v0.7.22's Scout default tool set.
      codingTools.multiEdit,
      codingTools.exitPlanMode,
      // Shard 6d-Q: Scout may dispatch read-only child investigations
      // (evidence scans, repo reconnaissance) in parallel before
      // emitting its verdict. The dispatch tool itself enforces
      // `read_only` in Scout context.
      scoutDispatch,
    ],
    handoffs: undefined,
    reasoning: { default: 'quick', max: 'balanced', escalateOnRevise: false },
  };
  // M1 parity (v0.7.26) — restore Planner's v0.7.22 inspection surface.
  // Legacy `buildManagedWorkerToolPolicy('planner')` exposed read / grep
  // / glob + repo_overview + changed_scope + changed_diff_bundle +
  // MCP_TOOL_NAMES (tool-policy.ts:237-243). The earlier Runner-driven
  // Planner was limited to read/grep/glob, so H2 planning had no
  // repo-overview / scoped-diff signal and had to draft contracts from
  // Scout memory alone. Each optional tool is only attached when its
  // registry definition exists, so minimal test fixtures still work.
  const plannerTools: RunnableTool[] = [
    contractEmit,
    codingTools.read,
    codingTools.grep,
    codingTools.glob,
  ];
  if (codingTools.repoOverview) plannerTools.push(codingTools.repoOverview);
  if (codingTools.changedScope) plannerTools.push(codingTools.changedScope);
  if (codingTools.changedDiffBundle) plannerTools.push(codingTools.changedDiffBundle);
  if (codingTools.changedDiff) plannerTools.push(codingTools.changedDiff);
  plannerTools.push(...codingTools.mcp);
  const planner: WritableAgent = {
    name: PLANNER_AGENT_NAME,
    instructions: () => resolveRoleInstructions(
      'planner',
      PLANNER_AGENT_NAME,
      PLANNER_INSTRUCTIONS_FALLBACK,
      recorder,
      promptContext,
      verification,
    ),
    tools: plannerTools,
    handoffs: undefined,
    reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
  };
  const generator: WritableAgent = {
    name: GENERATOR_AGENT_NAME,
    instructions: () => resolveRoleInstructions(
      'generator',
      GENERATOR_AGENT_NAME,
      GENERATOR_INSTRUCTIONS_FALLBACK,
      recorder,
      promptContext,
      verification,
    ),
    tools: [
      handoffEmit,
      codingTools.read,
      codingTools.grep,
      codingTools.glob,
      wrapGeneratorBashWithMutationGuard(codingTools.bash, recorder, planRef),
      wrapGeneratorWriteWithMutationGuard(codingTools.write, recorder, planRef),
      wrapGeneratorWriteWithMutationGuard(codingTools.edit, recorder, planRef),
      // P2a (v0.7.26) — multi_edit follows the same mutation-guard rules
      // as edit/write. review-only intent blocks all three; docs-scoped
      // intent enforces the DOCS_ONLY path allow-list.
      wrapGeneratorWriteWithMutationGuard(codingTools.multiEdit, recorder, planRef),
      // FEATURE_074 parity — Generator is the only role that mutates files,
      // so it is the only role that needs to ask the user to exit plan mode
      // before making edits. Without this tool the LLM sees no way to
      // request approval and either (a) writes without approval or
      // (b) stalls asking "how do I exit plan mode?".
      codingTools.exitPlanMode,
      // Shard 6d-Q: Generator may dispatch write-capable child tasks for
      // parallel fan-out. Worktree paths flow through
      // `childWriteWorktreePathsRef` so the Evaluator can inject the
      // write diffs at verdict time (FEATURE_067 v2 parity).
      generatorDispatch,
    ],
    handoffs: undefined,
    reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
  };
  const evaluator: WritableAgent = {
    name: EVALUATOR_AGENT_NAME,
    instructions: () => resolveRoleInstructions(
      'evaluator',
      EVALUATOR_AGENT_NAME,
      EVALUATOR_INSTRUCTIONS_FALLBACK,
      recorder,
      promptContext,
      verification,
    ),
    tools: [
      verdictEmit,
      codingTools.read,
      codingTools.grep,
      codingTools.glob,
      wrapReadOnlyBash(codingTools.bash, 'Evaluator'),
    ],
    handoffs: undefined,
    reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: false },
  };

  const scoutHandoffs: Handoff[] = [
    { target: generator, kind: 'continuation', description: 'Upgrade to H1 — execute + evaluate' },
    { target: planner, kind: 'continuation', description: 'Upgrade to H2 — plan + execute + evaluate' },
  ];
  const plannerHandoffs: Handoff[] = [
    { target: generator, kind: 'continuation', description: 'Hand off execution to Generator' },
  ];
  const generatorHandoffs: Handoff[] = [
    { target: evaluator, kind: 'continuation', description: 'Hand off to Evaluator for verification' },
  ];
  const evaluatorHandoffs: Handoff[] = [
    { target: generator, kind: 'continuation', description: 'revise — retry execution' },
    { target: planner, kind: 'continuation', description: 'replan — revise the contract' },
  ];

  scout.handoffs = scoutHandoffs;
  planner.handoffs = plannerHandoffs;
  generator.handoffs = generatorHandoffs;
  evaluator.handoffs = evaluatorHandoffs;

  return {
    scout: Object.freeze(scout) as Agent,
    planner: Object.freeze(planner) as Agent,
    generator: Object.freeze(generator) as Agent,
    evaluator: Object.freeze(evaluator) as Agent,
  };
}

/**
 * Shard 5a backward-compat: returns just the Scout from a chain (used by
 * existing callers that expected a single Scout agent). Tests that
 * previously asserted `scout.handoffs === undefined` need updating — Shard 5b
 * wires the full topology.
 */
export function buildRunnerScoutAgent(ctx: KodaXToolExecutionContext): Agent {
  const recorder: VerdictRecorder = {};
  return buildRunnerAgentChain(ctx, recorder).scout;
}

// =============================================================================
// LLM adapter: KodaX provider stream → RunnerLlmResult
// =============================================================================

/**
 * Cumulative token state captured by the LLM adapter across a full
 * runner chain, exposed back to `runManagedTaskViaRunner` so it can
 * populate `result.contextTokenSnapshot`. The REPL UI uses the snapshot
 * to refresh its token counter after every run.
 */
export interface RunnerAdapterTokenState {
  totalTokens: number;
  lastUsage?: import('@kodax/ai').KodaXTokenUsage;
  source: 'api' | 'estimate';
}

/**
 * P2b (v0.7.26) — default list of providers that have shown
 * reproducible mid-stream TCP RST during large tool_use buffering.
 * Users can override via the `KODAX_RST_PRONE_PROVIDERS` env var
 * (comma-separated provider names).
 */
const DEFAULT_RST_PRONE_PROVIDERS: ReadonlySet<string> = new Set([
  'zhipu-coding',
  'kimi-code',
  'minimax-coding',
  // mimo-coding is added prophylactically: same architectural pattern as
  // the three above (Chinese-cloud subscription gateway with /anthropic
  // shim) and not yet stress-tested on long write/edit turns. Remove via
  // KODAX_RST_PRONE_PROVIDERS env var once the endpoint proves stable.
  'mimo-coding',
]);

/** P2b — default per-turn ceiling applied when a write/edit tool is
 * in scope for an RST-prone provider. 8 KiB is comfortably below the
 * observed RST window while still large enough to fit a skeleton or a
 * single-section edit. Override via `KODAX_WRITE_TURN_MAX_TOKENS`. */
const DEFAULT_WRITE_TURN_MAX_OUTPUT_TOKENS = 8192;

/**
 * P2b — tool names whose presence in a turn's inventory indicates the
 * model MAY emit a large tool_use payload whose streaming buffering
 * could trip an RST on a weak provider.
 */
const P2B_CAPPED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'multi_edit',
]);

function resolveRstProneProviderSet(): ReadonlySet<string> {
  const override = process.env.KODAX_RST_PRONE_PROVIDERS;
  if (override === undefined) return DEFAULT_RST_PRONE_PROVIDERS;
  // Empty string is an explicit "disable the cap" signal, distinct
  // from unset (which keeps defaults).
  const trimmed = override.trim();
  if (trimmed.length === 0) return new Set();
  return new Set(trimmed.split(',').map((s) => s.trim()).filter(Boolean));
}

function resolveWriteTurnMaxTokens(): number {
  const raw = process.env.KODAX_WRITE_TURN_MAX_TOKENS;
  if (!raw) return DEFAULT_WRITE_TURN_MAX_OUTPUT_TOKENS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_WRITE_TURN_MAX_OUTPUT_TOKENS;
}

/**
 * P2b — decide whether this turn's tool inventory + provider warrant
 * the write-turn max_output_tokens cap, and apply it via the provider's
 * one-shot override. Returns `true` iff the cap was applied (the caller
 * clears the override in a finally block to prevent leakage). The cap
 * is NOT applied when the user has explicitly set KODAX_MAX_OUTPUT_TOKENS
 * — that signals "I want the higher budget even on risky providers."
 */
export function maybeApplyP2bWriteTurnCap(
  provider: { setMaxOutputTokensOverride: (v: number | undefined) => void; getEffectiveMaxOutputTokens: () => number },
  providerName: string,
  wireTools: readonly { name: string }[],
): boolean {
  // Explicit user override wins — never silently narrow their budget.
  if (process.env.KODAX_MAX_OUTPUT_TOKENS) return false;

  const proneProviders = resolveRstProneProviderSet();
  if (!proneProviders.has(providerName)) return false;

  const hasWriteTool = wireTools.some((t) => P2B_CAPPED_TOOL_NAMES.has(t.name));
  if (!hasWriteTool) return false;

  const cap = resolveWriteTurnMaxTokens();
  const effective = provider.getEffectiveMaxOutputTokens();
  if (effective <= cap) {
    // Already at or below the cap (another override is in force, e.g.
    // L4 escalation from a prior turn). Don't expand it.
    return false;
  }
  provider.setMaxOutputTokensOverride(cap);
  return true;
}

/**
 * C1 parity helper — map a registered Runner Agent name to its managed
 * task role. Used by the fenced-block fallback path in the LLM adapter
 * to decide which emit tool to synthesize when the LLM wrote the
 * fence but skipped the tool call.
 */
function agentNameToManagedRole(
  name: string,
): Exclude<KodaXTaskRole, 'direct'> | undefined {
  switch (name) {
    case SCOUT_AGENT_NAME: return 'scout';
    case PLANNER_AGENT_NAME: return 'planner';
    case GENERATOR_AGENT_NAME: return 'generator';
    case EVALUATOR_AGENT_NAME: return 'evaluator';
    default: return undefined;
  }
}

/**
 * C1 parity helper — unwrap the per-role slice from a normalized
 * managed-protocol payload so it matches the emit tool's snake_case
 * input schema. The real emitter re-runs `coerceManagedProtocolToolPayload`
 * on this input, so the shape just needs to round-trip cleanly; we
 * intentionally emit snake_case keys matching the tool schema.
 */
function flattenNormalizedForEmitterInput(
  payload: Partial<KodaXManagedProtocolPayload>,
): Record<string, unknown> {
  if (payload.scout) {
    const s = payload.scout;
    return {
      summary: s.summary,
      scope: s.scope,
      required_evidence: s.requiredEvidence,
      review_files_or_areas: s.reviewFilesOrAreas,
      evidence_acquisition_mode: s.evidenceAcquisitionMode,
      confirmed_harness: s.confirmedHarness,
      harness_rationale: s.harnessRationale,
      blocking_evidence: s.blockingEvidence,
      direct_completion_ready: s.directCompletionReady,
      skill_map: s.skillMap
        ? {
          skill_summary: s.skillMap.skillSummary,
          execution_obligations: s.skillMap.executionObligations,
          verification_obligations: s.skillMap.verificationObligations,
          ambiguities: s.skillMap.ambiguities,
          projection_confidence: s.skillMap.projectionConfidence,
        }
        : undefined,
    };
  }
  if (payload.contract) {
    return {
      summary: payload.contract.summary,
      success_criteria: payload.contract.successCriteria,
      required_evidence: payload.contract.requiredEvidence,
      constraints: payload.contract.constraints,
    };
  }
  if (payload.handoff) {
    return {
      status: payload.handoff.status,
      summary: payload.handoff.summary,
      evidence: payload.handoff.evidence,
      followup: payload.handoff.followup,
    };
  }
  if (payload.verdict) {
    return {
      status: payload.verdict.status,
      reason: payload.verdict.reason,
      followup: payload.verdict.followups,
      user_answer: payload.verdict.userAnswer,
      next_harness: payload.verdict.nextHarness,
    };
  }
  return {};
}

export function buildRunnerLlmAdapter(
  options: KodaXOptions,
  overrideStream?: (
    messages: readonly KodaXMessage[],
    tools: readonly KodaXToolDefinition[],
    system: string,
  ) => Promise<{ textBlocks?: readonly { text: string }[]; toolBlocks?: readonly KodaXToolUseBlock[] }>,
  tokenStateRef?: { current: RunnerAdapterTokenState },
  /**
   * FEATURE_078: optional callback that returns Scout's current
   * `downstream_reasoning_hint` (L3 input). Called once per per-role
   * adapter invocation so the resolver sees the hint as soon as the
   * Scout payload is populated. Returning `undefined` bypasses L3 and
   * falls back to L2 (`agent.reasoning.default`) clamped by L1
   * (user ceiling). The callback closes over the AMA frame's recorder.
   */
  getScoutReasoningHint?: () => KodaXReasoningMode | undefined,
): (messages: readonly KodaXMessage[], agent: Agent) => Promise<RunnerLlmResult> {
  // FEATURE_072 parity: the REPL's token-count indicator reads
  // `onIterationEnd` to refresh after each worker LLM turn. Track a
  // monotonically-increasing iteration counter across the entire runner
  // chain so the REPL sees progress for every role's turn.
  let iteration = 0;
  const MAX_ITER_HINT = 20; // matches core/src/runner-tool-loop.ts MAX_TOOL_LOOP_ITERATIONS

  // Cost tracker — one per session; `recordUsage` is called after every
  // provider.stream usage payload. REPL /cost reads through
  // `events.getCostReport.current`.
  let costTracker: CostTracker = createCostTracker();
  if (options.events?.getCostReport) {
    options.events.getCostReport.current = () =>
      formatCostReport(getCostSummary(costTracker));
  }

  return async (messages, agent) => {
    // Strip every leading contiguous system message and concatenate their
    // content. v0.7.22-style flows pushed a single agent-instructions system
    // prompt and nothing else, so taking only `messages[0]` was enough. The
    // Runner-driven path stacks [compaction-summary, post-compact-ledger,
    // post-compact-file-content, ...] after compaction+inject, and after a
    // handoff `replaceSystemMessage` only swaps [0] — the rest stay leading
    // system entries. Keeping only the first one would strand agent role
    // instructions (Scout/Planner/Generator/Evaluator) behind the summary and
    // still leak secondary system messages into the transcript, which the
    // provider layer now merges but which would otherwise confuse strict
    // proxies that reject any non-leading system message.
    let cut = 0;
    while (cut < messages.length && messages[cut]?.role === 'system') {
      cut += 1;
    }
    const systemParts: string[] = [];
    for (let i = 0; i < cut; i += 1) {
      const content = messages[i]!.content;
      const text = typeof content === 'string' ? content : '';
      if (text.trim().length > 0) {
        systemParts.push(text);
      }
    }
    const system = systemParts.join('\n\n');
    const transcript = messages.slice(cut);

    const wireTools: KodaXToolDefinition[] = (agent.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    // FEATURE_078 (v0.7.29): resolve per-role reasoning through the L1-L4
    // chain rather than reading `agent.reasoning?.default` directly:
    //   L1 (user ceiling)   ← `--reasoning <mode>` / options.reasoningMode
    //   L2 (agent default)  ← agent.reasoning.default + .max
    //   L3 (scout hint)     ← Scout's downstream_reasoning_hint, if any
    //   L4 (revise escalate) — handled later by escalateThinkingDepth
    // Pre-FEATURE_078 path was L2 only; that path is preserved when no
    // user ceiling override + no scout hint is in play (resolver collapses).
    const userCeiling = resolveReasoningMode(options);
    const scoutHint = getScoutReasoningHint?.();
    const role: ReasoningRole =
      agent.name === SCOUT_AGENT_NAME ? 'scout'
      : agent.name === PLANNER_AGENT_NAME ? 'planner'
      : agent.name === GENERATOR_AGENT_NAME ? 'generator'
      : agent.name === EVALUATOR_AGENT_NAME ? 'evaluator'
      : 'sa';
    const reasoningMode = resolveRoleReasoning(role, userCeiling, agent.reasoning, scoutHint);
    const providerReasoning: import('@kodax/ai').KodaXReasoningRequest | undefined =
      reasoningMode === 'off'
        ? { enabled: false, mode: 'off' }
        : {
            enabled: true,
            mode: reasoningMode,
            depth: reasoningModeToDepth(reasoningMode),
          };

    iteration += 1;
    options.events?.onIterationStart?.(iteration, MAX_ITER_HINT);

    // F1 parity (v0.7.26) — yield to queued user input at iteration
    // boundary. Mirrors legacy `agent.ts:2305` `hasQueuedFollowUp(events)`
    // check. Without this, the user hits Enter mid-run but their new
    // prompt sits in the queue until the current Scout/Generator/
    // Evaluator chain fully completes. Returning an empty reply with no
    // tool calls makes Runner exit the loop naturally — the Runner sees
    // "no more work" rather than an error, and the outer REPL can pick
    // up the queued prompt immediately.
    if (options.events?.hasPendingInputs?.() === true) {
      return {
        text: '',
        toolCalls: [],
        thinkingBlocks: undefined,
      };
    }

    let streamResult: {
      textBlocks?: readonly { text: string }[];
      toolBlocks?: readonly KodaXToolUseBlock[];
      thinkingBlocks?: readonly (
        | import('@kodax/ai').KodaXThinkingBlock
        | import('@kodax/ai').KodaXRedactedThinkingBlock
      )[];
      usage?: import('@kodax/ai').KodaXTokenUsage;
    };
    if (overrideStream) {
      streamResult = await overrideStream(transcript, wireTools, system);
    } else {
      const provider = resolveProvider(options.provider ?? 'anthropic');
      const providerName = options.provider ?? provider.name ?? 'anthropic';
      // Shard 6d-P: restore the legacy second-tier retry/recovery loop
      // (agent.ts:1955-2198). Without this, any transient stream error
      // (network/terminated/stream-incomplete/idle-timeout) aborts the
      // whole managed run on the first failure — no retry, no
      // `onProviderRecovery` event, and the REPL's onError handler ends
      // up printing the raw error via console.log which Ink places below
      // the user prompt instead of inline with the worker output.
      //
      // Mirrors the legacy loop: classify → decide → onProviderRecovery →
      // optional non-streaming fallback → executeRecovery (prune
      // incomplete tool_use turns) → waitForRetryDelay → retry.
      const resilienceCfg = resolveResilienceConfig(providerName);
      const API_HARD_TIMEOUT_MS = resilienceCfg.requestTimeoutMs;
      const API_IDLE_TIMEOUT_MS = resilienceCfg.streamIdleTimeoutMs;
      const boundaryTracker = new StableBoundaryTracker();
      const supportsFallback = typeof provider.supportsNonStreamingFallback === 'function'
        ? provider.supportsNonStreamingFallback()
        : false;
      const recoveryCoordinator = new ProviderRecoveryCoordinator(boundaryTracker, {
        ...resilienceCfg,
        enableNonStreamingFallback: resilienceCfg.enableNonStreamingFallback && supportsFallback,
      });
      // P2b (v0.7.26) — cap max_output_tokens on turns where the tool
      // inventory exposes `write` / `edit` / `multi_edit` for providers
      // that reproducibly RST the streaming connection during large
      // tool_use buffering (zhipu-coding / kimi-code / minimax-coding
      // observed). Rationale: an 8K ceiling physically prevents the
      // model from emitting a tool_use payload large enough to hit the
      // RST window, closing the "Scout jumps to Python to avoid write
      // streaming issues" escape path at the provider layer instead of
      // relying on prompt compliance. Works together with P2a
      // (multi_edit makes skeleton + batched edits cheap, so the cap
      // doesn't force awkward workflows).
      //
      // Override list: `KODAX_RST_PRONE_PROVIDERS` (comma-separated).
      // Override cap:  `KODAX_WRITE_TURN_MAX_TOKENS` (integer).
      // L4 escalation (64K) still fires on stop_reason=max_tokens and
      // takes precedence if the LLM genuinely needs more headroom.
      // `hasAppliedP2bWriteCap` tracks per-turn application so we can
      // clear the override on cleanup (prevents the cap from leaking to
      // the NEXT adapter invocation on the same provider instance).
      const hasAppliedP2bWriteCap = maybeApplyP2bWriteTurnCap(
        provider,
        providerName,
        wireTools,
      );
      let providerMessages: KodaXMessage[] = [...transcript];
      // Clean incomplete tool calls and validate tool history before
      // every provider call (CAP-002). Both helpers come from
      // `agent-runtime/history-cleanup.ts` and are shared with the
      // SA-mode substrate (see catch-terminals.ts:runCatchCleanup).
      providerMessages = cleanupIncompleteToolCalls(providerMessages);
      providerMessages = validateAndFixToolHistory(providerMessages);
      let attempt = 0;
      let raw!: Awaited<ReturnType<typeof provider.stream>>;
      // FEATURE_085 parity for the Scout/Runner path: mirror the main
      // agent loop's max_tokens escalation (cd213e4). When a capped-budget
      // turn returns stop_reason:max_tokens we retry the SAME stream call
      // once with KODAX_ESCALATED_MAX_OUTPUT_TOKENS (64K). At most one
      // escalation per adapter invocation — if 64K still hits the cap,
      // we surface the partial result so the Runner's outer loop can see
      // it and decide next steps. Full L5 continuation (meta "break into
      // smaller pieces") is handled by prompt-level guidance in system.ts
      // + write/edit tool descriptions rather than framework plumbing
      // through the Runner turn boundary.
      let hasEscalatedForCurrentAdapterCall = false;
      while (true) {
        attempt += 1;
        boundaryTracker.beginRequest(
          providerName,
          provider.getModel?.() ?? options.modelOverride ?? 'unknown',
          providerMessages,
          attempt,
          false,
        );
        telemetryBoundary(boundaryTracker.snapshot());

        const retryTimeoutController = new AbortController();
        let hardTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          retryTimeoutController.abort(new Error('API Hard Timeout (10 minutes)'));
        }, API_HARD_TIMEOUT_MS);
        const idleEnabled = API_IDLE_TIMEOUT_MS > 0;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        if (idleEnabled) {
          idleTimer = setTimeout(() => {
            retryTimeoutController.abort(
              new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`),
            );
          }, API_IDLE_TIMEOUT_MS);
        }
        const resetIdleTimer = () => {
          if (!idleEnabled) return;
          if (idleTimer) clearTimeout(idleTimer);
          if (!retryTimeoutController.signal.aborted) {
            idleTimer = setTimeout(() => {
              retryTimeoutController.abort(
                new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`),
              );
            }, API_IDLE_TIMEOUT_MS);
          }
        };
        const retrySignal = options.abortSignal
          ? AbortSignal.any([options.abortSignal, retryTimeoutController.signal])
          : retryTimeoutController.signal;

        const payloadBytes = estimateProviderPayloadBytes(providerMessages, system);
        emitResilienceDebug('[resilience:request]', {
          provider: providerName,
          attempt,
          fallbackActive: false,
          payloadBytes,
          payloadBucket: bucketProviderPayloadSize(payloadBytes),
        });

        // Wire the boundary tracker into the stream callbacks — the
        // coordinator inspects these markers to decide whether a failure
        // happened before the first delta, mid-stream, post-tool, etc.
        const streamOptions = {
          onTextDelta: (text: string) => {
            boundaryTracker.markTextDelta(text);
            resetIdleTimer();
            // M2 parity (v0.7.26) — scrub managed control-plane markers
            // and incomplete managed fences from the streamed delta
            // before surfacing to `events.onTextDelta`. Without this,
            // mid-turn `[managed-task] ...` / `<scout_verdict>` tags
            // briefly appear in REPL live output even though they're
            // stripped from the final turn text. Matches legacy
            // behaviour where managed-worker streams routed through
            // `sanitizeManagedStreamingText` before the REPL saw them.
            // The sanitize call trims — only apply it when we actually
            // detect a marker in this delta to preserve mid-token
            // whitespace in the common clean-delta case.
            const hasMarker = text.includes('```')
              || MANAGED_CONTROL_PLANE_MARKERS.some((marker) => text.includes(marker));
            const outText = hasMarker ? sanitizeManagedStreamingText(text) : text;
            if (outText.length === 0) return;
            options.events?.onTextDelta?.(outText);
          },
          onThinkingDelta: (text: string) => {
            boundaryTracker.markThinkingDelta(text);
            resetIdleTimer();
            options.events?.onThinkingDelta?.(text);
          },
          onThinkingEnd: (thinking: string) => {
            options.events?.onThinkingEnd?.(thinking);
          },
          onToolInputDelta: options.events?.onToolInputDelta,
        };

        try {
          raw = await provider.stream(
            providerMessages,
            [...wireTools],
            system,
            providerReasoning,
            streamOptions,
            retrySignal,
          );
          // max_tokens escalation: if the capped budget hit the cap and
          // we haven't yet escalated this adapter call, stage
          // KODAX_ESCALATED_MAX_OUTPUT_TOKENS for the next iteration and
          // re-enter the loop. Skipped when the user explicitly set
          // KODAX_MAX_OUTPUT_TOKENS or the effective budget already meets
          // the escalated threshold. Mirrors agent.ts:2264-2284.
          if (
            raw.stopReason === 'max_tokens'
            && !hasEscalatedForCurrentAdapterCall
            && !process.env.KODAX_MAX_OUTPUT_TOKENS
            && provider.getEffectiveMaxOutputTokens() < KODAX_ESCALATED_MAX_OUTPUT_TOKENS
          ) {
            hasEscalatedForCurrentAdapterCall = true;
            provider.setMaxOutputTokensOverride(KODAX_ESCALATED_MAX_OUTPUT_TOKENS);
            options.events?.onRetry?.(
              `Output budget reached, escalating to ${KODAX_ESCALATED_MAX_OUTPUT_TOKENS} tokens and retrying the same turn`,
              1,
              1,
            );
            if (hardTimer) clearTimeout(hardTimer);
            if (idleTimer) clearTimeout(idleTimer);
            hardTimer = undefined;
            idleTimer = undefined;
            // Escalation is a same-turn re-issue (change max_tokens, replay same messages),
            // not an error recovery. Reverse the `attempt += 1` at the top of the loop so
            // this iteration does not consume a slot from `resilienceCfg.maxRetries`. The
            // next iteration's attempt will be the same as this one, and subsequent real
            // errors still get the full retry budget.
            attempt -= 1;
            continue;
          }
          break;
        } catch (rawError) {
          let error = rawError instanceof Error ? rawError : new Error(String(rawError));
          if (
            error.name === 'AbortError'
              && retryTimeoutController.signal.aborted
              && !options.abortSignal?.aborted
          ) {
            const reason = (retryTimeoutController.signal as { reason?: { message?: string } })
              .reason?.message ?? 'Stream stalled';
            const { KodaXNetworkError } = await import('@kodax/ai');
            error = new KodaXNetworkError(reason, true);
          }

          const failureStage = boundaryTracker.inferFailureStage();
          const classified = classifyResilienceError(error, failureStage);
          telemetryClassify(error, classified);
          const decision = recoveryCoordinator.decideRecoveryAction(error, classified, attempt);
          telemetryDecision(decision, attempt);

          options.events?.onProviderRecovery?.({
            stage: decision.failureStage,
            errorClass: decision.reasonCode,
            attempt,
            maxAttempts: resilienceCfg.maxRetries,
            delayMs: decision.delayMs,
            recoveryAction: decision.action,
            ladderStep: decision.ladderStep,
            fallbackUsed: decision.shouldUseNonStreaming,
            serverRetryAfterMs: decision.serverRetryAfterMs,
          });
          // Dedicated rate-limit event so REPL can render a distinct 429
          // banner (separate from the generic retry UI).
          if (decision.reasonCode === 'rate_limit' && options.events) {
            emitProviderRateLimit(
              options.events,
              attempt,
              resilienceCfg.maxRetries,
              decision.delayMs,
            );
          }
          if (!options.events?.onProviderRecovery && decision.action !== 'manual_continue') {
            options.events?.onRetry?.(
              `${describeTransientProviderRetry(error)} · retry ${attempt}/${resilienceCfg.maxRetries} in ${Math.round(decision.delayMs / 1000)}s`,
              attempt,
              resilienceCfg.maxRetries,
            );
          }

          if (decision.shouldUseNonStreaming && typeof provider.complete === 'function') {
            const fallbackTimeoutController = new AbortController();
            const fallbackSignal = options.abortSignal
              ? AbortSignal.any([options.abortSignal, fallbackTimeoutController.signal])
              : fallbackTimeoutController.signal;
            const fallbackHardTimer = setTimeout(() => {
              fallbackTimeoutController.abort(new Error('API Hard Timeout (10 minutes)'));
            }, API_HARD_TIMEOUT_MS);
            try {
              if (idleTimer) clearTimeout(idleTimer);
              if (hardTimer) clearTimeout(hardTimer);
              hardTimer = undefined;
              idleTimer = undefined;
              boundaryTracker.beginRequest(
                providerName,
                provider.getModel?.() ?? options.modelOverride ?? 'unknown',
                providerMessages,
                attempt,
                true,
              );
              telemetryBoundary(boundaryTracker.snapshot());
              raw = await provider.complete(
                providerMessages,
                [...wireTools],
                system,
                providerReasoning,
                {
                  onTextDelta: (text: string) => {
                    boundaryTracker.markTextDelta(text);
                    options.events?.onTextDelta?.(text);
                  },
                  onThinkingDelta: (text: string) => {
                    boundaryTracker.markThinkingDelta(text);
                    options.events?.onThinkingDelta?.(text);
                  },
                  onThinkingEnd: (thinking: string) => {
                    options.events?.onThinkingEnd?.(thinking);
                  },
                  signal: fallbackSignal,
                },
                fallbackSignal,
              );
              break;
            } catch (fallbackError) {
              error = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
            } finally {
              clearTimeout(fallbackHardTimer);
            }
          }

          // sanitize_thinking_and_retry is a single-shot history-mutation
          // recovery (drop thinking blocks once, retry once) and must
          // bypass the regular retry-budget gate. It's gated by its own
          // `thinkingSanitizationUsed` latch inside the coordinator, so
          // it can fire at most once per request chain regardless of how
          // many normal retries already happened. v0.7.28.
          if (decision.action === 'sanitize_thinking_and_retry') {
            const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
            telemetryRecovery(decision.action, recovery);
            providerMessages = recovery.messages;
            if (hardTimer) clearTimeout(hardTimer);
            if (idleTimer) clearTimeout(idleTimer);
            hardTimer = undefined;
            idleTimer = undefined;
            // Don't bill an attempt slot for the sanitize step — same
            // rationale as the L1 escalation reversal at line ~2546.
            attempt -= 1;
            await waitForRetryDelay(decision.delayMs, options.abortSignal);
            continue;
          }

          if (decision.action === 'manual_continue' || attempt >= resilienceCfg.maxRetries) {
            // Preserve in-flight providerMessages on the thrown error so the
            // outer wrapper's session-snapshot save can persist real history
            // instead of `[]`. Non-enumerable so JSON-serializing telemetry
            // does not dump conversation history into logs. The outer catch
            // uses Array.isArray as a guard.
            Object.defineProperty(error, '__kodaxRecoveredMessages', {
              value: providerMessages,
              enumerable: false,
            });
            throw error;
          }

          const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
          telemetryRecovery(decision.action, recovery);
          providerMessages = recovery.messages;

          if (hardTimer) clearTimeout(hardTimer);
          if (idleTimer) clearTimeout(idleTimer);
          hardTimer = undefined;
          idleTimer = undefined;
          await waitForRetryDelay(decision.delayMs, options.abortSignal);
          continue;
        } finally {
          if (hardTimer) clearTimeout(hardTimer);
          if (idleTimer) clearTimeout(idleTimer);
        }
      }

      // M6 parity (v0.7.26) — L5 continuation ladder. When L1 escalation
      // is exhausted and the model still hit max_tokens mid-text (no
      // tool blocks, has text), inject a synthetic user "Continue from
      // where you left off" message and re-stream up to
      // KODAX_MAX_MAXTOKENS_RETRIES times, accumulating text +
      // thinkingBlocks across turns. Mirrors legacy agent.ts:2316-2334.
      // Without this, long Generator replies that blow through the
      // escalated 64K cap get truncated silently — the assistant stops
      // mid-sentence and the Runner exits with a partial answer.
      let l5Retries = 0;
      let accumulatedText = (raw.textBlocks ?? []).map((b) => b.text).join('');
      type ThinkingBlock = import('@kodax/ai').KodaXThinkingBlock
        | import('@kodax/ai').KodaXRedactedThinkingBlock;
      const accumulatedThinking: ThinkingBlock[] | undefined = raw.thinkingBlocks
        ? [...raw.thinkingBlocks]
        : undefined;
      while (
        raw.stopReason === 'max_tokens'
        && (raw.toolBlocks?.length ?? 0) === 0
        && accumulatedText.trim().length > 0
        && l5Retries < KODAX_MAX_MAXTOKENS_RETRIES
      ) {
        l5Retries += 1;
        options.events?.onTextDelta?.('\n\n[max_tokens reached, continuing...]\n\n');
        // Push the partial assistant turn + synthetic user continuation
        // onto the outgoing transcript. The provider will see the full
        // mid-thought state and pick up seamlessly.
        //
        // Thinking blocks accumulated so far must ride along on the
        // synthetic assistant turn. Without them, providers in strict
        // thinking-mode (deepseek V4) reject the next replay with
        // "reasoning_content must be passed back to the API" — the
        // synthetic turn would be a thinking-less assistant message in
        // a thinking-enabled request, which violates their per-turn
        // contract. Mirrors what agent.ts:2294 does for the legacy
        // path: thinking + text + tool_use stack on the assistant
        // message in history.
        const assistantContent: KodaXContentBlock[] = [
          ...(accumulatedThinking ?? []),
          { type: 'text', text: accumulatedText },
        ];
        providerMessages = [
          ...providerMessages,
          { role: 'assistant', content: assistantContent } as KodaXMessage,
          {
            role: 'user',
            content: [{
              type: 'text',
              text:
                'Output token limit hit. Resume directly — no apology, no recap of what you were doing. '
                + 'Pick up mid-thought if that is where the cut happened. '
                + 'Break remaining work into smaller pieces.',
            }],
          } as KodaXMessage,
        ];
        options.events?.onRetry?.(
          `max_tokens mid-text, appending continuation ${l5Retries}/${KODAX_MAX_MAXTOKENS_RETRIES}`,
          l5Retries,
          KODAX_MAX_MAXTOKENS_RETRIES,
        );
        const l5Signal = options.abortSignal ?? undefined;
        try {
          raw = await provider.stream(
            providerMessages,
            [...wireTools],
            system,
            providerReasoning,
            {
              onTextDelta: (text: string) => {
                const hasMarker = text.includes('```')
                  || MANAGED_CONTROL_PLANE_MARKERS.some((marker) => text.includes(marker));
                const outText = hasMarker ? sanitizeManagedStreamingText(text) : text;
                if (outText.length === 0) return;
                options.events?.onTextDelta?.(outText);
              },
              onThinkingDelta: (text: string) => {
                options.events?.onThinkingDelta?.(text);
              },
              onThinkingEnd: (thinking: string) => {
                options.events?.onThinkingEnd?.(thinking);
              },
              onToolInputDelta: options.events?.onToolInputDelta,
            },
            l5Signal,
          );
        } catch {
          // L5 retries are best-effort — any failure here falls back to
          // the partial result we already have.
          break;
        }
        const nextText = (raw.textBlocks ?? []).map((b) => b.text).join('');
        if (nextText) accumulatedText += nextText;
        if (raw.thinkingBlocks && accumulatedThinking) {
          accumulatedThinking.push(...raw.thinkingBlocks);
        }
        // Exit early on tool calls or natural stop.
        if ((raw.toolBlocks?.length ?? 0) > 0 || raw.stopReason !== 'max_tokens') {
          break;
        }
      }

      streamResult = {
        textBlocks: accumulatedText ? [{ text: accumulatedText }] : raw.textBlocks,
        toolBlocks: raw.toolBlocks,
        thinkingBlocks: accumulatedThinking ?? raw.thinkingBlocks,
        usage: raw.usage,
      };

      // P2b cleanup — if we applied the write-turn cap, ensure the
      // override doesn't leak to the next adapter invocation on this
      // same provider instance. Base provider clears on success inside
      // withRateLimit, but failure paths keep the override. Clearing
      // unconditionally here is safe: L4 escalation sets and clears
      // its own override within the retry loop, and any fresh
      // invocation will re-apply its own policy.
      if (hasAppliedP2bWriteCap) {
        provider.setMaxOutputTokensOverride(undefined);
      }
    }

    // Update cumulative token state for the final contextTokenSnapshot.
    if (tokenStateRef && streamResult.usage) {
      const current = tokenStateRef.current;
      tokenStateRef.current = {
        totalTokens: streamResult.usage.totalTokens ?? current.totalTokens,
        lastUsage: streamResult.usage,
        source: 'api',
      };
    }

    // Record turn usage into the cost tracker so `/cost` reflects AMA spend.
    if (streamResult.usage) {
      const providerName = options.provider ?? 'anthropic';
      costTracker = recordCostUsage(costTracker, {
        provider: providerName,
        model: options.modelOverride ?? options.model ?? 'unknown',
        inputTokens: streamResult.usage.inputTokens,
        outputTokens: streamResult.usage.outputTokens,
        cacheReadTokens: streamResult.usage.cachedReadTokens,
        cacheWriteTokens: streamResult.usage.cachedWriteTokens,
      });
    }

    // onStreamEnd fires after the provider finishes the current turn's
    // stream. The Runner-driven adapter funnels every turn through this
    // single return-path so the event fires once per stream.
    if (options.events) emitStreamEnd(options.events);

    // Fire onIterationEnd so the REPL token-count indicator can refresh
    // after each worker turn. `scope: 'worker'` mirrors the FEATURE_072
    // tagging — every Runner-driven iteration runs inside a worker role,
    // never the top-level REPL agent.
    if (options.events?.onIterationEnd) {
      const usage = streamResult.usage;
      const tokenCount = usage?.totalTokens ?? usage?.outputTokens ?? 0;
      options.events.onIterationEnd({
        iter: iteration,
        maxIter: MAX_ITER_HINT,
        tokenCount,
        tokenSource: usage ? 'api' : 'estimate',
        usage,
        scope: 'worker',
      });
    }

    const text = (streamResult.textBlocks ?? []).map((b) => b.text).join('');
    const toolCalls = (streamResult.toolBlocks ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input ?? {},
    }));

    // C1 parity (v0.7.26) — fenced-block fallback. v0.7.22 ran
    // `managedProtocolPayload?.scout ?? parseManagedTaskScoutDirective(text)`
    // at 4 call sites so an LLM that writes a well-formed `kodax-task-*`
    // block but forgets to call the emit tool still advances the
    // pipeline. The Runner-driven path lost this until now — a missed
    // emit stalls the entire run (task never records Scout/Handoff/
    // Verdict, Runner loops until the 500-iteration safety cap trips).
    //
    // Strategy: detect "LLM didn't call the expected emit_* tool this
    // turn, but assistant text contains the role's kodax-task-* fence"
    // → parse the fence via `attemptProtocolTextFallback`, synthesize a
    // matching tool_call entry. The Runner will dispatch it through
    // the agent's already-registered emit tool + `wrapEmitterWithRecorder`,
    // so recorder / budget / handoff bookkeeping flows through the
    // exact same code path as a real tool call. Zero new state
    // machinery. Mirrors v0.7.22's `?? parseManagedTask*Directive`
    // fallback at task-engine.ts:3242 / 3297 / 3371 / 3416.
    const fallbackRole = agentNameToManagedRole(agent.name);
    if (fallbackRole && text.length > 0) {
      const expectedEmit = getEmitToolNameForRole(fallbackRole);
      const alreadyEmitted = expectedEmit
        ? toolCalls.some((tc) => tc.name === expectedEmit)
        : false;
      if (expectedEmit && !alreadyEmitted) {
        const synthesized = attemptProtocolTextFallback(fallbackRole, text);
        if (synthesized) {
          toolCalls.push({
            id: `fallback-${fallbackRole}-${Date.now()}`,
            name: expectedEmit,
            // Re-serialize the normalized payload as the synthetic tool
            // input. The real emitter will re-run `coerceManagedProtocolToolPayload`,
            // which is idempotent on already-normalized input (keys
            // already snake_case via the block body; camelCase fields
            // the normalizer produced round-trip cleanly via the
            // tool's schema).
            input: flattenNormalizedForEmitterInput(synthesized.payload) as Record<string, unknown>,
          });
          options.events?.onRetry?.(
            `[fallback] ${fallbackRole} emitted ${getManagedBlockNameForRole(fallbackRole) ?? 'fenced block'} without calling ${expectedEmit}; synthesizing tool call from block body`,
            0,
            0,
          );
        }
      }
    }
    // Forward thinking blocks so
    // `buildAssistantMessageFromLlmResult` can prepend them to the
    // assistant content. Required for Anthropic extended thinking —
    // provider returns 400 if prior assistant turns with tool_use are
    // missing the thinking block in history.
    const thinkingBlocks = streamResult.thinkingBlocks;
    return { text, toolCalls, thinkingBlocks };
  };
}

// =============================================================================
// Result conversion: RunResult + VerdictRecorder → KodaXResult
// =============================================================================

function extractUserFacingText(result: { messages: readonly KodaXMessage[]; output: string }): string {
  const raw = extractUserFacingRaw(result);
  // Strip internal managed control-plane markers and any
  // stray ```kodax-task-*``` fences (complete or truncated) that the LLM
  // might emit in assistant text despite using structured emit tools.
  // Legacy task-engine.ts applied this at 14 call sites; re-added at the
  // single Runner-driven extraction point.
  return sanitizeManagedUserFacingText(raw);
}

function extractUserFacingRaw(result: { messages: readonly KodaXMessage[]; output: string }): string {
  if (result.output.trim().length > 0) return result.output;
  const last = result.messages[result.messages.length - 1];
  if (!last || last.role !== 'assistant') return '';
  if (typeof last.content === 'string') return last.content;
  return (last.content as KodaXContentBlock[])
    .filter((b): b is KodaXTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Derive the final signal + managedTask.verdict.status from the recorder.
 * Priority:
 *   1. Evaluator verdict if present (accept / revise / blocked)
 *   2. Scout H0 direct completion (maps to completed)
 *   3. Fallback: undefined (treated as converged by round-boundary for the
 *      SA fast-path pattern)
 */
function deriveFinalStatus(recorder: VerdictRecorder): {
  signal: KodaXResult['signal'];
  verdictStatus?: 'accept' | 'revise' | 'blocked';
  reason?: string;
  userAnswer?: string;
} {
  const verdictPayload = recorder.verdict?.payload.verdict;
  if (verdictPayload) {
    if (verdictPayload.status === 'blocked') {
      return {
        signal: 'BLOCKED',
        verdictStatus: 'blocked',
        reason: verdictPayload.reason,
      };
    }
    return {
      signal: 'COMPLETE',
      verdictStatus: verdictPayload.status,
      reason: verdictPayload.reason,
      userAnswer: verdictPayload.userAnswer,
    };
  }
  return { signal: 'COMPLETE' };
}

/**
 * Build the minimal `managedProtocolPayload` slice the round-boundary
 * reshape expects. Shard 5b populates whatever the recorder captured;
 * missing slices stay undefined.
 */
function buildManagedProtocolPayload(
  recorder: VerdictRecorder,
): KodaXManagedProtocolPayload | undefined {
  const slices: Partial<KodaXManagedProtocolPayload> = {};
  if (recorder.scout?.payload.scout) slices.scout = recorder.scout.payload.scout;
  if (recorder.contract?.payload.contract) slices.contract = recorder.contract.payload.contract;
  if (recorder.handoff?.payload.handoff) slices.handoff = recorder.handoff.payload.handoff;
  if (recorder.verdict?.payload.verdict) slices.verdict = recorder.verdict.payload.verdict;
  if (Object.keys(slices).length === 0) return undefined;
  return slices as KodaXManagedProtocolPayload;
}

// =============================================================================
// managedTask payload construction — Shard 6a
// =============================================================================

/**
 * Map the harness tier to the assignment-id convention legacy consumers
 * expect. H0 uses 'direct', H1/H2 use the role name.
 */
function harnessToBudget(harness: KodaXHarnessProfile): number {
  // Legacy per-harness global work budget constants (approximate; tests
  // only assert aggregate totals, not exact ceilings).
  if (harness === 'H0_DIRECT') return 50;
  if (harness === 'H1_EXECUTE_EVAL') return 400;
  return 600;
}

/**
 * Build the full `KodaXManagedTask` payload from the recorder, role
 * sequence, and run metadata. Fields are populated to the minimum
 * necessary for round-boundary reshape + REPL consumers + the subset of
 * test assertions mapped in Shard 6a's inventory.
 */
function buildManagedTaskPayload(args: {
  readonly prompt: string;
  readonly options: KodaXOptions;
  readonly recorder: VerdictRecorder;
  readonly rolesEmitted: readonly KodaXTaskRole[];
  readonly baseCtx: KodaXToolExecutionContext;
  readonly signal: KodaXResult['signal'];
  readonly verdictStatus?: 'accept' | 'revise' | 'blocked';
  readonly userAnswer?: string;
  readonly budget?: ManagedTaskBudgetController;
  readonly plan?: ReasoningPlan;
  readonly entries?: readonly KodaXTaskEvidenceEntry[];
  readonly degradedContinue?: boolean;
  readonly childWriteWorktreePaths?: ReadonlyMap<string, string>;
  /**
   * Stable taskId for the run. Callers that need deterministic snapshot
   * paths (runManagedTaskViaRunnerInner, checkpoint writer, skill-artifact
   * persistence) must pass the same id for every invocation in a run; if
   * omitted a fresh id is generated (back-compat for legacy callers).
   */
  readonly taskId?: string;
  /**
   * v0.7.26 C4 parity — extra evidence artefact records (e.g. skill
   * artifacts) that the caller has already persisted to disk and wants
   * merged into `evidence.artifacts` alongside the built-in snapshot set.
   */
  readonly extraArtifacts?: readonly KodaXTaskEvidenceArtifact[];
  /**
   * F4 parity (v0.7.26) — pre-floor routing decision (before
   * `applyCurrentDiffReviewRoutingFloor` runs). Populates
   * `runtime.rawRoutingDecision`.
   */
  readonly rawRoutingDecision?: KodaXTaskRoutingDecision;
  /**
   * F4 parity — human-readable explanation when the routing floor or
   * Scout overrides the initial decision. Populates
   * `runtime.routingOverrideReason`.
   */
  readonly routingOverrideReason?: string;
  /**
   * F4 parity — tool-output truncation ledger captured from the
   * tool-result-truncation guardrail's `afterTool` hook. Populates
   * `runtime.toolOutputTruncated` + `runtime.toolOutputTruncationNotes`.
   */
  readonly toolOutputTruncated?: boolean;
  readonly toolOutputTruncationNotes?: readonly string[];
}): KodaXManagedTask {
  const {
    prompt,
    options,
    recorder,
    rolesEmitted,
    baseCtx,
    signal,
    verdictStatus,
    userAnswer,
    budget,
    plan,
    entries,
    degradedContinue,
    childWriteWorktreePaths,
    taskId: providedTaskId,
    extraArtifacts,
    rawRoutingDecision,
    routingOverrideReason,
    toolOutputTruncated,
    toolOutputTruncationNotes,
  } = args;

  // Shard 6d-L: Scout's emitted harness still wins over the plan's
  // recommendation (FEATURE_061 — Scout is the routing authority). Fall
  // back to plan.decision.harnessProfile when Scout has not emitted yet,
  // then to H0_DIRECT.
  const harness: KodaXHarnessProfile =
    recorder.scout?.payload.scout?.confirmedHarness
      ?? plan?.decision.harnessProfile
      ?? 'H0_DIRECT';
  const contractPayload = recorder.contract?.payload.contract;

  const nowIso = new Date().toISOString();
  // v0.7.26 C4 parity — honour the caller-supplied taskId so every
  // `buildManagedTaskPayload` call within a single run reuses the same
  // workspaceDir. Prior behaviour generated a fresh id on every invocation,
  // so every observer snapshot wrote to a different folder and skill
  // artifacts could not be referenced by a stable path.
  const taskId = providedTaskId ?? `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const surface = getManagedTaskSurface(options);
  // Resolve the per-task workspace directory (e.g. `<cwd>/.agent/
  // managed-tasks/<taskId>/`) so downstream snapshot files and
  // `evidence.artifacts` point at a stable, writable location — matches
  // legacy `task-engine.ts:2106` and is required for checkpoint/resume
  // parity.
  const workspaceDir = path.join(getManagedTaskWorkspaceRoot(options, surface), taskId);

  const contractStatus =
    signal === 'BLOCKED' ? 'blocked' : verdictStatus === 'accept' ? 'completed' : 'running';

  // Shard 6d-L: honour the reasoning plan's routing decision when filling
  // `contract.*`. Legacy (`task-engine.ts:2160-2180`) populated every
  // contract field from `plan.decision`; the earlier Runner-driven payload
  // hard-coded `primaryTask:'conversation'` / `complexity:simple` /
  // `riskLevel:'low'` and broke every downstream branch that read these
  // values (agent.ts has ~10 `decision.primaryTask === 'review' | 'bugfix'
  // | ...` branches). When the plan is absent we still fall back to the
  // placeholders — keeps callers without a plan (test harness, direct
  // API use) working.
  const decision = plan?.decision;
  const contract: KodaXTaskContract = {
    taskId,
    surface,
    objective: prompt,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: contractStatus,
    primaryTask: decision?.primaryTask ?? 'conversation',
    workIntent: decision?.workIntent ?? 'new',
    complexity:
      decision?.complexity
        ?? (harness === 'H0_DIRECT' ? 'simple' : harness === 'H1_EXECUTE_EVAL' ? 'moderate' : 'complex'),
    riskLevel: decision?.riskLevel ?? 'low',
    harnessProfile: harness,
    recommendedMode: decision?.recommendedMode ?? 'conversation',
    requiresBrainstorm: decision?.requiresBrainstorm ?? false,
    reason: decision?.reason ?? 'Runner-driven AMA path',
    contractSummary: contractPayload?.summary,
    successCriteria: contractPayload?.successCriteria ?? [],
    requiredEvidence: contractPayload?.requiredEvidence ?? [],
    constraints: contractPayload?.constraints ?? [],
    verification: options.context?.taskVerification,
  };

  // De-dup roles while preserving first-occurrence order. The assignment
  // list is a historical record of who participated, not a schedule.
  const roleOrder: KodaXTaskRole[] = [];
  for (const r of rolesEmitted) {
    if (!roleOrder.includes(r)) roleOrder.push(r);
  }
  // H0_DIRECT convention: use 'direct' as the role when Scout answers
  // without handoff. The legacy path emits a single 'direct' assignment.
  const assignmentRoles: KodaXTaskRole[] =
    harness === 'H0_DIRECT' && roleOrder.length <= 1 ? ['direct'] : roleOrder;
  const roleAssignments: KodaXTaskRoleAssignment[] = assignmentRoles.map((role) => ({
    id: role,
    role,
    title: role.charAt(0).toUpperCase() + role.slice(1),
    dependsOn: [],
    status: contractStatus,
  }));

  const decidedByAssignmentId =
    harness === 'H0_DIRECT' ? 'direct' : verdictStatus ? 'evaluator' : 'generator';
  const verdictSummary =
    userAnswer ?? recorder.verdict?.payload.verdict?.reason ?? prompt;

  const task: KodaXManagedTask = {
    contract,
    roleAssignments,
    workItems: [],
    evidence: {
      workspaceDir,
      // Every managed task advertises a fixed set of 10 snapshot files
      // the writeManagedTaskArtifacts
      // pass is expected to produce. Downstream consumers (`resumeManagedTask`,
      // harness observers, the REPL transcript dump) index evidence by
      // artifact path, so we surface the records here even when the actual
      // files are written asynchronously at terminal exit.
      //
      // v0.7.26 C4 parity — merge any caller-supplied artefact records
      // (e.g. skill-execution.md / skill-map.md persisted by
      // `writeManagedSkillArtifacts`) alongside the built-in snapshot set
      // so the REPL + resume flow can resolve them by path.
      artifacts: mergeEvidenceArtifacts(
        buildManagedTaskArtifactRecords(workspaceDir),
        extraArtifacts,
      ),
      // Shard 6d-R: surface the per-role turn ledger and routing notes.
      // Legacy `task-engine.ts` fed these fields from each role completion
      // + `plan.decision.routingNotes`. Without them, snapshot consumers
      // (`buildManagedTaskRoundHistory`, REPL transcript dump, resume)
      // see empty history + no routing context.
      entries: entries ? [...entries] : [],
      routingNotes: plan?.decision.routingNotes ? [...plan.decision.routingNotes] : [],
    },
    verdict: {
      status:
        signal === 'BLOCKED'
          ? 'blocked'
          : verdictStatus === 'accept'
            ? 'completed'
            : 'running',
      decidedByAssignmentId,
      summary: verdictSummary,
      signal,
      continuationSuggested: recorder.handoff?.payload.handoff?.status === 'ready' && verdictStatus !== 'accept',
    },
    runtime: {
      globalWorkBudget: budget?.totalBudget ?? harnessToBudget(harness),
      budgetUsage: budget?.spentBudget ?? rolesEmitted.length,
      // `harnessTransitions` in legacy semantics records harness-tier
      // upgrades (e.g. H1 → H2 on revise+next_harness=H2), not individual
      // role transitions. For the Runner path we synthesise one transition
      // when Scout picks a non-H0 tier (the only case tests observe today).
      harnessTransitions:
        harness !== 'H0_DIRECT'
          ? [
              {
                from: 'H0_DIRECT',
                to: harness,
                round: 1,
                source: 'scout',
                reason: 'Scout confirmed harness tier',
                approved: true,
              },
            ]
          : [],
      // Shard 6d-O: fill runtime fields the legacy path populated so
      // downstream consumers (REPL harness UI, evaluator guardrails,
      // resume flow, session storage) see the same shape they did on
      // the legacy path. Empty-ish runtime defaulted to placeholder
      // values before this shard; the harness UI silently fell back to
      // defaults and lost context for `amaProfile` / `upgradeCeiling` /
      // `scoutDecision` etc.
      amaProfile: plan?.amaControllerDecision?.profile,
      amaTactics: plan?.amaControllerDecision?.tactics,
      amaControllerReason: plan?.amaControllerDecision?.reason,
      routingAttempts: plan?.decision.routingAttempts,
      routingSource: plan?.decision.routingSource,
      currentHarness: harness,
      upgradeCeiling: plan?.decision.upgradeCeiling ?? harness,
      qualityAssuranceMode: deriveQualityAssuranceMode(plan, harness),
      scoutDecision: recorder.scout?.payload.scout
        ? buildScoutDecisionRuntime(recorder.scout.payload.scout)
        : undefined,
      skillMap: buildSkillMapRuntime(recorder.scout?.payload.scout?.skillMap),
      // Shard 6d-U: propagate the degraded-continue signal. `true` when the
      // Evaluator requested an upgrade beyond `plan.decision.upgradeCeiling`
      // (rewritten back to Generator) or when budget-extension approval was
      // denied / skipped during revise. `undefined` when no degradation.
      degradedContinue: degradedContinue || undefined,
      // Shard 6d-S: derive per-criterion / per-runtime-check completion
      // status from the final verdict. Absent when no verification
      // contract was declared.
      completionContractStatus: buildCompletionContractStatus(
        options.context?.taskVerification,
        verdictStatus,
      ),
      // Shard 6d-Q: surface the dispatch_child_task write-fan-out ledger
      // so Evaluator diff injection (FEATURE_067 v2 parity) can find
      // per-child worktree paths. Undefined when no children dispatched.
      childWriteWorktreePaths:
        childWriteWorktreePaths && childWriteWorktreePaths.size > 0
          ? childWriteWorktreePaths
          : undefined,
      // F4 parity (v0.7.26) — surface routing provenance + tool
      // truncation state. `rawRoutingDecision` is the pre-floor snapshot
      // (before `applyCurrentDiffReviewRoutingFloor`); `finalRoutingDecision`
      // mirrors the active plan.decision; `routingOverrideReason` carries
      // any human-readable override explanation. Truncation tracking
      // lets downstream review UIs highlight when tool output was
      // clipped.
      rawRoutingDecision,
      finalRoutingDecision: plan?.decision,
      routingOverrideReason,
      toolOutputTruncated: toolOutputTruncated || undefined,
      toolOutputTruncationNotes:
        toolOutputTruncationNotes && toolOutputTruncationNotes.length > 0
          ? [...toolOutputTruncationNotes]
          : undefined,
    },
  };

  // H2 parity (v0.7.26) — populate the verification scorecard after the
  // task shape is built, mirroring legacy `createVerificationScorecard`.
  // Without this, `task.runtime.scorecard` stayed undefined and
  // `scorecard.json` persisted as `null`, starving downstream consumers
  // (review-scale UI, session-storage replay, rubric-family branches).
  const verdictPayload = recorder.verdict?.payload.verdict;
  const scorecardDirective: ScorecardVerdictDirective | undefined = verdictPayload
    ? { status: verdictPayload.status, reason: verdictPayload.reason }
    : undefined;
  const scorecard = createVerificationScorecard(task, scorecardDirective);
  return scorecard && task.runtime
    ? { ...task, runtime: { ...task.runtime, scorecard } }
    : task;
}

/**
 * Shard 6d-O: quality-assurance mode mirrors legacy
 * `resolveManagedTaskQualityAssuranceMode` (task-engine.ts:1108).
 * Runner simplification — legacy's branch depended on
 * `plan.decision.mutationSurface` / `assuranceIntent` /
 * `needsIndependentQA` / `riskLevel` / etc.; we reproduce the key
 * decisions:
 *   - H1 / H2 → 'required' (evaluator-mandatory).
 *   - H0 with explicit verification obligations or plan flags → 'required'.
 *   - Otherwise → 'optional'.
 */
function deriveQualityAssuranceMode(
  plan: ReasoningPlan | undefined,
  harness: KodaXHarnessProfile,
): 'required' | 'optional' {
  if (harness !== 'H0_DIRECT') return 'required';
  const decision = plan?.decision;
  if (!decision) return 'optional';
  if (decision.assuranceIntent === 'explicit-check') return 'required';
  if (decision.needsIndependentQA === true) return 'required';
  if (decision.riskLevel === 'high') return 'required';
  if (decision.primaryTask === 'qa' || decision.primaryTask === 'plan') return 'required';
  if (decision.recommendedMode === 'pr-review' || decision.recommendedMode === 'strict-audit') return 'required';
  return 'optional';
}

function buildScoutDecisionRuntime(
  scout: NonNullable<KodaXManagedProtocolPayload['scout']>,
): NonNullable<KodaXManagedTask['runtime']>['scoutDecision'] | undefined {
  if (!scout.summary && !scout.confirmedHarness) return undefined;
  return {
    summary: scout.summary ?? '',
    recommendedHarness: scout.confirmedHarness ?? 'H0_DIRECT',
    readyForUpgrade: scout.directCompletionReady !== 'yes',
    scope: scout.scope,
    requiredEvidence: scout.requiredEvidence,
    reviewFilesOrAreas: scout.reviewFilesOrAreas,
    evidenceAcquisitionMode: scout.evidenceAcquisitionMode,
    harnessRationale: scout.harnessRationale,
    blockingEvidence: scout.blockingEvidence,
    directCompletionReady: scout.directCompletionReady,
    skillSummary: scout.skillMap?.skillSummary,
    executionObligations: scout.skillMap?.executionObligations,
    verificationObligations: scout.skillMap?.verificationObligations,
    ambiguities: scout.skillMap?.ambiguities,
    projectionConfidence: scout.skillMap?.projectionConfidence,
  };
}

function buildSkillMapRuntime(
  scoutSkillMap: NonNullable<KodaXManagedProtocolPayload['scout']>['skillMap'],
): KodaXManagedTask['runtime'] extends infer R
  ? R extends { skillMap?: infer M } ? M : never
  : never {
  if (!scoutSkillMap) return undefined as never;
  return {
    summary: scoutSkillMap.skillSummary,
    executionObligations: scoutSkillMap.executionObligations ?? [],
    verificationObligations: scoutSkillMap.verificationObligations ?? [],
    ambiguities: scoutSkillMap.ambiguities ?? [],
    projectionConfidence: scoutSkillMap.projectionConfidence,
  } as never;
}

// =============================================================================
// Main entry
// =============================================================================

/**
 * Shard 6c + H1 structural resume (v0.7.26).
 *
 * Legacy behaviour (task-engine.ts:~6644 + `resumeManagedTask`): ask the
 * user whether to continue or restart, then either replay the partial
 * state (seeded plan, scoutDecision, budget) or drop the checkpoint.
 *
 *   - "restart" → delete stale checkpoint, start fresh.
 *   - "resume" → keep the checkpoint, return `{ resumeFrom }` so the
 *     caller can seed the recorder via `buildStructuralResumeSeed` and
 *     (depending on what roles already completed) start Runner.run at
 *     planner / generator / evaluator instead of scout. The textual
 *     preamble (`buildResumePreamble`) is still prepended for readability
 *     and to give any resumed-scout retries the prior findings in plain
 *     text.
 *   - "cancel" → delete the checkpoint + throw — the user asked to abort.
 *   - no askUser callback → silently clean up; non-interactive contexts
 *     can't prompt for a decision.
 */
async function handlePreRunCheckpoint(
  options: KodaXOptions,
): Promise<{ resumeFrom: ValidatedCheckpoint } | undefined> {
  let validated: ValidatedCheckpoint | undefined;
  try {
    validated = await findValidCheckpoint(options);
  } catch {
    return undefined;
  }
  if (!validated) return undefined;

  const deleteSafely = async (): Promise<void> => {
    try {
      await deleteCheckpoint(validated!.workspaceDir);
    } catch {
      // Delete failure is non-fatal; the next run will see the same
      // stale checkpoint and reach this branch again.
    }
  };

  if (!options.events?.askUser) {
    await deleteSafely();
    return undefined;
  }

  const useChinese = /[\u4e00-\u9fff]/.test(validated.managedTask.contract.objective ?? '');
  const answer = await options.events.askUser({
    question: useChinese ? '发现未完成的任务' : 'Found incomplete task',
    options: [
      {
        // H1 parity (v0.7.26) — text-level resume. The next run's prompt
        // receives a reconstructed preamble (Scout findings, contract,
        // last verdict) so the LLM can pick up where it left off
        // without re-investigating. Full structural replay of the
        // recorder state is deliberately out of scope for this MVP.
        label: useChinese ? '继续未完成的工作' : 'Resume',
        value: 'resume',
        description: useChinese
          ? '在先前 Scout/执行结果的基础上继续（上下文保留）'
          : 'Continue with preserved prior Scout / execution context',
      },
      {
        label: useChinese ? '重新开始' : 'Restart',
        value: 'restart',
        description: useChinese ? '丢弃之前的进度，重新开始' : 'Discard previous progress and start fresh',
      },
      {
        label: useChinese ? '取消' : 'Cancel',
        value: 'cancel',
        description: useChinese ? '中止当前请求' : 'Abort the current request',
      },
    ],
    default: 'resume',
  });
  if (answer === 'cancel') {
    await deleteSafely();
    throw new Error('Runner-driven path: user cancelled due to pre-existing checkpoint');
  }
  if (answer === 'resume') {
    // Keep the checkpoint in place — it gets rewritten fresh on the
    // next role emit. The caller builds a preamble from the validated
    // state and feeds it into the prompt.
    return { resumeFrom: validated };
  }
  await deleteSafely();
  return undefined;
}

/**
 * H1 parity (v0.7.26) — reconstruct a human-readable preamble from the
 * checkpoint's managedTask state. The next run pre-pends this onto the
 * user prompt so Scout / Generator / Evaluator see the prior
 * investigation + findings and can pick up the work instead of
 * rediscovering it. Text-level resume — not a full structural replay
 * of the recorder — but a meaningful quality-of-life improvement over
 * the prior "restart from scratch" behaviour.
 */
function buildResumePreamble(checkpoint: ValidatedCheckpoint): string {
  const task = checkpoint.managedTask;
  const lines: string[] = [
    '=== RESUMING INCOMPLETE TASK ===',
    `Checkpoint from: ${checkpoint.checkpoint.createdAt}`,
    `Original objective: ${task.contract.objective}`,
    `Harness: ${task.contract.harnessProfile}`,
    `Roles already executed: ${checkpoint.checkpoint.completedWorkerIds.join(', ') || 'none'}`,
  ];
  const scout = task.runtime?.scoutDecision;
  if (scout) {
    lines.push('', '--- Scout findings (already complete) ---');
    if (scout.summary) lines.push(`Summary: ${scout.summary}`);
    if (scout.harnessRationale) lines.push(`Harness rationale: ${scout.harnessRationale}`);
    if (scout.scope && scout.scope.length > 0) {
      lines.push(`Scope: ${scout.scope.join(', ')}`);
    }
    if (scout.reviewFilesOrAreas && scout.reviewFilesOrAreas.length > 0) {
      lines.push(`Review files/areas: ${scout.reviewFilesOrAreas.join(', ')}`);
    }
    if (scout.executionObligations && scout.executionObligations.length > 0) {
      lines.push('Execution obligations:');
      for (const ob of scout.executionObligations) lines.push(`  - ${ob}`);
    }
  }
  const contract = task.contract.contractSummary;
  if (contract) {
    lines.push('', '--- Contract (already produced) ---');
    lines.push(contract);
    if (task.contract.successCriteria.length > 0) {
      lines.push('Success criteria:');
      for (const c of task.contract.successCriteria) lines.push(`  - ${c}`);
    }
  }
  if (task.verdict?.summary) {
    lines.push('', '--- Last verdict ---');
    lines.push(`Status: ${task.verdict.status}`);
    lines.push(`Summary: ${task.verdict.summary}`);
  }
  lines.push(
    '',
    'Use this preserved context to avoid redundant investigation. Continue the work from where it was interrupted.',
    '=== END RESUME CONTEXT ===',
    '',
  );
  return lines.join('\n');
}

/**
 * H1 structural resume seed (v0.7.26) — reconstruct recorder slots, harness
 * tier, budget, and the agent entry-point from a validated checkpoint.
 *
 * Legacy `resumeManagedTask` synthesised a `ManagedTaskScoutDirective`
 * from `managedTask.runtime.scoutDecision`, applied it to the plan, then
 * filtered out `completedWorkerIds` so the resumed round skipped
 * already-completed workers. The Runner-driven path equivalent:
 *
 *   1. If Scout completed, re-emit the captured Scout directive into the
 *      recorder so `rolePromptContextFactory` → `previousRoleSummaries`
 *      + `scoutScope` still reach downstream roles.
 *   2. If the saved harness is H2 and `contract.contractSummary` is set,
 *      also seed the contract slot so the Planner turn can be skipped.
 *   3. Pick the entry agent based on which slots are seeded:
 *        - no scout      → scout (plain restart with preamble context)
 *        - scout + H0    → scout (re-emit H0 with saved findings)
 *        - scout + H1    → generator
 *        - scout + H2, no contract → planner
 *        - scout + H2 + contract  → generator
 *   4. Carry forward the harness tier + budget so budget caps + role-
 *      specific tool allow-lists are correct from turn 1. Budget spent is
 *      reset — the LLM is starting a fresh turn even if logically
 *      resuming, so old spend shouldn't eat into the new run's envelope.
 *
 * Handoff and verdict slots are deliberately NOT seeded: the legacy
 * resume also didn't replay them (it re-ran the terminal round). This
 * keeps the semantics simple — resume picks up at the last *role* that
 * needs to run, not at a specific revise-cycle iteration inside the
 * Evaluator loop.
 */
interface StructuralResumeSeed {
  readonly recorderSlots: {
    readonly scout?: ProtocolEmitterMetadata;
    readonly contract?: ProtocolEmitterMetadata;
  };
  readonly harness: KodaXHarnessProfile;
  readonly rolesEmitted: readonly KodaXTaskRole[];
  readonly startingRole: 'scout' | 'planner' | 'generator';
}

function buildStructuralResumeSeed(validated: ValidatedCheckpoint): StructuralResumeSeed {
  const task = validated.managedTask;
  const checkpoint = validated.checkpoint;
  const scoutDecision = task.runtime?.scoutDecision;
  const harness: KodaXHarnessProfile = task.contract.harnessProfile ?? 'H0_DIRECT';

  const recorderSlots: { scout?: ProtocolEmitterMetadata; contract?: ProtocolEmitterMetadata } = {};
  const rolesEmitted: KodaXTaskRole[] = [];

  if (checkpoint.scoutCompleted && scoutDecision) {
    const scoutPayload: Partial<KodaXManagedProtocolPayload> = {
      scout: {
        summary: scoutDecision.summary,
        scope: scoutDecision.scope ?? [],
        requiredEvidence: scoutDecision.requiredEvidence ?? [],
        reviewFilesOrAreas: scoutDecision.reviewFilesOrAreas,
        evidenceAcquisitionMode: scoutDecision.evidenceAcquisitionMode,
        confirmedHarness: scoutDecision.recommendedHarness,
        harnessRationale: scoutDecision.harnessRationale,
        blockingEvidence: scoutDecision.blockingEvidence,
        directCompletionReady: scoutDecision.directCompletionReady,
        skillMap: scoutDecision.skillSummary
          ? {
            skillSummary: scoutDecision.skillSummary,
            executionObligations: scoutDecision.executionObligations ?? [],
            verificationObligations: scoutDecision.verificationObligations ?? [],
            ambiguities: scoutDecision.ambiguities ?? [],
            projectionConfidence: scoutDecision.projectionConfidence,
          }
          : undefined,
      },
    };
    const { handoffTarget, isTerminal } = resolveHandoffTarget('scout', scoutPayload);
    recorderSlots.scout = {
      role: 'scout',
      payload: scoutPayload,
      handoffTarget,
      isTerminal,
    };
    rolesEmitted.push('scout');
  }

  const contractSummary = task.contract.contractSummary;
  if (
    harness === 'H2_PLAN_EXECUTE_EVAL'
    && contractSummary
    && contractSummary.trim().length > 0
  ) {
    const contractPayload: Partial<KodaXManagedProtocolPayload> = {
      contract: {
        summary: contractSummary,
        successCriteria: task.contract.successCriteria ?? [],
        requiredEvidence: task.contract.requiredEvidence ?? [],
        constraints: task.contract.constraints ?? [],
      },
    };
    const { handoffTarget, isTerminal } = resolveHandoffTarget('planner', contractPayload);
    recorderSlots.contract = {
      role: 'planner',
      payload: contractPayload,
      handoffTarget,
      isTerminal,
    };
    rolesEmitted.push('planner');
  }

  let startingRole: 'scout' | 'planner' | 'generator' = 'scout';
  if (recorderSlots.scout) {
    if (harness === 'H0_DIRECT') {
      startingRole = 'scout';
    } else if (harness === 'H1_EXECUTE_EVAL') {
      startingRole = 'generator';
    } else {
      startingRole = recorderSlots.contract ? 'generator' : 'planner';
    }
  }

  return { recorderSlots, harness, rolesEmitted, startingRole };
}

/**
 * Shard 6c: write a crash-safe checkpoint after each role transition.
 * Allows legacy tools and future resume logic to inspect partial state.
 */
async function writeCurrentCheckpoint(args: {
  readonly options: KodaXOptions;
  readonly managedTask: KodaXManagedTask;
  readonly currentRound: number;
  readonly completedWorkerIds: readonly string[];
  readonly scoutCompleted: boolean;
}): Promise<string | undefined> {
  const { options, managedTask, currentRound, completedWorkerIds, scoutCompleted } = args;
  try {
    const surface = getManagedTaskSurface(options);
    const workspaceRoot = getManagedTaskWorkspaceRoot(options, surface);
    const workspaceDir = path.join(workspaceRoot, managedTask.contract.taskId);
    const gitCommit = (await getGitHeadCommit(options.context?.gitRoot)) ?? 'unknown';
    const checkpoint: ManagedTaskCheckpoint = {
      version: 1,
      taskId: managedTask.contract.taskId,
      createdAt: managedTask.contract.createdAt,
      gitCommit,
      objective: managedTask.contract.objective,
      harnessProfile: managedTask.contract.harnessProfile,
      currentRound,
      completedWorkerIds: [...completedWorkerIds],
      scoutCompleted,
    };
    await writeCheckpoint(workspaceDir, checkpoint);
    return workspaceDir;
  } catch {
    // Checkpoint write is best-effort — failures should not abort the run.
    return undefined;
  }
}

/**
 * Internal test surface — exports otherwise-private helpers so the
 * runner-driven test file can exercise them directly without booting a
 * full Runner chain. Only the functions / constants listed here are
 * callable from `*.test.ts`; the rest of the module surface stays
 * encapsulated.
 *
 * Added v0.7.26 Risk-5 to cover:
 *   - H1 revise cap auto-conversion (Risk 2)
 *   - Evaluator explicit `budgetRequest` triggering dialog below 90%
 *     threshold (Risk 3)
 *   - Malformed verdict payload passthrough (existing recorder behaviour)
 */
export const __runnerDrivenTestables = {
  wrapEmitterWithRecorder,
  H1_MAX_SAME_HARNESS_REVISES,
  buildStructuralResumeSeed,
} as const;

export async function runManagedTaskViaRunner(
  options: KodaXOptions,
  prompt: string,
  adapterOverride?: Parameters<typeof buildRunnerLlmAdapter>[1],
  // Shard 6d-L: accept the reasoning plan produced by `createManagedReasoningPlan`
  // in `task-engine.ts`. Optional so direct Runner invocations from tests
  // (or future SDK consumers) still work without constructing a plan.
  plan?: ReasoningPlan,
): Promise<KodaXResult> {
  // FEATURE_103 (v0.7.29): apply L5 user-followup escalation once at the
  // AMA entry. Mirrors the SA `runKodaX` wiring so the bumped ceiling
  // propagates uniformly through createReasoningPlan, buildRunnerLlmAdapter,
  // and the per-iteration L1-L4 resolver inside the Runner loop. When no
  // signal fires, the helper returns the input options reference unchanged.
  const { options: effectiveOptions } = applyFollowupEscalationToOptions(options, prompt);
  // Fire onSessionStart early so REPL / CLI listeners bound to session
  // init trigger for AMA runs the same way they trigger for SA runs.
  const providerName = effectiveOptions.provider ?? 'anthropic';
  const initialSessionId = effectiveOptions.session?.id
    ?? `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (effectiveOptions.events) {
    emitSessionStart(effectiveOptions.events, { provider: providerName, sessionId: initialSessionId });
  }
  try {
    return await runManagedTaskViaRunnerInner(effectiveOptions, prompt, adapterOverride, plan);
  } catch (err) {
    // Surface onError so top-level consumers can flush telemetry /
    // show UI toast before the rejection propagates.
    const error = err instanceof Error ? err : new Error(String(err));
    if (effectiveOptions.events) emitError(effectiveOptions.events, error);
    // v0.7.26 parity (C3): persist an error snapshot so /resume can
    // pick up the last turn even after a crash. Legacy does the same at
    // agent.ts:2824. Best-effort.
    //
    // Inner catch (runManagedTaskViaRunnerInner) attaches the in-flight
    // providerMessages on the thrown error via __kodaxRecoveredMessages
    // so we can persist real history. Without that carrier we used to
    // write `messages: []`, which wiped the user's conversation on any
    // permanent error (e.g., deepseek thinking-mode 400) and made the
    // next prompt start as a fresh session.
    if (effectiveOptions.session?.storage) {
      try {
        const recoveredMessages = (err as { __kodaxRecoveredMessages?: unknown })
          ?.__kodaxRecoveredMessages;
        const messagesToPersist = Array.isArray(recoveredMessages)
          ? (recoveredMessages as KodaXMessage[])
          : [];
        await saveSessionSnapshot(effectiveOptions, initialSessionId, {
          messages: messagesToPersist,
          title: prompt.slice(0, 80),
          gitRoot: effectiveOptions.context?.gitRoot ?? undefined,
          errorMetadata: {
            lastError: error.message,
            lastErrorTime: Date.now(),
            consecutiveErrors: 1,
          },
        });
      } catch {
        // best-effort.
      }
    }
    throw err;
  } finally {
    // onComplete fires on every terminal — success, block, or error —
    // so REPL can re-render its status bar. NOTE: AMA path's
    // onComplete fires in finally (i.e. AFTER onError on the error
    // branch), whereas SA's onComplete is mutually exclusive with
    // onError (CAP-084). This is a pre-FEATURE_100 behavioral
    // divergence preserved deliberately — REPL listeners on the AMA
    // path rely on the universal-cleanup semantics. Future work to
    // unify would touch REPL contract.
    if (effectiveOptions.events) emitComplete(effectiveOptions.events);
  }
}

async function runManagedTaskViaRunnerInner(
  options: KodaXOptions,
  prompt: string,
  adapterOverride: Parameters<typeof buildRunnerLlmAdapter>[1] | undefined,
  plan: ReasoningPlan | undefined,
): Promise<KodaXResult> {
  // F3 parity (v0.7.26) — apply the diff-driven review routing floor so
  // `decision.reviewTarget` / `reviewScale` / diff-driven `primaryTask`
  // reflect the prompt's review surface. Runs before the Agent chain is
  // built so per-role tool policy + prompt overlay + routing-note strip
  // all see the floored decision. This is informational ONLY — never
  // forces a heavier harness (Scout remains the harness authority).
  // Mirrors legacy `task-engine.ts:6536` position.
  //
  // F4 parity — also snapshot the pre-floor decision so
  // `runtime.rawRoutingDecision` / `finalRoutingDecision` /
  // `routingOverrideReason` can be populated on the managed task shape.
  let rawRoutingDecision: KodaXTaskRoutingDecision | undefined;
  let routingOverrideReason: string | undefined;
  // F4 parity — track tool-output truncation so the managed task can
  // surface `runtime.toolOutputTruncated` + `toolOutputTruncationNotes`.
  // The guardrail's `afterTool.rewrite` sets `result.metadata.truncated`
  // which the `toolObserver.onToolResult` hook below harvests.
  const toolTruncationRef: { truncated: boolean; notes: string[] } = {
    truncated: false,
    notes: [],
  };
  if (plan) {
    const floored = applyCurrentDiffReviewRoutingFloor(
      plan,
      prompt,
      options.context?.repoRoutingSignals,
    );
    rawRoutingDecision = floored.rawDecision;
    routingOverrideReason = floored.routingOverrideReason;
    plan = floored.plan;
  }

  // Shard 6c: honour any pre-existing checkpoint before starting. Gated on
  // `askUser` presence — non-interactive contexts (unit tests, SDK
  // consumers without a prompt surface) skip the directory scan entirely.
  //
  // H1 structural resume (v0.7.26) — when the user picks "Resume":
  //   - Prepend a reconstructed preamble onto the prompt so the LLM has
  //     the prior findings in plain text (even structural skips still
  //     include scout's narrative + last verdict for clarity).
  //   - Build a `StructuralResumeSeed` so the recorder can be preseeded
  //     with scout/contract payloads and Runner.run can enter at
  //     planner/generator instead of scout when prior roles are complete.
  let structuralResumeSeed: StructuralResumeSeed | undefined;
  if (options.events?.askUser) {
    const checkpoint = await handlePreRunCheckpoint(options);
    if (checkpoint) {
      const preamble = buildResumePreamble(checkpoint.resumeFrom);
      prompt = `${preamble}\n${prompt}`;
      structuralResumeSeed = buildStructuralResumeSeed(checkpoint.resumeFrom);
    }
  }

  // v0.7.26 C4 parity — resolve the stable taskId + workspaceDir once and
  // reuse them across every `buildManagedTaskPayload` call in this run.
  // Without this each observer snapshot would generate a fresh id and
  // write to a different folder; skill artifacts could not be referenced
  // by a predictable path either. Mirrors legacy `task-engine.ts:2100`.
  const surface = getManagedTaskSurface(options);
  const taskId = `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceDir = path.join(getManagedTaskWorkspaceRoot(options, surface), taskId);
  const skillArtifactPaths = getManagedSkillArtifactPaths(workspaceDir);

  // v0.7.26 C4 parity — best-effort pre-run persistence of the expanded
  // skill content (+ skillMap, which Scout refines after its first emit;
  // see the observer hook below). Matches legacy `task-engine.ts:2311`.
  // Role prompts quote the on-disk paths as a stable source of truth so
  // Generator / Evaluator can reopen the skill without relying on prompt-
  // resident copies.
  const skillArtifactsRef: { current: KodaXTaskEvidenceArtifact[] } = { current: [] };
  const skillInvocationCtx = options.context?.skillInvocation;
  if (skillInvocationCtx) {
    try {
      await mkdir(workspaceDir, { recursive: true });
      const initialSkillArtifacts = await writeManagedSkillArtifacts(
        workspaceDir,
        skillInvocationCtx,
        undefined,
      );
      skillArtifactsRef.current = initialSkillArtifacts;
    } catch {
      // Artifact persistence is best-effort — a filesystem error must not
      // abort the AMA run. The prompt sections still reference the paths
      // (Generator / Evaluator will see "artifact not found" if they
      // actually reopen it).
    }
  }

  // Shard 6b: per-run mutation tracker and budget controller. The tracker
  // lives on baseCtx so coding-tool wrappers (write/edit/bash) can populate
  // it via `recordMutationForTool`; the budget controller lives outside
  // and is threaded explicitly into the tool wrappers + emit wrappers.
  const mutationTracker: ManagedMutationTracker = {
    files: new Map<string, number>(),
    totalOps: 0,
  };
  // baseCtx must carry the full KodaXToolExecutionContext
  // surface that tools expect — without these fields several tool families
  // early-return "... not available" in AMA mode:
  //   - askUser / askUserInput / askUserMulti: ask_user_question,
  //     exit_plan_mode (FEATURE_074) fail silently
  //   - extensionRuntime: all MCP tools (mcp-call / describe / get-prompt /
  //     read-resource / search), web_fetch, web_search, code_search fail
  //   - parentAgentConfig: dispatch_child_task's child-executor falls back
  //     to hardcoded 'anthropic' provider, breaking non-anthropic runs
  //   - reportToolProgress: async-generator tools (dispatch_child_task)
  //     lose their internal progress events
  //   - planModeBlockCheck: child tool calls bypass FEATURE_074 plan-mode
  //     safety boundary
  //   - exitPlanMode: FEATURE_074 exit_plan_mode tool fails
  // CAP-048: build base tool-execution-context via the shared substrate
  // helper so SA and AMA construct ctx through the same path. This
  // delivers two AMA-side regression fixes:
  //   1. `managedProtocolRole` + `emitManagedProtocol` — pre-FEATURE_100
  //      AMA's inline ctx omitted both, so worker tools that called
  //      `ctx.emitManagedProtocol(...)` were no-ops. The substrate
  //      helper wires the closure that mutates the payload ref.
  //   2. FEATURE_074 invariants centralized — set_permission_mode is
  //      explicitly NOT forwarded; FEATURE_067 `onChildProgress: undefined`
  //      is set explicitly. Both contracts now pinned in one helper.
  // The `mutationTracker` field is layered on top because AMA owns its
  // own per-run tracker (substrate has its own).
  const extensionRuntime = options.extensionRuntime;
  const managedProtocolPayloadRef: { current: KodaXManagedProtocolPayload | undefined } = {
    current: undefined,
  };
  const substrateBaseCtx = buildToolExecutionContext({
    options,
    runtime: extensionRuntime,
    managedProtocolPayloadRef,
  });
  const baseCtx: KodaXToolExecutionContext = {
    ...substrateBaseCtx,
    mutationTracker,
  };

  // Budget controller. Start with H0 cap (50); `wrapEmitterWithRecorder`
  // upgrades the cap when Scout confirms a non-H0 tier. Mirrors the
  // legacy `createManagedBudgetController` + Scout-commit bump pattern.
  //
  // H1 structural resume: when a checkpoint seeded a non-H0 harness,
  // start the budget at the saved tier's cap. Spent is reset — the LLM
  // enters a fresh turn on resume, so prior spend shouldn't eat into the
  // new run's envelope (same contract as legacy resumeManagedTask:
  // `createManagedBudgetController` always started at 0).
  const initialHarness: KodaXHarnessProfile = structuralResumeSeed?.harness ?? 'H0_DIRECT';
  const budget: ManagedTaskBudgetController = {
    totalBudget: BUDGET_CAP_BY_HARNESS[initialHarness],
    spentBudget: 0,
    currentHarness: initialHarness,
  };

  const recorder: VerdictRecorder = {};
  if (structuralResumeSeed?.recorderSlots.scout) {
    recorder.scout = structuralResumeSeed.recorderSlots.scout;
  }
  if (structuralResumeSeed?.recorderSlots.contract) {
    recorder.contract = structuralResumeSeed.recorderSlots.contract;
  }
  const harnessRef = { current: initialHarness };
  const rolesRef: { emitted: KodaXTaskRole[] } = {
    emitted: structuralResumeSeed ? [...structuralResumeSeed.rolesEmitted] : [],
  };
  const roundRef = { current: 0 };
  const maxRoundsRef = { current: MAX_ROUNDS_BY_HARNESS[initialHarness] };
  const budgetApprovalRef = { current: false };
  // Shard 6d-R: append-only evidence entries accumulator. Populated from
  // `onRoleEmit` so each role turn contributes exactly one entry to
  // `managedTask.evidence.entries[]`.
  const entriesRef: { items: KodaXTaskEvidenceEntry[] } = { items: [] };
  // Session id reference — propagated from `options.session` so each
  // entry's `sessionId` mirrors legacy (useful for REPL transcript dump
  // + resume flow when reconstructing per-role session lineage).
  const sessionIdRef: { current: string | undefined } = {
    current: options.session?.id,
  };

  // Shard 6c + 6d-N: per-role-emit hook. Two responsibilities:
  //   1. Snapshot write (always on) — mirrors legacy
  //      `writeManagedTaskSnapshotArtifacts` calls after each terminal
  //      worker (task-engine.ts:2405, 6036, 6466, 6532). Persists
  //      `contract.json` / `managed-task.json` / `round-history.json` /
  //      `budget.json` / `memory-strategy.json` / `runtime-contract.json`
  //      / `runtime-execution.md` / `scorecard.json` under
  //      `<workspaceDir>`. Without this the files only exist at terminal
  //      exit; any crash mid-run loses them.
  //   2. Checkpoint write (gated on askUser) — mirrors Shard 6c. Without
  //      an interactive `askUser` callback the user cannot be prompted
  //      to resume, so the checkpoint ledger is dead weight for
  //      non-interactive callers (unit tests, SDK consumers).
  let lastCheckpointWorkspaceDir: string | undefined;
  const checkpointingEnabled = Boolean(options.events?.askUser);
  const checkpointWriter = (role: KodaXTaskRole): void => {
    // v0.7.26 C4 parity — when Scout emits with a freshly derived
    // skillMap, re-persist the skill artefacts so downstream roles and
    // resume consumers can reach the structured map on disk. Best-effort;
    // the artefact paths in the role prompt stay valid even when the
    // re-write fails (the raw skill was written pre-run).
    if (role === 'scout' && skillInvocationCtx) {
      const scoutSkillMap = recorder.scout?.payload.scout?.skillMap;
      // Reconstruct the full KodaXSkillMap shape from Scout's emit payload
      // (which only carries a subset of fields). Missing fields fall back
      // to safe defaults so `writeManagedSkillArtifacts` + downstream
      // consumers render correctly.
      const fullSkillMap = scoutSkillMap
        ? {
            skillSummary: scoutSkillMap.skillSummary ?? '',
            executionObligations: scoutSkillMap.executionObligations ?? [],
            verificationObligations: scoutSkillMap.verificationObligations ?? [],
            requiredEvidence: [],
            ambiguities: scoutSkillMap.ambiguities ?? [],
            projectionConfidence: scoutSkillMap.projectionConfidence ?? 'medium',
            rawSkillFallbackAllowed: true,
          }
        : undefined;
      void writeManagedSkillArtifacts(workspaceDir, skillInvocationCtx, fullSkillMap)
        .then((records) => {
          skillArtifactsRef.current = records;
        })
        .catch(() => undefined);
    }
    const snapshot = buildManagedTaskPayload({
      prompt,
      options,
      recorder,
      rolesEmitted: rolesRef.emitted,
      baseCtx,
      signal: 'COMPLETE',
      budget,
      plan,
      entries: entriesRef.items,
      degradedContinue: degradedContinueRef.current,
      childWriteWorktreePaths: childWriteWorktreePathsRef.current,
      taskId,
      extraArtifacts: skillArtifactsRef.current,
      rawRoutingDecision,
      routingOverrideReason,
      toolOutputTruncated: toolTruncationRef.truncated,
      toolOutputTruncationNotes: toolTruncationRef.notes,
    });
    // Snapshot write — best-effort, must not throw out of the observer
    // callback or we'd abort the Runner mid-emit.
    void writeManagedTaskSnapshotArtifacts(snapshot.evidence.workspaceDir, snapshot)
      .catch(() => undefined);
    if (!checkpointingEnabled) {
      return;
    }
    const scoutCompleted = Boolean(recorder.scout);
    const currentRound = rolesRef.emitted.length;
    void writeCurrentCheckpoint({
      options,
      managedTask: snapshot,
      currentRound,
      completedWorkerIds: rolesRef.emitted.map((r) => r),
      scoutCompleted,
    }).then((dir) => {
      if (dir) lastCheckpointWorkspaceDir = dir;
    });
  };

  const observer = buildObserverBridge(
    options.events,
    harnessRef,
    rolesRef,
    budget,
    roundRef,
    maxRoundsRef,
    budgetApprovalRef,
    entriesRef,
    sessionIdRef,
    checkpointWriter,
  );

  // H3 parity (v0.7.26) — emit the `routing` phase before Scout's
  // preflight. Legacy `task-engine.ts:6545` fired this event right after
  // the routing decision was finalised so the REPL's AMA work-strip could
  // render "AMA routing · <scope>" before Scout starts thinking. Without
  // it, the UI jumped straight to `preflight` and the routing context
  // (review target, repo signals, override reason) was invisible.
  if (plan && options.events?.onManagedTaskStatus) {
    const routingNote = buildRunnerRoutingNote(plan);
    options.events.onManagedTaskStatus({
      agentMode: 'ama',
      harnessProfile: plan.decision.harnessProfile,
      phase: 'routing',
      note: routingNote,
      upgradeCeiling: plan.decision.upgradeCeiling ?? plan.decision.harnessProfile,
      ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
    });
  }

  observer.preflight();

  const planRef = { current: plan };
  // H1 structural resume (v0.7.26) — when scout is pre-seeded from a
  // checkpoint, the observer's `onRoleEmit` path never runs for scout on
  // this turn, so downstream role prompts would otherwise see the pre-
  // scout plan decision (wrong harness, wrong routing notes). Apply the
  // seeded scout payload to the plan immediately so planner/generator/
  // evaluator see the post-scout plan on their first turn. Mirrors the
  // legacy `applyScoutDecisionToPlan` invocation inside
  // `resumeManagedTask`.
  if (structuralResumeSeed?.recorderSlots.scout?.payload.scout && planRef.current) {
    const seededScout = structuralResumeSeed.recorderSlots.scout.payload.scout;
    planRef.current = applyScoutDecisionToPlanRunner(planRef.current, {
      confirmedHarness: seededScout.confirmedHarness,
      harnessRationale: seededScout.harnessRationale,
      summary: seededScout.summary,
    });
  }
  // Shard 6d-U: degraded-continue ref. Flipped by the verdict emitter
  // wrapper when the Evaluator requests an H2 upgrade beyond the plan's
  // `upgradeCeiling`, or when budget-extension approval is denied during
  // revise. Surfaced on `managedTask.runtime.degradedContinue` so the
  // REPL / CLI can warn the user.
  const degradedContinueRef: { current: boolean } = { current: false };
  // Shard 6d-Q: dispatch_child_task write-fan-out ledger. Generator's
  // dispatch invocations populate this map (childId → worktreePath);
  // the Evaluator reads it at verdict time to inject per-child diffs.
  // FEATURE_067 v2 parity.
  const childWriteWorktreePathsRef: { current: Map<string, string> } = {
    current: new Map(),
  };
  // Risk-2 fix — per-harness revise counter. The wrapper mutates this
  // map in place so consecutive Evaluator emits across the same run
  // share state. Initialised empty; first revise of any harness passes
  // through and bumps to 1, second triggers the cap logic.
  const reviseCountByHarnessRef: { current: Map<KodaXHarnessProfile, number> } = {
    current: new Map(),
  };
  const budgetExtension: BudgetExtensionContext = {
    events: options.events,
    originalTask: prompt,
    roundRef,
    maxRoundsRef,
    budgetApprovalRef,
    planRef,
    degradedContinueRef,
    harnessRef,
    reviseCountByHarnessRef,
  };
  const tokenStateRef: { current: RunnerAdapterTokenState } = {
    current: { totalTokens: 0, source: 'estimate' },
  };
  // Build the full role-prompt context so every role's
  // system prompt carries the full surface (decision summary + contract
  // + metadata + verification + tool policy + evidence strategies +
  // dispatch_child_task guidance + H0/H1/H2 quality framework +
  // handoff/verdict/contract block specs). The context factory closes over
  // the recorder so Scout's post-emit `skillMap` / `scope` reach
  // downstream Generator / Evaluator prompts at invocation time.
  // v0.7.26 NEW-1 — resolve workspace environment once so every role
  // prompt can tell the LLM where it is running. The SA path injects
  // `Working Directory: ${executionCwd}` via `buildSystemPrompt`, but
  // the Runner-driven path bypasses that builder. Without this block,
  // Scout/Planner/Generator/Evaluator all guess paths (e.g. the
  // reported `cd /d/user/kodax/workspace` against a real cwd of
  // `C:\Works\GitWorks\...`).
  const managedWorkspace = {
    executionCwd: resolveExecutionCwd(options.context),
    gitRoot: options.context?.gitRoot ?? undefined,
    platform: process.platform,
    osRelease: os.release(),
    // Forward the active provider/model so each role's `## Environment`
    // block discloses runtime identity. Mirrors the runtime-fact section
    // the SA path emits via `buildSystemPrompt`'s `getRuntimeFact`.
    provider: options.provider,
    model: options.modelOverride ?? options.model,
  };
  const rolePromptContextFactory: RolePromptContextFactory = (role, currentRecorder) => {
    const scoutPayload = currentRecorder.scout?.payload.scout;
    const ctx: ManagedRolePromptContext = {
      originalTask: prompt,
      workspace: managedWorkspace,
    };
    // v0.7.26 C4 parity — surface the caller's skill invocation + the
    // on-disk artefact paths so role prompts can quote a stable filesystem
    // location (skill-execution.md / skill-map.md). Matches legacy
    // `task-engine.ts:withManagedSkillArtifactPromptPaths`.
    if (skillInvocationCtx) {
      ctx.skillInvocation = skillInvocationCtx;
      ctx.skillExecutionArtifactPath = skillArtifactPaths.rawSkillPath;
      ctx.skillMapArtifactPath = skillArtifactPaths.skillMapMarkdownPath;
    }
    if (scoutPayload?.skillMap) {
      // The scout emit payload carries a subset of KodaXSkillMap fields
      // (skill_summary, execution_obligations, verification_obligations,
      // ambiguities, projection_confidence). Fill the remaining fields
      // with safe defaults so `formatSkillMapSection` renders correctly.
      ctx.skillMap = {
        skillSummary: scoutPayload.skillMap.skillSummary ?? '',
        executionObligations: scoutPayload.skillMap.executionObligations ?? [],
        verificationObligations: scoutPayload.skillMap.verificationObligations ?? [],
        requiredEvidence: [],
        ambiguities: scoutPayload.skillMap.ambiguities ?? [],
        projectionConfidence: scoutPayload.skillMap.projectionConfidence ?? 'medium',
        rawSkillFallbackAllowed: true,
      };
    }
    // Scout's scope hints are only relevant to post-Scout roles (Issue 119).
    // v0.7.26 loop-fix: also carry `confirmedHarness` so downstream
    // `inferScoutMutationIntent` calls can recognise execute harnesses
    // and stop misclassifying "review primaryTask + empty scope" as
    // review-only when Scout actually picked H1_EXECUTE_EVAL or
    // H2_PLAN_EXECUTE_EVAL.
    if (role !== 'scout') {
      const scope = scoutPayload?.scope ?? [];
      const reviewFilesOrAreas = scoutPayload?.reviewFilesOrAreas ?? [];
      const confirmedHarness = scoutPayload?.confirmedHarness;
      if (scope.length > 0 || reviewFilesOrAreas.length > 0 || confirmedHarness) {
        ctx.scoutScope = {
          scope: [...scope],
          reviewFilesOrAreas: [...reviewFilesOrAreas],
          confirmedHarness,
        };
      }
    }
    // M1 parity (v0.7.26) — populate `previousRoleSummaries` from the
    // recorder so each downstream role sees a distilled summary of what
    // the prior roles produced. Legacy carried this via
    // `ManagedWorkerSessionStorage`, where per-worker state accumulated
    // across rounds. Runner-driven doesn't have that storage; as a
    // minimum faithful port, synthesise each `KodaXRoleRoundSummary`
    // directly from the recorder's captured emit payloads so
    // role-prompt's `previousRoleSummarySection` stops being empty.
    if (role !== 'scout') {
      const summaries: Partial<Record<KodaXTaskRole, KodaXRoleRoundSummary>> = {};
      const nowIso = new Date().toISOString();
      if (currentRecorder.scout?.payload.scout) {
        const s = currentRecorder.scout.payload.scout;
        summaries.scout = {
          role: 'scout',
          round: 1,
          objective: 'Investigate task scope and confirm harness tier',
          confirmedConclusions: [
            s.summary ? `Summary: ${s.summary}` : undefined,
            s.confirmedHarness ? `Confirmed harness: ${s.confirmedHarness}` : undefined,
          ].filter((v): v is string => Boolean(v)),
          unresolvedQuestions: [],
          nextFocus: Array.isArray(s.scope) ? [...s.scope] : [],
          summary: s.summary ?? '',
          updatedAt: nowIso,
        };
      }
      if (currentRecorder.contract?.payload.contract && role !== 'planner') {
        const c = currentRecorder.contract.payload.contract;
        summaries.planner = {
          role: 'planner',
          round: 1,
          objective: 'Produce the H2 execution contract',
          confirmedConclusions: c.summary ? [c.summary] : [],
          unresolvedQuestions: [],
          nextFocus: Array.isArray(c.successCriteria) ? [...c.successCriteria] : [],
          summary: c.summary ?? '',
          updatedAt: nowIso,
        };
      }
      if (currentRecorder.handoff?.payload.handoff && role === 'evaluator') {
        const h = currentRecorder.handoff.payload.handoff;
        summaries.generator = {
          role: 'generator',
          round: 1,
          objective: 'Execute the task per the handoff',
          confirmedConclusions: h.summary ? [h.summary] : [],
          unresolvedQuestions: Array.isArray(h.followup) ? [...h.followup] : [],
          nextFocus: [],
          summary: h.summary ?? '',
          updatedAt: nowIso,
        };
      }
      if (Object.keys(summaries).length > 0) {
        ctx.previousRoleSummaries = summaries;
      }
    }
    return ctx;
  };
  // Pre-compute the repo-intelligence context block once per
  // Runner-driven entry so every role's system prompt carries repo
  // overview + changed scope + active module + impact metadata from
  // turn 1. Best-effort: failure to build must not fail the run.
  //
  // `isNewSession` mirrors the `messages.length === 1` heuristic used by
  // `runKodaX` at agent.ts:2423 — when the session has no prior messages,
  // we're on the user's first turn and want the full repo overview.
  let prebuiltRepoIntelligenceContext: string | undefined;
  if (plan) {
    const isNewSessionRunner = !options.session?.initialMessages
      || options.session.initialMessages.length === 0;
    try {
      prebuiltRepoIntelligenceContext = await buildAutoRepoIntelligenceContext(
        options,
        plan,
        isNewSessionRunner,
        options.events,
      );
    } catch {
      // Swallow — repo-intel injection is best-effort; the run must
      // continue even if repo-intel capture fails.
    }
  }

  const chainPromptContext: RunnerChainPromptContext | undefined = plan
    ? {
      prompt,
      // M4 parity — resolve decision from planRef at invocation time so
      // post-Scout plan updates (applyScoutDecisionToPlanRunner) reach
      // downstream Generator / Evaluator prompts. Without the thunk, the
      // captured `plan.decision` would keep pre-Scout harness / routing
      // notes and leak H2-only prompt guidance into H1 workers.
      decision: () => planRef.current?.decision ?? plan.decision,
      metadata: options.context?.taskMetadata,
      repoIntelligenceContext: prebuiltRepoIntelligenceContext,
      // P1 parity — per-role tool policy computed lazily so Generator
      // can see Scout's mutation intent after emit. Legacy routed this
      // through `buildManagedWorkerToolPolicy` per role; the Runner-driven
      // path needs the same branching to keep the "## Tool Policy"
      // section in each worker's system prompt (allow-lists, shell
      // patterns, docs-only write boundary).
      //
      // M4 parity extension — also read the current plan via `planRef`
      // so the Generator's H1 review-only / docs-scoped branch triggers
      // off Scout's post-decision harness + primaryTask, not the stale
      // pre-Scout snapshot.
      toolPolicyFactory: (role, currentRecorder) => {
        const currentDecision = planRef.current?.decision ?? plan.decision;
        return buildManagedWorkerToolPolicy(
          role,
          options.context?.taskVerification,
          currentDecision.harnessProfile,
          inferScoutMutationIntent(
            {
              scope: currentRecorder.scout?.payload.scout?.scope,
              reviewFilesOrAreas: currentRecorder.scout?.payload.scout?.reviewFilesOrAreas,
            },
            currentDecision.primaryTask,
            currentRecorder.scout?.payload.scout?.confirmedHarness,
          ),
          options.context?.repoIntelligenceMode,
        );
      },
      contextFactory: rolePromptContextFactory,
    }
    : undefined;
  const chain = buildRunnerAgentChain(
    baseCtx,
    recorder,
    observer,
    budget,
    budgetExtension,
    planRef,
    options.context?.taskVerification,
    childWriteWorktreePathsRef,
    chainPromptContext,
    options.events,
  );
  // FEATURE_078: provide a callback that surfaces Scout's
  // `downstream_reasoning_hint` to the per-role adapter. Read lazily —
  // Scout's payload only populates after Scout's own turn returns, so
  // the callback closes over `recorder` and reads on each adapter call.
  const llm = buildRunnerLlmAdapter(
    options,
    adapterOverride,
    tokenStateRef,
    () => recorder.scout?.payload.scout?.downstreamReasoningHint,
  );

  // Shard 6d-L: stitch `plan.promptOverlay` (the routing-notes block
  // `createReasoningPlan` produces — task-family guidance, work intent,
  // brainstorm directives, provider-policy notes, explicit-reason trail)
  // onto the user prompt so Scout/Planner/Generator/Evaluator receive the
  // same contextual overlay legacy workers did. Keeping the overlay as a
  // prompt prefix rather than a system-prompt injection matches the
  // legacy `buildPromptOverlay` output shape, which Scout expects as
  // free-text routing notes at the top of the task prompt.
  const promptOverlay = plan?.promptOverlay?.trim();
  const promptWithOverlay = promptOverlay
    ? `${promptOverlay}\n\n---\n\n${prompt}`
    : prompt;

  // Session continuity: when the caller passes `options.session.initialMessages`
  // (REPL multi-turn, session resume, plan-mode replay), prepend them as the
  // Runner transcript so the Scout/Planner/Generator/Evaluator see full
  // prior context — same behaviour as the SA-mode entry via the session
  // loader.
  //
  // v0.7.26 parity (C1): the user message content is built through
  // `buildPromptMessageContent(prompt, inputArtifacts)` so images pasted
  // /dragged into the REPL (carried on `options.context.inputArtifacts`)
  // reach the Scout turn as multimodal content blocks. Without this the
  // LLM sees a plain-text prompt and never perceives the image —
  // round-boundary reshape only rewrites outgoing `result.messages` for
  // display, not the inbound prompt — apply the lift here so the AMA
  // entry message carries multimodal blocks like the SA entry does.
  //
  // CAP-008: resolve initial messages through the substrate helper so AMA
  // gets the same three-tier resolution SA gets:
  //   1. caller-supplied `options.session.initialMessages` (REPL multi-turn,
  //      plan-mode replay, explicit resume) — preferred
  //   2. `options.session.storage.load(sessionId)` — recover a previously
  //      persisted session (`/resume <id>` / `--continue`) when no inline
  //      messages were provided. Pre-FEATURE_100 the AMA path skipped this
  //      tier and started fresh; substrate parity restores it.
  //   3. empty messages — first turn / unknown session
  const resolvedInitial = await resolveInitialMessages(options, options.session?.id);
  const userMessageContent = buildPromptMessageContent(
    promptWithOverlay,
    options.context?.inputArtifacts,
  );
  const runnerInput = resolvedInitial.messages.length > 0
    ? [...resolvedInitial.messages, { role: 'user' as const, content: userMessageContent }]
    : [{ role: 'user' as const, content: userMessageContent }];

  // Load the compaction hook once per run. `intelligentCompact` runs
  // before every provider.stream call; the Runner-driven path routes
  // it through Runner's
  // `compactionHook` (fired after each tool-result append). Without this
  // wiring, long AMA sessions hit context window overflow and 400.
  const compactionHook = await buildManagedTaskCompactionHook(options);

  // H1 structural resume: when a checkpoint seeded the recorder with a
  // completed scout (and optionally contract), skip straight to the
  // first unfinished role. The role-prompt factory reads the seeded
  // recorder slots so planner/generator/evaluator see `scoutScope` +
  // `previousRoleSummaries` on turn 1, matching what they'd see mid-run.
  const entryAgent: Agent = structuralResumeSeed
    ? (structuralResumeSeed.startingRole === 'generator'
      ? chain.generator
      : structuralResumeSeed.startingRole === 'planner'
        ? chain.planner
        : chain.scout)
    : chain.scout;
  const runResult = await Runner.run(entryAgent, runnerInput, {
    llm,
    abortSignal: options.abortSignal,
    compactionHook,
    // Register the tool-result truncation guardrail so every tool
    // invocation flows through the same post-execute size policy
    // the SA-mode substrate applies (via
    // `applyToolResultGuardrail`). Without it the LLM sees raw
    // unbounded tool output, blowing the context window on read/grep
    // of large files. The guardrail is authored in
    // `tools/tool-result-truncation-guardrail.ts` and participates in
    // the core Guardrail lifecycle (Span emission + declaration-order
    // composition).
    guardrails: [createToolResultTruncationGuardrail(baseCtx)],
    // Surface Runner tool-loop invocations through the
    // KodaXEvents channels the worker ledger consumes. Without this
    // wiring the REPL worker ledger stays empty mid-run — only the final
    // formal output reaches the user (observed regression report:
    // "除了正式输出之外的任何别的信息都看不到"). Legacy agent.ts fired
    // events.onToolResult at three sites per invocation (success / error
    // / cancelled); the Runner observer maps 1:1 onto
    // `onToolUseStart` + `onToolResult` here.
    toolObserver: {
      // CAP-010 tri-state permission gate: plan-mode / accept-edits /
      // extension "tool:before" hooks run here. Delegates to the
      // shared substrate helper so SA and AMA evaluate the same gate
      // chain — pre-FEATURE_100 the AMA path only invoked
      // `events.beforeToolExecute` and dropped the extension
      // `tool:before` branch entirely; substrate parity restores it.
      // Tri-state contract preserved verbatim: undefined → allow;
      // CANCELLED_TOOL_RESULT_MESSAGE → cancel; other string → block
      // with that string as the synthesized tool_result content.
      beforeTool: options.events
        ? async (call) => {
          const override = await getToolExecutionOverride(
            options.events!,
            call.name,
            call.input,
            call.id,
            options.context?.executionCwd,
            options.context?.gitRoot ?? undefined,
          );
          if (override === undefined) return true;
          if (override === CANCELLED_TOOL_RESULT_MESSAGE) return false;
          return override;
        }
        : undefined,
      onToolCall: (call) => {
        // CAP-035: filter internal control-plane tools (emit_managed_protocol,
        // etc.) so REPL transcript doesn't surface them. Pre-FEATURE_100
        // AMA emitted every tool call regardless of visibility — REPL
        // showed `emit_managed_protocol` invocations as if they were
        // user-facing. SA always filtered via isVisibleToolName; AMA now
        // does too.
        if (!isVisibleToolName(call.name)) return;
        options.events?.onToolUseStart?.({
          name: call.name,
          id: call.id,
          input: call.input,
        });
      },
      onToolResult: (call, result) => {
        // F4 parity — track whether any tool result was truncated by the
        // tool-result-truncation guardrail. `result.metadata.truncated`
        // is set by the guardrail's rewrite step. Observed values feed
        // into `runtime.toolOutputTruncated` / `toolOutputTruncationNotes`.
        const meta = result.metadata as { truncated?: boolean; policy?: unknown } | undefined;
        if (meta?.truncated) {
          toolTruncationRef.truncated = true;
          toolTruncationRef.notes.push(
            `${call.name}: result was truncated to guardrail policy`,
          );
        }
        // CAP-035: same visibility filter on the result side.
        if (!isVisibleToolName(call.name)) return;
        options.events?.onToolResult?.({
          id: call.id,
          name: call.name,
          content: result.content,
        });
      },
    },
    // Iteration cap for the entire Scout → (Planner) → Generator → Evaluator
    // chain. Core's default (20) is meant for stand-alone single-agent runs
    // and is far too low for a multi-role investigation + execution + verify
    // chain. This is a hard SAFETY ceiling — the real throttle is the
    // budget controller (H0=100 / H1=H2=200 base, +100/+200 on 90%-threshold
    // user approval). A 500-turn ceiling allows 2-3 extensions plus ample
    // room for tool-heavy iterations (each LLM turn can carry multiple
    // parallel tool calls). The budget-extension dialog (Shard 6b) catches
    // the user at the 90% threshold long before this cap, so reaching 500
    // genuinely indicates a prompt / tool-design bug worth flagging.
    maxToolLoopIterations: 500,
  });

  const lastText = extractUserFacingText(runResult);
  const { signal, verdictStatus, reason, userAnswer } = deriveFinalStatus(recorder);

  // Evaluator's user_answer may carry internal role
  // framing ("I verified the Generator…", "Let me double-check…") even
  // after the fence sanitizer runs. Strip that framing specifically for
  // review-like tasks where the evaluator was told to speak as the
  // reviewer, not about the review process. For non-review tasks, still
  // run the lighter sanitizer to drop control-plane markers + fences.
  const sanitizedUserAnswer = userAnswer
    ? (plan?.decision.primaryTask === 'review'
      ? sanitizeEvaluatorPublicAnswer(userAnswer)
      : sanitizeManagedUserFacingText(userAnswer))
    : undefined;

  // Prefer the verdict's explicit user_answer over the final transcript
  // text when the Evaluator provided one — it's the intentional final
  // answer, while transcript text may be any last assistant turn.
  const resolvedText = sanitizedUserAnswer && sanitizedUserAnswer.trim().length > 0
    ? sanitizedUserAnswer
    : lastText;

  const managedProtocolPayload = buildManagedProtocolPayload(recorder);
  const managedTask = buildManagedTaskPayload({
    prompt,
    options,
    recorder,
    rolesEmitted: rolesRef.emitted,
    baseCtx,
    signal,
    verdictStatus,
    userAnswer,
    budget,
    plan,
    entries: entriesRef.items,
    degradedContinue: degradedContinueRef.current,
    childWriteWorktreePaths: childWriteWorktreePathsRef.current,
    taskId,
    extraArtifacts: skillArtifactsRef.current,
    rawRoutingDecision,
    routingOverrideReason,
    toolOutputTruncated: toolTruncationRef.truncated,
    toolOutputTruncationNotes: toolTruncationRef.notes,
  });

  observer.completed(signal, reason ?? userAnswer);

  // Shard 6d-k: Scout suspicious-completion detection (legacy
  // task-engine.ts:4844). When harness is H0_DIRECT and Scout did not
  // declare an explicit completion signal, the harness inspects the
  // final transcript + mutation tracker + budget and surfaces
  // `onScoutSuspiciousCompletion` for the REPL to render an "uncertain"
  // warning. This is a passive signal — we do not change the verdict,
  // only annotate it.
  if (harnessRef.current === 'H0_DIRECT') {
    // Shard 6d-M: infer the mutation intent from Scout's emitted scope
    // list instead of reading a self-declared field. This matches legacy
    // `inferScoutMutationIntent` (Issue 119) — Scout's scope IS the
    // evidence.
    const scoutMutationIntent = recorder.scout
      ? inferScoutMutationIntent(
          {
            scope: recorder.scout.payload.scout?.scope,
            reviewFilesOrAreas: recorder.scout.payload.scout?.reviewFilesOrAreas,
          },
          plan?.decision.primaryTask,
          recorder.scout.payload.scout?.confirmedHarness,
        )
      : undefined;
    const budgetExhausted = budget.totalBudget > 0 && budget.spentBudget >= budget.totalBudget;
    const suspiciousSignals = detectScoutSuspiciousSignals({
      messages: runResult.messages,
      lastText: resolvedText,
      hasScoutPayload: Boolean(recorder.scout),
      scoutMutationIntent,
      mutationTracker,
      budgetExhausted,
    });
    if (suspiciousSignals.length > 0) {
      options.events?.onScoutSuspiciousCompletion?.({
        confidence: 'uncertain',
        signals: suspiciousSignals,
        sessionId: runResult.sessionId,
        lastTextPreview: (resolvedText ?? '').slice(0, SUSPICIOUS_LAST_TEXT_PREVIEW_LIMIT),
      });
    }
  }

  // Shard 6c: delete checkpoint on successful or blocked terminal exit.
  // (Blocked is still "the task concluded" from the checkpoint perspective
  // — the user saw a definitive answer, not an interrupted run.)
  if (lastCheckpointWorkspaceDir) {
    try {
      await deleteCheckpoint(lastCheckpointWorkspaceDir);
    } catch {
      // best-effort cleanup; stale checkpoints will be handled by
      // handlePreRunCheckpoint on the next run.
    }
  }

  // Populate contextTokenSnapshot so the REPL token-counter UI can
  // refresh when the run completes. `baselineEstimatedTokens` stays
  // equal to currentTokens when the provider returned usage — the REPL
  // uses the delta only to adjust subsequent local estimates.
  const tokenState = tokenStateRef.current;
  const contextTokenSnapshot =
    tokenState.source === 'api'
      ? {
          currentTokens: tokenState.totalTokens,
          baselineEstimatedTokens: tokenState.totalTokens,
          source: 'api' as const,
          usage: tokenState.lastUsage,
        }
      : undefined;

  const result: KodaXResult = {
    success: verdictStatus !== 'blocked',
    lastText: resolvedText,
    signal,
    signalReason: reason,
    messages: [...runResult.messages],
    sessionId: runResult.sessionId ?? `runner-${Date.now()}`,
    managedProtocolPayload,
    managedTask,
    contextTokenSnapshot,
    // Shard 6d-L: surface the reasoning plan's routing decision so
    // downstream consumers (REPL breadcrumb, session storage, evaluator
    // guardrails) can read `routingDecision.primaryTask` /
    // `.mutationSurface` / `.taskFamily` the same way they did on the
    // legacy path.
    routingDecision: plan?.decision,
  };

  // Shard 6d-i: capture task-scoped repo-intelligence snapshots
  // (repo-overview / changed-scope / active-module / impact-estimate /
  // summary.md) into `<workspaceDir>/repo-intelligence/` and merge the
  // resulting `KodaXTaskEvidenceArtifact` records into the task's
  // `evidence.artifacts`. Mirrors legacy `attachManagedTaskRepoIntelligence`
  // (task-engine.ts:4302). Also emits the four-stage
  // `onRepoIntelligenceTrace` events during capture.
  //
  // Best-effort: failure to capture must not fail the task run.
  let managedTaskWithRepoIntel = managedTask;
  try {
    managedTaskWithRepoIntel = await attachManagedTaskRepoIntelligence(options, managedTask);
  } catch {
    // fall through with the unaugmented task.
  }
  // Keep the KodaXResult.managedTask aligned with the augmented copy so
  // downstream consumers read the same artifact set whether they use the
  // REPL managedTask event or the final result payload.
  result.managedTask = managedTaskWithRepoIntel;

  // Shard 6d-h: persist the managed-task snapshot set under the task
  // workspace directory and leave the artifact records already attached
  // to `managedTask.evidence.artifacts` pointing at files that actually
  // exist on disk. Legacy behaviour (`writeManagedTaskArtifacts` at
  // task-engine.ts:5204) — without this, `contract.json` / `managed-
  // task.json` / `result.json` / `round-history.json` / `budget.json` /
  // `memory-strategy.json` / `runtime-contract.json` / `runtime-
  // execution.md` / `scorecard.json` / `continuation.json` are all
  // missing and any downstream consumer that reads artifact paths
  // (resume, harness UI, evaluator reshape) sees a broken ledger.
  //
  // Best-effort: an artifact-write failure (permission denied, disk
  // full) must not fail the task run itself — the in-memory result is
  // still valid.
  try {
    await writeManagedTaskArtifacts(
      managedTaskWithRepoIntel.evidence.workspaceDir,
      managedTaskWithRepoIntel,
      {
        success: result.success,
        lastText: result.lastText,
        sessionId: result.sessionId,
        signal: result.signal,
        signalReason: result.signalReason,
        signalDebugReason: result.signalDebugReason,
      },
    );
  } catch {
    // best-effort; failures should not abort the task run.
  }

  // Persist session snapshot to disk so `/resume <id>` and `--continue`
  // can reload the AMA conversation. The Runner-driven path has a
  // single non-error terminal (here). `saveSessionSnapshot` early-
  // returns when `options.session?.storage` is undefined and absorbs
  // any `storage.save` rejections internally (CAP-013-003 closed in
  // P3.6a), so we don't need a guard or try/catch at this call site.
  //
  // FEATURE_060 Track 2: pass `result.messages` by reference instead of
  // spreading. `result.messages` was already cloned at line 4676 from
  // `runResult.messages`; spreading again here would create a third
  // in-memory copy of the full transcript. `saveSessionSnapshot` does
  // not mutate the passed array (it forwards directly to
  // `storage.save`), so reference-passing is safe.
  await saveSessionSnapshot(options, result.sessionId, {
    messages: result.messages,
    title: prompt.slice(0, 80),
    gitRoot: options.context?.gitRoot ?? undefined,
  });

  return result;
}
