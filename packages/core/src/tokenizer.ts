/**
 * KodaX Tokenizer
 *
 * Token 估算 - 简单的基于字符数的 token 估算
 */

import { KodaXMessage, KodaXContentBlock, KodaXTextBlock } from './types.js';

/**
 * 估算消息的 token 数量
 * 使用简单的字符数/4 估算（约等于 GPT token 估算）
 */
export function estimateTokens(messages: KodaXMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') total += Math.ceil(m.content.length / 4);
    else for (const b of m.content) {
      if (b.type === 'text') total += Math.ceil(b.text.length / 4);
      else if (b.type === 'tool_result') total += Math.ceil(b.content.length / 4);
    }
  }
  return total;
}
