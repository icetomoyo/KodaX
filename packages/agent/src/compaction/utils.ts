/**
 * @kodax/agent Compaction Utils
 *
 * 消息序列化工具 - 将消息转换为结构化文本格式
 */

import type {
  KodaXMessage,
  KodaXContentBlock,
  KodaXTextBlock,
  KodaXToolUseBlock,
  KodaXToolResultBlock,
  KodaXThinkingBlock,
} from '@kodax/ai';

/**
 * 序列化对话为文本
 *
 * 将消息转换为结构化文本格式，保留完整内容不截断
 * 参考 pi-mono 的实现：让 LLM 决定重点，不通过截断丢失信息
 *
 * 输出格式:
 * ```
 * [User]: 用户说的内容
 * [Assistant thinking]: 内部推理
 * [Assistant]: 响应文本
 * [Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
 * [Tool result]: 工具输出
 * ```
 *
 * @param messages - 消息列表
 * @returns 序列化后的文本
 */
export function serializeConversation(messages: KodaXMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractTextFromMessage(msg);
      lines.push(`[User]: ${text}`);

      // 检查是否有 tool_result
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter(
          (b): b is KodaXToolResultBlock => b.type === 'tool_result'
        );
        for (const result of toolResults) {
          const content = typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content);
          lines.push(`[Tool result]: ${content}`);
        }
      }
    } else if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        // Thinking blocks
        const thinkingBlocks = msg.content.filter(
          (b): b is KodaXThinkingBlock => b.type === 'thinking'
        );
        for (const thinking of thinkingBlocks) {
          if (thinking.thinking.length > 0) {
            lines.push(`[Assistant thinking]: ${thinking.thinking}`);
          }
        }

        // Text blocks
        const textBlocks = msg.content.filter(
          (b): b is KodaXTextBlock => b.type === 'text'
        );
        for (const text of textBlocks) {
          lines.push(`[Assistant]: ${text.text}`);
        }

        // Tool calls
        const toolBlocks = msg.content.filter(
          (b): b is KodaXToolUseBlock => b.type === 'tool_use'
        );
        if (toolBlocks.length > 0) {
          const calls = toolBlocks.map(tc => {
            const input = tc.input as Record<string, unknown>;
            // 使用 JSON.stringify 保留完整参数，不截断
            const params = Object.entries(input)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(', ');
            return `${tc.name}(${params})`;
          }).join('; ');
          lines.push(`[Assistant tool calls]: ${calls}`);
        }
      } else {
        lines.push(`[Assistant]: ${msg.content}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * 从消息中提取文本内容
 *
 * @param msg - 消息
 * @returns 文本内容
 */
function extractTextFromMessage(msg: KodaXMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }

  const textBlocks = msg.content.filter(
    (b): b is KodaXTextBlock => b.type === 'text'
  );

  return textBlocks.map(b => b.text).join(' ');
}
