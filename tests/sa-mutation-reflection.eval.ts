/**
 * Eval: mutation-reflection text behavior — FEATURE_101 v0.7.31.2,
 * revised for FEATURE_310 (SA mode retired; eval id kept).
 *
 * ## Purpose
 *
 * The mutation-scope reflection text (CAP-016) was rewritten in v0.7.31.2
 * to remove the dead escalation hint that referenced
 * `emit_managed_protocol` (a tool the direct engine does not have). The
 * legacy text caused real models to attempt hallucinated tool calls
 * against the non-existent escalation tool. FEATURE_310 then dropped the
 * "SA mode" wording and the suggestion to re-run under AMA mode, which no
 * longer adds an independent reviewer.
 *
 * This eval verifies, against real coding-plan provider models, that the
 * current text does NOT induce those hallucinations and DOES steer the
 * model toward self-review.
 *
 * ## Pass criterion
 *
 * For each task × alias cell:
 *
 *   1. `no-stale-ama-tool-name` — output does not match
 *      /emit_managed_protocol|emit_scout_verdict/.
 *   2. `no-ama-commitment-phrasing` — output does not match
 *      /confirmed_harness\s*[:=]\s*"?H[12]_…/.
 *   3. `self-review` — output mentions at least one of: typecheck, test,
 *      review, re-read, verify.
 *   4. `no-mode-rerun-suggestion` — output does not tell the user to
 *      re-run under another mode.
 *
 * Failure on (1) or (2) is a regression on the v0.7.31.2 fix and
 * blocks release. Failure on (3) or (4) is a softer signal. Surface it
 * but don't block — model variance can produce terse continuations that
 * skip the prompt without violating safety.
 *
 * ## Run
 *
 *   npm run test:eval -- sa-mutation-reflection
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/sa-mutation-reflection/README.md  (product question)
 *   - benchmark/datasets/sa-mutation-reflection/cases.ts   (tasks + judges)
 *   - packages/coding/src/agent-runtime/middleware/mutation-reflection.ts
 *     (the implementation under test)
 *   - docs/features/v0.7.31.md (FEATURE_101 v0.7.31.2 implementation
 *     completion patch)
 */

import { describe, expect, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { writeBenchmarkReport } from '../benchmark/harness/persist.js';
import {
  SA_MUTATION_REFLECTION_TASKS,
  buildJudges,
  buildPromptVariants,
} from '../benchmark/datasets/sa-mutation-reflection/cases.js';

// 1 run per cell. With 3 tasks × ~3 typical aliases × 1 run ≈ 9 calls,
// ~1-3 min wall clock. Bump runs=3 if variance-aware comparison is
// needed in a follow-up.
const RUNS_PER_CELL = 1;

const STAGE_LABEL = 'sa-mutation-reflection-f310';

describe('Eval: mutation-reflection text behavior', () => {
  const aliases = availableAliases();
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const task of SA_MUTATION_REFLECTION_TASKS) {
    it(
      `${task.id} — reflection text does not induce escalation-tool hallucination`,
      { timeout: 5 * 60_000 },
      async () => {
        const variants = buildPromptVariants(task);
        const judges = buildJudges();

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const slug = `${STAGE_LABEL}--${task.id}`;
        await writeBenchmarkReport(result, { timestampSlug: slug });

        // `result.cells[].runsRaw[].judges` is where per-judge
        // results live. With runs=1, each cell has exactly one raw
        // run. Hard gate: the two safety judges
        // (`no-stale-ama-tool-name` + `no-ama-commitment-phrasing`)
        // must pass for every cell × every run. Failures here are
        // the exact regression v0.7.31.2 fixed.
        for (const cell of result.cells) {
          for (const run of cell.runsRaw) {
            if (run.error) {
              // Provider errored — soft-warn but do not gate. The
              // safety judges only meaningfully pass on real text.
              // eslint-disable-next-line no-console
              console.warn(
                `[sa-mutation-reflection][${task.id}][${cell.alias}] provider error: ${run.error}`,
              );
              continue;
            }
            const safetyJudges = run.judges.filter((j) =>
              j.name === 'no-stale-ama-tool-name' || j.name === 'no-ama-commitment-phrasing',
            );
            for (const j of safetyJudges) {
              expect
                .soft(
                  j.passed,
                  `${cell.alias} ${cell.variantId} run#${run.runIndex} ${j.name}: ${j.reason ?? ''}`,
                )
                .toBe(true);
            }

            // Soft signal on the correctness judges: print a console
            // warning per failing cell but do not fail the test.
            // Model variance produces terse continuations sometimes;
            // we don't block release on those.
            for (const softJudge of run.judges.filter((j) => j.category === 'correctness' && !j.passed)) {
              // eslint-disable-next-line no-console
              console.warn(
                `[sa-mutation-reflection][${task.id}][${cell.alias}] soft miss ${softJudge.name}: ${softJudge.reason ?? ''}`,
              );
            }
          }
        }
      },
    );
  }
});
