/**
 * FEATURE_112 docs-only coverage: verify the production anchor variant
 * routes docs-only tasks to the right ceiling.
 *
 * Background: read-scope-routing iteration rounds 1+2 selected
 * `feature_112_anchor` for the read-only side. The production
 * `deriveTopologyCeiling` merges `docs-only` and `read-only` into the
 * same branch (H0 default, H1 when complex/systemic), so the routing
 * logic for docs-only is shipped — but it had no eval coverage. This
 * eval closes that gap by probing the two corners of the docs-only
 * branch:
 *
 *   • `docs-shallow-fix` — single typo fix → expected H0_DIRECT
 *     (regression guard: docs-only simple edits must not bloat into H1)
 *   • `docs-deep-consistency` — multi-doc audit + rewrite plan →
 *     expected H1_EXECUTE_EVAL (the FEATURE_112 win for docs-side)
 *
 * Decision rule: anchor must not regress baseline on the shallow case
 * (no model that retained H0 on baseline may flip to H1 under anchor),
 * and should match-or-beat baseline on the deep case (more H1 dominance
 * cells). 2 variants × 2 tasks × 8 alias = 32 cells, ~7 min wall-clock.
 */

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { writeBenchmarkReport } from '../benchmark/harness/persist.js';
import {
  DOCS_SCOPE_TASKS,
  buildJudges,
  buildPromptVariants,
  type DocsVariantId,
} from '../benchmark/datasets/docs-scope-routing/cases.js';

const VARIANTS: readonly DocsVariantId[] = ['current_v0733', 'feature_112_anchor'];

const STAGE_LABEL = 'docs-only-coverage';

const RUNS_PER_CELL = 1;

describe('Eval: FEATURE_112 docs-only coverage', () => {
  const aliases = availableAliases();
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible.
    });
    return;
  }

  for (const task of DOCS_SCOPE_TASKS) {
    it(
      `${task.id} (${task.taskClass}, expected=${task.expectedHarness}) — ${STAGE_LABEL}`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants = buildPromptVariants(task, VARIANTS);
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
          `[feature-112 docs][${task.id}] dominant variants: ${
            passingVariants.length === 0 ? '(none)' : passingVariants.join(', ')
          }`,
        );
      },
    );
  }
});
