/**
 * Eval: FEATURE_097 prompt behaviors — v0.7.34 release gate.
 *
 * ## Purpose
 *
 * Verifies the four prompt-eval triggers from `docs/features/v0.7.34.md`
 * §"Prompt eval 触发清单" that are NOT covered by the standalone H0
 * mini-planner A/B eval (`feature-097-h0-mini-planner-strength.eval.ts`):
 *
 *   1. throttle_reminder_recovery — Layer 2 reminder (§5 ②) actually
 *      gets the model to call `todo_update` after the threshold fires.
 *   2. unknown_id_recovery — §5 ⑤ self-correction contract: when the
 *      tool returns `{ok:false, reason:"Unknown todo id: ... Current
 *      valid ids: ..."}`, the model retries with a valid id.
 *   3. generator_step_progression — Generator follows the role-prompt
 *      rule "every time you finish an item you MUST call todo_update".
 *   4. planner_refinement — Planner refines coarse Scout obligations
 *      into a structured contract / success-criteria list.
 *
 * ## Run model
 *
 * Single-turn probe per FEATURE_104 §single-step convention. Each case
 * runs once per available alias × one variant ("v0.7.34"). Pilot is 1
 * run/cell; post-pilot may bump to 3 if variance warrants.
 *
 * **Stage-1 acceptance gate** (per design §"Prompt eval 触发清单",
 * sharing the FEATURE_106 / FEATURE_112 threshold):
 *
 *   - 8 alias mean ≥ 80% pass per case.
 *
 * No hard `expect.fail` in this commit — the eval records numbers per
 * case for inspection, mirroring the FEATURE_106 / 112 transition
 * pattern. Stage gating to `expect.fail` is promoted post-pilot once
 * the threshold is calibrated.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-097-prompt-behaviors
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-097-prompt-behaviors/cases.ts (data)
 *   - tests/feature-097-h0-mini-planner-strength.eval.ts (H0 A/B sibling)
 *   - docs/features/v0.7.34.md#feature_097 (design + acceptance criteria)
 */

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { writeBenchmarkReport } from '../benchmark/harness/persist.js';
import {
  CASES,
  buildJudges,
  buildPromptVariants,
} from '../benchmark/datasets/feature-097-prompt-behaviors/cases.js';

const STAGE_LABEL = 'pilot-1run';
const RUNS_PER_CELL = 1;

describe('Eval: FEATURE_097 prompt behaviors (v0.7.34)', () => {
  const aliases = availableAliases();
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      { timeout: 5 * 60_000 },
      async () => {
        const variants = buildPromptVariants(c.id);
        const judges = buildJudges(c.id);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const slug = `feature-097-prompt-behaviors--${STAGE_LABEL}--${c.id}`;
        await writeBenchmarkReport(result, { timestampSlug: slug });

        // Per-cell pass/fail diagnostic so the run-log immediately tells
        // us which alias × case cells failed and why. Mirrors the
        // FEATURE_097 H0 mini-planner eval style.
        const lines: string[] = [];
        lines.push(`[feature-097-prompt-behaviors][${c.id}]`);
        lines.push(`  behaviour: ${c.behaviour}`);
        const cells = result.byVariant['v0.7.34'] ?? [];
        let passCount = 0;
        for (const cell of cells) {
          const firstRun = cell.runsRaw[0];
          if (!firstRun) continue;
          if (firstRun.passed) passCount++;
          const status = firstRun.passed ? 'PASS' : 'FAIL';
          const failedJudges = firstRun.judges
            .filter((j) => !j.passed)
            .map((j) => j.name)
            .join(',');
          lines.push(
            `  ${cell.alias.padEnd(13)} ${status}` +
              (failedJudges ? `  (failed: ${failedJudges})` : ''),
          );
        }
        const passRate = cells.length > 0
          ? ((passCount / cells.length) * 100).toFixed(1)
          : 'n/a';
        lines.push(`  pass-rate: ${passCount}/${cells.length} (${passRate}%)`);
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));
      },
    );
  }
});
