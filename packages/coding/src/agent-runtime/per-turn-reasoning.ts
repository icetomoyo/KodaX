/**
 * Per-turn effective reasoning plan + execution rebuild — CAP-057
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-057-per-turn-effectivereasoningplan-with-runtimethinkinglevel-override
 *
 * Class 1 (substrate). Evaluated at the start of every turn AFTER
 * `resolvePerTurnProvider` (CAP-055), BEFORE the provider stream.
 *
 * Two outputs from one input pair (`reasoningPlan` + `runtimeThinkingLevel`):
 *
 *   1. `effectiveReasoningPlan` — when an extension has set
 *      `sessionState.thinkingLevel`, that value overrides the plan's
 *      `mode` and derives a fresh `depth` via `reasoningModeToDepth`.
 *      When unset, returns `reasoningPlan` unchanged (reference-equal).
 *
 *   2. `currentExecution` — `ReasoningExecutionState` rebuilt via
 *      `buildReasoningExecutionState` (CAP-052) so the per-turn
 *      provider/model/reasoningMode overrides reach the system prompt
 *      / tool selection / providerReasoning envelope.
 *
 * The `isNewSession` boolean is derived from `messages.length === 1`.
 * NOTE (P3 R7): this is ambiguous after compaction (a compact-summary
 * message also has length 1) — the entire `isNewSession` audit is
 * P3-deferred per design doc §R7. P3.1 preserves the existing baseline
 * behavior verbatim.
 *
 * Migration history: extracted from `agent.ts:554-570` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P3.1.
 */

import type { KodaXOptions, KodaXReasoningMode } from '../types.js';
import type { KodaXMessage } from '@kodax/ai';
import { reasoningModeToDepth, type ReasoningPlan } from '../reasoning.js';
import {
  buildReasoningExecutionState,
  type ReasoningExecutionState,
} from './reasoning-plan-entry.js';

export interface PerTurnReasoning {
  readonly effectiveReasoningPlan: ReasoningPlan;
  readonly currentExecution: ReasoningExecutionState;
}

export interface PerTurnReasoningInput {
  readonly options: KodaXOptions;
  readonly providerName: string;
  readonly modelOverride: string | undefined;
  readonly thinkingLevel: KodaXReasoningMode | undefined;
  readonly reasoningPlan: ReasoningPlan;
  readonly messages: readonly KodaXMessage[];
}

export function buildEffectiveReasoningPlan(
  reasoningPlan: ReasoningPlan,
  thinkingLevel: KodaXReasoningMode | undefined,
): ReasoningPlan {
  if (!thinkingLevel) {
    return reasoningPlan;
  }
  return {
    ...reasoningPlan,
    mode: thinkingLevel,
    depth: reasoningModeToDepth(thinkingLevel),
  };
}

export async function resolvePerTurnReasoning(
  input: PerTurnReasoningInput,
): Promise<PerTurnReasoning> {
  const effectiveReasoningPlan = buildEffectiveReasoningPlan(
    input.reasoningPlan,
    input.thinkingLevel,
  );
  const currentExecution = await buildReasoningExecutionState(
    {
      ...input.options,
      provider: input.providerName,
      modelOverride: input.modelOverride,
      reasoningMode: input.thinkingLevel ?? input.options.reasoningMode,
    },
    effectiveReasoningPlan,
    input.messages.length === 1,
  );
  return { effectiveReasoningPlan, currentExecution };
}
