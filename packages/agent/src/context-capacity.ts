export const CONTEXT_SAFETY_FLOOR_TOKENS = 2_048;
export const CONTEXT_SAFETY_RATIO = 0.03;

export interface ContextCapacityInput {
  readonly contextWindow: number;
  readonly currentTokens: number;
  readonly reservedResponseTokens?: number;
}

export class ContextCapacityError extends Error {
  readonly code = 'KODAX_CONTEXT_CAPACITY_EXCEEDED';
  readonly contextWindow: number;
  readonly currentTokens: number;
  readonly reservedResponseTokens: number;

  constructor(input: ContextCapacityInput, operation = 'LLM request') {
    const contextWindow = Math.max(0, Math.floor(input.contextWindow));
    const currentTokens = Math.max(0, Math.floor(input.currentTokens));
    const reservedResponseTokens = Math.max(
      0,
      Math.floor(input.reservedResponseTokens ?? 0),
    );
    const safetyMargin = calculateContextSafetyMargin(currentTokens);
    super(
      `${operation} cannot fit the complete input: `
        + `${currentTokens} input + ${reservedResponseTokens} reserved output `
        + `+ ${safetyMargin} safety > ${contextWindow} context tokens.`,
    );
    this.name = 'ContextCapacityError';
    this.contextWindow = contextWindow;
    this.currentTokens = currentTokens;
    this.reservedResponseTokens = reservedResponseTokens;
  }
}

export function calculateContextSafetyMargin(currentTokens: number): number {
  const normalized = Math.max(0, Math.floor(currentTokens));
  return Math.max(
    CONTEXT_SAFETY_FLOOR_TOKENS,
    Math.ceil(normalized * CONTEXT_SAFETY_RATIO),
  );
}

export function exceedsContextCapacity(input: ContextCapacityInput): boolean {
  const contextWindow = Math.max(0, Math.floor(input.contextWindow));
  const currentTokens = Math.max(0, Math.floor(input.currentTokens));
  const reservedResponseTokens = Math.max(
    0,
    Math.floor(input.reservedResponseTokens ?? 0),
  );
  return currentTokens
    + reservedResponseTokens
    + calculateContextSafetyMargin(currentTokens)
    > contextWindow;
}

/** Largest complete request input that leaves response and safety capacity. */
export function calculateMaxContextInputTokens(
  contextWindow: number,
  reservedResponseTokens = 0,
): number {
  const window = Math.max(0, Math.floor(contextWindow));
  const reserved = Math.max(0, Math.floor(reservedResponseTokens));
  let low = 0;
  let high = Math.max(0, window - reserved);
  let best = 0;

  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    if (exceedsContextCapacity({
      contextWindow: window,
      currentTokens: candidate,
      reservedResponseTokens: reserved,
    })) {
      high = candidate - 1;
    } else {
      best = candidate;
      low = candidate + 1;
    }
  }

  return best;
}

/**
 * FEATURE_296 (ADR-067) recovery-ladder rung: shrink the reserved output
 * budget until the over-capacity input fits, bounded by this floor. Consumed
 * by the post-compaction `stillOverCapacity` checks (T3) and the request-build
 * max_tokens decision (T6). Compaction pressure detection keeps the true
 * reserve so relief still triggers conservatively.
 */
export const RESERVE_SHRINK_FLOOR_TOKENS = 3_000;

export function reclaimReservedResponseTokens(input: ContextCapacityInput): number {
  const window = Math.max(0, Math.floor(input.contextWindow));
  const current = Math.max(0, Math.floor(input.currentTokens));
  const base = Math.max(RESERVE_SHRINK_FLOOR_TOKENS, Math.floor(input.reservedResponseTokens ?? 0));
  if (!exceedsContextCapacity({ ...input, contextWindow: window, currentTokens: current })) {
    return base;
  }
  const headroom = window - current - calculateContextSafetyMargin(current);
  return Math.min(base, Math.max(RESERVE_SHRINK_FLOOR_TOKENS, headroom));
}
