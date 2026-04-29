/**
 * Eval: AMA harness selection — Stage 2 reasoning sweep — FEATURE_106 (v0.7.31).
 *
 * ## Purpose
 *
 * Stage 1 (`ama-harness-selection.eval.ts`) ran prompt × alias and showed
 * the FEATURE_106 prompt rewrite drives `multi_file_h0_rate` from 15.6% →
 * 0%. Stage 2 adds the reasoning axis to test the FEATURE_103 v0.7.29
 * Scout reasoning bump (`quick → balanced`) — the design doc lists
 * "更深 reasoning 让 Scout 更自信"我能搞定"" as a contributing factor to
 * v0.7.30's H0-leak bug, so we need data to decide whether to keep
 * `balanced` (FEATURE_103 default) or revert to `quick`.
 *
 * ## Matrix
 *
 *   6 task × 3 alias (kimi / ds/v4pro / zhipu/glm51) × 2 prompt
 *     (current / feature_106) × 3 reasoning (low / medium / high)
 *   = 108 cells, 1 run per cell.
 *
 * Three alias coverage spans 3 of the 5 provider families (Moonshot /
 * DeepSeek / Zhipu); enough to detect family-specific reasoning effects
 * without the wall-clock cost of all 8 alias × 3 reasoning.
 *
 * ## Reasoning depth → KodaXThinkingDepth mapping
 *
 *   FEATURE_103 design term  | KodaXThinkingDepth value
 *   -----------------------  | -----------------------
 *   `quick`                  | `'low'`
 *   `balanced`               | `'medium'`  (FEATURE_103 default)
 *   `deep`                   | `'high'`
 *
 * ## Decision rule (from `docs/features/v0.7.31.md` §Eval Plan):
 *
 *   - balanced 显著优于 quick → 保留 FEATURE_103
 *   - 三档差异在 noise 内       → 保留 FEATURE_103 (default)
 *   - quick 显著优于 balanced   → 回退到 quick
 *
 * ## Run
 *
 *   npm run test:eval -- ama-harness-selection-stage2
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - tests/ama-harness-selection.eval.ts          Stage 1 baseline
 *   - benchmark/datasets/ama-harness-selection/    cases + variants
 *   - docs/features/v0.7.31.md §Eval Plan          decision matrix
 */

import { describe, it } from 'vitest';
import type { KodaXThinkingDepth } from '@kodax/ai';

import type { ModelAlias } from '../benchmark/harness/aliases.js';
import { availableAliases } from '../benchmark/harness/aliases.js';
import {
  runBenchmark,
  type PromptVariant,
} from '../benchmark/harness/harness.js';
import { writeBenchmarkReport } from '../benchmark/harness/persist.js';
import {
  AMA_HARNESS_TASKS,
  CURRENT_VARIANT_SYSTEM_PROMPT,
  FEATURE_106_VARIANT_SYSTEM_PROMPT,
  buildJudges,
} from '../benchmark/datasets/ama-harness-selection/cases.js';

const STAGE_2_ALIAS_FILTER: readonly ModelAlias[] = [
  'kimi',
  'ds/v4pro',
  'zhipu/glm51',
];

interface ReasoningCell {
  readonly id: 'quick' | 'balanced' | 'deep';
  readonly depth: KodaXThinkingDepth;
}

const REASONING_PROFILES: readonly ReasoningCell[] = [
  { id: 'quick', depth: 'low' },
  { id: 'balanced', depth: 'medium' },
  { id: 'deep', depth: 'high' },
];

const STAGE_LABEL = 'stage2-reasoning-sweep';
const RUNS_PER_CELL = 1;

describe('Eval: AMA harness selection Stage 2 — reasoning sweep (FEATURE_106 / FEATURE_103)', () => {
  const allAvailable = availableAliases();
  const aliases = allAvailable.filter((a) =>
    STAGE_2_ALIAS_FILTER.includes(a as ModelAlias),
  );

  if (aliases.length === 0) {
    it('skips: no Stage 2 alias keys in env (kimi / ds/v4pro / zhipu/glm51)', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const task of AMA_HARNESS_TASKS) {
    it(
      `${task.id} (${task.taskClass}, expected=${task.expectedHarness}) — ${STAGE_LABEL}`,
      { timeout: 10 * 60_000 },
      async () => {
        const variants: PromptVariant[] = [];
        for (const promptVariant of ['current', 'feature_106'] as const) {
          const systemPrompt =
            promptVariant === 'current'
              ? CURRENT_VARIANT_SYSTEM_PROMPT
              : FEATURE_106_VARIANT_SYSTEM_PROMPT;
          for (const reasoning of REASONING_PROFILES) {
            variants.push({
              id: `${promptVariant}-${reasoning.id}`,
              description: `${promptVariant} prompt × reasoning=${reasoning.id} × task=${task.id}`,
              systemPrompt,
              userMessage: task.userMessage,
              reasoning: {
                enabled: reasoning.depth !== 'off',
                depth: reasoning.depth,
                taskType: 'conversation',
              },
            });
          }
        }

        const judges = buildJudges(task.expectedHarness);
        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        const slug = `${STAGE_LABEL}--${task.id}`;
        await writeBenchmarkReport(result, { timestampSlug: slug });

        const passingVariants = result.variantsDominantOnEveryModel;
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
