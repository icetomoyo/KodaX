import { createHash } from 'node:crypto';
import type { KodaXGenerationSource, KodaXImageBlock, KodaXMessage, KodaXToolResultBlock, KodaXToolResultImageItem } from '../types.js';
import { sameCloudSource, repairCloudToolHistory } from './cloud-history.js';
import { prepareImageBlock, UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER } from './image-serialization.js';

type Part = { type: 'text'; text: string } | { type: 'thinking'; thinking: { type: 'text'; text: string }[] }
  | { type: 'image_url'; image_url: { url: string } };
async function imageParts(block: KodaXImageBlock | KodaXToolResultImageItem, enabled: boolean): Promise<Part[]> {
  if (!enabled) return [{ type: 'text', text: UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER }];
  const image = await prepareImageBlock(block);
  if ('placeholder' in image) return [{ type: 'text', text: image.placeholder }];
  return [...(image.notice ? [{ type: 'text' as const, text: image.notice }] : []),
    { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } }];
}
async function receiptImages(content: KodaXToolResultBlock['content'], enabled: boolean): Promise<Part[]> {
  const result: Part[] = [];
  if (typeof content !== 'string') for (const item of content) {
    if (item.type === 'image') result.push(...await imageParts(item, enabled));
  }
  return result;
}
export async function projectMistralMessages(messages: readonly KodaXMessage[], source: KodaXGenerationSource, images: boolean): Promise<Record<string, unknown>[]> {
  const history = repairCloudToolHistory(messages);
  const calls = history.flatMap(m => typeof m.content === 'string' ? [] : m.content.filter(b => b.type === 'tool_use'));
  const occupied = new Set(calls.map(c => c.id).filter(id => /^[A-Za-z0-9]{9}$/.test(id)));
  const ids = new Map<string, string>();
  for (const call of calls) {
    let id = call.id;
    if (!/^[A-Za-z0-9]{9}$/.test(id)) {
      let attempt = 0;
      do { id = createHash('sha256').update(`${call.id}:${attempt++}`).digest('hex').slice(0, 9); } while (occupied.has(id));
      occupied.add(id);
    }
    ids.set(call.id, id);
  }
  const result: Record<string, unknown>[] = [];
  for (const message of history) {
    if (typeof message.content === 'string') { result.push({ role: message.role, content: message.content }); continue; }
    const content: Part[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'text': content.push({ type: 'text', text: block.text }); break;
        case 'thinking':
          content.push(block.source && sameCloudSource(block.source, source)
            ? { type: 'thinking', thinking: [{ type: 'text', text: block.thinking }] }
            : { type: 'text', text: `<prior_reasoning>\n${block.thinking}\n</prior_reasoning>` }); break;
        case 'tool_use': toolCalls.push({ id: ids.get(block.id), type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } }); break;
        case 'tool_result': {
          const text = typeof block.content === 'string' ? block.content : block.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          result.push({ role: 'tool', tool_call_id: ids.get(block.tool_use_id), content: text });
          content.push(...await receiptImages(block.content, images));
          break;
        }
        case 'image': content.push(...await imageParts(block, images)); break;
        case 'redacted_thinking': case 'cache-boundary': break;
      }
    }
    if (content.length || toolCalls.length) result.push({ role: message.role, content,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(message.role === 'assistant' ? { prefix: false } : {}) });
  }
  return result;
}
