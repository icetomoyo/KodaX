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
 *     empty assistant messages with 400, so we inject an EMPTY text-block
 *     marker when stripping would empty an assistant message — the visible
 *     `'...'` is synthesized wire-only by the provider serializer, never
 *     persisted into history).
 *
 * Migration history: extracted from `agent.ts` (originally lines 517–758)
 * during FEATURE_100 P2. Both `agent.ts` and `task-engine/runner-driven.ts`
 * already consume these via the package re-export (`@kodax-ai/coding`).
 *
 * Type guards are inlined here rather than imported from agent.ts because
 * the migration's whole point is to remove dependencies on agent.ts. If
 * additional agent-runtime modules need the same guards in the future,
 * extract them to `agent-runtime/content-blocks.ts`.
 */

import type { KodaXMessage } from '@kodax-ai/llm';
import { emitKodaXDiagnostic } from '../diagnostics.js';

type MessageContentBlock = Exclude<KodaXMessage['content'], string>[number];

function reportToolHistoryDiagnostic(message: string, detail?: unknown): void {
  emitKodaXDiagnostic({
    source: 'agent:tool-history',
    level: 'debug',
    message,
    ...(detail !== undefined ? { detail } : {}),
  });
}

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

function toolUseIds(message: KodaXMessage | undefined): Set<string> {
  const ids = new Set<string>();
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return ids;
  for (const block of message.content) {
    if (isToolUseContentBlock(block) && block.id) ids.add(block.id);
  }
  return ids;
}

function answersAnyCall(message: KodaXMessage, callIds: ReadonlySet<string>): boolean {
  return message.role === 'user'
    && Array.isArray(message.content)
    && message.content.some((block) =>
      isToolResultContentBlock(block) && callIds.has(block.tool_use_id));
}

/**
 * An assistant's tool calls own every message up to the next assistant — the
 * same pairing scope the provider serializers use. Messages that answer those
 * calls move directly after the assistant (keeping their relative order) and
 * any interposed message, such as an internal context envelope, follows them.
 * Scopes whose answers are already adjacent keep their exact order.
 */
function hoistScopedToolResults(messages: KodaXMessage[]): KodaXMessage[] {
  const ordered: KodaXMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    ordered.push(message);
    index += 1;
    const callIds = toolUseIds(message);
    if (callIds.size === 0) continue;
    const answers: KodaXMessage[] = [];
    const interposed: KodaXMessage[] = [];
    while (index < messages.length && messages[index]?.role !== 'assistant') {
      const scoped = messages[index]!;
      (answersAnyCall(scoped, callIds) ? answers : interposed).push(scoped);
      index += 1;
    }
    ordered.push(...answers, ...interposed);
  }
  return ordered;
}

/**
 * Walk the message history and remove mis-paired `tool_use` / `tool_result`
 * blocks. Never mutates input; message count is preserved.
 *
 * Rules enforced (scope = an assistant plus every message before the next
 * assistant):
 *   - result carriers move next to their assistant (see
 *     `hoistScopedToolResults`), so an interposed internal message cannot
 *     break a pair
 *   - assistant `tool_use` with no matching `tool_result` in its scope →
 *     removed
 *   - assistant `tool_use` with empty / missing id → removed
 *   - user `tool_result` with no matching `tool_use` in the scope's
 *     assistant → removed
 *   - user `tool_result` with empty / missing tool_use_id → removed
 *   - assistant message that becomes content-empty after stripping → inject
 *     an EMPTY text-block marker (preserves message-alternation invariant
 *     downstream providers like Kimi require; the visible '...' is added
 *     wire-only by the serializer, never persisted)
 */
export function validateAndFixToolHistory(input: KodaXMessage[]): KodaXMessage[] {
  const messages = hoistScopedToolResults(input);
  if (process.env.KODAX_DEBUG_TOOL_HISTORY) {
    reportToolHistoryDiagnostic('Validating messages.', { count: messages.length });
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;

      const toolUses = msg.content.filter(isToolUseContentBlock);
      const toolResults = msg.content.filter(isToolResultContentBlock);

      if (toolUses.length > 0 || toolResults.length > 0) {
        reportToolHistoryDiagnostic(`Message ${i} ${msg.role}.`, {
          toolUses: toolUses.map((toolUse) => ({ id: toolUse.id, name: toolUse.name })),
          toolResults: toolResults.map((toolResult) => ({ tool_use_id: toolResult.tool_use_id })),
        });
      }
    }
  }

  const fixedMessages: KodaXMessage[] = [];
  // Call ids of the assistant that owns the current pairing scope.
  let scopeCallIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'assistant') scopeCallIds = toolUseIds(msg);

    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) {
      fixedMessages.push(msg);
      continue;
    }

    const content = msg.content;
    const fixedContent: typeof content = [];

    if (msg.role === 'assistant') {
      const resultIds = new Set<string>();

      for (let j = i + 1; j < messages.length && messages[j]?.role !== 'assistant'; j++) {
        const scoped = messages[j];
        if (scoped?.role !== 'user' || !Array.isArray(scoped.content)) continue;
        for (const block of scoped.content) {
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
            reportToolHistoryDiagnostic('Removed tool_use with empty id.');
            continue;
          }

          if (!resultIds.has(block.id)) {
            reportToolHistoryDiagnostic('Removed orphaned tool_use.', { id: block.id });
            continue;
          }

          fixedContent.push(block);
        } else {
          fixedContent.push(block);
        }
      }
    } else if (msg.role === 'user') {
      for (const block of content) {
        if (!isTypedContentBlock(block)) {
          fixedContent.push(block as typeof content[number]);
          continue;
        }

        if (block.type === 'tool_result') {
          if (!block.tool_use_id || typeof block.tool_use_id !== 'string' || block.tool_use_id.trim() === '') {
            reportToolHistoryDiagnostic('Removed tool_result with empty tool_use_id.');
            continue;
          }

          if (!scopeCallIds.has(block.tool_use_id)) {
            reportToolHistoryDiagnostic('Removed orphaned tool_result.', { toolUseId: block.tool_use_id });
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

    // A message fully emptied by orphan stripping must NOT be dropped: removing
    // a mid-conversation turn breaks user/assistant alternation (e.g.
    // user, [dropped all-orphan assistant], user → user,user → Anthropic 400).
    // Hold the slot with an EMPTY text marker instead — this mirrors the
    // provider-side `repairToolCallHistory`, which already replaces an emptied
    // turn with a wire-only '...' for exactly this reason. The empty marker is
    // honest in history (a persisted '...' would leak to SDK/REPL as a
    // fabricated reply); the serializer synthesizes the wire-only '...' when a
    // gateway (e.g. Kimi) rejects empty content.
    if (fixedContent.length === 0) {
      fixedMessages.push({ ...msg, content: [{ type: 'text', text: '' }] });
      continue;
    }

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
        // Inject an EMPTY text block, not a persisted '...'. The empty
        // marker preserves message alternation (dropping would orphan
        // adjacent tool_result blocks) while keeping history honest — a
        // persisted '...' leaks to SDK/REPL as a fabricated reply. The
        // provider serializer synthesizes a wire-only '...' if the
        // gateway (e.g. Kimi) rejects empty content.
        fixedMessages.push({ ...msg, content: [{ type: 'text', text: '' }] });
        continue;
      }
    }
    fixedMessages.push({ ...msg, content: fixedContent });
  }

  // Note: message count is preserved — a fully-emptied turn is held with an
  // empty-text marker (to keep role alternation), not dropped — so we no longer
  // log a removed-message count here. Per-block removals are logged inline above.

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
