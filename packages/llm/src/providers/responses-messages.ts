import type { ResponseInput, ResponseInputContent } from 'openai/resources/responses/responses';
import type { KodaXGenerationSource, KodaXImageBlock, KodaXMessage, KodaXToolResultImageItem } from '../types.js';

/** Pure wire projection, shared by transport and cache diagnostics. */
export function projectResponsesMessages(
  messages: readonly KodaXMessage[],
  source: KodaXGenerationSource,
  image: (block: KodaXImageBlock | KodaXToolResultImageItem) => ResponseInputContent[],
): ResponseInput {
  const input: ResponseInput = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      input.push({ role: message.role, content: message.content });
      continue;
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text': input.push({ role: message.role, content: block.text }); break;
        case 'image': input.push({ role: 'user', content: image(block) }); break;
        case 'tool_use':
          input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
          break;
        case 'tool_result':
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
          }
          break;
        }
        // Foreign opaque signatures and local-only boundaries are never sent.
        case 'redacted_thinking': case 'cache-boundary': break;
      }
    }
  }
  return input;
}
