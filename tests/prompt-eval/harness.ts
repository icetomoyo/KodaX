/**
 * FEATURE_104 (v0.7.29) — Reusable harness for prompt-eval cases.
 *
 * Two patterns are supported:
 *
 * 1. **One-shot probe** (`runOneShot`) — fire one (system + user) message at
 *    one model, return the text. Use when each case has its own scoring
 *    logic (the existing `tests/identity-roundtrip.eval.ts` pattern).
 *
 * 2. **A/B variant comparison** (`runABComparison`) — fire N variants of a
 *    prompt against M models, run each output through the same judges,
 *    return a structured comparison matrix. Use when evaluating a prompt
 *    change ("does v2 beat v1 across our coding-plan providers?"). This
 *    is the typed evolution of the hand-rolled comparison in
 *    `tests/dispatch-prompt-comparison.eval.ts`.
 *
 * Both helpers skip models whose API key is absent. Eval files using this
 * harness should call `availableAliases(...)` from `./aliases.ts` to get
 * the runnable subset and pass it in.
 */

import { getProvider, type KodaXMessage, type KodaXToolDefinition } from '@kodax/ai';

import {
  resolveAlias,
  type ModelAlias,
  type ModelAliasTarget,
} from './aliases.js';
import {
  runJudges,
  type AggregatedJudgeRun,
  type JudgeCategory,
  type JudgeRunResult,
  type PromptJudge,
} from './judges.js';

export interface OneShotInput {
  readonly systemPrompt: string;
  readonly userMessage: string;
  /** Optional tools advertised to the provider (default: none). */
  readonly tools?: readonly KodaXToolDefinition[];
  /** Optional pre-conversation context (default: empty). */
  readonly priorMessages?: readonly KodaXMessage[];
}

export interface OneShotOutput {
  readonly alias: ModelAlias;
  readonly target: ModelAliasTarget;
  readonly text: string;
  /** Tool calls the provider emitted (if any). Useful when judging which tool was picked. */
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
}

/**
 * Run one (system + user) round against one model alias. Returns the
 * concatenated assistant text plus any tool calls AND the wall-clock
 * duration (used by `runBenchmark` to compute speed-scoring + p95
 * latency stats). The eval-file caller applies its own assertions /
 * judges.
 */
export async function runOneShot(
  alias: ModelAlias,
  input: OneShotInput,
): Promise<OneShotOutput & { durationMs: number }> {
  const target = resolveAlias(alias);
  const provider = getProvider(target.provider);

  const messages: KodaXMessage[] = [
    ...(input.priorMessages ?? []),
    { role: 'user', content: input.userMessage },
  ];
  const tools = input.tools ?? [];

  const startedAt = Date.now();
  const result = await provider.stream(messages, tools, input.systemPrompt);
  const durationMs = Date.now() - startedAt;

  const text = result.textBlocks.map((b) => b.text).join('').trim();
  const toolCalls = result.toolBlocks.map((b) => ({
    name: b.name,
    input: b.input,
  }));

  return { alias, target, text, toolCalls, durationMs };
}

export interface PromptVariant {
  /** Short stable id, e.g. 'v1', 'v2-with-rule-x'. Goes into the result row. */
  readonly id: string;
  /** Optional human-readable description for logs. */
  readonly description?: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly tools?: readonly KodaXToolDefinition[];
  readonly priorMessages?: readonly KodaXMessage[];
}

export interface VariantOutcome {
  readonly variantId: string;
  readonly alias: ModelAlias;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly judges: ReadonlyArray<{ name: string; passed: boolean; reason?: string }>;
  readonly passed: boolean;
}

export interface ABComparisonInput {
  readonly variants: readonly PromptVariant[];
  readonly models: readonly ModelAlias[];
  readonly judges: readonly PromptJudge[];
}

export interface ABComparisonResult {
  readonly outcomes: ReadonlyArray<VariantOutcome>;
  /** Variant id → list of outcomes (one per model). Convenience pivot. */
  readonly byVariant: Readonly<Record<string, readonly VariantOutcome[]>>;
  /** Model alias → list of outcomes (one per variant). Convenience pivot. */
  readonly byModel: Readonly<Record<string, readonly VariantOutcome[]>>;
  /** Variants that passed every model + every judge. Empty array means none. */
  readonly variantsPassingEveryModel: readonly string[];
}

/**
 * Run each variant against each model and apply the judges. Returns
 * a structured comparison the test file can assert on.
 *
 * Cost: `variants.length × models.length` provider calls. Eval cases
 * should keep both small (typically 2-4 variants × 2-3 models, capped
 * by `availableAliases()`).
 *
 * Failure handling: provider exceptions are caught per-cell and recorded
 * as a failed outcome with the error message; the matrix continues.
 * That keeps a single rate-limit hiccup from masking N-1 other cells.
 */
export async function runABComparison(
  input: ABComparisonInput,
): Promise<ABComparisonResult> {
  const outcomes: VariantOutcome[] = [];
  for (const variant of input.variants) {
    for (const alias of input.models) {
      let text = '';
      let toolCalls: VariantOutcome['toolCalls'] = [];
      try {
        const out = await runOneShot(alias, {
          systemPrompt: variant.systemPrompt,
          userMessage: variant.userMessage,
          tools: variant.tools,
          priorMessages: variant.priorMessages,
        });
        text = out.text;
        toolCalls = out.toolCalls;
      } catch (err) {
        text = '';
        toolCalls = [];
        const reason = err instanceof Error ? err.message : String(err);
        outcomes.push({
          variantId: variant.id,
          alias,
          text,
          toolCalls,
          judges: [{ name: 'provider-error', passed: false, reason }],
          passed: false,
        });
        continue;
      }

      const judgeRun = runJudges(text, input.judges);
      outcomes.push({
        variantId: variant.id,
        alias,
        text,
        toolCalls,
        judges: judgeRun.results,
        passed: judgeRun.passed,
      });
    }
  }

  const byVariant: Record<string, VariantOutcome[]> = {};
  const byModel: Record<string, VariantOutcome[]> = {};
  for (const o of outcomes) {
    (byVariant[o.variantId] ??= []).push(o);
    (byModel[o.alias] ??= []).push(o);
  }

  const variantsPassingEveryModel: string[] = [];
  for (const variant of input.variants) {
    const cells = byVariant[variant.id] ?? [];
    if (cells.length > 0 && cells.every((c) => c.passed)) {
      variantsPassingEveryModel.push(variant.id);
    }
  }

  return {
    outcomes,
    byVariant,
    byModel,
    variantsPassingEveryModel,
  };
}

/**
 * Pretty-print an `ABComparisonResult` for human-readable test logs.
 * Each cell shows pass/fail + the first failing-judge reason.
 */
export function formatComparisonTable(result: ABComparisonResult): string {
  const lines: string[] = [];
  const variantIds = Object.keys(result.byVariant);
  const models = Object.keys(result.byModel);
  if (variantIds.length === 0 || models.length === 0) {
    return '(empty comparison)';
  }
  // Compute column width from both the variant id and the longest cell
  // content (including "FAIL: <reason>"). Min 8 chars; +2 for inter-column
  // spacing.
  const cellTexts: string[] = [];
  for (const o of result.outcomes) {
    if (o.passed) cellTexts.push('PASS');
    else {
      const reason = o.judges.find((j) => !j.passed)?.reason ?? 'failed';
      cellTexts.push(`FAIL: ${reason}`);
    }
  }
  const colWidth = Math.max(
    8,
    ...variantIds.map((v) => v.length + 2),
    ...cellTexts.map((t) => t.length + 2),
  );
  const modelColWidth = Math.max(...models.map((m) => m.length));
  lines.push(
    `${'model'.padEnd(modelColWidth)}  ${variantIds.map((v) => v.padEnd(colWidth)).join('')}`,
  );
  for (const m of models) {
    const cells = result.byModel[m] ?? [];
    const cellMap = new Map(cells.map((c) => [c.variantId, c]));
    const row = variantIds
      .map((vid) => {
        const c = cellMap.get(vid);
        if (!c) return '-'.padEnd(colWidth);
        if (c.passed) return 'PASS'.padEnd(colWidth);
        const reason = c.judges.find((j) => !j.passed)?.reason ?? 'failed';
        return `FAIL: ${reason}`.padEnd(colWidth);
      })
      .join('');
    lines.push(`${m.padEnd(modelColWidth)}  ${row}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// FEATURE_104 v2 — Quantitative benchmark (multi-run + variance +
// decomposed scoring). Adapted from the LiveCanvas prompt benchmark recipe
// with one deliberate divergence:
//
//   **Quality is the only scoring metric. Speed is NOT scored.**
//
// LiveCanvas scores (quality, speed, composite) because it's an interactive
// UI generator — users wait for the answer, and a slow-but-correct
// provider has worse UX than a fast-good one. KodaX is a coding agent:
// the user pushes Enter and goes to lunch; a slow-but-correct provider
// is strictly better than a fast-but-wrong one. So the LiveCanvas
// composite formula does not transplant. Quality-only ranking is the
// right primitive.
//
// `durationMs` is still tracked per run as **diagnostic** info (spotting
// a provider that hangs for 10 minutes is still useful) and surfaced in
// REPORT.md §5 "Latency observed (informational, not scored)" — but it
// does not feed into rank, dominance, or any cell score.
//
// What v2 keeps from the recipe:
//
// 1. n=3 minimum runs per cell — n=1 is anti-pattern 4 ("judging from a
//    single lucky run"). Std-dev of pass rate across runs surfaces noisy
//    providers; "two competitors within 3 quality points are
//    statistically indistinguishable at this sample size".
// 2. Decomposed quality (format / correctness / style / safety) — anti-
//    pattern 2 ("scoring style without correctness"). Per-category pass
//    rates show WHY a variant wins.
// 3. Persisted raw outputs (anti-pattern 3) — see `./persist.ts`.
//
// `runBenchmark` returns a structured result with all numbers; rendering
// to markdown REPORT.md lives in `report.ts` (separate file so eval cases
// can also consume the raw result programmatically).
// ---------------------------------------------------------------------------

/** Default n=3 runs per cell — minimum for variance to be meaningful. */
export const DEFAULT_BENCHMARK_RUNS = 3;

export interface BenchmarkRunCell {
  readonly variantId: string;
  readonly alias: ModelAlias;
  /** Run index within this cell (0-based). */
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly durationMs: number;
  /** Set when the provider call itself errored (rate-limit, timeout, etc.). */
  readonly error?: string;
  readonly judges: readonly JudgeRunResult[];
  readonly judgeAggregate: AggregatedJudgeRun;
  readonly passed: boolean;
}

export interface DurationStats {
  readonly min: number;
  readonly median: number;
  readonly mean: number;
  readonly p95: number;
  readonly max: number;
}

export interface BenchmarkCellSummary {
  readonly variantId: string;
  readonly alias: ModelAlias;
  /** Total runs attempted (= input.runs). */
  readonly runs: number;
  /** Runs that completed without provider error. */
  readonly completed: number;
  /** 0-100. (passedRuns / runs) × 100. */
  readonly passRate: number;
  /** Std-dev of per-run pass-or-fail (0/1) × 100. Higher = noisier provider. */
  readonly passRateStdDev: number;
  /** Per-category pass count / total count, summed across runs. */
  readonly byCategory: Readonly<Record<JudgeCategory, { passed: number; total: number }>>;
  /** Per-category pass rate (0-100), summed across runs. */
  readonly qualityByCategory: Readonly<Record<JudgeCategory, number>>;
  /**
   * 0-100 quality score (overall pass rate, gated by format). This is the
   * single ranking metric — `variantsDominantOnEveryModel` is computed on
   * this value alone.
   */
  readonly quality: number;
  /** Per-run duration stats. **Informational only — not part of any score.** */
  readonly duration: DurationStats;
  readonly runsRaw: readonly BenchmarkRunCell[];
}

export interface BenchmarkRunInput {
  readonly variants: readonly PromptVariant[];
  readonly models: readonly ModelAlias[];
  readonly judges: readonly PromptJudge[];
  /** Number of runs per cell. Defaults to DEFAULT_BENCHMARK_RUNS (3). */
  readonly runs?: number;
}

export interface BenchmarkResult {
  readonly variants: readonly PromptVariant[];
  readonly models: readonly ModelAlias[];
  readonly cells: ReadonlyArray<BenchmarkCellSummary>;
  /** Variant id → cells for that variant (one per model). */
  readonly byVariant: Readonly<Record<string, readonly BenchmarkCellSummary[]>>;
  /** Model alias → cells for that model (one per variant). */
  readonly byModel: Readonly<Record<string, readonly BenchmarkCellSummary[]>>;
  /** Variants whose `quality` >= every other variant on every model. */
  readonly variantsDominantOnEveryModel: readonly string[];
  /** Total wall-clock seconds end-to-end (sequential). Diagnostic only. */
  readonly totalSeconds: number;
  /** Run config snapshot (for reports + reproducibility). */
  readonly config: {
    readonly runs: number;
  };
  /** ISO timestamp of run start, for persistence + reproduction. */
  readonly startedAt: string;
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function stdDev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Run the full N×M×K benchmark matrix and aggregate. Returns a structured
 * BenchmarkResult that callers can pass to `writeBenchmarkReport` (in
 * `./report.ts`) or inspect programmatically.
 *
 * Cells where a provider error occurs (rate-limit, timeout, malformed
 * response) record the error on that run and continue — a single cell
 * failure does not abort the matrix. Eval cases that need stricter
 * behavior can inspect `cell.runsRaw[*].error` and assert on it.
 */
export async function runBenchmark(input: BenchmarkRunInput): Promise<BenchmarkResult> {
  const runs = input.runs ?? DEFAULT_BENCHMARK_RUNS;

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  const cells: BenchmarkCellSummary[] = [];

  for (const variant of input.variants) {
    for (const alias of input.models) {
      const runsRaw: BenchmarkRunCell[] = [];

      for (let runIndex = 0; runIndex < runs; runIndex++) {
        let text = '';
        let durationMs = 0;
        let toolCalls: BenchmarkRunCell['toolCalls'] = [];
        let error: string | undefined;
        try {
          const out = await runOneShot(alias, {
            systemPrompt: variant.systemPrompt,
            userMessage: variant.userMessage,
            tools: variant.tools,
            priorMessages: variant.priorMessages,
          });
          text = out.text;
          toolCalls = out.toolCalls;
          durationMs = out.durationMs;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        const aggregate: AggregatedJudgeRun = error
          ? {
              passed: false,
              results: [{ name: 'provider-call', category: 'format', passed: false, reason: error }],
              byCategory: { format: { passed: 0, total: 1 } } as Record<
                JudgeCategory,
                { passed: number; total: number }
              >,
              formatPassed: false,
            }
          : runJudges(text, input.judges);

        runsRaw.push({
          variantId: variant.id,
          alias,
          runIndex,
          text,
          toolCalls,
          durationMs,
          error,
          judges: aggregate.results,
          judgeAggregate: aggregate,
          passed: aggregate.passed,
        });
      }

      // Cell aggregation
      const completedRuns = runsRaw.filter((r) => !r.error);
      const completed = completedRuns.length;
      const passedRuns = runsRaw.filter((r) => r.passed).length;
      const passRate = runs === 0 ? 0 : (passedRuns / runs) * 100;
      const passRateStdDev = runs === 0 ? 0 : stdDev(runsRaw.map((r) => (r.passed ? 1 : 0))) * 100;

      // Per-category aggregation across runs (sum, not average — preserves run count)
      const byCategory = {} as Record<JudgeCategory, { passed: number; total: number }>;
      for (const r of runsRaw) {
        for (const [cat, counts] of Object.entries(r.judgeAggregate.byCategory) as Array<
          [JudgeCategory, { passed: number; total: number }]
        >) {
          if (!byCategory[cat]) byCategory[cat] = { passed: 0, total: 0 };
          byCategory[cat]!.passed += counts.passed;
          byCategory[cat]!.total += counts.total;
        }
      }
      const qualityByCategory = {} as Record<JudgeCategory, number>;
      for (const [cat, counts] of Object.entries(byCategory) as Array<
        [JudgeCategory, { passed: number; total: number }]
      >) {
        qualityByCategory[cat] = counts.total === 0 ? 0 : (counts.passed / counts.total) * 100;
      }

      // Quality: pass rate gated by format (LiveCanvas recipe — no points for unparseable output)
      const formatRate = byCategory.format
        ? byCategory.format.total === 0
          ? 100
          : (byCategory.format.passed / byCategory.format.total) * 100
        : 100;
      const quality = formatRate < 100 ? formatRate * (passRate / 100) : passRate;

      // Duration stats from completed runs only (failed = no signal).
      // Diagnostic only — does NOT feed into ranking. KodaX is a coding
      // agent: a slow correct answer is strictly better than a fast wrong one.
      const completedDurations = completedRuns.map((r) => r.durationMs);
      const sortedDur = [...completedDurations].sort((a, b) => a - b);
      const meanDur =
        completed === 0 ? 0 : completedDurations.reduce((s, d) => s + d, 0) / completed;
      const duration: DurationStats = {
        min: sortedDur[0] ?? 0,
        median: median(sortedDur),
        mean: meanDur,
        p95: percentile(sortedDur, 95),
        max: sortedDur[sortedDur.length - 1] ?? 0,
      };

      cells.push({
        variantId: variant.id,
        alias,
        runs,
        completed,
        passRate,
        passRateStdDev,
        byCategory,
        qualityByCategory,
        quality,
        duration,
        runsRaw,
      });
    }
  }

  const byVariant: Record<string, BenchmarkCellSummary[]> = {};
  const byModel: Record<string, BenchmarkCellSummary[]> = {};
  for (const c of cells) {
    (byVariant[c.variantId] ??= []).push(c);
    (byModel[c.alias] ??= []).push(c);
  }

  // "Dominant on every model" = for every model, this variant has quality
  // >= every other variant. Useful for "is v2 strictly ≥ v1 across the board?"
  // Quality is the single ranking metric — speed is informational only.
  const variantsDominantOnEveryModel: string[] = [];
  for (const variant of input.variants) {
    const dominantEverywhere = input.models.every((alias) => {
      const myCell = cells.find((c) => c.variantId === variant.id && c.alias === alias);
      if (!myCell) return false;
      return input.variants.every((other) => {
        if (other.id === variant.id) return true;
        const otherCell = cells.find((c) => c.variantId === other.id && c.alias === alias);
        if (!otherCell) return true;
        return myCell.quality >= otherCell.quality;
      });
    });
    if (dominantEverywhere) variantsDominantOnEveryModel.push(variant.id);
  }

  const totalSeconds = (Date.now() - startedAtMs) / 1000;

  return {
    variants: input.variants,
    models: input.models,
    cells,
    byVariant,
    byModel,
    variantsDominantOnEveryModel,
    totalSeconds,
    config: { runs },
    startedAt,
  };
}
