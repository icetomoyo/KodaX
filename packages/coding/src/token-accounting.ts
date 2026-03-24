import type {
  KodaXContextTokenSnapshot,
  KodaXMessage,
  KodaXTokenUsage,
} from './types.js';
import { estimateTokens } from './tokenizer.js';

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function hasValidTokenUsage(
  usage: KodaXTokenUsage | null | undefined,
): usage is KodaXTokenUsage {
  if (!usage) {
    return false;
  }

  if (
    !isFiniteNonNegative(usage.inputTokens) ||
    !isFiniteNonNegative(usage.outputTokens) ||
    !isFiniteNonNegative(usage.totalTokens)
  ) {
    return false;
  }

  if (usage.totalTokens < usage.inputTokens || usage.totalTokens < usage.outputTokens) {
    return false;
  }

  if (usage.cachedReadTokens !== undefined && !isFiniteNonNegative(usage.cachedReadTokens)) {
    return false;
  }

  if (usage.cachedWriteTokens !== undefined && !isFiniteNonNegative(usage.cachedWriteTokens)) {
    return false;
  }

  if (usage.thoughtTokens !== undefined && !isFiniteNonNegative(usage.thoughtTokens)) {
    return false;
  }

  return true;
}

export function createEstimatedContextTokenSnapshot(
  messages: KodaXMessage[],
): KodaXContextTokenSnapshot {
  const baselineEstimatedTokens = estimateTokens(messages);
  return {
    currentTokens: baselineEstimatedTokens,
    baselineEstimatedTokens,
    source: 'estimate',
  };
}

export function createApiContextTokenSnapshot(
  messages: KodaXMessage[],
  usage: KodaXTokenUsage,
): KodaXContextTokenSnapshot {
  const baselineEstimatedTokens = estimateTokens(messages);
  return {
    currentTokens: usage.inputTokens,
    baselineEstimatedTokens,
    source: 'api',
    usage,
  };
}

export function createCompletedTurnTokenSnapshot(
  messages: KodaXMessage[],
  usage?: KodaXTokenUsage | null,
): KodaXContextTokenSnapshot {
  if (!hasValidTokenUsage(usage)) {
    return createEstimatedContextTokenSnapshot(messages);
  }

  return {
    currentTokens: usage.totalTokens,
    baselineEstimatedTokens: estimateTokens(messages),
    source: 'api',
    usage,
  };
}

export function createContextTokenSnapshot(
  messages: KodaXMessage[],
  usage?: KodaXTokenUsage | null,
): KodaXContextTokenSnapshot {
  if (hasValidTokenUsage(usage)) {
    return createApiContextTokenSnapshot(messages, usage);
  }

  return createEstimatedContextTokenSnapshot(messages);
}

export function resolveContextTokenCount(
  messages: KodaXMessage[],
  snapshot?: KodaXContextTokenSnapshot | null,
): number {
  const estimated = estimateTokens(messages);

  if (!snapshot) {
    return estimated;
  }

  if (
    !isFiniteNonNegative(snapshot.currentTokens) ||
    !isFiniteNonNegative(snapshot.baselineEstimatedTokens)
  ) {
    return estimated;
  }

  const adjusted = snapshot.currentTokens + (estimated - snapshot.baselineEstimatedTokens);
  if (!Number.isFinite(adjusted) || adjusted < 0) {
    return estimated;
  }

  return Math.round(adjusted);
}

export function rebaseContextTokenSnapshot(
  messages: KodaXMessage[],
  snapshot?: KodaXContextTokenSnapshot | null,
): KodaXContextTokenSnapshot {
  return {
    currentTokens: resolveContextTokenCount(messages, snapshot),
    baselineEstimatedTokens: estimateTokens(messages),
    source: snapshot?.source ?? 'estimate',
    usage: snapshot?.usage,
  };
}
