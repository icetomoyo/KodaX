/**
 * L5 max_tokens continuation — CAP-074
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-074-l5-max_tokens-continuation
 *
 * Class 1 (substrate). Per-turn epilogue gate that fires when the
 * model was producing pure text (no tool_use blocks) and the provider
 * stream stopped with `stopReason === 'max_tokens'`. The model got
 * cut mid-thought; we synthesize a "resume directly" user message and
 * loop back so the model can continue.
 *
 * Skipped when `result.toolBlocks.length > 0` because partial-JSON
 * salvage in the next turn handles tool-call truncation naturally —
 * the agent executes the partial tool, observes the resulting state
 * via the tool_result, and continues. No explicit meta nudge needed
 * for that path.
 *
 * Capped at `KODAX_MAX_MAXTOKENS_RETRIES = 3` consecutive retries to
 * prevent runaway loops; on retry exhaustion fires `events.onRetry`
 * with the canonical `"max_tokens truncation limit reached (N/3)"`
 * message and falls through to the text-only response handling.
 *
 * Time-ordering constraint: AFTER assistant push to history;
 * BEFORE managed-protocol auto-continue (CAP-075) and the tool-blocks
 * empty branch.
 *
 * Migration history: extracted from `agent.ts:976-996` — pre-FEATURE_100
 * baseline — during FEATURE_100 P3.5a. The `let maxTokensRetryCount`
 * counter is folded into the helper's input/output round-trip.
 */

import type { KodaXMessage, KodaXStreamResult } from '@kodax/ai';

import type { KodaXContextTokenSnapshot, KodaXEvents } from '../types.js';
import { KODAX_MAX_MAXTOKENS_RETRIES } from '../constants.js';
import { rebaseContextTokenSnapshot } from '../token-accounting.js';

export interface MaxTokensContinuationInput {
  readonly result: KodaXStreamResult;
  /** Live message buffer — mutated when continuation fires. */
  readonly messages: KodaXMessage[];
  readonly maxTokensRetryCount: number;
  readonly completedTurnTokenSnapshot: KodaXContextTokenSnapshot;
  readonly events: KodaXEvents;
}

export type MaxTokensContinuationOutcome =
  /** Gate condition not met (`stopReason !== 'max_tokens'` or tool_blocks present); caller proceeds normally. */
  | { readonly outcome: 'no_op'; readonly nextMaxTokensRetryCount: number }
  /** Synthetic continuation pushed; caller MUST `continue` the turn loop. */
  | {
      readonly outcome: 'continue';
      readonly nextMaxTokensRetryCount: number;
      readonly nextContextTokenSnapshot: KodaXContextTokenSnapshot;
    }
  /** Retry cap exhausted; `onRetry` fired; caller falls through to text-only response handling. */
  | { readonly outcome: 'exhausted'; readonly nextMaxTokensRetryCount: number };

/**
 * CAP-074: max-tokens continuation gate. Mutates `messages` only on
 * the `continue` branch. Returns the next-turn counter and (when
 * applicable) the rebased token snapshot.
 */
export function maybeContinueAfterMaxTokens(
  input: MaxTokensContinuationInput,
): MaxTokensContinuationOutcome {
  const { result, messages, maxTokensRetryCount, completedTurnTokenSnapshot, events } = input;

  if (result.stopReason !== 'max_tokens' || result.toolBlocks.length !== 0) {
    return { outcome: 'no_op', nextMaxTokensRetryCount: maxTokensRetryCount };
  }

  const nextCount = maxTokensRetryCount + 1;
  if (nextCount <= KODAX_MAX_MAXTOKENS_RETRIES) {
    events.onTextDelta?.('\n\n[output token limit hit, continuing…]\n\n');
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            'Output token limit hit. Resume directly — no apology, no recap of what you were doing. '
            + 'Pick up mid-thought if that is where the cut happened. '
            + 'Break remaining work into smaller pieces.',
        },
      ],
      _synthetic: true,
    });
    const nextContextTokenSnapshot = rebaseContextTokenSnapshot(messages, completedTurnTokenSnapshot);
    return {
      outcome: 'continue',
      nextMaxTokensRetryCount: nextCount,
      nextContextTokenSnapshot,
    };
  }

  // Retries exhausted — fall through to text-only response handling.
  events.onRetry?.(
    `max_tokens truncation limit reached (${nextCount - 1}/${KODAX_MAX_MAXTOKENS_RETRIES})`,
    nextCount - 1,
    KODAX_MAX_MAXTOKENS_RETRIES,
  );
  return { outcome: 'exhausted', nextMaxTokensRetryCount: nextCount };
}
