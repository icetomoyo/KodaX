import { createHash } from 'node:crypto';
import type { KodaXAssistantBlock, KodaXGenerationSource, KodaXMessage, KodaXToolUseBlock, KodaXImageBlock, KodaXToolResultImageItem } from '../types.js';
import { prepareImageBlock, UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER } from './image-serialization.js';
import { repairCloudToolHistory, sameCloudSource } from './cloud-history.js';

export interface GooglePart {
  text?: string; thought?: boolean; thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown>; partialArgs?: unknown; willContinue?: boolean };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
}
export function googleBlockHash(block: KodaXAssistantBlock): string {
  return createHash('sha256').update(JSON.stringify(block.type === 'tool_use' ? [block.type, block.id, block.name, block.input]
    : block.type === 'thinking' ? [block.type, block.thinking] : block.type === 'text' ? [block.type, block.text] : [block.type, block.data])).digest('hex');
}
async function imageParts(block: KodaXImageBlock | KodaXToolResultImageItem, enabled: boolean): Promise<GooglePart[]> {
  if (!enabled) return [{ text: UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER }];
  const prepared = await prepareImageBlock(block);
  return 'placeholder' in prepared ? [{ text: prepared.placeholder }]
    : [...(prepared.notice ? [{ text: prepared.notice }] : []), { inlineData: { mimeType: prepared.mediaType, data: prepared.data } }];
}
export async function projectGoogleMessages(messages: readonly KodaXMessage[], source: KodaXGenerationSource, images = false): Promise<{ role: 'user' | 'model'; parts: GooglePart[] }[]> {
  const result: { role: 'user' | 'model'; parts: GooglePart[] }[] = [];
  const calls = new Map<string, { block: KodaXToolUseBlock; native: boolean }>();
  for (const message of repairCloudToolHistory(messages)) {
    const parts: GooglePart[] = [];
    if (typeof message.content === 'string') parts.push({ text: message.content });
    else for (const block of message.content) {
      const replay = 'googlePart' in block ? block.googlePart : undefined;
      const own = !!replay && sameCloudSource(replay.source, source) && replay.contentHash === googleBlockHash(block as KodaXAssistantBlock);
      const signature = own && replay.thoughtSignature ? { thoughtSignature: replay.thoughtSignature } : {};
      switch (block.type) {
        case 'text': parts.push({ text: block.text, ...signature }); break;
        case 'thinking': if (own) parts.push({ text: block.thinking, thought: true, ...signature });
          else if (block.thinking) parts.push({ text: `<prior_reasoning>\n${block.thinking}\n</prior_reasoning>` }); break;
        case 'tool_use': {
          // Foreign/edited calls are readable history, never synthetic signed tool turns.
          calls.set(block.id, { block, native: own });
          parts.push(own ? { functionCall: { ...(replay.callId ? { id: replay.callId } : {}), name: block.name, args: block.input }, ...signature }
            : { text: `<prior_tool_call name=${JSON.stringify(block.name)}>\n${JSON.stringify(block.input)}\n</prior_tool_call>` });
          break;
        }
        case 'tool_result': {
          const call = calls.get(block.tool_use_id);
          if (!call) break;
          const text = typeof block.content === 'string' ? block.content : block.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
          if (call.native) parts.push({ functionResponse: { ...(call.block.googlePart?.callId ? { id: call.block.googlePart.callId } : {}),
            name: call.block.name, response: block.is_error ? { error: text } : { output: text } } });
          else parts.push({ text: `<prior_tool_result name=${JSON.stringify(call.block.name)}>\n${text}\n</prior_tool_result>` });
          const imagesInResult = typeof block.content === 'string' ? [] : block.content.filter(item => item.type === 'image');
          for (const item of imagesInResult) {
            parts.push(...await imageParts(item, images));
          }
          calls.delete(block.tool_use_id); break;
        }
        case 'image': {
          parts.push(...await imageParts(block, images));
          break;
        }
        case 'cache-boundary': case 'redacted_thinking': break;
      }
    }
    if (!parts.length) continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const previous = result.at(-1);
    if (previous?.role === role) previous.parts.push(...parts); else result.push({ role, parts });
  }
  return result;
}
