/**
 * Read-Scope Routing — dataset for FEATURE_112 (v0.7.34).
 *
 * See ./README.md for product question and run model. This module exports:
 *
 *   - `READ_SCOPE_TASKS`      — 4 task cases (shallow / deep / multi-thread / unknown-heavy)
 *   - `PROMPT_VARIANTS`       — Scout prompt variants (current_v0733 vs feature_112)
 *   - `buildJudges(expected)` — per-task judge factory
 *   - `buildPromptVariants()` — pivot to PromptVariant[] for runBenchmark
 *
 * Why text-output benchmarking (same rationale as ama-harness-selection):
 * runOneShot doesn't wire emit_scout_verdict, so the model expresses its
 * harness decision as `HARNESS: <id>` plain text. Judge accepts both
 * `HARNESS: <id>` and `confirmed_harness=<id>` so the model can fall back
 * to production phrasing.
 */

import type { KodaXMessage } from '@kodax/ai';

import type { PromptJudge } from '../../harness/judges.js';
import { mustMatch } from '../../harness/judges.js';
import type { PromptVariant } from '../../harness/harness.js';

export type HarnessId = 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
export type TaskClass =
  | 'shallow-qa'
  | 'deep-systemic'
  | 'multithread'
  | 'unknown-heavy';
export type TaskId =
  | 'read-shallow-qa'
  | 'read-deep-systemic'
  | 'read-multithread'
  | 'read-unknown-heavy';

export interface ReadScopeTaskCase {
  readonly id: TaskId;
  readonly taskClass: TaskClass;
  readonly expectedHarness: HarnessId;
  readonly description: string;
  readonly userMessage: string;
}

/**
 * 4 task cases. Each `userMessage` is phrased as the user's natural request
 * (no role-prompt scaffolding). The systemPrompt under test (see
 * PROMPT_VARIANTS) is what carries the harness-decision framework.
 */
export const READ_SCOPE_TASKS: readonly ReadScopeTaskCase[] = Object.freeze([
  {
    id: 'read-shallow-qa',
    taskClass: 'shallow-qa',
    expectedHarness: 'H0_DIRECT',
    description:
      'Single-file lookup with bounded answer — Scout should stay H0 (regression guard for FEATURE_112)',
    userMessage:
      'What does the function `parseConfig()` in packages/api/src/config.ts return when given an ' +
      'empty string as input? I just need a one-line answer; no need to investigate other files.',
  },
  {
    id: 'read-deep-systemic',
    taskClass: 'deep-systemic',
    expectedHarness: 'H1_EXECUTE_EVAL',
    description:
      'Multi-module systemic question requiring evidence across the codebase — should escalate to H1',
    userMessage:
      'Why does the AMA harness routing system always end up choosing H0 for read-only tasks even ' +
      'when the user is asking a complex multi-module question? I want a thorough explanation grounded ' +
      'in the actual routing code, harness selection logic, and Scout role-prompt. The answer needs ' +
      'to cite specific files and lines so I can verify it. This will probably require reading 5-10 ' +
      'files across packages/coding/src/reasoning.ts, the task-engine, and the role-prompt module.',
  },
  {
    id: 'read-multithread',
    taskClass: 'multithread',
    expectedHarness: 'H1_EXECUTE_EVAL',
    description:
      'Independent investigation threads (auth + storage + indexing) — should commit to escalation early',
    userMessage:
      'I need a complete audit of three independent subsystems before our security review next week: ' +
      '(1) the auth/session-token handling in packages/api/src/auth/, (2) the file-storage path ' +
      'sanitisation in packages/storage/, and (3) the search-indexing input validation in ' +
      'packages/indexer/. Each subsystem is independent of the others. Please produce one consolidated ' +
      'finding report covering all three.',
  },
  {
    id: 'read-unknown-heavy',
    taskClass: 'unknown-heavy',
    expectedHarness: 'H1_EXECUTE_EVAL',
    description:
      'Ambiguous-scope investigation likely to grow past 5 files — should escalate to H1 once scope is clear',
    userMessage:
      "I'm seeing intermittent 502s in production. Can you look into why? The user-facing symptom is " +
      'that some POST /api/notes calls fail roughly 1 in 50 times with no obvious pattern. I have no ' +
      'idea where to start — could be the API layer, the database connection pool, the upstream ' +
      'reverse-proxy config, or something else. Please investigate and produce a diagnosis with ' +
      'enough evidence that I can decide whether to ship a fix or escalate to ops.',
  },
]);

// ---------------------------------------------------------------------------
// systemPrompt variants under test
// ---------------------------------------------------------------------------

const SCOUT_IDENTITY =
  'You are Scout — the AMA entry role for a managed KodaX task. You judge task complexity ' +
  'and decide which harness profile (H0_DIRECT / H1_EXECUTE_EVAL / H2_PLAN_EXECUTE_EVAL) is ' +
  'appropriate.';

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

/**
 * `current_v0733` variant: v0.7.33 production Scout prompt (FEATURE_106
 * SCOPE COMMITMENT only — mutation-scope rule). This is what shipped in
 * v0.7.33 and is the FEATURE_112 baseline.
 *
 * Kept verbatim against `role-prompt.ts` pre-FEATURE_112. When that file's
 * SCOPE COMMITMENT block changes, update this constant in the same commit
 * and re-run baseline.
 */
const CURRENT_V0733_QUALITY_FRAMEWORK = [
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

export const CURRENT_V0733_VARIANT_SYSTEM_PROMPT: string = [
  SCOUT_IDENTITY,
  CURRENT_V0733_QUALITY_FRAMEWORK,
  BENCHMARK_OUTPUT_INSTRUCTION,
].join('\n\n');

/**
 * `feature_112` variant: SCOPE COMMITMENT block extended with the
 * investigation-scope rule + multi-thread early-decision rule. Verbatim
 * from `role-prompt.ts` post-Slice 3. When that file's SCOPE COMMITMENT
 * block changes, update this constant in the same commit and re-run.
 *
 * Slice 4 (decisionSummary semantic gloss) is NOT included here because
 * decisionSummary is rendered per-call from the runtime KodaXTaskRoutingDecision
 * object, not part of the static system prompt. The benchmark probes
 * the prompt rewrite alone; the gloss effect is observable in production
 * traces but out of scope for the single-turn probe.
 */
const FEATURE_112_QUALITY_FRAMEWORK = [
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
  'SCOPE COMMITMENT (hard rule):',
  '  • Mutation scope: If you intend to write ≥2 files OR start a project from scratch,',
  '    call emit_scout_verdict({confirmed_harness: H1 or H2}) BEFORE the first write.',
  '    The scope guardrail will surface belated commitments and slow you down.',
  '  • Investigation scope: If your read-only investigation reaches ≥5 distinct files',
  '    OR ≥8 searches without converging on a diagnosis, treat that as a signal the work',
  '    has exceeded H0 — emit emit_scout_verdict({confirmed_harness:"H1_EXECUTE_EVAL"}) so',
  '    an Evaluator can audit your conclusion. Continuing solo past this threshold loses',
  '    the audit signal.',
  '  • Multi-thread early decision: If your initial 1-2 scoping turns reveal ≥2',
  '    independent investigation threads, prefer dispatch_child_task over deep-diving',
  '    solo (per RULE A/B below). Dispatching AFTER you have already deep-dived is',
  '    wasted work — decide early.',
].join('\n');

export const FEATURE_112_VARIANT_SYSTEM_PROMPT: string = [
  SCOUT_IDENTITY,
  FEATURE_112_QUALITY_FRAMEWORK,
  BENCHMARK_OUTPUT_INSTRUCTION,
].join('\n\n');

/**
 * `feature_112_compact` variant: same content as `feature_112` but the
 * SCOPE COMMITMENT block is compressed to ~40% fewer characters. Iteration
 * driven by Stage 1 finding that `mmx/m27` produced garbled output on the
 * verbose feature_112 prompt (output: `"packageashawn张扬你是"` —
 * hallucinated tokens, no HARNESS line). Hypothesis: MiniMax M2.7 has a
 * lower stable prompt-length window; compact rules preserve the FEATURE_106
 * mutation rule + FEATURE_112 read-scope rules with terser wording so the
 * working instruction set fits within mmx's stability envelope.
 *
 * Title carries an implicit "default is H0" anchor ("escalation triggers")
 * so a model that scans the heading still sees the H0 default before reading
 * the trigger list.
 */
const FEATURE_112_COMPACT_QUALITY_FRAMEWORK = [
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
  'SCOPE COMMITMENT (escalation triggers — default is H0):',
  '  • Mutation ≥2 files OR new project from scratch → emit_scout_verdict(H1 or H2) before first write.',
  '  • Investigation reaches ≥5 distinct files OR ≥8 searches without convergence → emit_scout_verdict(H1_EXECUTE_EVAL) for evaluator audit.',
  '  • ≥2 independent investigation threads in initial 1-2 scoping turns → dispatch_child_task over solo deep-dive.',
].join('\n');

export const FEATURE_112_COMPACT_VARIANT_SYSTEM_PROMPT: string = [
  SCOUT_IDENTITY,
  FEATURE_112_COMPACT_QUALITY_FRAMEWORK,
  BENCHMARK_OUTPUT_INSTRUCTION,
].join('\n\n');

/**
 * `feature_112_anchor` variant: same verbose rules as `feature_112`,
 * but prepended with an explicit "Default is H0_DIRECT" reverse anchor.
 * Tests whether the mmx/m27 garbling was due to prompt length OR to the
 * model under-weighting the H0-default semantics implicit in the H0
 * tier definition above. If `compact` (which has the title anchor)
 * outperforms `anchor` (which has explicit reverse anchor but full
 * length), it is a length problem; if `anchor` wins or matches, it
 * is a semantic problem.
 */
const FEATURE_112_ANCHOR_QUALITY_FRAMEWORK = [
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
  'SCOPE COMMITMENT (hard rule):',
  '  Default harness is H0_DIRECT. The triggers below are escalation conditions, not defaults —',
  '  apply them only when one fires for the current task. Simple lookups, single-file edits, and',
  '  pure answer questions stay at H0 even when the rules below are present in this prompt.',
  '',
  '  • Mutation scope: If you intend to write ≥2 files OR start a project from scratch,',
  '    call emit_scout_verdict({confirmed_harness: H1 or H2}) BEFORE the first write.',
  '    The scope guardrail will surface belated commitments and slow you down.',
  '  • Investigation scope: If your read-only investigation reaches ≥5 distinct files',
  '    OR ≥8 searches without converging on a diagnosis, treat that as a signal the work',
  '    has exceeded H0 — emit emit_scout_verdict({confirmed_harness:"H1_EXECUTE_EVAL"}) so',
  '    an Evaluator can audit your conclusion. Continuing solo past this threshold loses',
  '    the audit signal.',
  '  • Multi-thread early decision: If your initial 1-2 scoping turns reveal ≥2',
  '    independent investigation threads, prefer dispatch_child_task over deep-diving',
  '    solo (per RULE A/B below). Dispatching AFTER you have already deep-dived is',
  '    wasted work — decide early.',
].join('\n');

export const FEATURE_112_ANCHOR_VARIANT_SYSTEM_PROMPT: string = [
  SCOUT_IDENTITY,
  FEATURE_112_ANCHOR_QUALITY_FRAMEWORK,
  BENCHMARK_OUTPUT_INSTRUCTION,
].join('\n\n');

// ---------------------------------------------------------------------------
// Judge construction
// ---------------------------------------------------------------------------

const HARNESS_PATTERN =
  /(?:HARNESS:|confirmed_harness\s*[:=]\s*"?)\s*(H0_DIRECT|H1_EXECUTE_EVAL|H2_PLAN_EXECUTE_EVAL)/i;

function harnessFormatJudge(): PromptJudge {
  return {
    ...mustMatch(HARNESS_PATTERN, 'harness-id'),
    name: 'harness-format',
    category: 'format',
  };
}

function harnessCorrectJudge(expected: HarnessId): PromptJudge {
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

/**
 * Build the judge set for one task. Format + correctness; eval cases that
 * want to layer extra judges (e.g. dispatch_child_task mention for the
 * multithread case) can spread the result.
 */
export function buildJudges(expected: HarnessId): readonly PromptJudge[] {
  return Object.freeze([harnessFormatJudge(), harnessCorrectJudge(expected)]);
}

// ---------------------------------------------------------------------------
// Variant pivot for runBenchmark
// ---------------------------------------------------------------------------

export type VariantId =
  | 'current_v0733'
  | 'feature_112'
  | 'feature_112_compact'
  | 'feature_112_anchor';

const VARIANT_PROMPTS: Readonly<Record<VariantId, string>> = Object.freeze({
  current_v0733: CURRENT_V0733_VARIANT_SYSTEM_PROMPT,
  feature_112: FEATURE_112_VARIANT_SYSTEM_PROMPT,
  feature_112_compact: FEATURE_112_COMPACT_VARIANT_SYSTEM_PROMPT,
  feature_112_anchor: FEATURE_112_ANCHOR_VARIANT_SYSTEM_PROMPT,
});

export function buildPromptVariants(
  task: ReadScopeTaskCase,
  variantIds: readonly VariantId[],
  priorMessages?: readonly KodaXMessage[],
): readonly PromptVariant[] {
  return variantIds.map((variantId): PromptVariant => ({
    id: variantId,
    description: `${variantId} prompt × task=${task.id}`,
    systemPrompt: VARIANT_PROMPTS[variantId],
    userMessage: task.userMessage,
    priorMessages,
  }));
}
