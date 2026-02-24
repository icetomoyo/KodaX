/**
 * SessionHistory - 会话历史显示组件
 *
 * 在恢复会话时显示最近的对话历史
 */

import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";

export interface SessionHistoryProps {
  /** 消息列表 */
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string | unknown[];
  }>;
  /** 最大显示条数，默认 5 */
  maxDisplay?: number;
  /** 每条消息最大长度，默认 100 */
  maxLength?: number;
}

/**
 * Truncates text to a maximum length with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Extracts string content from various message content types
 */
function extractContent(content: string | unknown[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    // Extract text from content blocks
    return content
      .filter((block) => {
        return (
          block !== null &&
          typeof block === "object" &&
          "type" in block &&
          (block as { type: string }).type === "text"
        );
      })
      .map((block) => (block as { type: string; text: string }).text)
      .join("");
  }
  return "[复杂内容]";
}

/**
 * Gets role display label
 */
function getRoleLabel(role: string): string {
  switch (role) {
    case "user":
      return "用户";
    case "assistant":
      return "助手";
    case "system":
      return "系统";
    default:
      return role;
  }
}

/**
 * Gets role color
 */
function getRoleColor(role: string): string {
  switch (role) {
    case "user":
      return "cyan";
    case "assistant":
      return "green";
    case "system":
      return "yellow";
    default:
      return "white";
  }
}

export const SessionHistory: React.FC<SessionHistoryProps> = ({
  messages,
  maxDisplay = 5,
  maxLength = 100,
}) => {
  const theme = getTheme("dark");

  if (!messages || messages.length === 0) {
    return null;
  }

  const displayMessages = messages.slice(-maxDisplay);

  return (
    <Box flexDirection="column" marginY={1}>
      <Text dimColor>
        [恢复会话 - 最近 {displayMessages.length} 条对话]
      </Text>
      {displayMessages.map((msg, i) => {
        const contentStr = extractContent(msg.content);
        const truncated = truncateText(contentStr, maxLength);

        return (
          <Box key={i}>
            <Text bold color={getRoleColor(msg.role)}>
              [{getRoleLabel(msg.role)}]
            </Text>
            <Text> {truncated}</Text>
          </Box>
        );
      })}
    </Box>
  );
};
