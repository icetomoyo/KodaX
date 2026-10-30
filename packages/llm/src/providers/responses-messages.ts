import type { ResponseInput, ResponseInputContent } from 'openai/resources/responses/responses';
import type { KodaXGenerationSource, KodaXImageBlock, KodaXMessage, KodaXToolResultImageItem } from '../types.js';
import { KODAX_INTERRUPTED_TOOL_RESULT_MARKER } from '../constants.js';

/** Pure wire projection, shared by transport and cache diagnostics. */
export function projectResponsesMessages(
  messages: readonly KodaXMessage[],
  source: KodaXGenerationSource,
  image: (block: KodaXImageBlock | KodaXToolResultImageItem) => ResponseInputContent[],
): ResponseInput {
  const input: ResponseInput = [];
  const pending = new Set<string>();
  const seen = new Set<string>();
  const settleMissing = (): void => {
    for (const call_id of pending) input.push({ type: 'function_call_output', call_id,
      output: `${KODAX_INTERRUPTED_TOOL_RESULT_MARKER} Tool execution was interrupted; no result is available.` });
    pending.clear();
  };
  for (const message of messages) {
    if (typeof message.content === 'string') {
      settleMissing();
      input.push({ role: message.role, content: message.content });
      continue;
    }
    // Receipts must settle the previous assistant turn before new user content.
    if (message.role === 'assistant') settleMissing();
    const blocks = message.role === 'user'
      ? [...message.content.filter(b => b.type === 'tool_result'), ...message.content.filter(b => b.type !== 'tool_result')]
      : message.content;
    for (const block of blocks) {
      if (message.role === 'user' && block.type !== 'tool_result') settleMissing();
      switch (block.type) {
        case 'text': input.push({ role: message.role, content: block.text }); break;
        case 'image': input.push({ role: 'user', content: image(block) }); break;
        case 'tool_use':
          if (!block.id || seen.has(block.id)) throw new Error('Responses history contains an empty or duplicate tool call ID.');
          seen.add(block.id);
          pending.add(block.id);
          input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
          break;
        case 'tool_result':
          if (!pending.delete(block.tool_use_id)) break;
          input.push({ type: 'function_call_output', call_id: block.tool_use_id,
            output: typeof block.content === 'string' ? block.content : block.content.flatMap(item =>
              item.type === 'text' ? [{ type: 'input_text' as const, text: item.text }] : image(item)) });
          break;
        case 'thinking': {
          const replay = block.responsesReasoning;
          if (replay && replay.source.api === source.api && replay.source.provider === source.provider
            && replay.source.model === source.model && replay.source.baseUrl === source.baseUrl) {
            input.push({ type: 'reasoning', id: replay.id, summary: replay.summary,
              ...(replay.encrypted_content ? { encrypted_content: replay.encrypted_content } : {}) });
          } else if (block.thinking) {
            input.push({ role: 'assistant', content: `<prior_reasoning>\n${block.thinking}\n</prior_reasoning>` });
          }
          break;
        }
        // Foreign opaque signatures and local-only boundaries are never sent.
        case 'redacted_thinking': case 'cache-boundary': break;
      }
    }
  }
  settleMissing();
  return input;
}
