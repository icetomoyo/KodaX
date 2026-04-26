/**
 * Tool result classification — CAP-032 + CAP-037
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-032-structured-tool-error-code-extraction
 *   - docs/features/v0.7.29-capability-inventory.md#cap-037-tool-result-errorcancellation-classification
 *
 * Class 1 (substrate middleware). Three pure predicates / extractors that
 * inspect the `string` content of a tool result block:
 *
 *   - `isToolResultErrorContent` — does this content begin with one of
 *     the error/cancel/block prefixes (`[Tool Error]`, `[Cancelled]`,
 *     `[Blocked]`, `[Error]`)? Used by:
 *       (a) `createToolResultBlock` to set `is_error: true`;
 *       (b) the dispatch loop to skip mutation-reflection / edit-recovery
 *           on success (CAP-016 / CAP-015 gates);
 *       (c) the edit-tool branch to trigger edit-recovery (CAP-015) on
 *           failure.
 *
 *   - `isCancelledToolResultContent` — narrower predicate: was this
 *     specifically a user-initiated cancellation (`[Cancelled]` prefix
 *     from `CANCELLED_TOOL_RESULT_PREFIX`)? Distinguished from generic
 *     errors so the post-tool judge / round-boundary logic can treat
 *     cancellations as terminal-but-not-failure.
 *
 *   - `extractStructuredToolErrorCode` — when a `[Tool Error] <name>:
 *     <CODE>:` envelope is present, pull out the `<CODE>` token
 *     (`[A-Z_]+`) for downstream policy decisions (e.g. retry-decision
 *     middleware reads `runtimeSessionState.lastToolErrorCode`).
 *     Returns `undefined` if no structured envelope is detected.
 *
 * The three operate as a coherent triple — `isToolResultErrorContent`
 * gates whether to look further; `isCancelledToolResultContent` and
 * `extractStructuredToolErrorCode` extract the discriminating signal
 * for the policy chain.
 *
 * Migration history:
 *   - `isToolResultErrorContent` extracted from `agent.ts:773-775`
 *   - `isCancelledToolResultContent` extracted from `agent.ts:777-779`
 *   - `extractStructuredToolErrorCode` extracted from `agent.ts:897-900`
 *   pre-FEATURE_100 baseline, during FEATURE_100 P2.
 */

import { CANCELLED_TOOL_RESULT_PREFIX } from '../constants.js';

export function isToolResultErrorContent(content: string): boolean {
  return /^\[(?:Tool Error|Cancelled|Blocked|Error)\]/.test(content);
}

export function isCancelledToolResultContent(content: string): boolean {
  return content.startsWith(CANCELLED_TOOL_RESULT_PREFIX);
}

export function extractStructuredToolErrorCode(content: string): string | undefined {
  const match = /^\[Tool Error\]\s+[^:]+:\s+([A-Z_]+):/.exec(content.trim());
  return match?.[1];
}
