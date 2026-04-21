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
import { inferIntentGate } from './reasoning.js';
import { reshapeToUserConversation } from './task-engine/_internal/round-boundary.js';
import { runManagedTaskViaRunner } from './task-engine/runner-driven.js';
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

  return runManagedTaskViaRunner(options, prompt);
}
