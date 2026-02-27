/**
 * Message Utils - Message processing utilities - 消息处理工具函数
 *
 * Provides message content extraction and formatting functions - 提供消息内容提取和格式化功能
 * Extracted from InkREPL.tsx to improve code organization - 从 InkREPL.tsx 提取以改善代码组织
 */

import type { KodaXMessage } from "@kodax/core";

/**
 * Extract text content from message - 从消息中提取文本内容
 *
 * Handles string and array content formats: - 处理字符串和数组两种内容格式：
 * - String: returned directly - 字符串：直接返回
 * - Array: extracts only text blocks, ignores thinking/tool_use/tool_result/redacted_thinking - 数组：只提取 text 块，忽略 thinking/tool_use/tool_result/redacted_thinking
 *
 * @param content - Message content (string or content block array) - 消息内容（字符串或内容块数组）
 * @returns Extracted text content, returns empty string for pure tool_result/thinking messages - 提取的文本内容，对于纯 tool_result/thinking 消息返回空字符串
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
            // Extract only text block content - 只提取 text 块的内容
            if ("text" in block) {
              textParts.push(String(block.text));
            }
            break;
          case "thinking":
          case "tool_use":
          case "tool_result":
          case "redacted_thinking":
            // These block types are not displayed in message history - 这些块类型不显示在历史消息中
            // thinking is AI internal thought process, should not be shown during session restore - thinking 是 AI 内部思考过程，不应在 session 恢复时显示
            break;
          default:
            // Unknown types are also ignored - 未知类型也忽略
            break;
        }
      }
    }
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
    // Pure tool_result/tool_use/thinking messages return empty string, let UI layer filter them out - 纯 tool_result/tool_use/thinking 消息返回空字符串，让 UI 层过滤掉
    return "";
  }

  // Unknown format returns empty string - 未知格式返回空字符串
  return "";
}

/**
 * Extract session title from message list - 从消息列表中提取会话标题
 *
 * Uses first 50 characters of first user message as title - 使用第一条用户消息的前 50 个字符作为标题
 *
 * @param messages - Message list - 消息列表
 * @returns Extracted title - 提取的标题
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
 * Format message preview - 格式化消息预览
 *
 * @param content - Message content - 消息内容
 * @param maxLength - Maximum length (default 60) - 最大长度（默认 60）
 * @returns Formatted preview text - 格式化后的预览文本
 */
export function formatMessagePreview(content: string, maxLength = 60): string {
  const preview = content.replace(/\n/g, " ");
  const ellipsis = preview.length > maxLength ? "..." : "";
  return preview.slice(0, maxLength) + ellipsis;
}
