import { calculateMaxContextInputTokens, RESERVE_SHRINK_FLOOR_TOKENS } from '@kodax-ai/agent';

import type {
  RuntimeContextBudgetSnapshot,
  RuntimeContextPressure,
} from '../agent-runtime/context-budget.js';
import type { ToolResultPolicy } from './tool-result-policy.js';

export type ToolResultBudgetReason =
  | 'large_window'
  | 'normal_pressure'
  | 'small_window_pressure'
  | 'critical_pressure';

/** Minimal capacity contract used by the request-level batch admission owner. */
export interface ToolResultCapacity {
  readonly aggregateInlineTokens: number;
}

/**
 * Public budget shape. Byte fields remain for source compatibility with SDK
 * embedders; KodaX's internal admission path uses only aggregateInlineTokens.
 */
export interface ToolResultBudget extends ToolResultCapacity {
  readonly pressure: RuntimeContextPressure;
  readonly contextWindow: number;
  readonly aggregateInlineBytes: number;
  readonly perResultInlineBytes: number;
  readonly reason: ToolResultBudgetReason;
}

export interface ToolResultBudgetUsageInput {
  readonly contextWindow: number;
  readonly currentTokens: number;
  /** Tokens reserved for the next model response by the provider/model. */
  readonly reservedResponseTokens?: number;
}

const TOKENS_TO_BYTES = 4;
const MIN_AGGREGATE_INLINE_BYTES = 12 * 1024;
const MIN_PER_RESULT_INLINE_BYTES = 4 * 1024;
const LARGE_WINDOW_AGGREGATE_BYTES = 192 * 1024;
const LARGE_WINDOW_PER_RESULT_BYTES = 64 * 1024;

/** @deprecated Prefer buildToolResultBudgetFromUsage for request admission. */
export function buildToolResultBudget(
  snapshot: RuntimeContextBudgetSnapshot,
): ToolResultBudget {
  return {
    aggregateInlineTokens: Math.max(0, Math.floor(snapshot.availableTokens)),
    ...buildCompatibilityMetadata({
      availableTokens: snapshot.availableTokens,
      contextWindow: snapshot.contextWindow,
      pressure: snapshot.pressure,
      smallWindow: snapshot.smallWindow,
    }),
  };
}

export function buildToolResultBudgetFromUsage(
  input: ToolResultBudgetUsageInput,
): ToolResultBudget {
  const contextWindow = Math.max(0, Math.floor(input.contextWindow));
  const currentTokens = Math.max(0, Math.floor(input.currentTokens));
  const reservedResponseTokens = Math.max(0, Math.floor(input.reservedResponseTokens ?? 0));
  let maxFinalInputTokens = calculateMaxContextInputTokens(
    contextWindow,
    reservedResponseTokens,
  );
  // Generation can reclaim an oversized preferred output reserve down to this
  // same floor. Do not make a read fail with a zero advisory budget when that
  // existing recovery rung can admit its result. Keep ordinary positive budgets
  // unchanged; final batch admission and generation still enforce capacity.
  if (maxFinalInputTokens <= currentTokens && reservedResponseTokens > RESERVE_SHRINK_FLOOR_TOKENS) {
    maxFinalInputTokens = calculateMaxContextInputTokens(contextWindow, RESERVE_SHRINK_FLOOR_TOKENS);
  }
  const aggregateInlineTokens = Math.max(0, maxFinalInputTokens - currentTokens);
  const usedRatio = contextWindow > 0 ? currentTokens / contextWindow : 1;
  const smallWindow = contextWindow > 0 && contextWindow <= 32_000;
  const pressure = classifyPressure(contextWindow, aggregateInlineTokens, usedRatio, smallWindow);

  return {
    aggregateInlineTokens,
    ...buildCompatibilityMetadata({
      availableTokens: aggregateInlineTokens,
      contextWindow,
      pressure,
      smallWindow,
    }),
  };
}

/**
 * @deprecated Opt-in compatibility helper. Internal request admission does not
 * call this per-result byte clamp because the batch token budget is authoritative.
 */
export function clampToolResultPolicyToBudget(
  policy: ToolResultPolicy,
  budget: ToolResultBudget | undefined,
): ToolResultPolicy {
  if (!budget) return policy;
  const maxBytes = Math.min(policy.maxBytes, budget.perResultInlineBytes);
  return {
    ...policy,
    maxBytes,
    maxLines: Math.min(policy.maxLines, estimateLineCap(policy, maxBytes)),
  };
}

function buildCompatibilityMetadata(input: {
  readonly availableTokens: number;
  readonly contextWindow: number;
  readonly pressure: RuntimeContextPressure;
  readonly smallWindow: boolean;
}): Omit<ToolResultBudget, 'aggregateInlineTokens'> {
  if (input.pressure === 'critical') {
    return {
      pressure: input.pressure,
      contextWindow: input.contextWindow,
      aggregateInlineBytes: Math.max(
        MIN_AGGREGATE_INLINE_BYTES,
        Math.floor(input.availableTokens * TOKENS_TO_BYTES * 0.2),
      ),
      perResultInlineBytes: MIN_PER_RESULT_INLINE_BYTES,
      reason: 'critical_pressure',
    };
  }

  if (input.smallWindow || input.pressure === 'high') {
    const aggregateInlineBytes = Math.max(
      MIN_AGGREGATE_INLINE_BYTES,
      Math.floor(input.availableTokens * TOKENS_TO_BYTES * 0.35),
    );
    return {
      pressure: input.pressure,
      contextWindow: input.contextWindow,
      aggregateInlineBytes,
      perResultInlineBytes: Math.min(
        16 * 1024,
        Math.max(MIN_PER_RESULT_INLINE_BYTES, Math.floor(aggregateInlineBytes / 3)),
      ),
      reason: 'small_window_pressure',
    };
  }

  if (input.pressure === 'medium') {
    return {
      pressure: input.pressure,
      contextWindow: input.contextWindow,
      aggregateInlineBytes: 96 * 1024,
      perResultInlineBytes: 32 * 1024,
      reason: 'normal_pressure',
    };
  }

  return {
    pressure: input.pressure,
    contextWindow: input.contextWindow,
    aggregateInlineBytes: LARGE_WINDOW_AGGREGATE_BYTES,
    perResultInlineBytes: LARGE_WINDOW_PER_RESULT_BYTES,
    reason: 'large_window',
  };
}

function estimateLineCap(policy: ToolResultPolicy, maxBytes: number): number {
  return Math.max(20, Math.floor(policy.maxLines * (maxBytes / Math.max(1, policy.maxBytes))));
}

function classifyPressure(
  contextWindow: number,
  availableTokens: number,
  usedRatio: number,
  smallWindow: boolean,
): RuntimeContextPressure {
  if (contextWindow <= 0 || availableTokens <= 0 || usedRatio >= 0.9) return 'critical';
  if (usedRatio >= 0.75) return 'high';
  if (usedRatio >= 0.55 || (smallWindow && usedRatio >= 0.4)) return 'medium';
  return 'low';
}
