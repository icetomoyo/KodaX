import { createHash } from 'node:crypto';
import type { KodaXAssistantBlock, KodaXGenerationSource, KodaXImageBlock, KodaXMessage, KodaXToolResultBlock, KodaXToolResultImageItem } from '../types.js';
import { repairCloudToolHistory, sameCloudSource } from './cloud-history.js';
import { prepareImageBlock, UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER } from './image-serialization.js';

export function piBlockHash(block: KodaXAssistantBlock): string {
  const value = block.type === 'tool_use' ? [block.type, block.id, block.name, block.input]
    : block.type === 'text' ? [block.type, block.text] : block.type === 'thinking' ? [block.type, block.thinking] : [block.type, block.data];
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function imagePart(block: KodaXImageBlock | KodaXToolResultImageItem, enabled: boolean): Promise<Record<string, unknown>[]> {
  if (!enabled) return [{ type: 'text', text: UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER }];
  const image = await prepareImageBlock(block);
  return 'placeholder' in image ? [{ type: 'text', text: image.placeholder }]
    : [...(image.notice ? [{ type: 'text', text: image.notice }] : []), { type: 'image', data: image.data, mimeType: image.mediaType }];
}
async function receiptParts(content: KodaXToolResultBlock['content'], images: boolean): Promise<Record<string, unknown>[]> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const result: Record<string, unknown>[] = [];
  for (const item of content) {
    if (item.type === 'text') result.push({ type: 'text', text: item.text }); else result.push(...await imagePart(item, images));
  }
  return result;
}
export async function projectPiMessages(messages: readonly KodaXMessage[], source: KodaXGenerationSource, images: boolean): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  const names = new Map<string, { name: string; native: boolean }>();
  for (const message of repairCloudToolHistory(messages)) {
    const parsedTime = Date.parse(message.timestamp ?? '');
    const timestamp = Number.isFinite(parsedTime) ? parsedTime : 0; // Explicitly unknown historical time.
    if (typeof message.content === 'string') { result.push({ role: message.role === 'assistant' ? 'user' : message.role,
      content: message.role === 'assistant' ? `<prior_assistant>\n${message.content}\n</prior_assistant>` : message.content, timestamp }); continue; }
    const assistant = message.role === 'assistant' ? message.content.filter((b): b is KodaXAssistantBlock => ['text', 'thinking', 'tool_use', 'redacted_thinking'].includes(b.type)) : undefined;
    const metadata = assistant?.[0]?.piPart?.message;
    const nativeAssistant = !!assistant?.length && !!metadata && assistant.every(block => block.piPart
      && sameCloudSource(block.piPart.source, source) && block.piPart.contentHash === piBlockHash(block));
    if (assistant && !nativeAssistant) {
      const text = assistant.flatMap(block => {
        if (block.type === 'tool_use') { names.set(block.id, { name: block.name, native: false }); return [`<prior_tool_call name=${JSON.stringify(block.name)}>\n${JSON.stringify(block.input)}\n</prior_tool_call>`]; }
        return block.type === 'text' ? [block.text] : block.type === 'thinking' ? [`<prior_reasoning>\n${block.thinking}\n</prior_reasoning>`] : [];
      }).join('\n');
      if (text) result.push({ role: 'user', content: `<prior_assistant>\n${text}\n</prior_assistant>`, timestamp });
      continue;
    }
    const content: Record<string, unknown>[] = [];
    for (const block of message.content) {
      const replay = 'piPart' in block ? block.piPart : undefined;
      const own = !!replay && sameCloudSource(replay.source, source) && replay.contentHash === piBlockHash(block as KodaXAssistantBlock);
      switch (block.type) {
        case 'text': content.push({ type: 'text', text: block.text, ...(own && replay.contentSignature ? { textSignature: replay.contentSignature } : {}) }); break;
        case 'thinking': content.push(own ? { type: 'thinking', thinking: block.thinking, ...(replay.contentSignature ? { thinkingSignature: replay.contentSignature } : {}) }
          : { type: 'text', text: `<prior_reasoning>\n${block.thinking}\n</prior_reasoning>` }); break;
        case 'redacted_thinking': if (own) content.push({ type: 'thinking', thinking: '', thinkingSignature: block.data, redacted: true }); break;
        case 'tool_use': names.set(block.id, { name: block.name, native: true }); content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: block.input }); break;
        case 'tool_result': {
          const receipt = await receiptParts(block.content, images);
          const call = names.get(block.tool_use_id);
          if (call?.native) result.push({ role: 'toolResult', toolCallId: block.tool_use_id, toolName: call.name, content: receipt, isError: block.is_error === true, timestamp });
          else result.push({ role: 'user', content: [{ type: 'text', text: `<prior_tool_result name=${JSON.stringify(call?.name)}>\n${receipt.filter(p => p.type === 'text').map(p => p.text).join('\n')}\n</prior_tool_result>` }, ...receipt.filter(p => p.type === 'image')], timestamp });
          break;
        }
        case 'image': content.push(...await imagePart(block, images)); break;
        case 'cache-boundary': break;
      }
    }
    if (content.length) result.push({ role: message.role, content, timestamp, ...(message.role === 'assistant'
      ? { api: source.api, provider: source.provider, model: source.model, ...metadata } : {}) });
  }
  return result;
}
