import type { KodaXAssistantBlock, KodaXRedactedThinkingBlock, KodaXThinkingBlock, KodaXToolUseBlock } from './types.js';

/** Keep known order while applying the consumer's authoritative sanitation/visibility/tool repairs. */
export function reconcileAssistantContent(
  ordered: readonly KodaXAssistantBlock[] | undefined,
  result: { textBlocks?: readonly { text: string }[]; toolBlocks?: readonly KodaXToolUseBlock[];
    thinkingBlocks?: readonly (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[] },
): KodaXAssistantBlock[] {
  const texts = (result.textBlocks ?? []).map(b => ({ type: 'text' as const, text: b.text }));
  const thinking = result.thinkingBlocks ?? [];
  const tools = result.toolBlocks ?? [];
  if (!ordered) return [...thinking, ...texts, ...tools];
  const originalText = ordered.filter(b => b.type === 'text').map(b => b.text).join('');
  const finalText = texts.map(b => b.text).join('');
  const unchangedText = originalText === finalText;
  const trimmedSuffix = !unchangedText && originalText.startsWith(finalText);
  let remainingText = finalText.length;
  const calls = new Map(tools.map(b => [b.id, b]));
  const blocks: KodaXAssistantBlock[] = [];
  let textEmitted = false;
  let thoughtIndex = 0;
  for (const block of ordered) {
    if (block.type === 'tool_use') {
      const call = calls.get(block.id);
      if (call) { blocks.push(call); calls.delete(block.id); }
    } else if (block.type === 'text') {
      if (unchangedText) blocks.push(block);
      else if (trimmedSuffix) {
        const text = block.text.slice(0, remainingText);
        if (text) blocks.push({ type: 'text', text });
        remainingText -= text.length;
      }
      else if (!textEmitted) blocks.push(...texts);
      textEmitted = true;
    } else {
      const thought = thinking[thoughtIndex++];
      if (thought) blocks.push(thought);
    }
  }
  // A guard can synthesize new text/tools. They have no native position to recover.
  if (!textEmitted) blocks.push(...texts);
  blocks.push(...thinking.slice(thoughtIndex), ...calls.values());
  return blocks;
}
