/**
 * FEATURE_296 (ADR-067) request-assembly recovery rungs shared by the AMA
 * adapter (task-engine) and the SA substrate (agent-runtime).
 *
 * - `degradeIrreducibleUserInputs`: a fresh user message that cannot fit the
 *   window even at the floor reserve could never be sent; the request copy is
 *   degraded to a preview head plus a volatile run-scoped artifact pointer so the run
 *   continues and the model pages the full content in slices. The transcript
 *   itself keeps the original — it is the unbounded source of truth.
 * - `applyContextCapacityReserveOverride`: while the assembled request is
 *   over capacity, shrink the wire-level output reserve (floor-bounded) so
 *   the request the provider actually receives is legal. The provider remains
 *   the authoritative judge: a rejection routes to classification instead of
 *   a speculative resend.
 */

import {
  calculateMaxContextInputTokens,
  exceedsContextCapacity,
  reclaimReservedResponseTokens,
  RESERVE_SHRINK_FLOOR_TOKENS,
} from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';

import { estimateTokens } from './tokenizer.js';
import { applyToolResultGuardrail } from './tools/tool-result-policy.js';
import {
  createTransientTextArtifact,
  deleteTransientTextArtifact,
} from './transient-text-artifacts.js';
import type { KodaXToolExecutionContext } from './types.js';

/** Preview retained inline when a fresh user input is irreducibly oversized. */
export const IRREDUCIBLE_INPUT_PREVIEW_TOKENS = 2_000;

/** Per-run request copies plus their process-memory artifact capabilities. */
export interface UserInputDegradationCache {
  readonly messages: Map<KodaXMessage, KodaXMessage>;
  readonly artifactPaths: Set<string>;
}

export function createUserInputDegradationCache(): UserInputDegradationCache {
  return { messages: new Map(), artifactPaths: new Set() };
}

function isDegradableUserMessage(
  message: KodaXMessage,
  irreducibleTokens: number,
): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false;
  const messageTokens = estimateTokens([message]);
  return messageTokens > irreducibleTokens
    && messageTokens > IRREDUCIBLE_INPUT_PREVIEW_TOKENS;
}

export function hasIrreducibleUserInput(
  messages: readonly KodaXMessage[],
  contextWindow: number,
): boolean {
  const irreducibleTokens = calculateMaxContextInputTokens(
    contextWindow,
    RESERVE_SHRINK_FLOOR_TOKENS,
  );
  return messages.some((message) => isDegradableUserMessage(message, irreducibleTokens));
}

/** Remove request-only user-input artifacts at the end of the owning run. */
export async function cleanupUserInputDegradationCache(
  cache: UserInputDegradationCache,
): Promise<void> {
  for (const artifactPath of cache.artifactPaths) {
    deleteTransientTextArtifact(artifactPath);
  }
  cache.artifactPaths.clear();
  cache.messages.clear();
}

/**
 * Degrade only messages that can never fit a legal request on their own
 * (larger than the maximum input at the floor reserve). Ordinary large
 * messages stay verbatim — debt admission and history compaction own those.
 * Any user message above the threshold qualifies (compaction runs first, so
 * whatever is left is genuinely irreducible).
 */
export async function degradeIrreducibleUserInputs(
  messages: readonly KodaXMessage[],
  ctx: KodaXToolExecutionContext,
  contextWindow: number,
  cache: UserInputDegradationCache,
): Promise<KodaXMessage[]> {
  const irreducibleTokens = calculateMaxContextInputTokens(
    contextWindow,
    RESERVE_SHRINK_FLOOR_TOKENS,
  );
  let degraded = false;
  const result = await Promise.all(messages.map(async (message) => {
    if (message.role !== 'user' || typeof message.content !== 'string') return message;
    const cached = cache.messages.get(message);
    if (cached) {
      degraded = true;
      return cached;
    }
    if (!isDegradableUserMessage(message, irreducibleTokens)) return message;
    const guarded = await applyToolResultGuardrail('user_input', message.content, ctx, {
      maxInlineTokens: IRREDUCIBLE_INPUT_PREVIEW_TOKENS,
      persistOutput: async (_toolName, content) => {
        const artifactPath = createTransientTextArtifact(content);
        cache.artifactPaths.add(artifactPath);
        return artifactPath;
      },
    });
    const replacement: KodaXMessage = { ...message, content: guarded.content };
    cache.messages.set(message, replacement);
    degraded = true;
    return replacement;
  }));
  return degraded ? result : [...messages];
}

/** Narrow structural slice the reserve override needs from any provider. */
export interface ContextReserveOverrideProvider {
  getEffectiveMaxOutputTokens(model?: string): number;
}

/**
 * Shrink the wire-level output reserve while the assembled request exceeds
 * capacity. Keeps the provider's existing budget untouched when the request
 * already fits.
 */
export function applyContextCapacityReserveOverride(
  provider: ContextReserveOverrideProvider,
  input: {
    readonly model?: string;
    readonly maxOutputTokens?: number;
    readonly contextWindow: number;
    readonly currentTokens: number;
  },
): number {
  const base = input.maxOutputTokens
    ?? provider.getEffectiveMaxOutputTokens(input.model);
  if (
    !exceedsContextCapacity({
      contextWindow: input.contextWindow,
      currentTokens: input.currentTokens,
      reservedResponseTokens: base,
    })
  ) {
    return base;
  }
  const reclaimed = reclaimReservedResponseTokens({
    contextWindow: input.contextWindow,
    currentTokens: input.currentTokens,
    reservedResponseTokens: base,
  });
  return reclaimed;
}
