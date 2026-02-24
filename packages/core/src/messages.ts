/**
 * KodaX Messages
 *
 * 消息处理 - 消息压缩和历史管理
 */

import { KodaXMessage, KodaXContentBlock, KodaXTextBlock, KodaXToolUseBlock } from './types.js';
import { KODAX_COMPACT_THRESHOLD, KODAX_COMPACT_KEEP_RECENT, KODAX_TOOL_REQUIRED_PARAMS } from './constants.js';
import { estimateTokens } from './tokenizer.js';

/**
 * 压缩消息历史
 * 当消息超过阈值时，保留最近的消息，压缩旧消息
 */
export function compactMessages(messages: KodaXMessage[]): KodaXMessage[] {
  if (estimateTokens(messages) <= KODAX_COMPACT_THRESHOLD) return messages;
  const recent = messages.slice(-KODAX_COMPACT_KEEP_RECENT);
  const old = messages.slice(0, -KODAX_COMPACT_KEEP_RECENT);
  const summary = old.map(m => {
    const content = typeof m.content === 'string' ? m.content : (m.content as KodaXContentBlock[]).filter((b): b is KodaXTextBlock => b.type === 'text').map(b => b.text).join(' ');
    return `- ${m.role}: ${content.slice(0, 100)}...`;
  }).join('\n');
  return [{ role: 'user', content: `[对话历史摘要]\n${summary}` }, ...recent];
}

/**
 * 检查工具调用是否完整
 * 返回不完整工具调用列表
 */
export function checkIncompleteToolCalls(toolBlocks: KodaXToolUseBlock[]): string[] {
  const incomplete: string[] = [];
  for (const tc of toolBlocks) {
    const required = KODAX_TOOL_REQUIRED_PARAMS[tc.name] ?? [];
    const input = (tc.input ?? {}) as Record<string, unknown>;
    for (const param of required) {
      if (input[param] === undefined || input[param] === null || input[param] === '') {
        incomplete.push(`${tc.name}: missing '${param}'`);
      }
    }
  }
  return incomplete;
}
