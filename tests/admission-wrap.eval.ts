/**
 * Eval: admission systemPrompt double-wrap non-degradation
 * — FEATURE_101 v0.7.31.1, design open question Q6 closure (real-LLM lane).
 *
 * ## Purpose
 *
 * Runs paired `unwrapped` vs `wrapped` system prompts across 5 deterministic
 * tasks × N coding-plan provider/model aliases. The wrap text is sourced
 * verbatim from the production `buildSystemPrompt` in
 * `packages/core/src/runner.ts` (TRUSTED_HEADER + fence + TRUSTED_FOOTER),
 * so any change to the wrap text re-runs against the same dataset on the
 * next eval pass.
 *
 * ## Pass criterion
 *
 * For each task × alias cell, both variants are independently judged.
 * Non-degradation declared when, across all cells, `wrapped` quality is
 * no worse than `unwrapped` quality minus 2 percentage points (FEATURE_104
 * convention noise tolerance). The gate fires per-cell so a single bad
 * cell surfaces clearly instead of being masked by averages.
 *
 * The gate is `expect`-driven so failures are visible in vitest output.
 * Skipped tasks (no API key) are no-ops — the suite degrades gracefully
 * to "no providers configured, nothing to evaluate".
 *
 * ## Run
 *
 *   npm run test:eval -- admission-wrap
 *   # or:
 *   npx vitest run -c vitest.eval.config.ts tests/admission-wrap.eval.ts
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/admission-wrap-baseline/README.md   (product question)
 *   - benchmark/datasets/admission-wrap-baseline/cases.ts    (tasks + variants + judges)
 *   - docs/features/v0.7.31.md (FEATURE_101 §Q6 resolution)
 */

import { describe, expect, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { writeBenchmarkReport } from '../benchmark/harness/persist.js';
import {
  WRAP_TASKS,
  buildJudges,
  buildPromptVariants,
} from '../benchmark/datasets/admission-wrap-baseline/cases.js';

// 1 run per cell keeps the wall clock manageable. With 5 tasks × 2
// variants × 3 typical aliases × 1 run ≈ 30 calls, ~3-5 min total.
// Bump runs=3 if variance-aware comparison is needed in a future patch.
const RUNS_PER_CELL = 1;

// FEATURE_104 convention noise tolerance: 2 percentage points. Wrap
// quality dropping more than this from unwrapped is real degradation,
// not run-to-run noise.
const NON_DEGRADATION_TOLERANCE_PP = 2;

const STAGE_LABEL = 'admission-wrap-baseline';

describe('Eval: admission systemPrompt double-wrap non-degradation (Q6)', () => {
  const aliases = availableAliases();
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const task of WRAP_TASKS) {
    it(
      `${task.id} — wrapped vs unwrapped non-degradation`,
      { timeout: 5 * 60_000 },
      async () => {
        const variants = buildPromptVariants(task);
        const judges = buildJudges(task.id);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        // Persist per-task report under a stable timestamped slug so
        // the full eval suite produces ONE results bundle.
        const slug = `${STAGE_LABEL}--${task.id}`;
        await writeBenchmarkReport(result, { timestampSlug: slug });

        // Per-cell non-degradation gate: for every alias, the wrapped
        // variant's quality must be within tolerance of unwrapped.
        for (const alias of aliases) {
          const unwrapped = result.byVariant.unwrapped?.find((c) => c.alias === alias);
          const wrapped = result.byVariant.wrapped?.find((c) => c.alias === alias);
          if (!unwrapped || !wrapped) continue;
          const delta = wrapped.quality - unwrapped.quality;
          if (delta < -NON_DEGRADATION_TOLERANCE_PP) {
            // Build a diagnostic message that surfaces both qualities so
            // the failure is actionable from CI logs alone.
            const msg =
              `[${task.id} on ${alias}] wrap degradation > ${NON_DEGRADATION_TOLERANCE_PP}pp: `
              + `unwrapped quality=${unwrapped.quality}, wrapped quality=${wrapped.quality} `
              + `(delta=${delta}). Inspect benchmark/results/<timestamp>--${slug}/ for raw outputs.`;
            // Use expect so vitest captures the message in its output.
            expect.fail(msg);
          }
        }

        // Always log the per-task summary line so non-failing runs still
        // produce visible signal in CI output.
        // eslint-disable-next-line no-console
        console.log(
          `[admission-wrap eval] task=${task.id} cells=${result.cells.length} `
          + `wrappedDominant=${result.variantsDominantOnEveryModel.includes('wrapped')} `
          + `unwrappedDominant=${result.variantsDominantOnEveryModel.includes('unwrapped')}`,
        );
      },
    );
  }
});
