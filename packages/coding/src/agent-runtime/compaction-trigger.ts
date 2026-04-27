/**
 * Compaction trigger decision — CAP-059
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-059-compaction-trigger-decision
 *
 * Class 1 (substrate). Per-turn predicate read BEFORE the provider
 * stream call to decide whether the compaction lifecycle (CAP-060)
 * should run this turn. Time-ordering: AFTER microcompact (CAP-014);
 * BEFORE intelligentCompact orchestration (CAP-060).
 *
 * The wrapper preserves the historical short-circuit `compactionConfig.enabled`
 * gate from `agent.ts` even though the underlying `needsCompaction`
 * helper already returns `false` when the config is disabled. The
 * double-gate matches the pre-FEATURE_100 baseline byte-for-byte —
 * removing the redundancy is a P3.6 cleanup concern, not a P3.4
 * extraction concern.
 *
 * Migration history: extracted from `agent.ts:598-600` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.4a.
 */

import type { KodaXMessage } from '@kodax/ai';
import { needsCompaction, type CompactionConfig } from '@kodax/agent';

export interface ShouldCompactInput {
  readonly messages: KodaXMessage[];
  readonly compactionConfig: CompactionConfig;
  readonly contextWindow: number;
  readonly currentTokens: number;
}

/**
 * Returns `true` iff the compaction lifecycle should run this turn.
 * Combines the config-enabled gate with the underlying trigger
 * threshold check from `@kodax/agent`'s `needsCompaction`.
 */
export function shouldCompact(input: ShouldCompactInput): boolean {
  return (
    input.compactionConfig.enabled
    && needsCompaction(
      input.messages,
      input.compactionConfig,
      input.contextWindow,
      input.currentTokens,
    )
  );
}
