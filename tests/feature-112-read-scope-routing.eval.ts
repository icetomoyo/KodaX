/**
 * Eval: Read-scope routing — FEATURE_112 (v0.7.34).
 *
 * ## Purpose
 *
 * Quantitatively measures whether the FEATURE_112 SCOPE COMMITMENT rewrite
 * (investigation-scope rule + multi-thread early-decision rule) shifts Scout's
 * harness choice toward `H1_EXECUTE_EVAL` for read-only deep investigation
 * tasks, **without regressing** the simple-answer case that should stay at
 * `H0_DIRECT`.
 *
 * Counterpart to `ama-harness-selection.eval.ts` (FEATURE_106), which covers
 * the mutation-side leakage. FEATURE_106 closed `multi_file_h0_rate` 15.6% →
 * 0%; FEATURE_112 attacks the symmetric read-side issue: a "why does the
 * system behave like X" question that reads 5+ files across modules currently
 * caps at H0 ceiling, so Scout has no path to emit H1 for evaluator audit.
 *
 * ## Run model
 *
 * Single-turn probe (per FEATURE_104 §single-step convention). Runs
 * `current_v0733` (v0.7.33 baseline) vs `feature_112` (post-rewrite) per
 * task per alias. The acceptance gate per `benchmark/datasets/read-scope-routing/README.md`:
 *
 *   - Shallow QA (1 case): `feature_112` ≥ 95% H0 — must not regress.
 *   - Three deep classes (3 cases): `feature_112` `read_scope_h1_rate` ≥
 *     `current_v0733` + 30 percentage points across alias mean.
 *
 * No hard `expect` assertion in this commit — the eval records baseline +
 * post-rewrite numbers per `STAGE_LABEL` for inspection. Stage gating happens
 * post-pilot once the threshold target is calibrated against real provider
 * behavior, mirroring FEATURE_092 / FEATURE_106's transition pattern.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-112-read-scope-routing
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/read-scope-routing/README.md  product question
 *   - benchmark/datasets/read-scope-routing/cases.ts   tasks + variants + judges
 *   - docs/features/v0.7.34.md#feature_112              design + acceptance criteria
 *   - tests/ama-harness-selection.eval.ts               mutation-side counterpart
 */

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { writeBenchmarkReport } from '../benchmark/harness/persist.js';
import {
  READ_SCOPE_TASKS,
  buildJudges,
  buildPromptVariants,
  type VariantId,
} from '../benchmark/datasets/read-scope-routing/cases.js';

const ACTIVE_VARIANTS: readonly VariantId[] = ['current_v0733', 'feature_112'];

const STAGE_LABEL = 'stage1-comparison';

// Single run per cell keeps the wall clock predictable. With 4 tasks × N
// alias × 2 variants × 1 run, a 3-alias smoke run is ~30s; the full
// 8-alias matrix is ~2-3 minutes.
const RUNS_PER_CELL = 1;

describe('Eval: Read-scope routing (FEATURE_112)', () => {
  const aliases = availableAliases();
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const task of READ_SCOPE_TASKS) {
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

        const slug = `feature-112--${STAGE_LABEL}--${task.id}`;
        await writeBenchmarkReport(result, { timestampSlug: slug });

        // Record dominant variants per task for visual inspection. Stage 1
        // gating (regression on shallow-qa, ≥30pp lift on deep classes) is
        // promoted from console-log to expect.fail post-pilot.
        const passingVariants = result.variantsDominantOnEveryModel;
        // eslint-disable-next-line no-console
        console.log(
          `[feature-112][${task.id}] dominant variants: ${
            passingVariants.length === 0 ? '(none)' : passingVariants.join(', ')
          }`,
        );
      },
    );
  }
});
