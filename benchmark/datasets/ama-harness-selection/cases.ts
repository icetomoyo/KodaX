/**
 * AMA Harness Selection Calibration — dataset for FEATURE_106 (v0.7.31).
 *
 * See ./README.md for the product question and run model. This module
 * exports:
 *
 *   - `AMA_HARNESS_TASKS`     — 6 task cases (2 H0 / 2 H1 / 2 H2)
 *   - `PROMPT_VARIANTS`       — Scout role-prompt variants under test
 *                               (current = v0.7.30 baseline; feature_106
 *                               variant added by FEATURE_106 Slice 2)
 *   - `buildJudges(expected)` — per-task judge factory
 *   - `buildPromptVariants()` — pivot to PromptVariant[] for runBenchmark
 *
 * Why text-output benchmarking instead of real `emit_scout_verdict` tool
 * call: the Scout role prompt instructs the model to call a tool that
 * doesn't exist in this benchmark harness. Rather than wire up a fake
 * tool (which would itself require deciding what arguments are valid and
 * couple the dataset to the protocol-emitters package), we ask the model
 * to express its harness decision as plain text. The judge accepts both
 * `HARNESS: <id>` (preferred) and `confirmed_harness=<id>` (the form Scout
 * would have passed to the tool). This keeps the dataset standalone and
 * avoids drift when emit-tool schemas change.
 */

import type { KodaXMessage } from '@kodax/ai';

import type { PromptJudge } from '../../harness/judges.js';
import { mustMatch, mustNotMatch } from '../../harness/judges.js';
import type { PromptVariant } from '../../harness/harness.js';

export type HarnessId = 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
export type TaskClass = 'H0' | 'H1' | 'H2';
export type TaskId =
  | 'h0-typo'
  | 'h0-lookup'
  | 'h1-multifile-bugfix'
  | 'h1-refactor'
  | 'h2-newproject'
  | 'h2-architectural';

export interface AmaHarnessTaskCase {
  readonly id: TaskId;
  readonly taskClass: TaskClass;
  readonly expectedHarness: HarnessId;
  readonly description: string;
  readonly userMessage: string;
}

/**
 * 6 task cases. Each `userMessage` is phrased as the user's natural request
 * (no role-prompt scaffolding) — the systemPrompt under test (see
 * PROMPT_VARIANTS) is what carries the harness-decision framework.
 */
export const AMA_HARNESS_TASKS: readonly AmaHarnessTaskCase[] = Object.freeze([
  {
    id: 'h0-typo',
    taskClass: 'H0',
    expectedHarness: 'H0_DIRECT',
    description: 'Single-file single-line typo fix — minimal mutation, no review needed',
    userMessage:
      'Fix the typo "recieve" → "receive" on line 42 of packages/api/src/auth.ts. ' +
      'It\'s a single character flip in a comment. Just apply the fix.',
  },
  {
    id: 'h0-lookup',
    taskClass: 'H0',
    expectedHarness: 'H0_DIRECT',
    description: 'Pure-answer lookup — no file mutation, no review needed',
    userMessage:
      'What does the function `parseConfig()` in packages/api/src/config.ts return when given an ' +
      'empty string as input? I just need the answer; you do not need to modify any files.',
  },
  {
    id: 'h1-multifile-bugfix',
    taskClass: 'H1',
    expectedHarness: 'H1_EXECUTE_EVAL',
    description: 'Multi-file bug fix in known territory — scope is explicit, needs review before shipping',
    userMessage:
      'There is a Safari-only login bug. The error originates in packages/api/src/auth.ts ' +
      '(token validation rejects valid Safari user-agent strings) and the symptom shows up in ' +
      'packages/web/src/login.tsx (form stuck in loading state on Safari). Both files need fixes ' +
      'and they have to stay consistent. Please fix the bug.',
  },
  {
    id: 'h1-refactor',
    taskClass: 'H1',
    expectedHarness: 'H1_EXECUTE_EVAL',
    description: 'Mechanical rename across 5 files — multi-file by definition, needs review',
    userMessage:
      'Rename the function `getCwd` to `getCurrentWorkingDirectory` across the codebase. ' +
      'Definition lives in packages/coding/src/utils/path.ts. Callers I know of: ' +
      'packages/coding/src/agent.ts, packages/coding/src/task-engine.ts, ' +
      'packages/coding/src/tools/bash.ts, packages/repl/src/ui/StatusBar.tsx. ' +
      'Update all of them; there may also be other callers I missed.',
  },
  {
    id: 'h2-newproject',
    taskClass: 'H2',
    expectedHarness: 'H2_PLAN_EXECUTE_EVAL',
    description: 'New TypeScript REST API package from scratch — no existing anchor, needs plan-first',
    userMessage:
      'Create a new TypeScript package at packages/notes-api/ that exposes a REST API for a ' +
      'notes service. Endpoints: GET /notes (list), POST /notes (create), GET /notes/:id (read), ' +
      'PUT /notes/:id (update), DELETE /notes/:id (delete). Include schema validation, error ' +
      'handling, and unit tests for each endpoint. There is no existing notes-api code to start ' +
      'from — design the architecture from scratch.',
  },
  {
    id: 'h2-architectural',
    taskClass: 'H2',
    expectedHarness: 'H2_PLAN_EXECUTE_EVAL',
    description: 'Cross-module architectural feature — needs design pass before coding',
    userMessage:
      'Add a caching layer to the API request pipeline. Requirements: TTL-based eviction (configurable ' +
      'per-route default 60s), works transparently for all existing handlers in packages/api/src/handlers/, ' +
      'and exposes a way for individual routes to opt out or set their own TTL. The cache implementation ' +
      'should live in packages/api/src/cache/. Update existing middleware in packages/api/src/middleware/ ' +
      'to wire the cache. Add tests covering TTL expiry, opt-out, and per-route override. Plan the design ' +
      'before implementing — the right cache key strategy is non-obvious.',
  },
]);

// ---------------------------------------------------------------------------
// systemPrompt variants under test
// ---------------------------------------------------------------------------

/**
 * Verbatim copy of the H0/H1/H2 §QUALITY FRAMEWORK section from
 * v0.7.30 `packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts:432-466`.
 *
 * Kept verbatim (including the "H0 (default)" wording FEATURE_106 will fix)
 * so this benchmark measures the actual production prompt's behavior, not
 * a paraphrase. When role-prompt.ts changes, update this constant in the
 * same commit and re-run baseline.
 */
const CURRENT_QUALITY_FRAMEWORK = [
  'QUALITY FRAMEWORK — Think of yourself as a senior engineer who just received this task.',
  '',
  'You have the full default tool set: read / grep / glob / bash / write / edit /',
  'dispatch_child_task(read-only) / exit_plan_mode. The harness decision below is about WHETHER',
  'your work needs an independent reviewer — NOT about whether you are allowed to use those tools.',
  '',
  'H0 (default) — "I\'d just do this myself. No one needs to check my work."',
  '  Examples: fixing a typo, answering a question, git commit/push, config change, single-file edit,',
  '  one-off scratch file, straightforward bug fix the user explicitly asked you to just apply.',
  '  → Complete the task directly — read, edit, write, and run bash as the user authorised. No',
  '    special protocol needed. You MAY optionally call emit_scout_verdict with',
  '    confirmed_harness="H0_DIRECT" for observability, but it is not required — a direct text',
  '    answer plus whatever file writes you performed is sufficient.',
  '',
  'H1 — "I can do this, but someone should review my work before shipping."',
  '  Examples: fixing a bug across files, code review, performance optimization, security fix,',
  '  non-trivial refactor of an unfamiliar module.',
  '  → Call emit_scout_verdict with confirmed_harness="H1_EXECUTE_EVAL" to escalate. A Generator+Evaluator pipeline will handle it.',
  '',
  'H2 — "I need to plan the approach first before coding."',
  '  Examples: new feature from scratch, cross-module refactoring, system design, database migration.',
  '  → Call emit_scout_verdict with confirmed_harness="H2_PLAN_EXECUTE_EVAL" to escalate. A Planner+Generator+Evaluator pipeline will handle it.',
  '',
  'ESCALATION EXAMPLE:',
  '  emit_scout_verdict({confirmed_harness:"H1_EXECUTE_EVAL", summary:"...", scope:[...], review_files_or_areas:[...]})',
  '',
  'SCOPE SELF-CHECK: If you find yourself modifying 3+ files or making changes across multiple modules,',
  'pause and ask: "Would I ship this without review?" If not, escalate.',
].join('\n');

/**
 * Benchmark-specific instruction telling the model to express its harness
 * decision as plain text (the benchmark harness does not provide tools).
 *
 * This is the ONE deviation from production prompt — necessary because
 * `runOneShot` doesn't wire emit_scout_verdict, but designed to NOT bias
 * the harness choice itself: we accept either `HARNESS: <id>` or
 * `confirmed_harness=<id>` in the judge, so the model can fall back to
 * the production phrasing if it prefers.
 */
const BENCHMARK_OUTPUT_INSTRUCTION = [
  'IMPORTANT — output format for this benchmark:',
  '  This benchmark harness does not provide the emit_scout_verdict tool.',
  '  Instead, output your harness decision as plain text on its own line:',
  '',
  '    HARNESS: <H0_DIRECT|H1_EXECUTE_EVAL|H2_PLAN_EXECUTE_EVAL>',
  '',
  '  followed by a brief one-line rationale. You may include any analysis above',
  '  or below this line; only the HARNESS: line is parsed.',
].join('\n');

const SCOUT_IDENTITY = 'You are Scout — the AMA entry role for a managed KodaX task. You judge task complexity and decide which harness profile (H0_DIRECT / H1_EXECUTE_EVAL / H2_PLAN_EXECUTE_EVAL) is appropriate.';

/**
 * `current` variant: v0.7.30 production Scout prompt's harness-decision
 * portion + a benchmark-output adapter. This is what's running in
 * v0.7.30 today — the prompt that produced the H0 bias.
 */
export const CURRENT_VARIANT_SYSTEM_PROMPT = [
  SCOUT_IDENTITY,
  CURRENT_QUALITY_FRAMEWORK,
  BENCHMARK_OUTPUT_INSTRUCTION,
].join('\n\n');

/**
 * Verbatim copy of the post-Slice 2 §QUALITY FRAMEWORK section in
 * v0.7.31 `packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`.
 *
 * Same caveat as CURRENT_QUALITY_FRAMEWORK above: when role-prompt.ts
 * changes, update this constant in the same commit and re-run the
 * Stage 1 + Stage 2 benchmarks. The FEATURE_106 Slice 2 changes are:
 *
 *   1. H0 reframed: "default" → "Bounded mutation OR pure answer"
 *      (≤1 file ≤30 lines OR no mutation)
 *   2. H0/H1/H2 examples quantified (≥2 files / >30 lines etc.)
 *   3. SCOPE SELF-CHECK (subjective) → SCOPE COMMITMENT (hard rule)
 *   4. Explicit reference to the scope guardrail so the LLM knows the
 *      system will surface belated commitments
 */
const FEATURE_106_QUALITY_FRAMEWORK = [
  'QUALITY FRAMEWORK — Think of yourself as a senior engineer who just received this task.',
  '',
  'You have the full default tool set: read / grep / glob / bash / write / edit /',
  'dispatch_child_task(read-only) / exit_plan_mode. The harness decision below is about WHETHER',
  'your work needs an independent reviewer — NOT about whether you are allowed to use those tools.',
  '',
  'H0 — Bounded mutation OR pure answer. ≤1 file ≤30 lines mutation, OR no file',
  '  mutation at all (lookup / review / answer / git commit / config change / one-off',
  '  scratch file / straightforward typo).',
  '  → For mutation tasks within this bound, complete directly. For non-mutation tasks',
  '    (lookup / review / answer), no emit needed. Anything beyond this bound MUST',
  '    emit_scout_verdict first (see SCOPE COMMITMENT below).',
  '',
  'H1 — Multi-file change in known territory: bug fix across modules, refactor of familiar',
  '  code, security/perf fix. ≥2 files OR >30 lines mutation in 1 file.',
  '  → Call emit_scout_verdict with confirmed_harness="H1_EXECUTE_EVAL" to escalate. A Generator+Evaluator pipeline will handle it.',
  '',
  'H2 — New code without existing anchor: project from scratch, cross-module refactor,',
  '  new feature, system design, database migration.',
  '  → Call emit_scout_verdict with confirmed_harness="H2_PLAN_EXECUTE_EVAL" to escalate. A Planner+Generator+Evaluator pipeline will handle it.',
  '',
  'ESCALATION EXAMPLE:',
  '  emit_scout_verdict({confirmed_harness:"H1_EXECUTE_EVAL", summary:"...", scope:[...], review_files_or_areas:[...]})',
  '',
  'SCOPE COMMITMENT (hard rule): If you intend to write ≥2 files OR start a project from',
  'scratch, call emit_scout_verdict({confirmed_harness: H1 or H2}) BEFORE the first write.',
  'The scope guardrail will surface belated commitments and slow you down.',
].join('\n');

/**
 * `feature_106` variant: post-Slice 2 Scout prompt + the same benchmark
 * output adapter. Stage 1 + Stage 2 use this against `current` to measure
 * `multi_file_h0_rate` (target ≤5%) and `pre_emit_commitment_rate`
 * (target ≥70%) — see `docs/features/v0.7.31.md` §FEATURE_106 Eval Plan.
 */
export const FEATURE_106_VARIANT_SYSTEM_PROMPT: string = [
  SCOUT_IDENTITY,
  FEATURE_106_QUALITY_FRAMEWORK,
  BENCHMARK_OUTPUT_INSTRUCTION,
].join('\n\n');

// ---------------------------------------------------------------------------
// Judge construction
// ---------------------------------------------------------------------------

const HARNESS_PATTERN = /(?:HARNESS:|confirmed_harness\s*[:=]\s*"?)\s*(H0_DIRECT|H1_EXECUTE_EVAL|H2_PLAN_EXECUTE_EVAL)/i;

function harnessFormatJudge(): PromptJudge {
  return {
    ...mustMatch(HARNESS_PATTERN, 'harness-id'),
    name: 'harness-format',
    category: 'format',
  };
}

function harnessCorrectJudge(expected: HarnessId): PromptJudge {
  // Per-call match: extract the first harness id and compare.
  return {
    name: `harness-correct(${expected})`,
    category: 'correctness',
    judge(output: string) {
      const match = output.match(HARNESS_PATTERN);
      if (!match) return { passed: false, reason: 'no harness id found in output' };
      const found = match[1]?.toUpperCase();
      if (found === expected) return { passed: true };
      return { passed: false, reason: `expected ${expected}, got ${found}` };
    },
  };
}

const STALE_TOOL_NAME_PATTERN = /\bemit_managed_protocol\b/;

function noStaleToolNameJudge(): PromptJudge {
  return {
    ...mustNotMatch(STALE_TOOL_NAME_PATTERN, 'no-emit_managed_protocol'),
    name: 'no-stale-tool-name',
    category: 'safety',
  };
}

/**
 * Build the judge set for one task. Format + correctness + safety; eval
 * cases that want to layer extra judges can spread the result.
 */
export function buildJudges(expected: HarnessId): readonly PromptJudge[] {
  return Object.freeze([
    harnessFormatJudge(),
    harnessCorrectJudge(expected),
    noStaleToolNameJudge(),
  ]);
}

// ---------------------------------------------------------------------------
// Variant pivot for runBenchmark
// ---------------------------------------------------------------------------

export type VariantId = 'current' | 'feature_106';

/**
 * Build a `PromptVariant` per (task, variantId) pair.
 *
 * Caller threads the variant ids through `runBenchmark` once per task
 * (since the judges are task-specific, the runBenchmark call is also
 * task-scoped — see `tests/ama-harness-selection.eval.ts`).
 */
export function buildPromptVariants(
  task: AmaHarnessTaskCase,
  variantIds: readonly VariantId[],
  priorMessages?: readonly KodaXMessage[],
): readonly PromptVariant[] {
  return variantIds.map((variantId): PromptVariant => {
    const systemPrompt =
      variantId === 'current'
        ? CURRENT_VARIANT_SYSTEM_PROMPT
        : FEATURE_106_VARIANT_SYSTEM_PROMPT;
    return {
      id: variantId,
      description: `${variantId} prompt × task=${task.id}`,
      systemPrompt,
      userMessage: task.userMessage,
      priorMessages,
    };
  });
}
