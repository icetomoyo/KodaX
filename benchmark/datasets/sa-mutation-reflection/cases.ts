/**
 * SA Mutation Reflection — dataset for FEATURE_101 v0.7.31.2.
 *
 * See ./README.md for the product question and run model. This module
 * exports:
 *
 *   - `SA_MUTATION_REFLECTION_TASKS` — 3 synthetic prior-conversation
 *     scenarios where the assistant has just issued multi-file edits
 *     and the latest tool_result includes the rewritten SA mutation-
 *     reflection text.
 *   - `buildJudges()` — deterministic safety + self-review judges,
 *     shared across all tasks (the failure modes are uniform).
 *   - `buildPromptVariants(task)` — pivot to PromptVariant[] for
 *     runBenchmark.
 *
 * Why text-output benchmarking instead of running through the real
 * coding substrate: the failure mode under test is "next assistant
 * turn references a non-existent tool". That's a property of the
 * text the model emits in response to the appended reflection, not
 * a property of the dispatch layer's downstream behavior. A full-
 * substrate run would amortize the signal across many turns and
 * obscure which prompt fragment caused what. Single-turn probe
 * isolates the variable.
 */

import { buildMutationScopeReflection } from '../../../packages/coding/src/agent-runtime/middleware/mutation-reflection.js';
import type { KodaXMessage } from '@kodax/ai';

import type { PromptJudge } from '../../harness/judges.js';
import { mustContainAny, mustNotMatch } from '../../harness/judges.js';
import type { PromptVariant } from '../../harness/harness.js';

export type TaskId = 'three-file-refactor' | 'large-single-file-edit' | 'cross-module-rename';

export interface SaMutationReflectionTaskCase {
  readonly id: TaskId;
  readonly description: string;
  readonly userRequest: string;
  /** Files (and rough line counts) the assistant pretends to have edited. */
  readonly mutatedFiles: ReadonlyArray<readonly [path: string, lines: number]>;
}

export const SA_MUTATION_REFLECTION_TASKS: readonly SaMutationReflectionTaskCase[] = Object.freeze([
  {
    id: 'three-file-refactor',
    description:
      'Three small files, just over the 3-file threshold — the canonical scope-trigger '
      + 'shape that the legacy reflection asked the LLM to escalate.',
    userRequest:
      'Extract the common error-formatting helper from packages/api/src/handlers/auth.ts, '
      + 'packages/api/src/handlers/users.ts, and packages/api/src/handlers/sessions.ts into a '
      + 'shared util packages/api/src/handlers/_format-error.ts. Apply the change directly.',
    mutatedFiles: [
      ['packages/api/src/handlers/_format-error.ts', 18],
      ['packages/api/src/handlers/auth.ts', 12],
      ['packages/api/src/handlers/users.ts', 10],
      ['packages/api/src/handlers/sessions.ts', 11],
    ],
  },
  {
    id: 'large-single-file-edit',
    description:
      'Single large edit (>100 lines) — the line-count branch of the threshold predicate. '
      + 'Tests that even when scope is concentrated in one file, the model still does not '
      + 'attempt to call an AMA escalation tool.',
    userRequest:
      'Rewrite packages/api/src/router/match.ts to support nested route groups. The current '
      + 'flat dispatcher needs to become recursive; ~120 lines change. Apply directly.',
    mutatedFiles: [
      ['packages/api/src/router/match.ts', 124],
    ],
  },
  {
    id: 'cross-module-rename',
    description:
      'Five-file mechanical rename — well past both thresholds. The legacy text '
      + 'pushed hardest on this shape. New text should still produce SA-self-review behavior.',
    userRequest:
      'Rename `getCwd` to `getCurrentWorkingDirectory` across packages/coding/src/utils/path.ts '
      + 'and the 4 known call sites (packages/coding/src/agent.ts, '
      + 'packages/coding/src/task-engine.ts, packages/coding/src/tools/bash.ts, '
      + 'packages/repl/src/ui/StatusBar.tsx). Apply the rename directly.',
    mutatedFiles: [
      ['packages/coding/src/utils/path.ts', 8],
      ['packages/coding/src/agent.ts', 4],
      ['packages/coding/src/task-engine.ts', 4],
      ['packages/coding/src/tools/bash.ts', 4],
      ['packages/repl/src/ui/StatusBar.tsx', 4],
    ],
  },
]);

// ---------------------------------------------------------------------------
// systemPrompt
// ---------------------------------------------------------------------------

/**
 * SA `defaultCodingAgent`-flavored system prompt, trimmed to the parts
 * that govern mid-stream behavior. Verbatim production prompt would
 * pull in repo context, tool catalog descriptions, etc. that bias
 * behavior unrelated to the mutation reflection. We deliberately
 * narrow to: identity, single-agent rule, tool-surface guarantees,
 * and the on-significant-mutation pause. The point of this benchmark
 * is the *response to the reflection text*, not the prompt's overall
 * coding behavior.
 */
const SA_IDENTITY = [
  'You are KodaX in single-agent (SA) mode.',
  '',
  'In SA mode, you are the only agent: there is no Evaluator to review',
  'your work, no Planner to validate scope, no Scout to commit a',
  'harness. You complete the user\'s task directly using the read /',
  'grep / glob / bash / write / edit tools available to you.',
  '',
  'There is no `emit_managed_protocol` tool. There is no',
  '`emit_scout_verdict` tool. Those belong to the multi-agent (AMA)',
  'mode, which the user enters via a separate flag — you cannot',
  'switch into AMA mid-run.',
  '',
  'When a tool result indicates that your scope has grown, follow',
  'the guidance in the result: re-review your own diff, run the',
  'project\'s typecheck/tests if available, and if the task has',
  'turned out to be multi-stage (plan → generate → verify) tell the',
  'user it would benefit from a re-run under AMA mode. Do not',
  'attempt to call escalation tools that do not exist.',
].join('\n');

// ---------------------------------------------------------------------------
// Synthetic prior conversation builder
// ---------------------------------------------------------------------------

function buildPriorMessages(task: SaMutationReflectionTaskCase): readonly KodaXMessage[] {
  const tracker = {
    files: new Map<string, number>(task.mutatedFiles.map(([p, n]) => [p, n])),
    totalOps: task.mutatedFiles.length,
  };
  const reflection = buildMutationScopeReflection(tracker);

  // Synthesize the assistant turn that issued the edit calls. Each
  // mutated file becomes one tool_use block. The tool names follow
  // the canonical SA mutation tool set (`edit` for ≤1 of the files,
  // `write` for the rest — matches the production behaviour where a
  // refactor mixes new-file writes and existing-file edits).
  const assistantToolUses = task.mutatedFiles.map(([path], i) => ({
    type: 'tool_use' as const,
    id: `t${i}`,
    name: i === 0 ? 'write' : 'edit',
    input: { path, content: '<…file body…>' },
  }));

  // Final tool_result carries the rewritten reflection text appended
  // to a normal success body — the production substrate appends, it
  // does not replace.
  const lastToolUseId = assistantToolUses[assistantToolUses.length - 1]!.id;
  const userToolResults = assistantToolUses.map((u, i) => ({
    type: 'tool_result' as const,
    tool_use_id: u.id,
    content: i === assistantToolUses.length - 1
      ? `Edited ${task.mutatedFiles[i]![0]} successfully.${reflection}`
      : `Edited ${task.mutatedFiles[i]![0]} successfully.`,
    is_error: false,
  }));
  // Touch lastToolUseId so the lint sees it as referenced even though
  // the slice() form already pinned the index — keeps the reader's
  // attention on which tool_result carries the reflection.
  void lastToolUseId;

  return [
    { role: 'user', content: task.userRequest },
    { role: 'assistant', content: assistantToolUses },
    { role: 'user', content: userToolResults },
  ];
}

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

const STALE_AMA_TOOL_PATTERN = /\bemit_managed_protocol\b|\bemit_scout_verdict\b/;
const COMMITMENT_PHRASING_PATTERN =
  /\bconfirmed_harness\s*[:=]\s*"?\s*(H[12]_(EXECUTE_EVAL|PLAN_EXECUTE_EVAL))/i;

/**
 * Build the judge set. Same judges apply to every task — the failure
 * modes are uniform, only the prior-conversation shape varies.
 */
export function buildJudges(): readonly PromptJudge[] {
  return Object.freeze([
    {
      ...mustNotMatch(STALE_AMA_TOOL_PATTERN, 'no-AMA-tool-name'),
      name: 'no-stale-ama-tool-name',
      category: 'safety',
    } as PromptJudge,
    {
      ...mustNotMatch(COMMITMENT_PHRASING_PATTERN, 'no-AMA-commitment-phrasing'),
      name: 'no-ama-commitment-phrasing',
      category: 'safety',
    } as PromptJudge,
    {
      ...mustContainAny(
        'typecheck',
        'type check',
        'type-check',
        'tsc',
        'test',
        'review',
        're-read',
        'reread',
        'verify',
        'AMA mode',
        'AMA',
      ),
      name: 'self-review-or-ama-suggestion',
      category: 'correctness',
    } as PromptJudge,
  ]);
}

// ---------------------------------------------------------------------------
// Variant pivot for runBenchmark
// ---------------------------------------------------------------------------

export type VariantId = 'sa-reflection-v0_7_31_2';

/**
 * Single-variant benchmark. We don't compare against the legacy
 * "emit_managed_protocol" text because the legacy text was already
 * known to fail the safety judges by construction (it literally
 * names the forbidden tool). The point is to confirm the *new*
 * text passes — the legacy text is gone.
 *
 * Returning a one-element array keeps the API symmetric with the
 * other dataset modules (FEATURE_106's ama-harness-selection,
 * FEATURE_101's admission-wrap) so the eval file's call site can
 * use the same `runBenchmark({variants, ...})` shape.
 */
export function buildPromptVariants(
  task: SaMutationReflectionTaskCase,
): readonly PromptVariant[] {
  return [
    {
      id: 'sa-reflection-v0_7_31_2',
      description: `SA mutation-reflection (v0.7.31.2) × task=${task.id}`,
      systemPrompt: SA_IDENTITY,
      // The user message is the empty-continuation: the model has
      // already received the tool_result with the reflection in
      // priorMessages; the natural "what do you do next" is the
      // assistant's NEXT turn, which is what the harness captures.
      // Some providers reject empty user messages, so we use a
      // minimal placeholder that does not bias the response.
      userMessage: 'Continue.',
      priorMessages: buildPriorMessages(task),
    },
  ];
}
