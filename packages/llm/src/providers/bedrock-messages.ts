import type { ContentBlock, Message, ConverseCommandInput, ToolResultContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { KodaXGenerationSource, KodaXMessage, KodaXImageBlock, KodaXToolResultImageItem } from '../types.js';
import { prepareImageBlock, UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER } from './image-serialization.js';
import { repairCloudToolHistory, sameCloudSource } from './cloud-history.js';
import { resolvePromptCacheDisabled } from '../run-scoped-config.js';

type Document = Exclude<ConverseCommandInput['additionalModelRequestFields'], undefined>;
export function bedrockDocument(value: unknown): Document {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(bedrockDocument);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bedrockDocument(entry)]));
  throw new Error('Bedrock document must contain JSON values.');
}
async function image(block: KodaXImageBlock | KodaXToolResultImageItem, enabled: boolean): Promise<Array<{ text: string } | { image: { format: 'png' | 'jpeg' | 'gif' | 'webp'; source: { bytes: Uint8Array } } }>> {
  if (!enabled) return [{ text: UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER }];
  const prepared = await prepareImageBlock(block);
  if ('placeholder' in prepared) return [{ text: prepared.placeholder }];
  const format = prepared.mediaType.split('/')[1];
  if (!['png', 'jpeg', 'gif', 'webp'].includes(format!)) throw new Error('Unsupported Bedrock image format.');
  return [...(prepared.notice ? [{ text: prepared.notice }] : []), { image: { format: format as 'png' | 'jpeg' | 'gif' | 'webp', source: { bytes: Buffer.from(prepared.data, 'base64') } } }];
}
export async function projectBedrockMessages(messages: readonly KodaXMessage[], source: KodaXGenerationSource, cache: boolean, images = false): Promise<Message[]> {
  const result: Message[] = [];
  for (const message of repairCloudToolHistory(messages)) {
    const content: ContentBlock[] = [];
    if (typeof message.content === 'string') { if (message.content) content.push({ text: message.content }); }
    else for (const block of message.content) {
      switch (block.type) {
        case 'text': if (block.text) content.push({ text: block.text }); break;
        case 'thinking':
          if (block.source && sameCloudSource(block.source, source) && block.signature) content.push({ reasoningContent: { reasoningText: { text: block.thinking, signature: block.signature } } });
          else if (block.thinking) content.push({ text: `<prior_reasoning>\n${block.thinking}\n</prior_reasoning>` }); break;
        case 'redacted_thinking': if (block.source && sameCloudSource(block.source, source)) content.push({ reasoningContent: { redactedContent: Buffer.from(block.data, 'base64') } }); break;
        case 'tool_use': content.push({ toolUse: { toolUseId: block.id, name: block.name, input: bedrockDocument(block.input) } }); break;
        case 'tool_result': {
          const output: ToolResultContentBlock[] = [];
          if (typeof block.content === 'string') output.push({ text: block.content || '(empty tool result)' });
          else for (const item of block.content) output.push(...(item.type === 'text' ? [{ text: item.text || '(empty tool result)' }] : await image(item, images)));
          content.push({ toolResult: { toolUseId: block.tool_use_id, content: output.length ? output : [{ text: '(empty tool result)' }], status: block.is_error ? 'error' : 'success' } }); break;
        }
        case 'image': content.push(...await image(block, images)); break;
        case 'cache-boundary': if (cache && !resolvePromptCacheDisabled() && content.length) content.push({ cachePoint: { type: 'default' } }); break;
      }
    }
    if (!content.length) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = result.at(-1);
    if (previous?.role === role) previous.content!.push(...content); else result.push({ role, content });
  }
  return result;
}
