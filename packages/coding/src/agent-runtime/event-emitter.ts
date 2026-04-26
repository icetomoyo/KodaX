/**
 * Event-emitter helpers — CAP-035 + CAP-038
 *
 * Capability inventory:
 *   - docs/features/v0.7.29-capability-inventory.md#cap-035-tool-name-visibility-classification
 *   - docs/features/v0.7.29-capability-inventory.md#cap-038-queued-follow-up-detection
 *
 * Two small predicates used by the SA loop's event-emission and
 * terminal-decision paths:
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
 * Migration history:
 *   - `isVisibleToolName` extracted from `agent.ts:882-884` during the
 *     FEATURE_100 P2 baseline batch.
 *   - `hasQueuedFollowUp` extracted from `agent.ts:769-771` during
 *     FEATURE_100 P2 (CAP-031/032/037/038 batch).
 */

import type { KodaXEvents } from '../types.js';
import { isManagedProtocolToolName } from '../managed-protocol.js';

export function isVisibleToolName(name: string): boolean {
  return !isManagedProtocolToolName(name);
}

export function hasQueuedFollowUp(events: KodaXEvents): boolean {
  return events.hasPendingInputs?.() === true;
}
