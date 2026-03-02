/**
 * @kodax/agent Messages
 *
 * 消息处理 - 消息压缩和历史管理
 */

import type { KodaXMessage, KodaXContentBlock, KodaXTextBlock } from '@kodax/ai';
import { KODAX_COMPACT_THRESHOLD, KODAX_COMPACT_KEEP_RECENT } from './constants.js';
import { estimateTokens } from './tokenizer.js';

/**
 * 压缩消息历史
 * 当消息超过阈值时，保留最近的消息，压缩旧消息
 */
export function compactMessages(messages: KodaXMessage[]): KodaXMessage[] {
  if (estimateTokens(messages) <= KODAX_COMPACT_THRESHOLD) {
    return messages;
  }

  const recent = messages.slice(-KODAX_COMPACT_KEEP_RECENT);
  const old = messages.slice(0, -KODAX_COMPACT_KEEP_RECENT);

  const summary = old.map(m => {
    const content = typeof m.content === 'string'
      ? m.content
      : (m.content as KodaXContentBlock[])
          .filter((b): b is KodaXTextBlock => b.type === 'text')
          .map(b => b.text)
          .join(' ');
    return `- ${m.role}: ${content.slice(0, 100)}...`;
  }).join('\n');

  return [{ role: 'user', content: `[对话历史摘要]\n${summary}` }, ...recent];
}
