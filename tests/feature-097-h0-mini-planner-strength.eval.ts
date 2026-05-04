/**
 * Eval: H0 Mini-Planner Strength — FEATURE_097 (v0.7.34) release gate.
 *
 * ## Purpose
 *
 * A/B comparison of `light` vs `heavy` Scout role-prompt mini-planner wording.
 * Decides which variant ships in v0.7.34 based on data, not preference.
 *
 * The two competing forces (per design-doc §H0 Mini-Planner 强度 A/B Eval):
 *
 *   - **More planning** = better multi-step task visibility + ReAct-style
 *     "list before acting" quality lift. Hypothesis: heavy variant produces
 *     more structured obligation lists on multi-step tasks.
 *
 *   - **Less planning** = no over-formalization of simple tasks (typo fix
 *     should NOT yield a 3-step plan). Hypothesis: heavy examples (positive
 *     and negative) keep simple tasks at 0-1 obligations.
 *
 * Both hypotheses must be validated jointly: a variant that wins multistep
 * but breaks simple is NOT acceptable.
 *
 * ## Run model
 *
 * Single-turn probe per FEATURE_104 §single-step convention. 4 tasks × 2
 * variants × N alias × 1 run/cell. Pilot run is 1 run/cell (matches
 * FEATURE_106/112 stage 1 convention); post-pilot may bump to 3 run/cell.
 *
 * Acceptance gate per `benchmark/datasets/scout-h0-mini-planner/README.md`:
 *
 *   - `simple_overformalization_rate` ≤ 15%
 *   - `multistep_completeness` ≥ 70%
 *   - `obligation_coherence` ≥ 80% mean
 *   - `h0_harness_retain` ≥ 90% (no FEATURE_112 H1-promotion regression)
 *
 * Pre-decision matrix (committed before run, NOT adjusted post-hoc):
 *
 *   | Heavy vs Light                                | Ship   |
 *   |-----------------------------------------------|--------|
 *   | multistep +15pp AND simple ≤ +5pp             | Heavy  |
 *   | multistep +15pp BUT simple > +5pp             | Iter 1 round; still over → Light |
 *   | both ±5pp (within noise)                      | Light (shorter prompt) |
 *   | simple worse AND multistep no gain            | Light  |
 *
 * No hard `expect.fail` in this commit — the eval records baseline + heavy
 * numbers per `STAGE_LABEL` for inspection. Stage gating happens post-pilot
 * once the threshold target is calibrated against real provider behavior,
 * mirroring FEATURE_106 / FEATURE_112's transition pattern.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-097-h0-mini-planner-strength
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/scout-h0-mini-planner/README.md  product question
 *   - benchmark/datasets/scout-h0-mini-planner/cases.ts   tasks + variants + judges
 *   - docs/features/v0.7.34.md#feature_097                 design + acceptance criteria
 *   - tests/feature-112-read-scope-routing.eval.ts         sibling pattern
 */

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { writeBenchmarkReport } from '../benchmark/harness/persist.js';
import {
  H0_MINI_PLANNER_TASKS,
  buildJudges,
  buildPromptVariants,
  parseObligations,
  type VariantId,
} from '../benchmark/datasets/scout-h0-mini-planner/cases.js';

const ACTIVE_VARIANTS: readonly VariantId[] = ['light', 'heavy'];

const STAGE_LABEL = 'pilot-1run';

// Single run per cell keeps the wall clock predictable for the pilot.
// 4 tasks × 8 alias × 2 variants × 1 run = 64 calls (~3-5 minutes).
// Post-pilot may bump to 3 run/cell once the variant decision is locked.
const RUNS_PER_CELL = 1;

describe('Eval: H0 mini-planner strength A/B (FEATURE_097)', () => {
  const aliases = availableAliases();
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const task of H0_MINI_PLANNER_TASKS) {
    it(
      `${task.id} (${task.complexity}, expected ${task.expectedObligationCount.min}-${task.expectedObligationCount.max} obligations) — ${STAGE_LABEL}`,
      { timeout: 5 * 60_000 },
      async () => {
        const variants = buildPromptVariants(task, ACTIVE_VARIANTS);
        const judges = buildJudges(task);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const slug = `feature-097--${STAGE_LABEL}--${task.id}`;
        await writeBenchmarkReport(result, { timestampSlug: slug });

        // Per-cell obligation count diagnostic. Logs the parsed obligation
        // count for each (variant × alias) cell so we can see at a glance
        // whether heavy variant under/over-decomposes vs light.
        const lines: string[] = [];
        lines.push(`[feature-097][${task.id}] obligation counts per cell:`);
        for (const variantId of ACTIVE_VARIANTS) {
          const cells = result.byVariant[variantId] ?? [];
          for (const cell of cells) {
            const firstRun = cell.runsRaw[0];
            if (!firstRun) continue;
            const parsed = parseObligations(firstRun.text);
            const harnessMatch = firstRun.text.match(/HARNESS:\s*(\w+)/i);
            const harness = harnessMatch?.[1] ?? '???';
            const filler = parsed.fillerItems.length;
            const passed = firstRun.passed ? 'PASS' : 'FAIL';
            lines.push(
              `  ${variantId.padEnd(6)} ${cell.alias.padEnd(13)} harness=${harness.padEnd(18)} obligations=${String(parsed.items.length).padStart(2)} filler=${filler} ${passed}`,
            );
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Dominance summary (purely structural — no expect assertions yet).
        const dominant = result.variantsDominantOnEveryModel;
        // eslint-disable-next-line no-console
        console.log(
          `[feature-097][${task.id}] dominant variants: ${
            dominant.length === 0 ? '(none — split decision)' : dominant.join(', ')
          }`,
        );
      },
    );
  }
});
