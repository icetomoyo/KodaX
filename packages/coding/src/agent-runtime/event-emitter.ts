/**
 * Event-emitter helpers — CAP-035 + CAP-038 + CAP-053 + CAP-058
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-035-tool-name-visibility-classification
 *   - docs/features/v0.7.29-capability-inventory.md#cap-038-queued-follow-up-detection
 *   - docs/features/v0.7.29-capability-inventory.md#cap-053-emititerationend-helper-eventsoniterationend--token-snapshot-rebase
 *   - docs/features/v0.7.29-capability-inventory.md#cap-058-eventsoniterationstart-event
 *
 * Predicates and event-fan-out helpers used by the SA loop:
 *
 *   - `isVisibleToolName` (CAP-035): predicate for whether a given tool
 *     call should be surfaced to the host (REPL, IDE extension, AMA
 *     observer) via `onToolUseStart` / `onToolResult`. Managed-protocol
 *     tools (e.g. `emit_managed_protocol`) are infrastructure-level
 *     signals the host should not echo back — they belong to the harness,
 *     not to the user-visible work transcript.
 *
 *   - `hasQueuedFollowUp` (CAP-038): consulted at end-of-turn terminal
 *     decision points to keep the loop running when the host has a
 *     queued user input ready. The optional-chained call to
 *     `events.hasPendingInputs?.()` ensures hosts that don't implement
 *     this hook (the default) simply return `false` — no behavioural
 *     change for non-REPL embedders.
 *
 *   - `emitIterationStart` (CAP-058): fires `events.onIterationStart`
 *     with `iter+1` (1-based for display) and `maxIter`. Caller must
 *     have already fired the `turn:start` extension event — this helper
 *     is the user-visible counterpart that runs immediately after.
 *
 *   - `emitIterationEnd` (CAP-053): rebases the context-token snapshot
 *     against the latest messages buffer, then fires
 *     `events.onIterationEnd` carrying the rebased snapshot. Returns
 *     the new snapshot so the caller can reassign its mutable holder.
 *     The rebase is load-bearing — it's the only place where streaming
 *     usage deltas accumulated during the turn are reconciled with the
 *     persistent message-count baseline before the next turn begins.
 *
 * Migration history:
 *   - `isVisibleToolName` extracted from `agent.ts:882-884` during the
 *     FEATURE_100 P2 baseline batch.
 *   - `hasQueuedFollowUp` extracted from `agent.ts:769-771` during
 *     FEATURE_100 P2 (CAP-031/032/037/038 batch).
 *   - `emitIterationStart` / `emitIterationEnd` extracted from
 *     `agent.ts:511-528` and `agent.ts:577` during FEATURE_100 P3.1.
 */

import type { KodaXEvents, KodaXContextTokenSnapshot } from '../types.js';
import type { KodaXMessage } from '@kodax/ai';
import { isManagedProtocolToolName } from '../managed-protocol.js';
import { rebaseContextTokenSnapshot } from '../token-accounting.js';

export function isVisibleToolName(name: string): boolean {
  return !isManagedProtocolToolName(name);
}

export function hasQueuedFollowUp(events: KodaXEvents): boolean {
  return events.hasPendingInputs?.() === true;
}

/**
 * Fire the user-facing `onIterationStart` event. `iter` is 0-based at
 * the call site; this helper translates to the 1-based display value.
 */
export function emitIterationStart(
  events: KodaXEvents,
  iter: number,
  maxIter: number,
): void {
  events.onIterationStart?.(iter + 1, maxIter);
}

/**
 * Rebase the context-token snapshot and fire `onIterationEnd`. Returns
 * the rebased snapshot so the caller can reassign its holder. Pass
 * `snapshotOverride` when an upstream step (compaction, post-compact
 * attachments) has already produced a fresher baseline.
 */
export function emitIterationEnd(
  events: KodaXEvents,
  params: {
    iter: number;
    maxIter: number;
    messages: readonly KodaXMessage[];
    currentSnapshot: KodaXContextTokenSnapshot;
    snapshotOverride?: KodaXContextTokenSnapshot;
  },
): KodaXContextTokenSnapshot {
  const rebased = rebaseContextTokenSnapshot(
    params.messages as KodaXMessage[],
    params.snapshotOverride ?? params.currentSnapshot,
  );
  events.onIterationEnd?.({
    iter: params.iter,
    maxIter: params.maxIter,
    tokenCount: rebased.currentTokens,
    tokenSource: rebased.source,
    usage: rebased.usage,
    contextTokenSnapshot: rebased,
  });
  return rebased;
}
