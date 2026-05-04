/**
 * Iteration eval: FEATURE_112 prompt-length / H0-anchor variants.
 *
 * Stage 1 (`tests/feature-112-read-scope-routing.eval.ts`) found `mmx/m27`
 * regressing on `read-shallow-qa` from 100% → 0% under `feature_112` —
 * the actual cause was prompt-length-induced output garbling
 * (`"packageashawn张扬你是"` hallucination), not "model upgrades simple
 * QA to H1". This iteration tests two hypotheses:
 *
 *   - **A — length** (`feature_112_compact`): cuts SCOPE COMMITMENT
 *     verbosity ~40% so the working instruction set fits within mmx's
 *     stable prompt window.
 *   - **B — semantics** (`feature_112_anchor`): keeps verbose rules but
 *     prepends an explicit "Default harness is H0_DIRECT" reverse anchor
 *     to test whether garbling came from missing H0-default semantics.
 *
 * Decision rule: pick the variant that
 *   1. preserves shallow-qa H0 retention on every alias (no regression vs. baseline),
 *   2. matches or beats `feature_112` on the deep classes (deep-systemic etc.),
 *   3. has fewer format-fail cells across the matrix.
 *
 * If `compact` wins, length was the root cause. If `anchor` wins, semantics
 * was the root cause. If both win equally, we ship `compact` (shorter prompt
 * is strictly better for token cost).
 *
 * Scope: only the two diagnostically-loaded tasks — `read-shallow-qa`
 * (regression case) and `read-deep-systemic` (main goal). Multithread /
 * unknown-heavy can be added once the winner is picked.
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

const ITERATION_VARIANTS: readonly VariantId[] = [
  'current_v0733',
  'feature_112',
  'feature_112_compact',
  'feature_112_anchor',
];

const STAGE_LABEL = 'iteration--length-vs-anchor';

// Only the two diagnostically-loaded tasks — keeps wall clock predictable
// while still measuring both directions of the trade-off.
const ITERATION_TASK_IDS = new Set(['read-shallow-qa', 'read-deep-systemic']);

const RUNS_PER_CELL = 1;

describe('Eval: FEATURE_112 iteration (length vs anchor)', () => {
  const aliases = availableAliases();
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible.
    });
    return;
  }

  const focusedTasks = READ_SCOPE_TASKS.filter((t) => ITERATION_TASK_IDS.has(t.id));

  for (const task of focusedTasks) {
    it(
      `${task.id} (${task.taskClass}, expected=${task.expectedHarness}) — ${STAGE_LABEL}`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = buildPromptVariants(task, ITERATION_VARIANTS);
        const judges = buildJudges(task.expectedHarness);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const slug = `feature-112--${STAGE_LABEL}--${task.id}`;
        await writeBenchmarkReport(result, { timestampSlug: slug });

        const passingVariants = result.variantsDominantOnEveryModel;
        // eslint-disable-next-line no-console
        console.log(
          `[feature-112 iteration][${task.id}] dominant variants: ${
            passingVariants.length === 0 ? '(none)' : passingVariants.join(', ')
          }`,
        );
      },
    );
  }
});
