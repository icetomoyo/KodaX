/**
 * Compaction trigger decision — CAP-059
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-059-compaction-trigger-decision
 *
 * Class 1 (substrate). Per-turn predicate read before the provider stream
 * call. The default policy compares the final physical request, provider
 * output reserve, and shared safety margin against the model window. A
 * trigger below 100 remains an explicit early-compaction opt-in.
 *
 * Since FEATURE_272 automatic large compaction is always enabled. The legacy
 * `enabled` field remains source-compatible but cannot short-circuit pressure.
 *
 * Migration history:
 *   - extracted from `agent.ts:598-600` — pre-FEATURE_100 baseline —
 *     during FEATURE_100 P3.4a.
 *   - moved from `../../index.js/src/runtime-middleware/` to
 *     `@kodax-ai/session-lineage/src/runtime-middleware/` in v0.7.36 to
 *     break the build cycle introduced by FEATURE_142 Batch D
 *     (agent → session-lineage → agent). session-lineage already
 *     depends on agent, so this direction is acyclic. Semantically
 *     this also reflects that compaction trigger is part of the
 *     compaction lifecycle, which is session-lineage's domain.
 */

import type { KodaXMessage } from '@kodax-ai/llm';

import { needsCompaction } from '../compaction/compaction.js';
import type { CompactionConfig } from '../compaction/types.js';
import type { ResolvedCompactionPolicy } from '../compaction/policy.js';

export interface ShouldCompactInput {
  readonly messages: KodaXMessage[];
  readonly compactionConfig: CompactionConfig;
  readonly contextWindow: number;
  readonly currentTokens: number;
  readonly reservedResponseTokens?: number;
  readonly onPolicy?: (policy: ResolvedCompactionPolicy) => void;
}

/**
 * Returns `true` iff the complete request exceeds physical capacity or an
 * explicitly configured early trigger. `currentTokens` must already include
 * the final system/tool/framing overhead selected for this provider turn.
 */
export function shouldCompact(input: ShouldCompactInput): boolean {
  return needsCompaction(
    input.messages,
    input.compactionConfig,
    input.contextWindow,
    input.currentTokens,
    input.reservedResponseTokens,
    input.onPolicy,
  );
}
