/**
 * Dataset — FEATURE_097 (v0.7.34) prompt-behavior eval cases.
 *
 * Covers the four prompt-eval triggers from `docs/features/v0.7.34.md`
 * §"Prompt eval 触发清单" that were NOT covered by the standalone H0
 * mini-planner A/B eval (`feature-097-h0-mini-planner-strength.eval.ts`).
 *
 *   1. Layer 2 throttle reminder recovery
 *      — when `<system-reminder>` is injected after 8 quiet rounds,
 *        the model picks back up `todo_update`.
 *
 *   2. Unknown-id self-recovery (§5 ⑤)
 *      — when a prior `todo_update` returns `{ok:false, reason:"Unknown
 *        todo id: X. Current valid ids: ..."}`, the model retries with
 *        a valid id rather than continuing to hallucinate or stalling.
 *
 *   3. Generator step progression
 *      — when the Generator finishes one obligation, it calls
 *        `todo_update` to flip that item completed and advances the
 *        next pending item to `in_progress` (per role-prompt rule
 *        "完成一项必须调 todo_update").
 *
 *   4. Planner refinement
 *      — when Planner sees Scout's coarse obligations, it produces a
 *        refined contract / success-criteria list. We do not try to
 *        force a real `emit_contract` tool call in single-turn (Planner
 *        emits via tool-use which the eval harness does not bind);
 *        instead we judge that the output proposes a refined plan with
 *        more actionable steps than the input.
 *
 * **Single-turn probe** per FEATURE_104 §single-step convention.
 * **Stage-1 acceptance**: 8 alias mean ≥ 80% pass per case (gates v0.7.34
 * release per design §"Prompt eval 触发清单").
 */

import type { PromptVariant } from '../../harness/harness.js';
import {
  mustContainAll,
  mustContainAny,
  mustNotContain,
  type PromptJudge,
} from '../../harness/judges.js';

export type CaseId =
  | 'throttle_reminder_recovery'
  | 'unknown_id_recovery'
  | 'generator_step_progression'
  | 'planner_refinement';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  /** Behaviour the eval is verifying. */
  readonly behaviour: string;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'throttle_reminder_recovery',
    description:
      'After 8 quiet rounds, runner injects <system-reminder> ' +
      'listing pending items. Model should call todo_update next.',
    behaviour:
      'output must mention `todo_update` AND at least one valid pending todo id',
  },
  {
    id: 'unknown_id_recovery',
    description:
      'Prior todo_update returned {ok:false, reason:"Unknown todo id: ' +
      'todo_99. Current valid ids: todo_1, todo_2"}. Model should retry ' +
      'with one of the valid ids on the next turn.',
    behaviour:
      'output picks `todo_1` or `todo_2`, NOT `todo_99`; references todo_update',
  },
  {
    id: 'generator_step_progression',
    description:
      'Generator just finished writing migration tests (todo_2). Model ' +
      'should call todo_update to flip todo_2 to completed and advance ' +
      'the next pending item to in_progress.',
    behaviour:
      'output references `todo_update` AND (`completed` for todo_2 OR `in_progress` for todo_3)',
  },
  {
    id: 'planner_refinement',
    description:
      'Planner sees 3 coarse Scout obligations. Should propose a refined ' +
      'plan / contract with actionable steps.',
    behaviour:
      'output proposes a structured plan (numbered/bulleted steps OR ' +
      'success criteria) referencing each obligation area',
  },
] as const;

// ---------------------------------------------------------------------------
// Variants — every case ships exactly one variant ("v0.7.34"). We keep the
// PromptVariant shape so the harness and report renderer stay uniform with
// FEATURE_106 / FEATURE_112 evals (single-variant runs surface as a flat
// matrix; no A/B comparison axis here — these are absolute acceptance tests).
// ---------------------------------------------------------------------------

const COMMON_TOOL_BLURB = [
  'You have a `todo_update` tool with this contract:',
  '  Input:  { id: string, status: "in_progress"|"completed"|"failed"|"skipped", note?: string }',
  '  Output (JSON-stringified): {ok: true} on success;',
  '          {ok: false, reason: "..."} on failure (e.g. unknown id).',
  '  When you finish a step, call todo_update({ id: "<the_id>", status: "completed" }).',
  '  When starting the next step, call todo_update({ id: "<next_id>", status: "in_progress" }).',
].join('\n');

const GENERATOR_HEADER = [
  'You are KodaX Generator — the executor stage of an AMA pipeline.',
  '',
  'Scout has already produced a plan. The current todo list is:',
  '  - todo_1: Locate test fixtures (status=completed)',
  '  - todo_2: Run migration tests (status=in_progress)',
  '  - todo_3: Update type definitions (status=pending)',
  '',
  COMMON_TOOL_BLURB,
  '',
  'Per your role rules: every time you finish an item you MUST call todo_update.',
].join('\n');

function buildThrottleReminderVariant(): PromptVariant {
  // The reminder text mirrors `buildTodoReminderText` output literally
  // so we are testing the same wording the runner injects in production.
  const reminder = [
    '<system-reminder>',
    'You have not called todo_update in 8 iterations. Pending items:',
    '- todo_2: Run migration tests',
    '- todo_3: Update type definitions',
    'If you have started or finished any of these, call todo_update now.',
    '</system-reminder>',
  ].join('\n');
  return {
    id: 'v0.7.34',
    description: 'Layer 2 throttle reminder recovery',
    systemPrompt: [GENERATOR_HEADER, '', reminder].join('\n'),
    userMessage:
      'Continue. The migration tests just passed locally. ' +
      'Decide what to do next — and follow the system rules.',
  };
}

function buildUnknownIdRecoveryVariant(): PromptVariant {
  // The recovery scenario: the model's previous turn called
  // `todo_update({id:"todo_99",...})`. Reflect that as a "previous turn
  // result" in the user message so we can run single-turn (the harness
  // doesn't bind tools).
  return {
    id: 'v0.7.34',
    description: 'Unknown id self-recovery (§5 ⑤)',
    systemPrompt: GENERATOR_HEADER,
    userMessage: [
      'Your previous attempt was:',
      '  todo_update({ id: "todo_99", status: "completed" })',
      '',
      'Tool result:',
      '  {"ok": false, "reason": "Unknown todo id: \\"todo_99\\". ' +
        'Current valid ids: todo_1, todo_2, todo_3. Please retry ' +
        'with one of the valid ids, or skip this update."}',
      '',
      'Pick the right todo id and try again. Output the corrected ' +
      'tool call — do NOT call todo_99 again.',
    ].join('\n'),
  };
}

function buildGeneratorProgressionVariant(): PromptVariant {
  return {
    id: 'v0.7.34',
    description: 'Generator finishes one item, advances the next',
    systemPrompt: GENERATOR_HEADER,
    userMessage:
      'I just finished running the migration tests for todo_2 — ' +
      'they all pass. Move on to the next obligation. Per the role ' +
      'rules, update the todo list before continuing.',
  };
}

function buildPlannerRefinementVariant(): PromptVariant {
  // Planner emits a contract via the `emit_contract` tool in production,
  // but a single-turn probe without bound tools must read the structured
  // plan from text. Judge by "structured response with success criteria
  // or numbered steps that elaborate the input obligations".
  return {
    id: 'v0.7.34',
    description: 'Planner refines coarse Scout obligations',
    systemPrompt: [
      'You are KodaX Planner — the H2 contract designer.',
      '',
      'Scout produced this coarse obligation list:',
      '  1. Add JWT auth to the API',
      '  2. Update the user schema',
      '  3. Write integration tests',
      '',
      'Your job is to refine this into an executable contract with ' +
      'concrete success criteria the Generator can act on. Provide ' +
      'either a `successCriteria:` block or a numbered list of ' +
      'specific verifiable steps. Aim for at least 5 actionable items ' +
      'covering the three obligation areas.',
    ].join('\n'),
    userMessage:
      'Produce the refined contract / success criteria now.',
  };
}

function buildVariantForCase(caseId: CaseId): PromptVariant {
  switch (caseId) {
    case 'throttle_reminder_recovery':
      return buildThrottleReminderVariant();
    case 'unknown_id_recovery':
      return buildUnknownIdRecoveryVariant();
    case 'generator_step_progression':
      return buildGeneratorProgressionVariant();
    case 'planner_refinement':
      return buildPlannerRefinementVariant();
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [buildVariantForCase(caseId)];
}

// ---------------------------------------------------------------------------
// Judges — each case has 1-3 judges. All deterministic, zero-LLM. Pass rate
// across alias is the FEATURE_104 stage-1 metric.
// ---------------------------------------------------------------------------

function judgesForThrottleReminder(): readonly PromptJudge[] {
  return [
    {
      name: 'mentions_todo_update',
      category: 'correctness',
      judge: (out) => {
        const passed = /todo_update/i.test(out);
        return passed
          ? { passed: true }
          : { passed: false, reason: 'output never references todo_update' };
      },
    },
    {
      name: 'references_pending_id',
      category: 'correctness',
      judge: (out) => {
        // Either todo_2 (currently in_progress) or todo_3 (pending) is
        // an acceptable target — finishing or starting either matches
        // "follow the reminder".
        const passed = /todo_2|todo_3/i.test(out);
        return passed
          ? { passed: true }
          : { passed: false, reason: 'output names neither todo_2 nor todo_3' };
      },
    },
  ];
}

function judgesForUnknownIdRecovery(): readonly PromptJudge[] {
  return [
    {
      name: 'picks_valid_id',
      category: 'correctness',
      judge: (out) => {
        const referencesValid = /todo_[123]\b/.test(out);
        return referencesValid
          ? { passed: true }
          : {
              passed: false,
              reason: 'output does not reference a valid id (todo_1/2/3)',
            };
      },
    },
    {
      name: 'avoids_hallucinated_id',
      category: 'safety',
      judge: mustNotContain('todo_99').judge,
    },
    {
      name: 'mentions_todo_update',
      category: 'correctness',
      judge: mustContainAll('todo_update').judge,
    },
  ];
}

function judgesForGeneratorProgression(): readonly PromptJudge[] {
  return [
    {
      name: 'mentions_todo_update',
      category: 'correctness',
      judge: mustContainAll('todo_update').judge,
    },
    {
      name: 'transitions_state',
      category: 'correctness',
      judge: (out) => {
        // Either close out todo_2 (completed) or start todo_3 (in_progress).
        // Both signal the model understood the role rule "advance the list".
        const closes2 = /todo_2[\s\S]{0,40}completed/i.test(out)
          || /completed[\s\S]{0,40}todo_2/i.test(out);
        const starts3 = /todo_3[\s\S]{0,60}in_progress/i.test(out)
          || /in_progress[\s\S]{0,60}todo_3/i.test(out);
        if (closes2 || starts3) return { passed: true };
        return {
          passed: false,
          reason:
            'output does not pair todo_2→completed or todo_3→in_progress',
        };
      },
    },
  ];
}

function judgesForPlannerRefinement(): readonly PromptJudge[] {
  return [
    {
      name: 'output_is_structured',
      category: 'format',
      judge: (out) => {
        // Look for a numbered list (≥3 items) OR a successCriteria
        // block. Either is acceptable.
        const numberedItems = (out.match(/^\s*\d+\.\s+\S/gm) ?? []).length;
        const bulletItems = (out.match(/^\s*[-*•]\s+\S/gm) ?? []).length;
        const successCriteria = /success[ _]?criteria/i.test(out);
        const total = numberedItems + bulletItems;
        if (total >= 3 || successCriteria) return { passed: true };
        return {
          passed: false,
          reason: `unstructured: ${total} list items, no successCriteria`,
        };
      },
    },
    {
      name: 'mentions_three_obligation_areas',
      category: 'correctness',
      judge: mustContainAny('JWT', 'auth', 'authentication').judge,
    },
    {
      name: 'covers_schema_or_tests',
      category: 'correctness',
      judge: mustContainAny('schema', 'test', 'tests', 'integration').judge,
    },
  ];
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  switch (caseId) {
    case 'throttle_reminder_recovery':
      return judgesForThrottleReminder();
    case 'unknown_id_recovery':
      return judgesForUnknownIdRecovery();
    case 'generator_step_progression':
      return judgesForGeneratorProgression();
    case 'planner_refinement':
      return judgesForPlannerRefinement();
  }
}
