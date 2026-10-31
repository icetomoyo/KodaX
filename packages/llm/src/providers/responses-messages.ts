import type { ResponseInput, ResponseInputContent } from 'openai/resources/responses/responses';
import type { KodaXGenerationSource, KodaXImageBlock, KodaXMessage, KodaXToolResultImageItem } from '../types.js';
import { KODAX_INTERRUPTED_TOOL_RESULT_MARKER } from '../constants.js';

function sameSource(left: KodaXGenerationSource | undefined, right: KodaXGenerationSource): boolean {
  return !!left && left.api === right.api && left.provider === right.provider && left.model === right.model
    && left.baseUrl === right.baseUrl && left.credentialScope === right.credentialScope;
}
function cacheBoundary(input: ResponseInput): void {
  const last = input.at(-1);
  if (!last) return;
  const marked = (text: string) => ({ type: 'input_text' as const, text, prompt_cache_breakpoint: { mode: 'explicit' as const } });
  if ('role' in last && last.role !== 'assistant' && typeof last.content === 'string') {
    input[input.length - 1] = { ...last, content: [marked(last.content)] };
  } else if (last.type === 'function_call_output' && typeof last.output === 'string') {
    input[input.length - 1] = { ...last, output: [marked(last.output)] };
  }
}

/** Pure wire projection, shared by transport and cache diagnostics. */
export function projectResponsesMessages(
  messages: readonly KodaXMessage[],
  source: KodaXGenerationSource,
  image: (block: KodaXImageBlock | KodaXToolResultImageItem) => ResponseInputContent[],
  options: { cacheBreakpoints?: boolean; settleTrailing?: boolean } = {},
): ResponseInput {
  const input: ResponseInput = [];
  const pending = new Map<string, 'function' | 'custom'>();
  const seen = new Set<string>();
  const settleMissing = (): void => {
    for (const [call_id, kind] of pending) input.push({ type: kind === 'custom' ? 'custom_tool_call_output' : 'function_call_output', call_id,
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
        case 'tool_use': {
          if (!block.id || seen.has(block.id)) throw new Error('Responses history contains an empty or duplicate tool call ID.');
          seen.add(block.id);
          const custom = block.customTool;
          const text = custom && typeof custom.property === 'string' && sameSource(custom.source, source) && Object.keys(block.input).length === 1
            && Object.hasOwn(block.input, custom.property) ? block.input[custom.property] : undefined;
          pending.set(block.id, typeof text === 'string' ? 'custom' : 'function');
          input.push(typeof text === 'string' ? { type: 'custom_tool_call', call_id: block.id, name: block.name, input: text }
            : { type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
          break;
        }
        case 'tool_result': {
          const kind = pending.get(block.tool_use_id);
          if (!pending.delete(block.tool_use_id)) break;
          input.push({ type: kind === 'custom' ? 'custom_tool_call_output' : 'function_call_output', call_id: block.tool_use_id,
            output: typeof block.content === 'string' ? block.content : block.content.flatMap(item =>
              item.type === 'text' ? [{ type: 'input_text' as const, text: item.text }] : image(item)) });
          break;
        }
        case 'thinking': {
          const replay = block.responsesReasoning;
          if (replay && sameSource(replay.source, source)) {
            input.push({ type: 'reasoning', id: replay.id, summary: replay.summary,
              ...(replay.encrypted_content ? { encrypted_content: replay.encrypted_content } : {}) });
          } else if (block.thinking) {
            input.push({ role: 'assistant', content: `<prior_reasoning>\n${block.thinking}\n</prior_reasoning>` });
          }
          break;
        }
        // Foreign opaque signatures and local-only boundaries are never sent.
        case 'cache-boundary': if (options.cacheBreakpoints) cacheBoundary(input); break;
        case 'redacted_thinking': break;
      }
    }
  }
  if (options.settleTrailing !== false) settleMissing();
  return input;
}
