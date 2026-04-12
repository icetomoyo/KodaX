/**
 * KodaX Microcompaction - Time-driven tool output cleanup
 *
 * Clears old tool result content from messages to slow context growth.
 * Pure function, no LLM calls, runs after each agent turn.
 *
 * Design:
 * - Tracks "turns" (role switches from assistant to user)
 * - Clears tool_result blocks older than maxAge turns
 * - Preserves protected tools (e.g., ask_user_question)
 * - Placeholder format matches compaction pruning: `[Cleared: grep src/auth.ts "pattern"]`
 * - Immutable: returns new array, never mutates input
 */

import type { KodaXMessage, KodaXContentBlock, KodaXToolResultBlock } from '@kodax/ai';
import { buildToolContextMap } from './compaction.js';

export interface MicrocompactionConfig {
  readonly enabled: boolean;
  readonly maxAge: number;                     // Clear tool outputs older than N turns, default 20
  readonly protectedTools: readonly string[];  // Tools never cleared
}

export const DEFAULT_MICROCOMPACTION_CONFIG: MicrocompactionConfig = {
  enabled: true,
  maxAge: 20,
  protectedTools: ['ask_user_question'],
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
      if (block.type !== 'tool_result') {
        return block;
      }

      const toolResult = block as KodaXToolResultBlock;

      // Already cleared
      if (toolResult.content.startsWith('[Cleared:') || toolResult.content.startsWith('[Pruned:')) {
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
      return {
        ...toolResult,
        content: `[Cleared: ${preview}]`,
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
