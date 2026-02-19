/**
 * MessageList - 消息列表组件
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";
import type { MessageListProps, Message } from "../types.js";

/**
 * 格式化时间戳
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 单条消息组件
 */
const MessageItem: React.FC<{ message: Message }> = ({ message }) => {
  const theme = useMemo(() => getTheme("dark"), []);

  const roleColors: Record<string, string> = {
    user: theme.colors.primary,
    assistant: theme.colors.secondary,
    system: theme.colors.dim,
  };

  const roleLabels: Record<string, string> = {
    user: "You",
    assistant: "Assistant",
    system: "System",
  };

  const color = roleColors[message.role] ?? theme.colors.text;
  const label = roleLabels[message.role] ?? message.role;
  const time = formatTimestamp(message.timestamp);

  // 限制显示行数
  const maxLines = 20;
  const lines = message.content.split("\n");
  const displayLines = lines.slice(0, maxLines);
  const hasMore = lines.length > maxLines;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 消息头部 */}
      <Box>
        <Text color={color} bold>
          {label}
        </Text>
        <Text dimColor> [{time}]</Text>
      </Box>

      {/* 消息内容 */}
      <Box marginLeft={2} flexDirection="column">
        {displayLines.map((line, index) => (
          <Text key={index} color={theme.colors.text}>
            {line || " "}
          </Text>
        ))}
        {hasMore && (
          <Text dimColor>... ({lines.length - maxLines} more lines)</Text>
        )}
      </Box>
    </Box>
  );
};

export const MessageList: React.FC<MessageListProps> = ({ messages, isLoading }) => {
  const theme = useMemo(() => getTheme("dark"), []);

  if (messages.length === 0 && !isLoading) {
    return (
      <Box paddingY={1}>
        <Text dimColor>No messages yet. Start typing to begin.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}

      {/* 加载指示器 */}
      {isLoading && (
        <Box>
          <Text color={theme.colors.accent}>Thinking...</Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * 简化消息显示
 */
export const SimpleMessageDisplay: React.FC<{
  role: "user" | "assistant" | "system";
  content: string;
}> = ({ role, content }) => {
  const theme = useMemo(() => getTheme("dark"), []);

  const color = {
    user: theme.colors.primary,
    assistant: theme.colors.secondary,
    system: theme.colors.dim,
  }[role];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {role === "user" ? ">" : role === "assistant" ? "<" : "#"}
      </Text>
      <Text>{content}</Text>
    </Box>
  );
};
