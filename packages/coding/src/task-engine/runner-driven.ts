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
  KodaXManagedProtocolPayload,
  KodaXOptions,
  KodaXResult,
  KodaXToolExecutionContext,
} from '../types.js';

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
 * Wrap a protocol emitter so every successful execution records its
 * `ProtocolEmitterMetadata` into the per-run recorder. The wrapped tool
 * otherwise behaves identically to the base tool.
 */
function wrapEmitterWithRecorder(
  base: RunnableTool,
  slot: 'scout' | 'contract' | 'handoff' | 'verdict',
  recorder: VerdictRecorder,
): RunnableTool {
  return {
    ...base,
    execute: async (input, ctx): Promise<RunnerToolResult> => {
      const result = await base.execute(input, ctx);
      if (!result.isError && result.metadata) {
        recorder[slot] = result.metadata as unknown as ProtocolEmitterMetadata;
      }
      return result;
    },
  };
}

// =============================================================================
// Tool wrapping: coding handler → RunnableTool
// =============================================================================

function wrapCodingToolAsRunnable(
  definition: KodaXToolDefinition,
  handler: (
    input: Record<string, unknown>,
    ctx: KodaXToolExecutionContext,
  ) => Promise<string>,
  baseCtx: KodaXToolExecutionContext,
): RunnableTool {
  return {
    ...definition,
    execute: async (input: Record<string, unknown>): Promise<RunnerToolResult> => {
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

interface CodingToolBundle {
  readonly read: RunnableTool;
  readonly grep: RunnableTool;
  readonly glob: RunnableTool;
  readonly bash: RunnableTool;
  readonly write: RunnableTool;
  readonly edit: RunnableTool;
}

function buildCodingToolBundle(baseCtx: KodaXToolExecutionContext): CodingToolBundle {
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
    read: wrapCodingToolAsRunnable(read, toolRead, baseCtx),
    grep: wrapCodingToolAsRunnable(grep, toolGrep, baseCtx),
    glob: wrapCodingToolAsRunnable(glob, toolGlob, baseCtx),
    bash: wrapCodingToolAsRunnable(bash, toolBash, baseCtx),
    write: wrapCodingToolAsRunnable(write, toolWrite, baseCtx),
    edit: wrapCodingToolAsRunnable(edit, toolEdit, baseCtx),
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
): RunnerAgentChain {
  const codingTools = buildCodingToolBundle(ctx);

  const scoutEmit = wrapEmitterWithRecorder(emitScoutVerdict, 'scout', recorder);
  const contractEmit = wrapEmitterWithRecorder(emitContract, 'contract', recorder);
  const handoffEmit = wrapEmitterWithRecorder(emitHandoff, 'handoff', recorder);
  const verdictEmit = wrapEmitterWithRecorder(emitVerdict, 'verdict', recorder);

  type WritableAgent = { -readonly [K in keyof Agent]: Agent[K] };

  const scout: WritableAgent = {
    name: SCOUT_AGENT_NAME,
    instructions: SCOUT_INSTRUCTIONS,
    tools: [scoutEmit, codingTools.read, codingTools.grep, codingTools.glob, codingTools.bash],
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
    tools: [verdictEmit, codingTools.read, codingTools.grep, codingTools.glob, codingTools.bash],
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

export function buildRunnerLlmAdapter(
  options: KodaXOptions,
  overrideStream?: (
    messages: readonly KodaXMessage[],
    tools: readonly KodaXToolDefinition[],
    system: string,
  ) => Promise<{ textBlocks?: readonly { text: string }[]; toolBlocks?: readonly KodaXToolUseBlock[] }>,
): (messages: readonly KodaXMessage[], agent: Agent) => Promise<RunnerLlmResult> {
  return async (messages, agent) => {
    const leadingSystem = messages[0]?.role === 'system' ? messages[0] : undefined;
    const system = typeof leadingSystem?.content === 'string' ? leadingSystem.content : '';
    const transcript = leadingSystem ? messages.slice(1) : messages;

    const wireTools: KodaXToolDefinition[] = (agent.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    let streamResult: {
      textBlocks?: readonly { text: string }[];
      toolBlocks?: readonly KodaXToolUseBlock[];
    };
    if (overrideStream) {
      streamResult = await overrideStream(transcript, wireTools, system);
    } else {
      const provider = resolveProvider(options.provider ?? 'anthropic');
      const raw = await provider.stream([...transcript], [...wireTools], system);
      streamResult = { textBlocks: raw.textBlocks, toolBlocks: raw.toolBlocks };
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
// Main entry
// =============================================================================

export async function runManagedTaskViaRunner(
  options: KodaXOptions,
  prompt: string,
  adapterOverride?: Parameters<typeof buildRunnerLlmAdapter>[1],
): Promise<KodaXResult> {
  const baseCtx: KodaXToolExecutionContext = {
    backups: new Map<string, string>(),
    gitRoot: options.context?.gitRoot ?? process.cwd(),
    executionCwd: options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd(),
    abortSignal: options.abortSignal,
  };

  const recorder: VerdictRecorder = {};
  const chain = buildRunnerAgentChain(baseCtx, recorder);
  const llm = buildRunnerLlmAdapter(options, adapterOverride);

  const runResult = await Runner.run(chain.scout, prompt, {
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

  // Shard 5b deliberately does NOT reconstruct a full `KodaXManagedTask`
  // (contract + roleAssignments + workItems + evidence + verdict). Those
  // fields are consumed by the legacy observer surface and not by
  // FEATURE_076 reshape. For round-boundary purposes we only need the
  // verdict status, which we also surface via `signal`. Leaving
  // `managedTask` undefined (like the SA fast-path) is correct.
  const result: KodaXResult = {
    success: verdictStatus !== 'blocked',
    lastText: resolvedText,
    signal,
    signalReason: reason,
    messages: [...runResult.messages],
    sessionId: runResult.sessionId ?? `runner-${Date.now()}`,
    managedProtocolPayload,
  };
  return result;
}
