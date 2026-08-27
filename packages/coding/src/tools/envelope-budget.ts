/**
 * Capacity owner for background child/workflow completion envelopes.
 *
 * Child results are queued in full. Immediately before the synthetic user
 * message is built, this callback checks the same physical next-request budget
 * used by ordinary tool-result batches. No budget means pass-through; there is
 * deliberately no fixed character fallback.
 */

import type {
  EnvelopeAggregateCapacityContext,
  EnvelopeAggregateEnforcer,
} from '@kodax-ai/agent';
import { countTokens } from '../tokenizer.js';
import type { KodaXToolExecutionContext } from '../types.js';
import type { ToolResultBudget } from './tool-result-budget.js';
import {
  applyToolResultBatchGuardrail,
  emitCapacityDebtDiagnostic,
} from './tool-result-policy.js';

export type EnvelopeBudgetResolver = (
  context?: EnvelopeAggregateCapacityContext,
) => ToolResultBudget | undefined;

export function createEnvelopeAggregateBudgetEnforcer(
  ctx: KodaXToolExecutionContext,
  resolveBudget?: EnvelopeBudgetResolver,
): EnvelopeAggregateEnforcer {
  return async (fragments, capacityContext) => {
    const budget = resolveBudget?.(capacityContext);
    if (!budget || fragments.length === 0) return fragments;

    const guarded = await applyToolResultBatchGuardrail(
      fragments.map((content, index) => ({
        id: `background-${index}`,
        toolName: 'child_task_summary',
        content,
      })),
      ctx,
      budget,
    );
    const result = guarded.entries.map((entry) => entry.content);
    const finalTokens = countEnvelopeTokens(result);
    if (
      finalTokens > budget.aggregateInlineTokens
      && !guarded.capacityDebt
    ) {
      // FEATURE_296 (ADR-067): an irreducible envelope marker records debt
      // instead of failing; the wake commits and compaction owns recovery.
      emitCapacityDebtDiagnostic(finalTokens, budget.aggregateInlineTokens);
    }
    return result;
  };
}

function countEnvelopeTokens(fragments: readonly string[]): number {
  return countTokens(fragments.join('\n\n')) + 4;
}
