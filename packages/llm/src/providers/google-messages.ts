import { createHash } from 'node:crypto';
import type { KodaXAssistantBlock, KodaXGenerationSource, KodaXMessage, KodaXToolUseBlock, KodaXImageBlock, KodaXToolResultImageItem } from '../types.js';
import { prepareImageBlock, UNSUPPORTED_TOOL_RESULT_IMAGE_PLACEHOLDER } from './image-serialization.js';
import { repairCloudToolHistory, sameCloudSource } from './cloud-history.js';
import { withoutReplayArtifacts } from './reasoning-replay.js';

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
/**
 * Gemini 3 rejects a model step whose first functionCall has no signature. Calls written by
 * another model or edited since carry Google's documented skip value instead, base64-encoded
 * because the field is bytes.
 */
const SKIP_SIGNATURE = Buffer.from('skip_thought_signature_validator').toString('base64');
function signFirstCall(parts: GooglePart[]): void {
  const first = parts.find(part => part.functionCall);
  if (first && !first.thoughtSignature) first.thoughtSignature = SKIP_SIGNATURE;
}
export async function projectGoogleMessages(messages: readonly KodaXMessage[], source: KodaXGenerationSource, images = false): Promise<{ role: 'user' | 'model'; parts: GooglePart[] }[]> {
  const result: { role: 'user' | 'model'; parts: GooglePart[] }[] = [];
  const calls = new Map<string, { block: KodaXToolUseBlock; callId?: string }>();
  for (const message of repairCloudToolHistory(withoutReplayArtifacts(messages))) {
    const parts: GooglePart[] = [];
    if (typeof message.content === 'string') parts.push({ text: message.content });
    else for (const block of message.content) {
      const replay = 'googlePart' in block ? block.googlePart : undefined;
      const own = !!replay && sameCloudSource(replay.source, source) && replay.contentHash === googleBlockHash(block as KodaXAssistantBlock);
      const signature = own && replay.thoughtSignature ? { thoughtSignature: replay.thoughtSignature } : {};
      // Gemini reads an empty text as a part without data and rejects the request; a signed one must still echo back.
      const dataless = (block.type === 'text' && !block.text) || (block.type === 'thinking' && !block.thinking);
      if (dataless && !signature.thoughtSignature) continue;
      switch (block.type) {
        case 'text': parts.push({ text: block.text, ...signature }); break;
        // Only own reasoning replays; other reasoning is never reply text (Issue 441).
        case 'thinking': if (own) parts.push({ text: block.thinking, thought: true, ...signature }); break;
        case 'tool_use': {
          // Foreign or edited calls stay structured; read as text, the model starts writing calls as text.
          const callId = own ? replay.callId : undefined;
          calls.set(block.id, { block, callId });
          parts.push({ functionCall: { ...(callId ? { id: callId } : {}), name: block.name, args: block.input }, ...signature });
          break;
        }
        case 'tool_result': {
          const call = calls.get(block.tool_use_id);
          if (!call) break;
          const text = typeof block.content === 'string' ? block.content : block.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
          parts.push({ functionResponse: { ...(call.callId ? { id: call.callId } : {}),
            name: call.block.name, response: block.is_error ? { error: text } : { output: text } } });
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
    if (role === 'model') signFirstCall(parts);
    const previous = result.at(-1);
    if (previous?.role === role) previous.parts.push(...parts); else result.push({ role, parts });
  }
  return result;
}
