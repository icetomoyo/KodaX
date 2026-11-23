/**
 * Per-session CostTracker middleware — CAP-012
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-012-per-session-costtracker
 *
 * Substrate-level wrapper around the immutable cost-tracker primitives that
 * live in `@kodax-ai/llm`. Re-exported here so other agent-runtime modules
 * import from a stable agent-runtime path rather than reaching into the
 * sibling AI package directly.
 *
 * Migration history: implementation has lived in `@kodax-ai/llm` since v0.7.22;
 * this re-export module is the FEATURE_100 P2 surface that future substrate
 * executor wiring imports against. Both `agent.ts:1435` and
 * `runner-driven.ts:2273` already construct trackers via `createCostTracker`;
 * once the substrate executor takes over per-frame tracker construction,
 * those direct call sites collapse into a single substrate hook.
 *
 * Public contract preserved across the migration:
 *   - createCostTracker() returns an empty tracker per call (per-frame state)
 *   - recordUsage(tracker, entry) returns a NEW tracker with the entry
 *     appended; never mutates the input
 *   - getSummary(tracker) returns aggregated totals + per-provider +
 *     per-role breakdowns
 *   - formatCostReport(summary) renders the human-readable string the
 *     REPL `/cost` command displays
 */

import { getSummary, type CostTracker, type KodaXTokenUsage } from '@kodax-ai/llm';

export {
  createCostTracker,
  recordUsage,
  recordRetry,
  getSummary,
  formatCost,
  formatCostReport,
} from '@kodax-ai/llm';

/** What the tracked calls used together, as a result reports it. Undefined before any call. */
export function trackedUsage(tracker: CostTracker): KodaXTokenUsage | undefined {
  const summary = getSummary(tracker);
  if (summary.callCount === 0) return undefined;
  return {
    inputTokens: summary.totalInputTokens,
    outputTokens: summary.totalOutputTokens,
    totalTokens: summary.totalInputTokens + summary.totalOutputTokens,
    ...(summary.totalCacheReadTokens > 0 ? { cachedReadTokens: summary.totalCacheReadTokens } : {}),
    ...(summary.totalCacheWriteTokens > 0 ? { cachedWriteTokens: summary.totalCacheWriteTokens } : {}),
  };
}

export type {
  CostTracker,
  TokenUsageRecord,
  RetryRecord,
  SessionCostSummary,
  ProviderCostSummary,
} from '@kodax-ai/llm';
