import { createHash } from 'node:crypto';
import type { KodaXAssistantBlock, KodaXGenerationSource, KodaXImageBlock, KodaXMessage, KodaXToolResultBlock, KodaXToolResultImageItem } from '../types.js';
import { repairCloudToolHistory, sameCloudSource } from './cloud-history.js';
import { withoutReplayArtifacts } from './reasoning-replay.js';
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
/**
 * A turn written by another model, or edited since, replays as a pi assistant message from an
 * unknown origin: pi then treats it as foreign, drops reasoning and signatures, and keeps the calls
 * structured. Its usage is unknown, so it reports zero rather than another model's numbers.
 */
const FOREIGN_ORIGIN = { api: 'unknown', provider: 'unknown', model: 'unknown',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
function foreignAssistant(blocks: readonly KodaXAssistantBlock[], timestamp: number): Record<string, unknown> | undefined {
  const content = blocks.flatMap((block): Record<string, unknown>[] => block.type === 'tool_use' ? [{ type: 'toolCall', id: block.id, name: block.name, arguments: block.input }]
    // Reasoning from another model is never replayed (Issue 441).
    : block.type === 'text' && block.text ? [{ type: 'text', text: block.text }] : []);
  if (!content.length) return undefined;
  return { role: 'assistant', content, ...FOREIGN_ORIGIN, stopReason: content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop', timestamp };
}
export async function projectPiMessages(messages: readonly KodaXMessage[], source: KodaXGenerationSource, images: boolean): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  const names = new Map<string, string>();
  for (const message of repairCloudToolHistory(withoutReplayArtifacts(messages))) {
    const parsedTime = Date.parse(message.timestamp ?? '');
    const timestamp = Number.isFinite(parsedTime) ? parsedTime : 0; // Explicitly unknown historical time.
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    const assistant = message.role === 'assistant' ? blocks.filter((b): b is KodaXAssistantBlock => ['text', 'thinking', 'tool_use', 'redacted_thinking'].includes(b.type)) : undefined;
    const metadata = assistant?.[0]?.piPart?.message;
    const nativeAssistant = !!assistant?.length && !!metadata && assistant.every(block => block.piPart
      && sameCloudSource(block.piPart.source, source) && block.piPart.contentHash === piBlockHash(block));
    if (assistant && !nativeAssistant) {
      for (const block of assistant) if (block.type === 'tool_use') names.set(block.id, block.name);
      const replay = foreignAssistant(assistant, timestamp);
      if (replay) result.push(replay);
      continue;
    }
    if (typeof message.content === 'string') { result.push({ role: message.role, content: message.content, timestamp }); continue; }
    const content: Record<string, unknown>[] = [];
    for (const block of message.content) {
      const replay = 'piPart' in block ? block.piPart : undefined;
      const own = !!replay && sameCloudSource(replay.source, source) && replay.contentHash === piBlockHash(block as KodaXAssistantBlock);
      switch (block.type) {
        case 'text': content.push({ type: 'text', text: block.text, ...(own && replay.contentSignature ? { textSignature: replay.contentSignature } : {}) }); break;
        case 'thinking': if (own) content.push({ type: 'thinking', thinking: block.thinking, ...(replay.contentSignature ? { thinkingSignature: replay.contentSignature } : {}) }); break;
        case 'redacted_thinking': if (own) content.push({ type: 'thinking', thinking: '', thinkingSignature: block.data, redacted: true }); break;
        case 'tool_use': names.set(block.id, block.name); content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: block.input }); break;
        case 'tool_result': {
          // Repair drops receipts without a call, so every receipt here names one.
          const toolName = names.get(block.tool_use_id);
          if (toolName === undefined) break;
          result.push({ role: 'toolResult', toolCallId: block.tool_use_id, toolName, content: await receiptParts(block.content, images), isError: block.is_error === true, timestamp });
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
