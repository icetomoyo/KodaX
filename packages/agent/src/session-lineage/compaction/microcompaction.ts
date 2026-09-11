/**
 * KodaX Microcompaction - Explicit legacy context cleanup
 *
 * Clears old tool result content only when a caller explicitly enables it.
 * The default is disabled because age alone is not evidence that deleting a
 * complete result will reduce end-to-end token use.
 *
 * Design:
 * - Tracks "turns" (role switches from assistant to user)
 * - Clears tool_result blocks older than maxAge turns
 * - Preserves thinking blocks (token cost is marginal; Kimi requires non-empty
 *   reasoning_content on every tool-call assistant message)
 * - Preserves image blocks (replacing them invalidates Anthropic prompt-cache
 *   prefixes and discards multimodal context; all reference agents — claudecode,
 *   pi-mono, opencode — also preserve images at this layer. Token cost is handled
 *   by the LLM compaction layer that produces a summary when budget pressure hits.)
 * - Preserves protected tools (e.g., ask_user_question)
 * - Placeholder format matches compaction pruning: `[Cleared: grep src/auth.ts "pattern"]`
 * - Immutable: returns new array, never mutates input
 */

import type { KodaXMessage, KodaXContentBlock, KodaXToolResultBlock } from '@kodax-ai/llm';
import { buildToolContextMap, PROTECTED_TOOL_NAMES } from './compaction.js';
import { preserveToolResultRecovery } from './result-extractors.js';

export interface MicrocompactionConfig {
  readonly enabled: boolean;
  readonly maxAge: number;                     // Clear tool outputs older than N turns, default 20
  readonly protectedTools: readonly string[];  // Tools never cleared
}

/**
 * FEATURE_183 (v0.7.42): align `protectedTools` with the canonical
 * PROTECTED_TOOL_NAMES from compaction.ts so microcompact and the
 * slow-path pruneToolResults agree on which tools are off-limits. Pre-F183
 * the two sets had drifted (microcompact = `['ask_user_question']`, prune
 * = `['skill']`), meaning a tool could be cleared by one path and
 * protected by the other depending on whether maxAge or pruning ran
 * first — semantically incoherent.
 */
export const DEFAULT_MICROCOMPACTION_CONFIG: MicrocompactionConfig = {
  enabled: false,
  maxAge: 20,
  protectedTools: Array.from(PROTECTED_TOOL_NAMES),
};

/**
 * Build a turn index: maps each message index to a turn number.
 * A "turn" increments each time the role switches from assistant to user.
 */
function buildTurnIndex(messages: readonly KodaXMessage[]): readonly number[] {
  const turns: number[] = [];
  let currentTurn = 0;
  let lastRole: string | undefined;

  for (const msg of messages) {
    if (msg.role === 'user' && lastRole === 'assistant') {
      currentTurn++;
    }
    turns.push(currentTurn);
    lastRole = msg.role;
  }

  return turns;
}

/**
 * Microcompact messages by clearing old tool result content.
 * Returns a new array - does NOT mutate the input.
 *
 * Placeholder format reuses the same rich preview as compaction pruning:
 * - bash:  `[Cleared: git status]`
 * - grep:  `[Cleared: grep src/auth.ts "pattern"]`
 * - read:  `[Cleared: read auth.ts]`
 * - edit:  `[Cleared: edit auth.ts]`
 *
 * @param messages - The input messages to microcompact
 * @param config - Configuration (defaults to DEFAULT_MICROCOMPACTION_CONFIG)
 * @returns A new message array with old tool results cleared, or original if unchanged
 */
export function microcompact(
  messages: readonly KodaXMessage[],
  config: MicrocompactionConfig = DEFAULT_MICROCOMPACTION_CONFIG,
): readonly KodaXMessage[] {
  if (!config.enabled || messages.length === 0) {
    return messages;
  }

  const turnIndex = buildTurnIndex(messages);
  const currentTurn = turnIndex[turnIndex.length - 1] ?? 0;

  // Build tool context map for rich previews (same logic as compaction pruning)
  const toolContextMap = buildToolContextMap(messages as KodaXMessage[]);

  let changed = false;

  const result = messages.map((msg, msgIdx) => {
    if (!Array.isArray(msg.content)) {
      return msg;
    }

    const msgTurn = turnIndex[msgIdx] ?? 0;
    const age = currentTurn - msgTurn;

    // Message is too recent to compact
    if (age < config.maxAge) {
      return msg;
    }

    let blockChanged = false;
    const newContent = msg.content.map((block): KodaXContentBlock => {
      // NOTE: thinking blocks are intentionally NOT cleared here.
      // Providers like Kimi require non-empty reasoning_content on every assistant
      // tool-call message — clearing thinking text causes 400 errors. The token
      // savings from clearing thinking (~200-500 tokens per block) are marginal
      // compared to tool_result clearing, and old messages are typically summarized
      // by LLM compaction before microcompact's maxAge threshold matters.

      // Image blocks are preserved — see module header. Replacing them
      // invalidates Anthropic prompt-cache prefixes (every block hashed into
      // the cache key) and drops multimodal context the model still needs.
      if (block.type !== 'tool_result') {
        return block;
      }

      const toolResult = block as KodaXToolResultBlock;
      // Nested images have the same preservation contract as top-level images.
      if (Array.isArray(toolResult.content)
        && toolResult.content.some((item) => item.type === 'image')) return block;

      // Already cleared
      if (typeof toolResult.content === 'string' && (toolResult.content.startsWith('[Cleared:') || toolResult.content.startsWith('[Pruned:'))) {
        return block;
      }

      // Look up rich preview from tool context map
      const toolInfo = toolContextMap.get(toolResult.tool_use_id);
      const toolName = toolInfo?.name;

      // Check if protected
      if (toolName && config.protectedTools.includes(toolName)) {
        return block;
      }

      // Use rich preview (same format as pruning) — e.g. "grep src/auth.ts "pattern""
      const preview = toolInfo?.preview ?? toolName ?? 'unknown';

      blockChanged = true;
      const placeholder = `[Cleared: ${preview}]`;
      return {
        ...toolResult,
        content: preserveToolResultRecovery(toolResult.content, placeholder, toolResult.metadata),
      };
    });

    if (!blockChanged) {
      return msg;
    }

    changed = true;
    return { ...msg, content: newContent };
  });

  return changed ? result : messages;
}
