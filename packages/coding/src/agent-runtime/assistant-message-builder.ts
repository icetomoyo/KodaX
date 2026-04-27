/**
 * Assistant message empty-content guard — CAP-073
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-073-empty-assistant-content-guard
 *
 * Class 1 (substrate). Guards against pushing an assistant message with
 * an empty content array onto the message history. This can happen when
 * the model only emits invisible tool calls (e.g. `emit_managed_protocol`)
 * with no text or thinking blocks — the user-visible filter strips them
 * out (`isVisibleToolName`), leaving `[...thinkingBlocks, ...textBlocks,
 * ...visibleToolBlocks]` empty.
 *
 * Some providers (Kimi being the canonical case) reject assistant
 * messages with empty content via a 400 error before the next
 * provider call can be made — the guard prevents that. Others tolerate
 * empty content but produce degenerate next turns. Either way, an
 * empty assistant message is a corrupt history shape; replacing it
 * with a minimal `[{ type: 'text', text: '...' }]` placeholder is
 * the cheapest correct intervention.
 *
 * The placeholder is intentionally short (`'...'`) so it does not
 * pollute the visible transcript when the host renders the turn —
 * three dots read as "the assistant continued silently" rather than
 * looking like a substantive response.
 *
 * Migration history: extracted from `agent.ts:1064-1070` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P3.3a.
 */

import type { KodaXContentBlock } from '@kodax/ai';

export const EMPTY_ASSISTANT_CONTENT_PLACEHOLDER: KodaXContentBlock = {
  type: 'text',
  text: '...',
};

/**
 * Return the input content unchanged when non-empty; otherwise return a
 * single-element array with the canonical placeholder text block.
 *
 * The function does NOT mutate `content` — callers receive a fresh
 * array on the placeholder path.
 */
export function guardEmptyAssistantContent(
  content: KodaXContentBlock[],
): KodaXContentBlock[] {
  if (content.length === 0) {
    return [EMPTY_ASSISTANT_CONTENT_PLACEHOLDER];
  }
  return content;
}
