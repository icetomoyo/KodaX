/**
 * Eval: AMA harness selection calibration — FEATURE_106 (v0.7.31).
 *
 * ## Purpose
 *
 * Quantitatively measures whether the Scout role-prompt correctly classifies
 * tasks into H0_DIRECT / H1_EXECUTE_EVAL / H2_PLAN_EXECUTE_EVAL across the
 * 8 coding-plan provider/model aliases (`benchmark/harness/aliases.ts`).
 *
 * v0.7.30 implementation report: complex multi-file projects all sink to
 * H0_DIRECT — the bug FEATURE_106 fixes. This eval is the empirical proof
 * before / after.
 *
 * ## Stages
 *
 * - **Stage 0 (this commit)**: baseline — `current` variant only, locks in
 *   the v0.7.30 numbers we're trying to beat. Skipped automatically when
 *   `feature_106` variant is undefined (placeholder), so this same file
 *   transitions cleanly to Stage 1 once Slice 2 lands.
 *
 * - **Stage 1** (after FEATURE_106 Slice 2 fills `feature_106` prompt):
 *   `current` vs `feature_106` × 8 alias × 6 task = 96 cells. Hard gate:
 *   feature_106 multi_file_h0_rate ≤5%, task_quality not regressed.
 *
 * - **Stage 2** (after Stage 1 passes): adds reasoning profile axis. 6
 *   task × 3 alias (kimi / ds/v4pro / zhipu/glm51) × 2 prompt × 3 reasoning
 *   = 108 cells. Decides FEATURE_103 reasoning fate.
 *
 * ## Run
 *
 *   npm run test:eval -- ama-harness-selection
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/ama-harness-selection/README.md  product question
 *   - benchmark/datasets/ama-harness-selection/cases.ts   task + variant + judges
 *   - docs/features/v0.7.31.md#feature_106-ama-harness-selection-calibration
 */

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { writeBenchmarkReport } from '../benchmark/harness/persist.js';
import {
  AMA_HARNESS_TASKS,
  buildJudges,
  buildPromptVariants,
  type VariantId,
} from '../benchmark/datasets/ama-harness-selection/cases.js';

// ---------------------------------------------------------------------------
// Stage selection
// ---------------------------------------------------------------------------

/**
 * Variant set: Stage 1 onward — both `current` (v0.7.30 baseline) and
 * `feature_106` (post-Slice 2) variants run together so the comparison
 * is single-pass. Stage 2 will add a reasoning-profile axis on top.
 *
 * The Stage 0 baseline-only mode (current variant alone, used when
 * feature_106 was undefined during the transition) is no longer needed
 * — Slice 2 has landed and the post-rewrite prompt is the canonical
 * v0.7.31 candidate.
 */
const ACTIVE_VARIANTS: readonly VariantId[] = ['current', 'feature_106'];

const STAGE_LABEL = 'stage1-comparison';

// Stage 1 / Stage 0: 1 run per cell keeps the wall clock manageable
// (8 alias × 6 task × N variant × 1 run ≈ 1-2 minutes per provider).
// Stage 2 will bump runs=3 for variance, but also reduce alias to 3.
const RUNS_PER_CELL = 1;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Eval: AMA harness selection calibration (FEATURE_106)', () => {
  const aliases = availableAliases();
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  // One vitest case per task — keeps each task's pass/fail clearly
  // attributable in the test runner (and prevents a single H2 failure
  // from masking H0/H1 cells).
  for (const task of AMA_HARNESS_TASKS) {
    it(
      `${task.id} (${task.taskClass}, expected=${task.expectedHarness}) — ${STAGE_LABEL}`,
      { timeout: 5 * 60_000 },
      async () => {
        const variants = buildPromptVariants(task, ACTIVE_VARIANTS);
        const judges = buildJudges(task.expectedHarness);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        // Persist per-task results under a stable timestamped dir so the
        // full eval suite produces ONE results bundle (rather than 6
        // separate timestamped dirs that would each contain one task).
        const slug = `${STAGE_LABEL}--${task.id}`;
        await writeBenchmarkReport(result, { timestampSlug: slug });

        // No hard assertion on Stage 0: we're recording baseline, not
        // gating on it. Stage 1 onward will assert variant comparisons
        // here. The result is captured to disk for inspection
        // regardless.
        const passingVariants = result.variantsDominantOnEveryModel;
        // Vitest's structured output captures this; CI can grep for it.
        // eslint-disable-next-line no-console
        console.log(
          `[${task.id}] dominant variants: ${
            passingVariants.length === 0 ? '(none)' : passingVariants.join(', ')
          }`,
        );
      },
    );
  }
});
