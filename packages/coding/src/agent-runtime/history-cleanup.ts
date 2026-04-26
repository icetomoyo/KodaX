/**
 * History cleanup middleware — CAP-002
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-002
 *
 * Two pure functions that maintain the assistant↔user `tool_use`/`tool_result`
 * pairing invariant the provider expects. Both functions take a message array
 * and return a new array (immutable — never mutate the input).
 *
 *   - `cleanupIncompleteToolCalls`: when a stream is interrupted mid-flight,
 *     the last assistant message may carry orphan `tool_use` blocks with no
 *     matching `tool_result`. The next provider call would 400 with
 *     "tool_call_id not found". This function strips those orphans before
 *     the next request.
 *
 *   - `validateAndFixToolHistory`: deeper pass that walks the full message
 *     history and fixes mis-pairings on both sides — orphan `tool_use` in
 *     assistant messages, orphan `tool_result` in user messages, and ensures
 *     no message becomes empty after stripping (Kimi specifically rejects
 *     empty assistant messages with 400, so we inject a `'...'` placeholder
 *     when stripping would empty an assistant message).
 *
 * Migration history: extracted from `agent.ts` (originally lines 517–758)
 * during FEATURE_100 P2. Both `agent.ts` and `task-engine/runner-driven.ts`
 * already consume these via the package re-export (`@kodax/coding`).
 *
 * Type guards are inlined here rather than imported from agent.ts because
 * the migration's whole point is to remove dependencies on agent.ts. If
 * additional agent-runtime modules need the same guards in the future,
 * extract them to `agent-runtime/content-blocks.ts`.
 */

import type { KodaXMessage } from '@kodax/ai';

type MessageContentBlock = Exclude<KodaXMessage['content'], string>[number];

function isTypedContentBlock(block: unknown): block is MessageContentBlock {
  return block !== null && typeof block === 'object' && 'type' in block;
}

function isToolUseContentBlock(
  block: unknown,
): block is Extract<MessageContentBlock, { type: 'tool_use' }> {
  return isTypedContentBlock(block) && block.type === 'tool_use';
}

function isToolResultContentBlock(
  block: unknown,
): block is Extract<MessageContentBlock, { type: 'tool_result' }> {
  return isTypedContentBlock(block) && block.type === 'tool_result';
}

/**
 * Walk the message history and remove mis-paired `tool_use` / `tool_result`
 * blocks. Preserves message order and structure; never mutates input.
 *
 * Rules enforced:
 *   - assistant `tool_use` with no matching `tool_result` in the next user
 *     message → removed
 *   - assistant `tool_use` with empty / missing id → removed
 *   - user `tool_result` with no matching assistant `tool_use` in the previous
 *     message → removed
 *   - user `tool_result` with empty / missing tool_use_id → removed
 *   - assistant message that becomes content-empty after stripping → inject
 *     a `'...'` placeholder text block (preserves message-alternation invariant
 *     downstream providers like Kimi require)
 */
export function validateAndFixToolHistory(messages: KodaXMessage[]): KodaXMessage[] {
  if (process.env.KODAX_DEBUG_TOOL_HISTORY) {
    console.error('[ToolHistory] Validating messages:', messages.length);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;

      const toolUses = msg.content.filter(isToolUseContentBlock);
      const toolResults = msg.content.filter(isToolResultContentBlock);

      if (toolUses.length > 0 || toolResults.length > 0) {
        console.error(`  [${i}] ${msg.role}:`, {
          toolUses: toolUses.map((toolUse) => ({ id: toolUse.id, name: toolUse.name })),
          toolResults: toolResults.map((toolResult) => ({ tool_use_id: toolResult.tool_use_id })),
        });
      }
    }
  }

  const fixedMessages: KodaXMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) {
      fixedMessages.push(msg);
      continue;
    }

    const content = msg.content;
    const fixedContent: typeof content = [];

    if (msg.role === 'assistant') {
      const nextMsg = messages[i + 1];
      const resultIds = new Set<string>();

      if (nextMsg?.role === 'user' && Array.isArray(nextMsg.content)) {
        for (const block of nextMsg.content) {
          if (isToolResultContentBlock(block) && block.tool_use_id) {
            resultIds.add(block.tool_use_id);
          }
        }
      }

      for (const block of content) {
        if (!isTypedContentBlock(block)) {
          fixedContent.push(block as typeof content[number]);
          continue;
        }

        if (block.type === 'tool_use') {
          if (!block.id || typeof block.id !== 'string' || block.id.trim() === '') {
            console.error('[ToolHistoryFix] Removed tool_use with empty id');
            continue;
          }

          if (!resultIds.has(block.id)) {
            console.error('[ToolHistoryFix] Removed orphaned tool_use:', block.id);
            continue;
          }

          fixedContent.push(block);
        } else {
          fixedContent.push(block);
        }
      }
    } else if (msg.role === 'user') {
      const prevMsg = messages[i - 1];
      const toolUseIds = new Set<string>();

      if (prevMsg?.role === 'assistant' && Array.isArray(prevMsg.content)) {
        for (const block of prevMsg.content) {
          if (isToolUseContentBlock(block) && block.id) {
            toolUseIds.add(block.id);
          }
        }
      }

      for (const block of content) {
        if (!isTypedContentBlock(block)) {
          fixedContent.push(block as typeof content[number]);
          continue;
        }

        if (block.type === 'tool_result') {
          if (!block.tool_use_id || typeof block.tool_use_id !== 'string' || block.tool_use_id.trim() === '') {
            console.error('[ToolHistoryFix] Removed tool_result with empty tool_use_id');
            continue;
          }

          if (!toolUseIds.has(block.tool_use_id)) {
            console.error('[ToolHistoryFix] Removed orphaned tool_result:', block.tool_use_id);
            continue;
          }

          fixedContent.push(block);
        } else {
          fixedContent.push(block);
        }
      }
    } else {
      fixedContent.push(...content);
    }

    if (fixedContent.length > 0) {
      // Guard: after tool_use removal + microcompaction clearing thinking text,
      // an assistant message might only contain cleared thinking blocks (thinking: '')
      // and/or empty text blocks (text: ''). Providers like Kimi reject these as
      // "empty" (400 error). Inject minimal placeholder to preserve message alternation
      // — dropping the message would orphan adjacent tool_result blocks.
      if (msg.role === 'assistant') {
        const hasSubstantiveContent = fixedContent.some((block) => {
          if (!block || typeof block !== 'object' || !('type' in block)) return false;
          const b = block as { type: string; text?: string; thinking?: string };
          if (b.type === 'tool_use') return true;
          if (b.type === 'text') return !!b.text;
          if (b.type === 'thinking') return !!b.thinking;
          return true; // preserve unknown block types
        });
        if (!hasSubstantiveContent) {
          fixedMessages.push({ ...msg, content: [{ type: 'text', text: '...' }] });
          continue;
        }
      }
      fixedMessages.push({ ...msg, content: fixedContent });
    }
  }

  if (process.env.KODAX_DEBUG_TOOL_HISTORY && fixedMessages.length !== messages.length) {
    console.error('[ToolHistory] Fixed: removed', messages.length - fixedMessages.length, 'invalid messages');
  }

  return fixedMessages;
}

/**
 * Strip orphan `tool_use` blocks from the LAST assistant message only.
 *
 * Used as a quick pre-stream guard when a previous turn was interrupted
 * (Issue 072): the last assistant message has unanswered tool_use blocks,
 * and the next provider request would 400 with "tool_call_id not found".
 *
 * Cheaper than `validateAndFixToolHistory` because it only touches the tail.
 */
export function cleanupIncompleteToolCalls(messages: KodaXMessage[]): KodaXMessage[] {
  if (messages.length === 0) return messages;

  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role !== 'assistant') return messages;

  if (typeof lastMsg.content !== 'string' && Array.isArray(lastMsg.content)) {
    const content = lastMsg.content;

    const toolUseIds = new Set<string>();
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block && typeof block === 'object' && 'type' in block) {
        if (block.type === 'tool_use' && 'id' in block) {
          toolUseIds.add(block.id);
        }
      }
    }

    if (toolUseIds.size === 0) return messages;

    const toolResultIds = new Set<string>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== 'user') continue;

      const userContent = msg.content;
      if (typeof userContent === 'string' || !Array.isArray(userContent)) continue;

      for (const block of userContent) {
        if (block && typeof block === 'object' && 'type' in block) {
          if (block.type === 'tool_result' && 'tool_use_id' in block) {
            toolResultIds.add(block.tool_use_id);
          }
        }
      }
    }

    const orphanedToolUseIds = new Set<string>();
    for (const id of toolUseIds) {
      if (!toolResultIds.has(id)) {
        orphanedToolUseIds.add(id);
      }
    }

    if (orphanedToolUseIds.size > 0) {
      const cleanedContent = content.filter((block) => {
        if (!block || typeof block !== 'object') return true;
        if (!('type' in block)) return true;
        const typedBlock = block as { type: string; id?: string };
        if (typedBlock.type !== 'tool_use') return true;
        return !orphanedToolUseIds.has(typedBlock.id ?? '');
      });

      if (cleanedContent.length === 0) {
        return messages.slice(0, -1);
      }

      return [
        ...messages.slice(0, -1),
        { ...lastMsg, content: cleanedContent },
      ];
    }
  }

  return messages;
}
