/**
 * Mutation scope reflection — dataset (FEATURE_101 v0.7.31.2; revised for
 * FEATURE_310 when SA mode was retired). The eval id keeps its historical
 * `sa-` prefix.
 *
 * See ./README.md for the product question and run model. This module
 * exports:
 *
 *   - `SA_MUTATION_REFLECTION_TASKS` — 3 synthetic prior-conversation
 *     scenarios where the assistant has just issued multi-file edits
 *     and the latest tool_result includes the mutation-reflection text.
 *   - `DIRECT_ENGINE_IDENTITY` / `buildPriorMessages(task, reflection)` —
 *     the frozen request parts, shared with Layer-2 A/B captures.
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
import type { KodaXMessage } from '@kodax-ai/llm';

import type { PromptJudge } from '../../harness/judges.js';
import { mustContainAny, mustNotMatch } from '../../harness/judges.js';
import type { PromptVariant } from '../../harness/harness.js';
import { TASK_CONVERSATIONS, mutatedFiles, type TaskConversation } from './conversations.js';

export type TaskId = 'three-file-refactor' | 'large-single-file-edit' | 'cross-module-rename';

export interface SaMutationReflectionTaskCase {
  readonly id: TaskId;
  readonly description: string;
  readonly userRequest: string;
  /** Exploration and mutation calls the assistant made before the reflection. */
  readonly conversation: TaskConversation;
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
    conversation: TASK_CONVERSATIONS['three-file-refactor'],
  },
  {
    id: 'large-single-file-edit',
    description:
      'Single large edit (>100 lines) — the line-count branch of the threshold predicate. '
      + 'Tests that even when scope is concentrated in one file, the model still does not '
      + 'attempt to call an escalation tool.',
    userRequest:
      'Rewrite packages/api/src/router/match.ts to support nested route groups. The current '
      + 'flat dispatcher needs to become recursive; ~120 lines change. Apply directly.',
    conversation: TASK_CONVERSATIONS['large-single-file-edit'],
  },
  {
    id: 'cross-module-rename',
    description:
      'Five-file mechanical rename — well past both thresholds. The legacy text '
      + 'pushed hardest on this shape. New text should still produce self-review behavior.',
    userRequest:
      'Rename `getCwd` to `getCurrentWorkingDirectory` across packages/coding/src/utils/path.ts '
      + 'and the 4 known call sites (packages/coding/src/agent.ts, '
      + 'packages/coding/src/task-engine.ts, packages/coding/src/tools/bash.ts, '
      + 'packages/repl/src/ui/StatusBar.tsx). Apply the rename directly.',
    conversation: TASK_CONVERSATIONS['cross-module-rename'],
  },
]);

// ---------------------------------------------------------------------------
// systemPrompt
// ---------------------------------------------------------------------------

/**
 * Direct-engine system prompt stand-in, trimmed to identity and tool
 * surface. The verbatim production prompt would pull in repo context and
 * tool catalog prose that bias behavior unrelated to the reflection. It
 * deliberately says nothing about scope reviews or modes, so the response
 * to the reflection text is the only variable.
 */
export const DIRECT_ENGINE_IDENTITY = [
  'You are KodaX, a coding agent.',
  '',
  'You complete the user\'s task directly using the read / grep / glob /',
  'bash / write / edit tools available to you.',
].join('\n');

// ---------------------------------------------------------------------------
// Synthetic prior conversation builder
// ---------------------------------------------------------------------------

/** The reflection the production substrate appends for this task's mutations. */
export function currentReflection(task: SaMutationReflectionTaskCase): string {
  const files = mutatedFiles(task.conversation);
  return buildMutationScopeReflection({ files: new Map(files), totalOps: task.conversation.mutations.length });
}

type ToolCall = TaskConversation['exploration'][number] | TaskConversation['mutations'][number];

function toolTurn(calls: readonly ToolCall[], idPrefix: string, lastSuffix = ''): readonly KodaXMessage[] {
  const uses = calls.map((call, i) => ({ type: 'tool_use' as const, id: `${idPrefix}${i}`, name: call.name, input: call.input }));
  const results = calls.map((call, i) => ({
    type: 'tool_result' as const,
    tool_use_id: `${idPrefix}${i}`,
    content: i === calls.length - 1 ? call.result + lastSuffix : call.result,
    is_error: false,
  }));
  return [{ role: 'assistant', content: uses }, { role: 'user', content: results }];
}

/**
 * User request, the read-only exploration turn, then the mutation turn. The
 * last mutation result carries the reflection: the production substrate
 * appends it to the result that crossed the threshold, it does not replace it.
 */
export function buildPriorMessages(
  task: SaMutationReflectionTaskCase,
  reflection = currentReflection(task),
): readonly KodaXMessage[] {
  return [
    { role: 'user', content: task.userRequest },
    ...toolTurn(task.conversation.exploration, 'r'),
    ...toolTurn(task.conversation.mutations, 'm', reflection),
  ];
}

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

const STALE_AMA_TOOL_PATTERN = /\bemit_managed_protocol\b|\bemit_scout_verdict\b/;
const RERUN_IN_MODE_PATTERN = /AMA mode|SA mode|re-run (?:it |this )?under/i;
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
      ),
      name: 'self-review',
      category: 'correctness',
    } as PromptJudge,
    {
      // No mode switch adds a reviewer, so suggesting one misleads the user.
      ...mustNotMatch(RERUN_IN_MODE_PATTERN, 'no-mode-rerun-suggestion'),
      name: 'no-mode-rerun-suggestion',
      category: 'correctness',
    } as PromptJudge,
  ]);
}

// ---------------------------------------------------------------------------
// Variant pivot for runBenchmark
// ---------------------------------------------------------------------------

export type VariantId = 'reflection-current';

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
      id: 'reflection-current',
      description: `mutation-reflection (current text) × task=${task.id}`,
      systemPrompt: DIRECT_ENGINE_IDENTITY,
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
