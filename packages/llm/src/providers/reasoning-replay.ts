import type { KodaXMessage } from '../types.js';

// Issue 441: replayed reasoning from another model used to reach the model as
// `<prior_reasoning>` text, and models learned to open their replies with one.
// Replay removes such a segment from the start of assistant text so history
// stops teaching the pattern. A tag later in the text stays: it may be a real
// discussion of the tag.
const LEADING_PRIOR_REASONING = /^\s*<prior_reasoning>[\s\S]*?<\/prior_reasoning>\s*/;

export function stripLeadingPriorReasoning(text: string): string {
  return text.replace(LEADING_PRIOR_REASONING, '');
}

/** Replay copy of history; stored history is never changed. Unchanged messages keep their identity. */
export function withoutReplayArtifacts(messages: readonly KodaXMessage[]): KodaXMessage[] {
  return messages.map(message => {
    if (message.role !== 'assistant') return message;
    if (typeof message.content === 'string') {
      const text = stripLeadingPriorReasoning(message.content);
      return text === message.content ? message : { ...message, content: text };
    }
    if (!message.content.some(block => block.type === 'text' && LEADING_PRIOR_REASONING.test(block.text))) return message;
    const content = message.content.flatMap(block => {
      if (block.type !== 'text' || !LEADING_PRIOR_REASONING.test(block.text)) return [block];
      const text = stripLeadingPriorReasoning(block.text);
      return text ? [{ ...block, text }] : [];
    });
    return { ...message, content };
  });
}

/**
 * Lenient reasoning channels replay thinking that is only '...' as empty. Models
 * copied that placeholder and stopped reasoning; an empty block keeps the slot
 * that DeepSeek requires on a tool turn without teaching anything.
 */
export function replayableReasoning(text: string): string {
  return text.trim() === '...' ? '' : text;
}
