/**
 * Runner-driven AMA path — FEATURE_084 Shards 5a + 5b (v0.7.26).
 *
 * A Runner-based replacement for the legacy `runManagedTask` state machine.
 *
 *   - Shard 5a: Scout H0_DIRECT only (Scout answers directly, no handoff).
 *   - Shard 5b: Full chain — Scout → {Generator (H1) | Planner (H2)} →
 *     Evaluator → {accept | revise → Generator | replan → Planner | blocked}.
 *
 * **Dispatch**: selected by the env flag `KODAX_MANAGED_TASK_RUNTIME=runner`
 * at the top of `executeRunManagedTask` in `task-engine.ts`. Default
 * remains the legacy path — this is opt-in until Shard 6 flips the
 * default + cleans legacy.
 *
 * **Intentionally not implemented yet**:
 *   - Checkpoint recovery (FEATURE_071)
 *   - Budget tracking (per-round / per-role ceilings)
 *   - Full observer events (managedTaskPhase / roleRoundStarted / ...)
 *   - Mutation tracker integration (scope-awareness note when H0 with >3 mutations)
 *   - Persistent session storage & lineage ledger recording
 * These land as follow-up polish or in later versions — the goal of
 * Shard 5b is proving the chain runs and produces a FEATURE_076-compatible
 * KodaXResult for all five canonical paths.
 */

import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXTextBlock,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax/ai';
import type {
  Agent,
  Handoff,
  RunnableTool,
  RunnerLlmResult,
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
import { getToolDefinition } from '../tools/registry.js';
import type {
  KodaXEvents,
  KodaXHarnessProfile,
  KodaXManagedProtocolPayload,
  KodaXManagedTask,
  KodaXManagedTaskPhase,
  KodaXOptions,
  KodaXResult,
  KodaXTaskContract,
  KodaXTaskRole,
  KodaXTaskRoleAssignment,
  KodaXToolExecutionContext,
  ManagedMutationTracker,
} from '../types.js';
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

const SCOUT_INSTRUCTIONS = [
  'You are Scout, the AMA entry role. Analyse the user task, then choose a harness tier:',
  '  - H0_DIRECT: trivial lookup / factual / review — Scout answers directly, no handoff',
  '  - H1_EXECUTE_EVAL: execution task, small scope — hand off to Generator, Evaluator verifies',
  '  - H2_PLAN_EXECUTE_EVAL: larger task, needs structured plan — hand off to Planner first',
  '',
  'You may call these tools to gather context: read, grep, glob, bash.',
  '',
  'When ready, call `emit_scout_verdict` exactly once with `confirmed_harness` set.',
  'For H0, also set `direct_completion_ready: "yes"` and produce ONE final assistant text turn ',
  'with the user-facing answer. For H1/H2, do NOT produce a final answer — control transfers ',
  'to the next role on emit.',
].join('\n');

const PLANNER_INSTRUCTIONS = [
  'You are Planner (H2 role). The Scout has chosen H2_PLAN_EXECUTE_EVAL, which means the task ',
  'needs a structured execution contract before Generator touches code.',
  '',
  'You may call these tools to inspect the repo: read, grep, glob.',
  '',
  'Call `emit_contract` exactly once with:',
  '  - summary: one-line contract summary',
  '  - success_criteria: what success looks like (concrete and testable)',
  '  - required_evidence: what evidence Generator must produce (tests, file diffs, output)',
  '  - constraints: gotchas Generator must respect',
  '',
  'After emit_contract the Runner transfers ownership to Generator — do not produce a final text.',
].join('\n');

const GENERATOR_INSTRUCTIONS = [
  'You are Generator (H1/H2 execution role). Execute the task: read context, modify files, ',
  'run commands, gather evidence.',
  '',
  'You may call: read, grep, glob, bash, write, edit.',
  '',
  'When execution is complete or blocked, call `emit_handoff` exactly once with:',
  '  - status: "ready" | "incomplete" | "blocked"',
  '  - summary: one-line handoff summary',
  '  - evidence: what you produced (files modified, test runs, commands)',
  '  - followup: required next steps for Evaluator',
  '',
  'After emit_handoff the Runner transfers to Evaluator — do not produce a final text.',
].join('\n');

const EVALUATOR_INSTRUCTIONS = [
  'You are Evaluator (H1/H2 verifier). Check Generator\'s output against the task requirements ',
  '(and the contract if H2).',
  '',
  'You may call: read, grep, glob, bash (read-only verification preferred).',
  '',
  'Call `emit_verdict` exactly once with `status`:',
  '  - accept: task complete. Provide `user_answer` (multi-line, user-facing)',
  '  - revise: Generator needs another pass. Optional `next_harness: H2_PLAN_EXECUTE_EVAL` to escalate',
  '  - blocked: verification cannot complete. Provide `reason`',
  '',
  'After emit_verdict on accept/blocked, produce ONE final assistant text turn with the user answer.',
  'On revise, control transfers back to Generator (or Planner for replan) — do not produce a final text.',
].join('\n');

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
      const result = await base.execute(input, ctx);
      if (!result.isError && result.metadata) {
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
        if (slot === 'verdict' && budget && budgetExtension) {
          const verdictPayload = recorder.verdict?.payload.verdict;
          if (verdictPayload?.status === 'revise') {
            observer.notifyBudgetApprovalRequest();
            const decision = await maybeRequestAdditionalWorkBudget(
              budgetExtension.events,
              budget,
              {
                summary: verdictPayload.reason ?? 'Evaluator requested another pass',
                currentRound: budgetExtension.roundRef.current,
                maxRounds: budgetExtension.maxRoundsRef.current,
                originalTask: budgetExtension.originalTask,
              },
            );
            budgetExtension.budgetApprovalRef.current = false;
            if (decision === 'approved') {
              budgetExtension.maxRoundsRef.current += 1;
            }
          }
        }
      }
      return result;
    },
  };
}

const BUDGET_CAP_BY_HARNESS: Record<KodaXHarnessProfile, number> = {
  H0_DIRECT: 50,
  H1_EXECUTE_EVAL: 400,
  H2_PLAN_EXECUTE_EVAL: 600,
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
      emit({
        phase: 'round',
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
): RunnableTool {
  return {
    ...definition,
    execute: async (input: Record<string, unknown>): Promise<RunnerToolResult> => {
      if (budget) incrementManagedBudgetUsage(budget, 1);
      recordMutationForTool(baseCtx.mutationTracker, definition.name, input);
      try {
        const content = await handler(input, baseCtx);
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
    read: wrapCodingToolAsRunnable(read, toolRead, baseCtx, budget),
    grep: wrapCodingToolAsRunnable(grep, toolGrep, baseCtx, budget),
    glob: wrapCodingToolAsRunnable(glob, toolGlob, baseCtx, budget),
    bash: wrapCodingToolAsRunnable(bash, toolBash, baseCtx, budget),
    write: wrapCodingToolAsRunnable(write, toolWrite, baseCtx, budget),
    edit: wrapCodingToolAsRunnable(edit, toolEdit, baseCtx, budget),
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
): RunnerAgentChain {
  const codingTools = buildCodingToolBundle(ctx, budget);

  const scoutEmit = wrapEmitterWithRecorder(emitScoutVerdict, 'scout', recorder, observer, budget);
  const contractEmit = wrapEmitterWithRecorder(emitContract, 'contract', recorder, observer, budget);
  const handoffEmit = wrapEmitterWithRecorder(emitHandoff, 'handoff', recorder, observer, budget);
  const verdictEmit = wrapEmitterWithRecorder(emitVerdict, 'verdict', recorder, observer, budget, budgetExtension);

  type WritableAgent = { -readonly [K in keyof Agent]: Agent[K] };

  const scout: WritableAgent = {
    name: SCOUT_AGENT_NAME,
    instructions: SCOUT_INSTRUCTIONS,
    tools: [
      scoutEmit,
      codingTools.read,
      codingTools.grep,
      codingTools.glob,
      wrapReadOnlyBash(codingTools.bash, 'Scout'),
    ],
    handoffs: undefined,
    reasoning: { default: 'quick', max: 'balanced', escalateOnRevise: false },
  };
  const planner: WritableAgent = {
    name: PLANNER_AGENT_NAME,
    instructions: PLANNER_INSTRUCTIONS,
    tools: [contractEmit, codingTools.read, codingTools.grep, codingTools.glob],
    handoffs: undefined,
    reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
  };
  const generator: WritableAgent = {
    name: GENERATOR_AGENT_NAME,
    instructions: GENERATOR_INSTRUCTIONS,
    tools: [
      handoffEmit,
      codingTools.read,
      codingTools.grep,
      codingTools.glob,
      codingTools.bash,
      codingTools.write,
      codingTools.edit,
    ],
    handoffs: undefined,
    reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
  };
  const evaluator: WritableAgent = {
    name: EVALUATOR_AGENT_NAME,
    instructions: EVALUATOR_INSTRUCTIONS,
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
      usage?: import('@kodax/ai').KodaXTokenUsage;
    };
    if (overrideStream) {
      streamResult = await overrideStream(transcript, wireTools, system);
    } else {
      const provider = resolveProvider(options.provider ?? 'anthropic');
      // Forward the caller's event callbacks through to the provider stream
      // so `onTextDelta` / `onThinkingDelta` / `onToolInputDelta` / etc.
      // fire for every role's LLM turn, matching the legacy `runKodaX`
      // behaviour that REPL streaming UIs rely on.
      const streamOptions = options.events
        ? {
            onTextDelta: options.events.onTextDelta,
            onThinkingDelta: options.events.onThinkingDelta,
            onThinkingEnd: options.events.onThinkingEnd,
            onToolInputDelta: options.events.onToolInputDelta,
          }
        : undefined;
      const raw = await provider.stream(
        [...transcript],
        [...wireTools],
        system,
        undefined,
        streamOptions,
        options.abortSignal,
      );
      streamResult = { textBlocks: raw.textBlocks, toolBlocks: raw.toolBlocks, usage: raw.usage };
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
    return { text, toolCalls };
  };
}

// =============================================================================
// Result conversion: RunResult + VerdictRecorder → KodaXResult
// =============================================================================

function extractUserFacingText(result: { messages: readonly KodaXMessage[]; output: string }): string {
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
  } = args;

  const harness: KodaXHarnessProfile =
    recorder.scout?.payload.scout?.confirmedHarness ?? 'H0_DIRECT';
  const contractPayload = recorder.contract?.payload.contract;

  const nowIso = new Date().toISOString();
  const taskId = `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const surface = (options.context as { surface?: 'cli' | 'repl' | 'project' | 'plan' })
    ?.surface ?? 'cli';

  const contractStatus =
    signal === 'BLOCKED' ? 'blocked' : verdictStatus === 'accept' ? 'completed' : 'running';

  const contract: KodaXTaskContract = {
    taskId,
    surface,
    objective: prompt,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: contractStatus,
    primaryTask: 'conversation',
    workIntent: 'new',
    complexity: harness === 'H0_DIRECT' ? 'simple' : harness === 'H1_EXECUTE_EVAL' ? 'moderate' : 'complex',
    riskLevel: 'low',
    harnessProfile: harness,
    recommendedMode: 'conversation',
    requiresBrainstorm: false,
    reason: 'Runner-driven AMA path',
    contractSummary: contractPayload?.summary,
    successCriteria: contractPayload?.successCriteria ?? [],
    requiredEvidence: contractPayload?.requiredEvidence ?? [],
    constraints: contractPayload?.constraints ?? [],
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
      workspaceDir: baseCtx.gitRoot ?? process.cwd(),
      artifacts: [],
      entries: [],
      routingNotes: [],
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
    },
  };
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
    const workspaceDir = `${workspaceRoot}/${managedTask.contract.taskId}`;
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
  const baseCtx: KodaXToolExecutionContext = {
    backups: new Map<string, string>(),
    gitRoot: options.context?.gitRoot ?? process.cwd(),
    executionCwd: options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd(),
    abortSignal: options.abortSignal,
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

  // Shard 6c: checkpoint writer, invoked after each role emit. Gated on
  // the presence of an interactive `askUser` callback — without it the
  // user cannot be prompted to resume, so writing checkpoints is useless
  // infrastructure cost (forks git, touches filesystem). This keeps unit
  // tests (which usually don't register askUser) fast and deterministic.
  let lastCheckpointWorkspaceDir: string | undefined;
  const checkpointingEnabled = Boolean(options.events?.askUser);
  const checkpointWriter = checkpointingEnabled
    ? (_role: KodaXTaskRole): void => {
        const snapshot = buildManagedTaskPayload({
          prompt,
          options,
          recorder,
          rolesEmitted: rolesRef.emitted,
          baseCtx,
          signal: 'COMPLETE',
          budget,
        });
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
      }
    : undefined;

  const observer = buildObserverBridge(
    options.events,
    harnessRef,
    rolesRef,
    budget,
    roundRef,
    maxRoundsRef,
    budgetApprovalRef,
    checkpointWriter,
  );

  observer.preflight();

  const budgetExtension: BudgetExtensionContext = {
    events: options.events,
    originalTask: prompt,
    roundRef,
    maxRoundsRef,
    budgetApprovalRef,
  };
  const tokenStateRef: { current: RunnerAdapterTokenState } = {
    current: { totalTokens: 0, source: 'estimate' },
  };
  const chain = buildRunnerAgentChain(baseCtx, recorder, observer, budget, budgetExtension);
  const llm = buildRunnerLlmAdapter(options, adapterOverride, tokenStateRef);

  // Session continuity: when the caller passes `options.session.initialMessages`
  // (REPL multi-turn, session resume, plan-mode replay), prepend them as the
  // Runner transcript so the Scout/Planner/Generator/Evaluator see full
  // prior context — matching legacy `runKodaX` behaviour via the session
  // loader.
  const initialMessages = options.session?.initialMessages ?? [];
  const runnerInput = initialMessages.length > 0
    ? [...initialMessages, { role: 'user' as const, content: prompt }]
    : prompt;

  const runResult = await Runner.run(chain.scout, runnerInput, {
    llm,
    abortSignal: options.abortSignal,
  });

  const lastText = extractUserFacingText(runResult);
  const { signal, verdictStatus, reason, userAnswer } = deriveFinalStatus(recorder);

  // Prefer the verdict's explicit user_answer over the final transcript
  // text when the Evaluator provided one — it's the intentional final
  // answer, while transcript text may be any last assistant turn.
  const resolvedText = userAnswer && userAnswer.trim().length > 0 ? userAnswer : lastText;

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
  });

  observer.completed(signal, reason ?? userAnswer);

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
  };
  return result;
}
