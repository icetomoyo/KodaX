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
import {
  KODAX_ESCALATED_MAX_OUTPUT_TOKENS,
  createCostTracker,
  formatCostReport,
  getSummary as getCostSummary,
  recordUsage as recordCostUsage,
  type CostTracker,
} from '@kodax/ai';
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
  bucketProviderPayloadSize,
  describeTransientProviderRetry,
  emitResilienceDebug,
  estimateProviderPayloadBytes,
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
  type ProtocolEmitterMetadata,
} from '../agents/protocol-emitters.js';
import { toolBash } from '../tools/bash.js';
import { toolEdit } from '../tools/edit.js';
import { toolGlob } from '../tools/glob.js';
import { toolGrep } from '../tools/grep.js';
import { toolRead } from '../tools/read.js';
import { toolWrite } from '../tools/write.js';
import { toolDispatchChildTask } from '../tools/dispatch-child-tasks.js';
import { getToolDefinition } from '../tools/registry.js';
import type {
  KodaXEvents,
  KodaXHarnessProfile,
  KodaXJsonValue,
  KodaXManagedProtocolPayload,
  KodaXManagedTask,
  KodaXManagedTaskPhase,
  KodaXOptions,
  KodaXResult,
  KodaXTaskContract,
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
  writeManagedTaskArtifacts,
  writeManagedTaskSnapshotArtifacts,
} from './_internal/managed-task/artifacts.js';
import { attachManagedTaskRepoIntelligence } from './_internal/managed-task/repo-intelligence.js';
import {
  DOCS_ONLY_WRITE_PATH_PATTERNS,
  enforceShellWriteBoundary,
  enforceWritePathBoundary,
  inferScoutMutationIntent,
  type ScoutMutationIntent,
} from './_internal/managed-task/tool-policy.js';
import {
  SUSPICIOUS_LAST_TEXT_PREVIEW_LIMIT,
  detectScoutSuspiciousSignals,
} from './_internal/managed-task/scout-signals.js';
import { createRolePrompt } from './_internal/managed-task/role-prompt.js';
import type { ManagedRolePromptContext } from './_internal/managed-task/role-prompt-types.js';
import {
  sanitizeEvaluatorPublicAnswer,
  sanitizeManagedUserFacingText,
} from './_internal/managed-task/sanitize.js';
import { buildManagedTaskCompactionHook } from './_internal/managed-task/compaction.js';
import { createToolResultTruncationGuardrail } from '../tools/tool-result-truncation-guardrail.js';
import path from 'node:path';

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
  /** Routing decision from `createReasoningPlan`. */
  readonly decision: KodaXTaskRoutingDecision;
  /** Optional structured task metadata. */
  readonly metadata?: Record<string, KodaXJsonValue>;
  /** Optional tool policy (derived elsewhere; Runner-driven path defaults to undefined). */
  readonly toolPolicy?: KodaXTaskToolPolicy;
  /** Optional role-context factory for skillMap / scoutScope / childWriteReviewPrompt injection. */
  readonly contextFactory?: RolePromptContextFactory;
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
  return createRolePrompt(
    role,
    promptContext.prompt,
    promptContext.decision,
    verification,
    promptContext.toolPolicy,
    agentName,
    promptContext.metadata,
    ctx,
    undefined, // workerId — unused by createRolePrompt body
    false, // isTerminalAuthority — Runner-driven path always runs with Evaluator
  );
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
}

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
        }
        recorder[slot] = result.metadata as unknown as ProtocolEmitterMetadata;
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
          const extensionSummary = slot === 'verdict'
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
              // Legacy parity: `skipped` means "didn't need to ask" (no
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
 * before Scout can commit a verdict. H1/H2 stay at 200 (matching legacy
 * `DEFAULT_MANAGED_WORK_BUDGET`) — those tiers get the budget-extension
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
  readonly notifyChildFanout: (fanoutClass: 'finding-validation' | 'evidence-scan' | 'module-triage') => void;
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
 *     and `false` for transient progress ticks, matching legacy contract
 *   - events[] — inline live-event list, currently one entry per observer
 *     tick so the REPL ticker has something to render
 */
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
    notifyChildFanout: (fanoutClass) => {
      if (!events?.onManagedTaskStatus) return;
      events.onManagedTaskStatus({
        agentMode: 'ama',
        harnessProfile: harnessRef.current,
        currentRound: roundRef.current,
        maxRounds: maxRoundsRef.current,
        upgradeCeiling: harnessRef.current,
        phase: 'worker',
        activeWorkerId: 'child',
        activeWorkerTitle: 'Child agent',
        childFanoutClass: fanoutClass,
        childFanoutCount: 1,
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
      // v0.7.26 parity: attach reportToolProgress per-call so async-generator
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
 * Shell commands that mutate the filesystem / git state. Mirrors the
 * legacy `SHELL_WRITE_PATTERNS` allowlist so verification-only roles
 * (Evaluator) can still use `bash` for read-only checks (ls, cat,
 * git diff, etc.) without silently gaining write capability.
 *
 * Matches on leading command-word boundary — `rm /tmp/foo` blocks
 * but `node rm-stub.js` does not.
 */
const SHELL_MUTATION_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bmv\s/i,
  /\bcp\s+-[a-z]*[rf]/i,
  /\bchmod\s/i,
  /\bchown\s/i,
  /\b(?:>|>>)\s*\S/,
  /\bgit\s+(?:add|commit|push|merge|rebase|reset|checkout\s+[^-]|rm)/i,
  /\bnpm\s+(?:install|publish|update|rm)/i,
  /\bpnpm\s+(?:install|publish|update|rm)/i,
  /\byarn\s+(?:add|publish|remove)/i,
];

/**
 * Wrap a bash tool so verification-only roles (Evaluator) cannot
 * execute shell commands that mutate the filesystem or git state.
 * Mirrors legacy `createToolPolicyHook` behaviour at task-engine.ts
 * ~1915 which blocked `SHELL_WRITE_PATTERNS` on read-only role tool
 * policies. Non-bash tools pass through unchanged.
 */
function wrapReadOnlyBash(bashTool: RunnableTool, roleTitle: string): RunnableTool {
  return {
    ...bashTool,
    execute: async (input, ctx): Promise<RunnerToolResult> => {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      if (command && SHELL_MUTATION_PATTERNS.some((re) => re.test(command))) {
        return {
          content:
            `[Managed Task ${roleTitle}] Shell command blocked because this role is verification-only. ` +
            `Command: ${command.slice(0, 120)}`,
          isError: true,
        };
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
 * `primaryTask`, matching legacy Issue 119 inference. Scout's LLM
 * payload is no longer consulted for this boundary; its scope list is
 * the evidence.
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
): RunnableTool {
  return {
    ...definition,
    execute: async (input: Record<string, unknown>): Promise<RunnerToolResult> => {
      if (budget) incrementManagedBudgetUsage(budget, 1);
      // v0.7.22 parity: fire a fanout status event so the REPL's
      // AmaWorkStrip can render a "Scout/Generator fanning out" badge.
      // Best-effort — the legacy path batched these on LLM emit (count=N),
      // while the Runner path fires per tool call (count=1). Downstream
      // UIs overwrite with the latest.
      observer.notifyChildFanout('evidence-scan');
      // Shallow clone so the managedProtocolRole + registerChildWriteWorktrees
      // callback are local to this invocation. The base ctx stays pristine
      // for parallel dispatches.
      const perCallCtx: KodaXToolExecutionContext = {
        ...baseCtx,
        managedProtocolRole: role,
        registerChildWriteWorktrees: (worktreePaths) => {
          for (const [id, p] of worktreePaths) {
            childWriteWorktreePathsRef.current.set(id, p);
          }
        },
      };
      try {
        const gen = toolDispatchChildTask(input, perCallCtx);
        // Drain the generator. We don't render progress through the
        // Runner's transcript today — legacy surfaced it via
        // `onToolProgress`, which the Runner path exposes on ctx already
        // (inside toolDispatchChildTask → ctx.reportToolProgress?.()).
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
  if (!read || !grep || !glob || !bash || !write || !edit) {
    throw new Error(
      'Runner-driven path: expected core tools (read/grep/glob/bash/write/edit) to be registered',
    );
  }
  return {
    read: wrapCodingToolAsRunnable(read, toolRead, baseCtx, budget, events),
    grep: wrapCodingToolAsRunnable(grep, toolGrep, baseCtx, budget, events),
    glob: wrapCodingToolAsRunnable(glob, toolGlob, baseCtx, budget, events),
    bash: wrapCodingToolAsRunnable(bash, toolBash, baseCtx, budget, events),
    write: wrapCodingToolAsRunnable(write, toolWrite, baseCtx, budget, events),
    edit: wrapCodingToolAsRunnable(edit, toolEdit, baseCtx, budget, events),
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
  // v0.7.26 parity: full role-prompt context (original task, decision,
  // metadata, tool policy, skill / scope factory). When provided, every
  // role's `instructions` resolves through `createRolePrompt` — the
  // v0.7.22 prompt surface (decision summary, contract, metadata,
  // verification contract, tool policy, evidence strategies,
  // dispatch_child_task guidance, H0/H1/H2 quality framework,
  // handoff/verdict/contract block specs, shared closing rules). When
  // absent (test paths), the fallback minimal instructions are used.
  promptContext?: RunnerChainPromptContext,
  // v0.7.26 parity: events bus so coding-tool wrappers can attach
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
  );
  const generatorDispatch = wrapDispatchChildTaskForRole(
    dispatchDefinition,
    ctx,
    'generator',
    budget,
    childWriteWorktreePathsRef,
    observer,
  );

  const scoutEmit = wrapEmitterWithRecorder(emitScoutVerdict, 'scout', recorder, observer, budget);
  const contractEmit = wrapEmitterWithRecorder(emitContract, 'contract', recorder, observer, budget);
  const handoffEmit = wrapEmitterWithRecorder(emitHandoff, 'handoff', recorder, observer, budget);
  const verdictEmit = wrapEmitterWithRecorder(emitVerdict, 'verdict', recorder, observer, budget, budgetExtension);

  type WritableAgent = { -readonly [K in keyof Agent]: Agent[K] };

  // v0.7.26 parity: dynamic role instructions. Every agent's `instructions`
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
      wrapReadOnlyBash(codingTools.bash, 'Scout'),
      // Shard 6d-Q: Scout may dispatch read-only child investigations
      // (evidence scans, repo reconnaissance) in parallel before
      // emitting its verdict. The dispatch tool itself enforces
      // `read_only` in Scout context.
      scoutDispatch,
    ],
    handoffs: undefined,
    reasoning: { default: 'quick', max: 'balanced', escalateOnRevise: false },
  };
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
    tools: [contractEmit, codingTools.read, codingTools.grep, codingTools.glob],
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

export function buildRunnerLlmAdapter(
  options: KodaXOptions,
  overrideStream?: (
    messages: readonly KodaXMessage[],
    tools: readonly KodaXToolDefinition[],
    system: string,
  ) => Promise<{ textBlocks?: readonly { text: string }[]; toolBlocks?: readonly KodaXToolUseBlock[] }>,
  tokenStateRef?: { current: RunnerAdapterTokenState },
): (messages: readonly KodaXMessage[], agent: Agent) => Promise<RunnerLlmResult> {
  // FEATURE_072 parity: the REPL's token-count indicator reads
  // `onIterationEnd` to refresh after each worker LLM turn. Track a
  // monotonically-increasing iteration counter across the entire runner
  // chain so the REPL sees progress for every role's turn.
  let iteration = 0;
  const MAX_ITER_HINT = 20; // matches core/src/runner-tool-loop.ts MAX_TOOL_LOOP_ITERATIONS

  // v0.7.22 parity: cost tracker. Legacy agent.ts:1681 creates one per
  // session and recordUsage after every provider.stream usage payload.
  // REPL /cost reads through `events.getCostReport.current`.
  let costTracker: CostTracker = createCostTracker();
  if (options.events?.getCostReport) {
    options.events.getCostReport.current = () =>
      formatCostReport(getCostSummary(costTracker));
  }

  return async (messages, agent) => {
    const leadingSystem = messages[0]?.role === 'system' ? messages[0] : undefined;
    const system = typeof leadingSystem?.content === 'string' ? leadingSystem.content : '';
    const transcript = leadingSystem ? messages.slice(1) : messages;

    const wireTools: KodaXToolDefinition[] = (agent.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    iteration += 1;
    options.events?.onIterationStart?.(iteration, MAX_ITER_HINT);

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
      let providerMessages: KodaXMessage[] = [...transcript];
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
            options.events?.onTextDelta?.(text);
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
            undefined,
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
          // v0.7.22 parity: dedicated rate-limit event so REPL can render
          // a distinct 429 banner (separate from the generic retry UI).
          // Legacy agent.ts:2064 fires this on the same branch.
          if (decision.reasonCode === 'rate_limit') {
            options.events?.onProviderRateLimit?.(
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
                undefined,
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

          if (decision.action === 'manual_continue' || attempt >= resilienceCfg.maxRetries) {
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
      streamResult = {
        textBlocks: raw.textBlocks,
        toolBlocks: raw.toolBlocks,
        thinkingBlocks: raw.thinkingBlocks,
        usage: raw.usage,
      };
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

    // v0.7.22 parity: record turn usage into the cost tracker so `/cost`
    // reflects AMA spend. Mirrors agent.ts:2205-2213.
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

    // v0.7.22 parity: onStreamEnd fires after the provider finishes the
    // current turn's stream. Legacy agent.ts:2201 / :2687 / :2835 fires
    // this at three terminal points; the Runner-driven adapter funnels
    // every turn through this single return-path.
    options.events?.onStreamEnd?.();

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
    // v0.7.26 parity: forward thinking blocks so
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
  // v0.7.26 parity: strip internal managed control-plane markers and any
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
  const taskId = `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  return {
    contract,
    roleAssignments,
    workItems: [],
    evidence: {
      workspaceDir,
      // Legacy parity (task-engine.ts:4324 + 5084): every managed task
      // advertises a fixed set of 10 snapshot files the writeManagedTaskArtifacts
      // pass is expected to produce. Downstream consumers (`resumeManagedTask`,
      // harness observers, the REPL transcript dump) index evidence by
      // artifact path, so we surface the records here even when the actual
      // files are written asynchronously at terminal exit.
      artifacts: buildManagedTaskArtifactRecords(workspaceDir),
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
    },
  };
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
 * Shard 6c: handle a pre-existing checkpoint before the run starts.
 *
 * Legacy behaviour for reference (task-engine.ts:~6644): ask the user
 * whether to continue from checkpoint or restart, then delegate to
 * `resumeManagedTask` on continue. The Runner-driven path cannot (yet)
 * faithfully resume a partial state — the legacy `resumeManagedTask` runs
 * ~700 lines of coupled internal state reconstruction that does not map
 * cleanly to the Agent/Handoff model.
 *
 * For Shard 6c we honour the UX contract (user is informed, dialog fires)
 * but treat every case as a fresh start:
 *   - "restart" → delete stale checkpoint, start fresh.
 *   - "continue" → log a note that resume is not yet wired in the Runner
 *     path; delete the stale checkpoint; start fresh. This is explicit
 *     about the current limitation and avoids silently losing state into
 *     a no-op path.
 *   - no askUser callback or no checkpoint → silently clean up any stale
 *     checkpoint and start fresh.
 *
 * Future work: implement a structural resume — re-seed the recorder with
 * `validated.managedTask.runtime.scoutDecision` etc. and skip past
 * completed roles. See legacy `resumeManagedTask` for the state shape.
 */
async function handlePreRunCheckpoint(options: KodaXOptions): Promise<void> {
  let validated: ValidatedCheckpoint | undefined;
  try {
    validated = await findValidCheckpoint(options);
  } catch {
    return;
  }
  if (!validated) return;

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
    return;
  }

  const useChinese = /[\u4e00-\u9fff]/.test(validated.managedTask.contract.objective ?? '');
  const answer = await options.events.askUser({
    question: useChinese
      ? '发现未完成的任务（Runner 路径暂不支持断点续传）'
      : 'Found incomplete task (Runner path does not yet support resume)',
    options: [
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
    default: 'restart',
  });
  await deleteSafely();
  if (answer === 'cancel') {
    throw new Error('Runner-driven path: user cancelled due to pre-existing checkpoint');
  }
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

export async function runManagedTaskViaRunner(
  options: KodaXOptions,
  prompt: string,
  adapterOverride?: Parameters<typeof buildRunnerLlmAdapter>[1],
  // Shard 6d-L: accept the reasoning plan produced by `createManagedReasoningPlan`
  // in `task-engine.ts`. Optional so direct Runner invocations from tests
  // (or future SDK consumers) still work without constructing a plan.
  plan?: ReasoningPlan,
): Promise<KodaXResult> {
  // v0.7.26 parity: fire onSessionStart early so REPL / CLI listeners
  // bound to session init trigger for AMA runs the same way they trigger
  // for SA runs. Legacy agent.ts:1677 fires this once per runKodaX entry.
  const providerName = options.provider ?? 'anthropic';
  const initialSessionId = options.session?.id
    ?? `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  options.events?.onSessionStart?.({ provider: providerName, sessionId: initialSessionId });
  try {
    return await runManagedTaskViaRunnerInner(options, prompt, adapterOverride, plan);
  } catch (err) {
    // v0.7.22 parity: surface onError so top-level consumers can flush
    // telemetry / show UI toast. Legacy agent.ts:2854 fires this before
    // rethrowing; we keep the same contract.
    const error = err instanceof Error ? err : new Error(String(err));
    options.events?.onError?.(error);
    throw err;
  } finally {
    // v0.7.22 parity: onComplete fires on every terminal — success, block,
    // or error — so REPL can re-render its status bar. Legacy agent.ts
    // fires this at 3 sites (:2249 / :2450 / :2666); we mirror by putting
    // it in finally (fires after onError too — matches legacy order).
    options.events?.onComplete?.();
  }
}

async function runManagedTaskViaRunnerInner(
  options: KodaXOptions,
  prompt: string,
  adapterOverride: Parameters<typeof buildRunnerLlmAdapter>[1] | undefined,
  plan: ReasoningPlan | undefined,
): Promise<KodaXResult> {
  // Shard 6c: honour any pre-existing checkpoint before starting. Gated on
  // `askUser` presence — non-interactive contexts (unit tests, SDK
  // consumers without a prompt surface) skip the directory scan entirely.
  if (options.events?.askUser) {
    await handlePreRunCheckpoint(options);
  }

  // Shard 6b: per-run mutation tracker and budget controller. The tracker
  // lives on baseCtx so coding-tool wrappers (write/edit/bash) can populate
  // it via `recordMutationForTool`; the budget controller lives outside
  // and is threaded explicitly into the tool wrappers + emit wrappers.
  const mutationTracker: ManagedMutationTracker = {
    files: new Map<string, number>(),
    totalOps: 0,
  };
  // v0.7.26 parity: baseCtx must carry the full KodaXToolExecutionContext
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
  // Mirrors `agent.ts:1510-1552` (v0.7.22 ctx construction).
  const extensionRuntime = options.extensionRuntime;
  const baseCtx: KodaXToolExecutionContext = {
    backups: new Map<string, string>(),
    gitRoot: options.context?.gitRoot ?? process.cwd(),
    executionCwd: options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd(),
    extensionRuntime,
    askUser: options.events?.askUser,
    askUserMulti: options.events?.askUserMulti,
    askUserInput: options.events?.askUserInput,
    exitPlanMode: options.events?.exitPlanMode,
    abortSignal: options.abortSignal,
    planModeBlockCheck: options.context?.planModeBlockCheck,
    parentAgentConfig: {
      provider: options.provider,
      model: options.model,
      reasoningMode: options.reasoningMode,
    },
    registerChildWriteWorktrees: options.context?.registerChildWriteWorktrees,
    mutationTracker,
  };

  // Budget controller. Start with H0 cap (50); `wrapEmitterWithRecorder`
  // upgrades the cap when Scout confirms a non-H0 tier. Mirrors the
  // legacy `createManagedBudgetController` + Scout-commit bump pattern.
  const budget: ManagedTaskBudgetController = {
    totalBudget: BUDGET_CAP_BY_HARNESS.H0_DIRECT,
    spentBudget: 0,
    currentHarness: 'H0_DIRECT',
  };

  const recorder: VerdictRecorder = {};
  const harnessRef = { current: 'H0_DIRECT' as KodaXHarnessProfile };
  const rolesRef: { emitted: KodaXTaskRole[] } = { emitted: [] };
  const roundRef = { current: 0 };
  const maxRoundsRef = { current: MAX_ROUNDS_BY_HARNESS.H0_DIRECT };
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
  const checkpointWriter = (_role: KodaXTaskRole): void => {
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

  observer.preflight();

  const planRef = { current: plan };
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
  const budgetExtension: BudgetExtensionContext = {
    events: options.events,
    originalTask: prompt,
    roundRef,
    maxRoundsRef,
    budgetApprovalRef,
    planRef,
    degradedContinueRef,
    harnessRef,
  };
  const tokenStateRef: { current: RunnerAdapterTokenState } = {
    current: { totalTokens: 0, source: 'estimate' },
  };
  // v0.7.26 parity: build the full role-prompt context so every role's
  // system prompt carries the v0.7.22 surface (decision summary + contract
  // + metadata + verification + tool policy + evidence strategies +
  // dispatch_child_task guidance + H0/H1/H2 quality framework +
  // handoff/verdict/contract block specs). The context factory closes over
  // the recorder so Scout's post-emit `skillMap` / `scope` reach
  // downstream Generator / Evaluator prompts at invocation time.
  const rolePromptContextFactory: RolePromptContextFactory = (role, currentRecorder) => {
    const scoutPayload = currentRecorder.scout?.payload.scout;
    const ctx: ManagedRolePromptContext = {
      originalTask: prompt,
    };
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
    if (role !== 'scout') {
      const scope = scoutPayload?.scope ?? [];
      const reviewFilesOrAreas = scoutPayload?.reviewFilesOrAreas ?? [];
      if (scope.length > 0 || reviewFilesOrAreas.length > 0) {
        ctx.scoutScope = { scope: [...scope], reviewFilesOrAreas: [...reviewFilesOrAreas] };
      }
    }
    return ctx;
  };
  const chainPromptContext: RunnerChainPromptContext | undefined = plan
    ? {
      prompt,
      decision: plan.decision,
      metadata: options.context?.taskMetadata,
      // toolPolicy not surfaced on KodaXContextOptions at the top level
      // (it's per-role on KodaXTaskRoleAssignment). The Runner-driven path
      // runs a single chain, so the formatTaskPolicy section stays absent
      // unless later wiring injects a synthesized union policy.
      toolPolicy: undefined,
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
  const llm = buildRunnerLlmAdapter(options, adapterOverride, tokenStateRef);

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
  // prior context — matching legacy `runKodaX` behaviour via the session
  // loader.
  const initialMessages = options.session?.initialMessages ?? [];
  const runnerInput = initialMessages.length > 0
    ? [...initialMessages, { role: 'user' as const, content: promptWithOverlay }]
    : promptWithOverlay;

  // v0.7.26 parity: load the compaction hook once per run. Legacy
  // agent.ts ran `intelligentCompact` before every provider.stream call;
  // the Runner-driven path routes the same logic through Runner's
  // `compactionHook` (fired after each tool-result append). Without this
  // wiring, long AMA sessions hit context window overflow and 400.
  const compactionHook = await buildManagedTaskCompactionHook(options);

  const runResult = await Runner.run(chain.scout, runnerInput, {
    llm,
    abortSignal: options.abortSignal,
    compactionHook,
    // v0.7.26 parity: register the tool-result truncation guardrail so
    // every tool invocation flows through the same post-execute size
    // policy the legacy path applies (agent.ts via
    // `applyToolResultGuardrail`). Without it the LLM sees raw
    // unbounded tool output, blowing the context window on read/grep
    // of large files. The guardrail is authored in
    // `tools/tool-result-truncation-guardrail.ts` and participates in
    // the core Guardrail lifecycle (Span emission + declaration-order
    // composition).
    guardrails: [createToolResultTruncationGuardrail(baseCtx)],
    // v0.7.26 parity: surface Runner tool-loop invocations through the
    // same KodaXEvents channels legacy runManagedTask used. Without this
    // wiring the REPL worker ledger stays empty mid-run — only the final
    // formal output reaches the user (observed regression report:
    // "除了正式输出之外的任何别的信息都看不到"). Legacy agent.ts fired
    // events.onToolResult at three sites per invocation (success / error
    // / cancelled); the Runner observer maps 1:1 onto
    // `onToolUseStart` + `onToolResult` here.
    toolObserver: {
      // v0.7.22 parity: permission gate. plan-mode / accept-edits /
      // extension "tool:before" hooks run here. Legacy agent.ts:810 ran
      // this pre-execute; we preserve the tri-state contract
      // (true/undefined allow, false block generic, string block with
      // custom message).
      beforeTool: options.events?.beforeToolExecute
        ? async (call) => {
          const verdict = await options.events!.beforeToolExecute!(
            call.name,
            call.input,
            { toolId: call.id },
          );
          // KodaXEvents.beforeToolExecute contract: boolean | string.
          // RunnerToolObserver.beforeTool contract: boolean | string | undefined.
          return verdict;
        }
        : undefined,
      onToolCall: (call) => {
        options.events?.onToolUseStart?.({
          name: call.name,
          id: call.id,
          input: call.input,
        });
      },
      onToolResult: (call, result) => {
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

  // v0.7.26 parity: Evaluator's user_answer may carry internal role
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

  return result;
}
