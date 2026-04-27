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
 * concatenated assistant text plus any tool calls. The eval-file caller
 * applies its own assertions / judges.
 */
export async function runOneShot(
  alias: ModelAlias,
  input: OneShotInput,
): Promise<OneShotOutput> {
  const target = resolveAlias(alias);
  const provider = getProvider(target.provider);

  const messages: KodaXMessage[] = [
    ...(input.priorMessages ?? []),
    { role: 'user', content: input.userMessage },
  ];
  const tools = input.tools ?? [];
  const result = await provider.stream(messages, tools, input.systemPrompt);

  const text = result.textBlocks.map((b) => b.text).join('').trim();
  const toolCalls = result.toolBlocks.map((b) => ({
    name: b.name,
    input: b.input,
  }));

  return { alias, target, text, toolCalls };
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
