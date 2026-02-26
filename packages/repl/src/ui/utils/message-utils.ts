/**
 * Message Utils - 消息处理工具函数
 *
 * 提供消息内容提取和格式化功能
 * 从 InkREPL.tsx 提取以改善代码组织
 */

import type { KodaXMessage } from "@kodax/core";

/**
 * 从消息中提取文本内容
 *
 * 处理字符串和数组两种内容格式：
 * - 字符串：直接返回
 * - 数组：只提取 text 块，忽略 thinking/tool_use/tool_result/redacted_thinking
 *
 * @param content - 消息内容（字符串或内容块数组）
 * @returns 提取的文本内容，对于纯 tool_result/thinking 消息返回空字符串
 */
export function extractTextContent(content: string | unknown[]): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        switch (block.type) {
          case "text":
            // 只提取 text 块的内容
            if ("text" in block) {
              textParts.push(String(block.text));
            }
            break;
          case "thinking":
          case "tool_use":
          case "tool_result":
          case "redacted_thinking":
            // 这些块类型不显示在历史消息中
            // thinking 是 AI 内部思考过程，不应在 session 恢复时显示
            break;
          default:
            // 未知类型也忽略
            break;
        }
      }
    }
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
    // 纯 tool_result/tool_use/thinking 消息返回空字符串，让 UI 层过滤掉
    return "";
  }

  // 未知格式返回空字符串
  return "";
}

/**
 * 从消息列表中提取会话标题
 *
 * 使用第一条用户消息的前 50 个字符作为标题
 *
 * @param messages - 消息列表
 * @returns 提取的标题
 */
export function extractTitle(messages: KodaXMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser) {
    const content =
      typeof firstUser.content === "string" ? firstUser.content : "";
    return content.slice(0, 50) + (content.length > 50 ? "..." : "");
  }
  return "Untitled Session";
}

/**
 * 格式化消息预览
 *
 * @param content - 消息内容
 * @param maxLength - 最大长度（默认 60）
 * @returns 格式化后的预览文本
 */
export function formatMessagePreview(content: string, maxLength = 60): string {
  const preview = content.replace(/\n/g, " ");
  const ellipsis = preview.length > maxLength ? "..." : "";
  return preview.slice(0, maxLength) + ellipsis;
}
