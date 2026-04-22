/**
 * FEATURE_076 + FEATURE_084 (v0.7.26):
 *
 * `runManagedTask` is the single public entry point for AMA/SA task runs.
 * Its body collapsed dramatically in Shard 6d when the legacy state-machine
 * orchestration (formerly ~6000 lines of role dispatch, protocol parsing,
 * harness escalation, budget accounting, and manual evaluator reshaping)
 * was replaced by the Runner-driven path in `./task-engine/runner-driven.ts`.
 *
 * Dispatch:
 *   - SA mode  -> `runDirectKodaX` with a direct-path prompt overlay.
 *   - AMA mode -> `runManagedTaskViaRunner` (Scout → Planner? → Generator
 *                 → Evaluator via Layer-A Runner + protocol emit tools).
 *
 * The outer wrapper also runs `reshapeToUserConversation` so
 * `result.messages` surfaces a clean user-facing {user, assistant} pair
 * regardless of the internal round shape.
 *
 * `__checkpointTestables` is re-exported for `checkpoint.test.ts`; the
 * underlying helpers live in `./task-engine/_internal/managed-task/checkpoint.ts`
 * and are still used at runtime by the Runner path.
 */
import { runKodaX as runDirectKodaX } from './agent.js';
import { createReasoningPlan, inferIntentGate } from './reasoning.js';
import { resolveProvider } from './providers/index.js';
import { reshapeToUserConversation } from './task-engine/_internal/round-boundary.js';
import { runManagedTaskViaRunner } from './task-engine/runner-driven.js';
import { getRepoRoutingSignals } from './repo-intelligence/runtime.js';
import { resolveKodaXAutoRepoMode } from './repo-intelligence/runtime.js';
import {
  emitManagedRepoIntelligenceTrace,
} from './task-engine/_internal/managed-task/repo-intelligence.js';
import {
  CHECKPOINT_FILE,
  CHECKPOINT_MAX_AGE_MS,
  getGitHeadCommit,
  writeCheckpoint,
  deleteCheckpoint,
  findValidCheckpoint,
} from './task-engine/_internal/managed-task/checkpoint.js';
import type {
  KodaXAgentMode,
  KodaXOptions,
  KodaXResult,
  KodaXTaskRoutingDecision,
} from './types.js';

function resolveManagedAgentMode(options: KodaXOptions): KodaXAgentMode {
  return options.agentMode ?? 'ama';
}

function buildDirectPathTaskFamilyPromptOverlay(
  family: KodaXTaskRoutingDecision['taskFamily'] | undefined,
  sections: Array<string | undefined>,
): string {
  const familyRule = family === 'review'
    ? '[Direct Path Rule] Return a review report, not a plan. Findings first when issues exist; otherwise explicitly say no findings.'
    : family === 'lookup'
      ? '[Direct Path Rule] Return a concise factual answer with the relevant file path(s) and only the minimum supporting detail.'
      : family === 'planning'
        ? '[Direct Path Rule] Return a concrete plan, not an implementation report.'
        : family === 'investigation'
          ? '[Direct Path Rule] Return diagnosis, evidence, and next steps.'
          : undefined;

  return [...sections, familyRule].filter(Boolean).join('\n\n');
}

export const __checkpointTestables = {
  writeCheckpoint,
  deleteCheckpoint,
  findValidCheckpoint,
  getGitHeadCommit,
  CHECKPOINT_MAX_AGE_MS,
  CHECKPOINT_FILE,
};

export async function runManagedTask(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  const result = await executeRunManagedTask(options, prompt);
  return reshapeToUserConversation(result, options, prompt);
}

async function executeRunManagedTask(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  const agentMode = resolveManagedAgentMode(options);
  if (agentMode === 'sa') {
    const intentGate = inferIntentGate(prompt);
    return runDirectKodaX(
      {
        ...options,
        context: {
          ...options.context,
          promptOverlay: buildDirectPathTaskFamilyPromptOverlay(
            intentGate.taskFamily,
            [options.context?.promptOverlay],
          ),
        },
      },
      prompt,
    );
  }

  // Shard 6d-L: AMA entry must run the same `createReasoningPlan` the legacy
  // task engine ran (task-engine.ts:1670-1702). The reasoning plan produces
  // `decision.primaryTask` / `decision.mutationSurface` / `decision.riskLevel`
  // / `decision.taskFamily` / `decision.harnessProfile` etc. Without this the
  // Runner-driven path used placeholder `conversation` / `simple` / `low`
  // values, which broke every downstream branch that read `contract.primaryTask`
  // (agent.ts has 10+ such branches in SA guardrails).
  //
  // `createReasoningPlan` also computes `plan.promptOverlay` — a block of
  // per-task routing notes (task-family guidance, work intent, brainstorm
  // directives, provider policy notes) legacy injected into every managed
  // worker's prompt. We thread it into the Runner chain so Scout/Planner/
  // Generator/Evaluator see the same contextual overlay as legacy workers.
  const plan = await buildManagedReasoningPlan(options, prompt);
  return runManagedTaskViaRunner(options, prompt, undefined, plan);
}

async function buildManagedReasoningPlan(options: KodaXOptions, prompt: string) {
  // Mirror the conditional repo-routing-signal capture from legacy
  // `createManagedReasoningPlan` (task-engine.ts:1670-1689): read signals
  // only when the workspace is available AND repo-intel auto mode is not
  // disabled. The routing-signal stage fires its own `onRepoIntelligenceTrace`
  // event so downstream observers can see where routing context came from.
  const intentGate = inferIntentGate(prompt);
  const shouldLoadRepoSignals = intentGate.shouldUseRepoSignals && Boolean(
    options.context?.executionCwd || options.context?.gitRoot,
  );
  const autoRepoMode = resolveKodaXAutoRepoMode(options.context?.repoIntelligenceMode);
  const repoRoutingSignals = options.context?.repoRoutingSignals
    ?? (
      shouldLoadRepoSignals && autoRepoMode !== 'off'
        ? await getRepoRoutingSignals({
          executionCwd: options.context?.executionCwd,
          gitRoot: options.context?.gitRoot ?? undefined,
        }, {
          mode: autoRepoMode,
        }).catch(() => null)
        : null
    );
  emitManagedRepoIntelligenceTrace(
    options.events,
    options,
    'routing',
    repoRoutingSignals,
    repoRoutingSignals?.activeModuleId
      ? `active_module=${repoRoutingSignals.activeModuleId}`
      : undefined,
  );

  try {
    const provider = resolveProvider(options.provider);
    const recentMessages = Array.isArray(options.session?.initialMessages)
      && options.session.initialMessages.length > 0
      ? options.session.initialMessages.slice(-10)
      : undefined;
    return await createReasoningPlan(options, prompt, provider, {
      repoSignals: repoRoutingSignals ?? undefined,
      recentMessages,
    });
  } catch {
    // Match legacy resilience (task-engine.ts:1721-1762): reasoning failure
    // must not abort the AMA run. `createReasoningPlan` already performs
    // heuristic routing internally, but if provider resolution itself
    // throws (e.g. bad model id) we want the Runner to continue with a
    // minimally-populated plan rather than bailing out. Returning
    // undefined leaves the Runner to use its current defaults.
    return undefined;
  }
}
