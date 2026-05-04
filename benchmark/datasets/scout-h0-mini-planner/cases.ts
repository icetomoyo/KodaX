/**
 * Scout H0 Mini-Planner Strength — dataset for FEATURE_097 (v0.7.34).
 *
 * See ./README.md for product question and run model. This module exports:
 *
 *   - `H0_MINI_PLANNER_TASKS`        — 4 task cases (simple-typo / borderline /
 *                                       multistep / complex)
 *   - `LIGHT_VARIANT_SYSTEM_PROMPT`  — current v0.7.34 design baseline (1-line hint)
 *   - `HEAVY_VARIANT_SYSTEM_PROMPT`  — proposed strengthened mini-planner text
 *   - `buildJudges(expected)`        — per-task judge factory
 *   - `buildPromptVariants()`        — pivot to PromptVariant[] for runBenchmark
 *
 * Why text-output benchmarking (same rationale as ama-harness-selection /
 * read-scope-routing): the eval harness does not wire `emit_scout_verdict`,
 * so the model expresses its harness + obligations decisions as plain text:
 *
 *   HARNESS: H0_DIRECT
 *   OBLIGATIONS:
 *   - Step 1
 *   - Step 2
 *   ...
 *   RATIONALE: <one-line>
 *
 * The judge parses the HARNESS line + OBLIGATIONS block. A model that
 * legitimately decides "no plan needed" can omit OBLIGATIONS or leave it
 * with 0-1 entries (matches FEATURE_097 `obligations.length >= 2` display
 * gate).
 *
 * Pinned baseline: this dataset SHIPS the FEATURE_112 anchor prompt as the
 * common base (FEATURE_112 already landed in v0.7.34). The two variants
 * under test differ ONLY in the H0 mini-planner addendum. When the
 * production Scout role-prompt changes (e.g. v0.7.35+), this dataset
 * remains pinned for replay; the active production prompt evolves
 * independently.
 */

import type { KodaXMessage } from '@kodax/ai';

import type { PromptJudge } from '../../harness/judges.js';
import type { PromptVariant } from '../../harness/harness.js';

export type HarnessId = 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
export type TaskComplexity =
  | 'simple-typo'
  | 'borderline-2step'
  | 'multistep-rename'
  | 'complex-flag';
export type TaskId =
  | 'h0-simple-typo'
  | 'h0-borderline-2step'
  | 'h0-multistep-rename'
  | 'h0-complex-flag';

export interface ObligationCountRange {
  readonly min: number;
  readonly max: number;
}

export interface H0MiniPlannerTaskCase {
  readonly id: TaskId;
  readonly complexity: TaskComplexity;
  readonly expectedHarness: HarnessId;
  readonly expectedObligationCount: ObligationCountRange;
  readonly description: string;
  readonly userMessage: string;
}

/**
 * 4 task cases spanning the H0/H1 complexity spectrum:
 *
 * - `simple-typo` + `borderline-2step` are within H0_DIRECT bounds (≤1 file
 *   mutation) and guard the over-formalization red line.
 * - `multistep-rename` + `complex-flag` mutate ≥2 files, which by FEATURE_106
 *   mutation rule MUST escalate to H1_EXECUTE_EVAL. They test whether heavier
 *   wording produces structured plans WHILE keeping correct harness escalation.
 *
 * Original (pre-pilot) declaration had all 4 expected as H0_DIRECT, but pilot
 * data showed multistep + complex correctly escalated to H1 across most aliases
 * — fixed in 2026-05-04 update.
 */
export const H0_MINI_PLANNER_TASKS: readonly H0MiniPlannerTaskCase[] = Object.freeze([
  {
    id: 'h0-simple-typo',
    complexity: 'simple-typo',
    expectedHarness: 'H0_DIRECT',
    expectedObligationCount: { min: 0, max: 1 },
    description:
      'Single-token typo fix in one file. Should produce 0-1 obligations — over-formalization red line.',
    userMessage:
      "Please fix the typo on line 12 of README.md: 'recieve' should be 'receive'. " +
      'Just that one word, nothing else.',
  },
  {
    id: 'h0-borderline-2step',
    complexity: 'borderline-2step',
    expectedHarness: 'H0_DIRECT',
    expectedObligationCount: { min: 2, max: 3 },
    description:
      'Two-step refactor (replace + verify) on one file. Borderline — heavy variant should produce a small explicit plan, light variant may either way. Single-file mutation keeps it within H0 bounds.',
    userMessage:
      "In src/utils/log.ts, replace all `console.log(...)` calls with `logger.info(...)`. " +
      'After the change, run `npm run lint` to confirm nothing is broken.',
  },
  {
    id: 'h0-multistep-rename',
    complexity: 'multistep-rename',
    expectedHarness: 'H1_EXECUTE_EVAL',
    expectedObligationCount: { min: 3, max: 6 },
    description:
      'Multi-file rename (definition + 4-5 callers) + verification. By FEATURE_106 mutation rule (≥2 files → H1) this MUST escalate, but should still produce a structured obligation list. Tests "heavy wording produces clean plan WHILE escalating correctly".',
    userMessage:
      'I want to rename the function `emitMessage` to `publishMessage` in packages/coding/src/messaging.ts. ' +
      'Then update every caller across the codebase (there are about 4-5 of them). ' +
      'Finally, run `npm run typecheck` and `npm run lint` to make sure nothing else broke. ' +
      'This is a bounded mechanical rename — the function signature stays the same, just the name changes.',
  },
  {
    id: 'h0-complex-flag',
    complexity: 'complex-flag',
    expectedHarness: 'H1_EXECUTE_EVAL',
    expectedObligationCount: { min: 4, max: 7 },
    description:
      'CLI flag addition spanning parser + logger config + a unit test + README docs. ≥2 files mutation → H1 by FEATURE_106 mutation rule. Multiple distinct independent steps test multistep_completeness ceiling behavior.',
    userMessage:
      'Add a new `--verbose` boolean flag to the CLI in src/cli/options.ts. ' +
      'The parser should recognize it and pass the value through to the logger configuration ' +
      'in src/cli/logger.ts (when verbose is true, set log level to "debug"). ' +
      'Write a small unit test for the flag-parsing branch in src/cli/options.test.ts. ' +
      'Finally, update the "Usage" section of README.md to document the new flag. ' +
      'Each step is independent and bounded — this is a single feature add, not a refactor.',
  },
]);

// ---------------------------------------------------------------------------
// systemPrompt variants under test
//
// Pinned baseline: SCOUT_IDENTITY + QUALITY_FRAMEWORK + FEATURE_112_ANCHOR
// SCOPE COMMITMENT block (verbatim from `feature_112_anchor` shipped in
// v0.7.34). The two variants under test differ ONLY in the H0 mini-planner
// addendum block + the OBLIGATIONS_OUTPUT_INSTRUCTION (which is identical
// across variants — only the planner GUIDANCE differs).
// ---------------------------------------------------------------------------

const SCOUT_IDENTITY =
  'You are Scout — the AMA entry role for a managed KodaX task. You judge task complexity ' +
  'and decide which harness profile (H0_DIRECT / H1_EXECUTE_EVAL / H2_PLAN_EXECUTE_EVAL) is ' +
  'appropriate.';

/**
 * Pinned base from `feature_112_anchor` (FEATURE_112 winner, shipped v0.7.34).
 * Captures (a) tool inventory + harness-decision framing, (b) H0/H1/H2 tier
 * definitions, (c) FEATURE_106 + FEATURE_112 scope commitment block.
 */
const PINNED_QUALITY_FRAMEWORK = [
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
  '  → Call emit_scout_verdict with confirmed_harness="H1_EXECUTE_EVAL" to escalate.',
  '',
  'H2 — New code without existing anchor: project from scratch, cross-module refactor,',
  '  new feature, system design, database migration.',
  '  → Call emit_scout_verdict with confirmed_harness="H2_PLAN_EXECUTE_EVAL" to escalate.',
  '',
  'SCOPE COMMITMENT (hard rule):',
  '  Default harness is H0_DIRECT. The triggers below are escalation conditions, not defaults —',
  '  apply them only when one fires for the current task. Simple lookups, single-file edits, and',
  '  pure answer questions stay at H0 even when the rules below are present in this prompt.',
  '',
  '  • Mutation scope: If you intend to write ≥2 files OR start a project from scratch,',
  '    call emit_scout_verdict({confirmed_harness: H1 or H2}) BEFORE the first write.',
  '  • Investigation scope: If your read-only investigation reaches ≥5 distinct files',
  '    OR ≥8 searches without converging on a diagnosis, emit_scout_verdict(H1_EXECUTE_EVAL).',
  '  • Multi-thread early decision: If your initial 1-2 scoping turns reveal ≥2',
  '    independent investigation threads, prefer dispatch_child_task over deep-diving solo.',
].join('\n');

/**
 * `light` variant: minimal 1-line mini-planner hint (current v0.7.34
 * design-doc baseline as of 2026-05-03).
 */
const LIGHT_MINI_PLANNER_BLOCK = [
  'EXECUTION OBLIGATIONS:',
  '  For any task that requires ≥ 2 distinct execution steps (whether at H0_DIRECT,',
  '  H1_EXECUTE_EVAL, or H2_PLAN_EXECUTE_EVAL), populate executionObligations with',
  '  one entry per step. The user surface will render these as a visible plan',
  '  checklist; this is a quality signal, not a routing signal.',
].join('\n');

/**
 * `heavy` variant: explicit "list plan BEFORE acting" framing + positive
 * and negative examples to guard against over-formalization.
 */
const HEAVY_MINI_PLANNER_BLOCK = [
  'EXECUTION OBLIGATIONS:',
  '  For any task that requires ≥ 2 distinct execution steps (whether at H0_DIRECT,',
  '  H1_EXECUTE_EVAL, or H2_PLAN_EXECUTE_EVAL), populate executionObligations with',
  '  one entry per step BEFORE calling emit_scout_verdict.',
  '',
  '  Examples of "distinct execution steps" (DO list separately):',
  '    - Editing files in different modules',
  '    - Refactor + verification (e.g. rename + run tests)',
  '    - Multiple changes to the same file when each is independent',
  '',
  '  Examples of NOT distinct steps (do NOT split into multiple obligations):',
  '    - Reading a file before editing it (preparation, not a step)',
  '    - "Think about X" or "analyze Y" (reasoning, not a step)',
  '    - Single-token typo fixes (single action, no plan needed)',
  '',
  '  After emit_scout_verdict, when continuing as H0_DIRECT executor, call',
  '  todo_update at each transition (pending → in_progress → completed) so the',
  '  user sees real-time progress. This gives the user a visible plan and forces',
  '  you to think through the full scope before acting.',
].join('\n');

/**
 * Common output instruction. IDENTICAL across variants — only the planner
 * GUIDANCE varies. This eliminates the "we changed the format spec by
 * accident" confound when comparing.
 */
const OBLIGATIONS_OUTPUT_INSTRUCTION = [
  'IMPORTANT — output format for this benchmark:',
  '  This benchmark harness does not provide the emit_scout_verdict tool.',
  '  Instead, output your harness + obligations decision as plain text:',
  '',
  '    HARNESS: <H0_DIRECT|H1_EXECUTE_EVAL|H2_PLAN_EXECUTE_EVAL>',
  '',
  '    OBLIGATIONS:',
  '    - <step description>',
  '    - <step description>',
  '    ...',
  '',
  '    RATIONALE: <one-line rationale>',
  '',
  '  The OBLIGATIONS list is OPTIONAL — for tasks that genuinely do not',
  '  warrant a multi-step plan (e.g. a single typo fix, a one-line lookup),',
  '  either omit the OBLIGATIONS section entirely or list 0-1 entries.',
  '  Only the HARNESS line and OBLIGATIONS list are parsed by judges; you',
  '  may include other prose above or below.',
].join('\n');

export const LIGHT_VARIANT_SYSTEM_PROMPT: string = [
  SCOUT_IDENTITY,
  PINNED_QUALITY_FRAMEWORK,
  LIGHT_MINI_PLANNER_BLOCK,
  OBLIGATIONS_OUTPUT_INSTRUCTION,
].join('\n\n');

export const HEAVY_VARIANT_SYSTEM_PROMPT: string = [
  SCOUT_IDENTITY,
  PINNED_QUALITY_FRAMEWORK,
  HEAVY_MINI_PLANNER_BLOCK,
  OBLIGATIONS_OUTPUT_INSTRUCTION,
].join('\n\n');

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

const HARNESS_PATTERN =
  /(?:HARNESS:|confirmed_harness\s*[:=]\s*"?)\s*(H0_DIRECT|H1_EXECUTE_EVAL|H2_PLAN_EXECUTE_EVAL)/i;

/**
 * Words that signal a "preparation" or "reasoning" step rather than a
 * concrete execution step. Used to flag low-coherence obligations
 * deterministically (no LLM judge needed). The list is intentionally
 * conservative — false negatives are fine, false positives (flagging a
 * legitimate step as filler) would distort the eval.
 */
const FILLER_LEAD_PATTERN =
  /^\s*(?:read(?:ing)?|examine|examining|understand(?:ing)?|review(?:ing)?\s+(?:the|how)|think(?:ing)?\s+about|consider(?:ing)?|analy[sz]e|analy[sz]ing|investigate(?:\s|$)|investigating|explore|exploring|study(?:ing)?|familiar[iy][sz]e)\b/i;

export interface ParsedObligations {
  /** Each obligation as a non-empty trimmed string, in order. */
  readonly items: readonly string[];
  /** Items whose lead word matches FILLER_LEAD_PATTERN (filler/reasoning steps). */
  readonly fillerItems: readonly string[];
  /** True if an OBLIGATIONS: section was detected at all. */
  readonly hasSection: boolean;
}

/**
 * Parse the OBLIGATIONS section from model output. Tolerant of formatting
 * variations: accepts `- item`, `* item`, `1. item`, `1) item`. Stops at
 * the next ALL-CAPS section header (RATIONALE:, NOTES:, etc.) or end of
 * text. Items must be non-empty after trimming.
 */
export function parseObligations(output: string): ParsedObligations {
  const lower = output.toLowerCase();
  const sectionStart = lower.indexOf('obligations:');
  if (sectionStart < 0) {
    return { items: [], fillerItems: [], hasSection: false };
  }

  // Skip past the "obligations:" header (regardless of its case).
  const afterHeader = output.substring(sectionStart + 'obligations:'.length);
  const lines = afterHeader.split('\n');

  const items: string[] = [];
  const fillerItems: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    // Empty line: skip but do not end the section. Some models put blank
    // lines between obligations (e.g. for visual grouping).
    if (line.length === 0) continue;

    // Stop on next section header (RATIONALE:, NOTES:, HARNESS:, etc.).
    if (/^[A-Z][A-Z _-]{2,}:\s*/.test(line)) break;

    // Bare list marker without content (e.g. "- " or "*"). Skip, don't
    // end the section — the next valid item should still be picked up.
    if (/^(?:[-*•]|\(?\d+[.)])\s*$/.test(line)) continue;

    // Match list-item prefixes: "-", "*", "1.", "1)", "(1)" etc. The
    // marker MUST be followed by ≥1 whitespace char before content. This
    // disambiguates `**RATIONALE:**` (markdown bold) from a real `* item`
    // — without the whitespace gate, `**X` would be parsed as `*` marker +
    // content `*X`, polluting the obligation list with phantom entries.
    const m = line.match(/^(?:[-*•]|\(?\d+[.)])\s+(.+)$/);
    if (!m) {
      // Non-list, non-section-header prose. If we have items already,
      // treat this as end of section (prose continuation). If not, keep
      // scanning (might be header padding or pre-list intro).
      if (items.length > 0) break;
      continue;
    }
    const content = m[1]!.trim();
    if (content.length === 0) continue;
    items.push(content);
    if (FILLER_LEAD_PATTERN.test(content)) {
      fillerItems.push(content);
    }
  }

  return { items, fillerItems, hasSection: true };
}

// ---------------------------------------------------------------------------
// Judge construction
// ---------------------------------------------------------------------------

function harnessFormatJudge(): PromptJudge {
  return {
    name: 'harness-format',
    category: 'format',
    judge(output: string) {
      if (HARNESS_PATTERN.test(output)) return { passed: true };
      return { passed: false, reason: 'no HARNESS: line found' };
    },
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
 * Pass when the parsed obligation count is in [min, max]. Records the
 * actual count in the failure reason.
 */
function obligationCountJudge(range: ObligationCountRange): PromptJudge {
  return {
    name: `obligation-count(${range.min}..${range.max})`,
    category: 'correctness',
    judge(output: string) {
      const parsed = parseObligations(output);
      const count = parsed.items.length;
      if (count >= range.min && count <= range.max) return { passed: true };
      return {
        passed: false,
        reason: `expected ${range.min}-${range.max} obligations, got ${count}`,
      };
    },
  };
}

/**
 * Pass when no parsed obligation matches FILLER_LEAD_PATTERN (no
 * "read/think/understand X" filler steps). Skips when there are 0
 * obligations.
 */
function obligationCoherenceJudge(): PromptJudge {
  return {
    name: 'obligation-coherence(no-filler)',
    category: 'style',
    judge(output: string) {
      const parsed = parseObligations(output);
      if (parsed.items.length === 0) return { passed: true };
      if (parsed.fillerItems.length === 0) return { passed: true };
      return {
        passed: false,
        reason: `${parsed.fillerItems.length} filler step(s): ${parsed.fillerItems
          .slice(0, 2)
          .map((s) => s.slice(0, 40))
          .join(' | ')}`,
      };
    },
  };
}

/**
 * Build the judge set for one task. Format + harness-correct + obligation
 * count + obligation coherence (4 judges total). Eval cases that want to
 * layer extra judges (LLM-as-judge style step-coherence) can spread the
 * result.
 */
export function buildJudges(task: H0MiniPlannerTaskCase): readonly PromptJudge[] {
  return Object.freeze([
    harnessFormatJudge(),
    harnessCorrectJudge(task.expectedHarness),
    obligationCountJudge(task.expectedObligationCount),
    obligationCoherenceJudge(),
  ]);
}

// ---------------------------------------------------------------------------
// Variant pivot for runBenchmark
// ---------------------------------------------------------------------------

export type VariantId = 'light' | 'heavy';

const VARIANT_PROMPTS: Readonly<Record<VariantId, string>> = Object.freeze({
  light: LIGHT_VARIANT_SYSTEM_PROMPT,
  heavy: HEAVY_VARIANT_SYSTEM_PROMPT,
});

export function buildPromptVariants(
  task: H0MiniPlannerTaskCase,
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
