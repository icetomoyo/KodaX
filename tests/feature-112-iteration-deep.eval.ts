/**
 * Iteration eval round 2: confirm `feature_112_anchor` preserves the deep-class
 * H1 lift that `feature_112` showed in Stage 1 (deep-systemic +50pp alias mean).
 *
 * Round 1 (`tests/feature-112-iteration.eval.ts`) showed `feature_112_anchor`
 * is the most-stable shallow-qa variant (5/6 effective alias retain H0,
 * vs feature_112's 4/6, vs baseline's 3/6). All 0-scores were format-fails,
 * not "model upgrades H0 → H1" — so the regression worry was a noise
 * artifact in Stage 1. The anchor variant adds an explicit "Default is H0"
 * preamble without removing any escalation rule, so the deep-class H1 gain
 * is logically preserved — but we verify empirically before promoting it
 * to production role-prompt.ts.
 *
 * Scope: deep-systemic only, 2 variants × 8 alias = 16 cells. Should fit
 * within 10 min wall clock without timeout, leaving room for writeBenchmarkReport.
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

const FOCUSED_VARIANTS: readonly VariantId[] = ['current_v0733', 'feature_112_anchor'];

const STAGE_LABEL = 'iteration--anchor-deep-confirm';

const FOCUSED_TASK_ID = 'read-deep-systemic';

const RUNS_PER_CELL = 1;

describe('Eval: FEATURE_112 iteration round 2 (anchor preserves deep gain?)', () => {
  const aliases = availableAliases();
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible.
    });
    return;
  }

  const focused = READ_SCOPE_TASKS.find((t) => t.id === FOCUSED_TASK_ID);
  if (!focused) {
    throw new Error(`Focused task not found: ${FOCUSED_TASK_ID}`);
  }

  it(
    `${focused.id} (${focused.taskClass}, expected=${focused.expectedHarness}) — ${STAGE_LABEL}`,
    { timeout: 10 * 60_000 },
    async () => {
      const variants = buildPromptVariants(focused, FOCUSED_VARIANTS);
      const judges = buildJudges(focused.expectedHarness);

      const result = await runBenchmark({
        variants,
        models: aliases,
        judges,
        runs: RUNS_PER_CELL,
      });

      const slug = `feature-112--${STAGE_LABEL}--${focused.id}`;
      await writeBenchmarkReport(result, { timestampSlug: slug });

      const passingVariants = result.variantsDominantOnEveryModel;
      // eslint-disable-next-line no-console
      console.log(
        `[feature-112 iteration round2][${focused.id}] dominant variants: ${
          passingVariants.length === 0 ? '(none)' : passingVariants.join(', ')
        }`,
      );
    },
  );
});
