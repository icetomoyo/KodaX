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
 * CRITICAL: 确保 assistant(tool_use) 和 user(tool_result) 不被拆开
 *
 * @deprecated Superseded by the pluggable `CompactionPolicy` interface in
 *   `@kodax/coding/primitives/compaction.ts` (FEATURE_081, v0.7.23). For
 *   coding-preset use, `LineageCompaction` (v0.7.24) preserves the full
 *   FEATURE_072 post-compact reconstruction behavior; for external agents,
 *   use `DefaultSummaryCompaction`. This helper will be removed in
 *   FEATURE_086 (v0.7.27).
 */
export function compactMessages(messages: KodaXMessage[]): KodaXMessage[] {
  if (estimateTokens(messages) <= KODAX_COMPACT_THRESHOLD) {
    return messages;
  }

  // 计算保留条数
  let keepCount = Math.min(KODAX_COMPACT_KEEP_RECENT, messages.length);
  let cutIndex = messages.length - keepCount;

  // 避免将 tool_result 和前面的 tool_use 拆散
  if (cutIndex > 0 && cutIndex < messages.length) {
    const msgAtCut = messages[cutIndex];
    if (msgAtCut?.role === 'user' && typeof msgAtCut.content !== 'string') {
      const hasToolResult = msgAtCut.content.some((b: any) => b.type === 'tool_result');
      if (hasToolResult) {
        // 如果切在 tool_result 上，往前多保留一条
        cutIndex = Math.max(0, cutIndex - 1);
      }
    }
  }

  const recent = messages.slice(cutIndex);
  const old = messages.slice(0, cutIndex);

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
