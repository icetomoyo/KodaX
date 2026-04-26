/**
 * Per-session CostTracker middleware — CAP-012
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-012-per-session-costtracker
 *
 * Substrate-level wrapper around the immutable cost-tracker primitives that
 * live in `@kodax/ai`. Re-exported here so other agent-runtime modules
 * import from a stable agent-runtime path rather than reaching into the
 * sibling AI package directly.
 *
 * Migration history: implementation has lived in `@kodax/ai` since v0.7.22;
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

export {
  createCostTracker,
  recordUsage,
  getSummary,
  formatCost,
  formatCostReport,
} from '@kodax/ai';

export type {
  CostTracker,
  TokenUsageRecord,
  SessionCostSummary,
  ProviderCostSummary,
} from '@kodax/ai';
