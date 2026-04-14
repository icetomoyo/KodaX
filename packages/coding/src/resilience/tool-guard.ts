/**
 * KodaX Tool Guard (Feature 045)
 *
 * Prevents tool side-effect replay during provider recovery.
 * When recovering to a stable boundary, executed tool results must be
 * preserved and incomplete tool calls must be dropped.
 *
 * This module provides the message reconstruction logic that ensures:
 * 1. Executed tool results are preserved in the reconstructed messages
 * 2. Dropped tool calls are cleaned up (removed from pending)
 * 3. A continuation hint is appended so the model knows to continue
 *    from where it left off
 */

import type { KodaXMessage, KodaXContentBlock, KodaXToolResultBlock } from '@kodax/ai';

// ============== Message Reconstruction ==============

/**
 * Reconstructs messages after a recovery, ensuring executed tool results
 * are preserved and dropped tool calls are cleaned up.
 *
 * @param stableMessages - Messages up to the stable boundary
 * @param executedToolCallIds - Tool calls that have been executed (preserve results)
 * @param droppedToolCallIds - Tool calls that were in progress (drop them)
 * @returns Reconstructed message list
 */
export function reconstructMessagesWithToolGuard(
  stableMessages: KodaXMessage[],
  executedToolCallIds: string[],
  droppedToolCallIds: string[],
): KodaXMessage[] {
  if (stableMessages.length === 0) {
    return [];
  }

  // Filter out any incomplete tool calls from stable messages
  const filtered = filterIncompleteToolCalls(stableMessages, droppedToolCallIds);

  // Verify executed tool results are present in the filtered messages
  const presentToolResults = collectToolResultIds(filtered);
  const missingExecutedResults = executedToolCallIds.filter(
    id => !presentToolResults.includes(id),
  );

  // If some executed tool results are missing from stable messages,
  // we need to add placeholder tool results to maintain message integrity.
  // This shouldn't normally happen if the stable boundary is tracked correctly,
  // but we handle it defensively.
  if (missingExecutedResults.length > 0) {
    return appendMissingToolResults(filtered, missingExecutedResults);
  }

  return filtered;
}

// ============== Filtering ==============

/**
 * Removes incomplete tool calls (and their partial results) from messages.
 * A tool call is considered incomplete if its ID is in the dropped list
 * and there is no corresponding tool_result in the same message or
 * the next message.
 */
function filterIncompleteToolCalls(
  messages: KodaXMessage[],
  droppedToolCallIds: string[],
): KodaXMessage[] {
  if (droppedToolCallIds.length === 0) {
    return [...messages];
  }

  const droppedSet = new Set(droppedToolCallIds);

  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return msg;
    }

    // Filter content blocks to remove dropped tool_use and tool_result blocks
    const filteredContent = (msg.content as KodaXContentBlock[]).filter(block => {
      if (block.type === 'tool_use') {
        return !droppedSet.has(block.id);
      }
      if (block.type === 'tool_result') {
        return !droppedSet.has(block.tool_use_id);
      }
      return true;
    });

    // If filtering removed all content, inject a minimal placeholder.
    // CRITICAL: text must be non-empty — providers like Kimi reject messages
    // with empty content (400 "must not be empty").
    if (filteredContent.length === 0) {
      return {
        ...msg,
        content: [{ type: 'text', text: '...' }],
      };
    }

    return {
      ...msg,
      content: filteredContent,
    };
  });
}

// ============== Tool Result Collection ==============

/**
 * Collects all tool_result IDs present in the message list.
 */
function collectToolResultIds(messages: KodaXMessage[]): string[] {
  const ids: string[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      continue;
    }
    for (const block of msg.content as KodaXContentBlock[]) {
      if (block.type === 'tool_result') {
        ids.push((block as KodaXToolResultBlock).tool_use_id);
      }
    }
  }

  return ids;
}

// ============== Missing Tool Results ==============

/**
 * Appends placeholder tool results for executed tools whose results
 * are missing from the stable messages. This ensures the model can
 * continue without re-executing the tools.
 */
function appendMissingToolResults(
  messages: KodaXMessage[],
  missingToolCallIds: string[],
): KodaXMessage[] {
  const result = [...messages];

  // Add a user message with tool results if there's an assistant message
  // that references these tools but the results are missing
  const toolResultBlocks: KodaXToolResultBlock[] = missingToolCallIds.map(id => ({
    type: 'tool_result' as const,
    tool_use_id: id,
    content: '[Result preserved from previous attempt - tool already executed]',
  }));

  if (toolResultBlocks.length > 0) {
    result.push({
      role: 'user',
      content: toolResultBlocks,
    });
  }

  return result;
}
