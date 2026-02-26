/**
 * MessageList - 历史消息列表组件
 *
 * 参考 Gemini CLI 的消息显示架构实现。
 * 支持 HistoryItem 类型：user, assistant, tool_group, thinking, error, info, hint
 */

import React, { useMemo, type ReactNode } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";
import { Spinner } from "./LoadingIndicator.js";
import type { Theme } from "../types.js";
import {
  ToolCallStatus,
  type HistoryItem,
  type HistoryItemUser,
  type HistoryItemAssistant,
  type HistoryItemToolGroup,
  type HistoryItemThinking,
  type HistoryItemError,
  type HistoryItemInfo,
  type HistoryItemHint,
  type HistoryItemSystem,
  type ToolCall,
} from "../types.js";

// === Types ===

export interface MessageListProps {
  /** 历史项列表 */
  items: HistoryItem[];
  /** 是否加载中 */
  isLoading?: boolean;
  /** 最大显示行数 */
  maxLines?: number;
  /** 是否正在 thinking */
  isThinking?: boolean;
  /** Thinking 字符计数 */
  thinkingCharCount?: number;
  /** Thinking 内容 (实时显示) */
  thinkingContent?: string;
  /** 当前流式响应文本 (实时显示) */
  streamingResponse?: string;
  /** 当前工具名称 */
  currentTool?: string;
  /** 工具输入字符计数 */
  toolInputCharCount?: number;
}

export interface HistoryItemRendererProps {
  item: HistoryItem;
  theme?: Theme;
  maxLines?: number;
}

// === Helpers ===

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
 * 截断文本到最大行数
 */
function truncateLines(text: string, maxLines: number): { lines: string[]; hasMore: boolean } {
  const lines = text.split("\n");
  const displayLines = lines.slice(0, maxLines);
  const hasMore = lines.length > maxLines;
  return { lines: displayLines, hasMore };
}

/**
 * 格式化工具执行时间
 */
function formatDuration(startTime: number, endTime?: number): string {
  if (!endTime) return "";
  const ms = endTime - startTime;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 获取工具状态图标
 */
function getToolStatusIcon(status: ToolCallStatus): string {
  switch (status) {
    case ToolCallStatus.Scheduled:
      return "○";
    case ToolCallStatus.Validating:
      return "◐";
    case ToolCallStatus.AwaitingApproval:
      return "⏸";
    case ToolCallStatus.Executing:
      return "●";
    case ToolCallStatus.Success:
      return "✓";
    case ToolCallStatus.Error:
      return "✗";
    case ToolCallStatus.Cancelled:
      return "⊘";
    default:
      return "?";
  }
}

/**
 * 获取工具状态颜色
 */
function getToolStatusColor(status: ToolCallStatus, theme: Theme): string {
  switch (status) {
    case ToolCallStatus.Scheduled:
    case ToolCallStatus.Validating:
      return theme.colors.dim;
    case ToolCallStatus.AwaitingApproval:
      return theme.colors.accent;
    case ToolCallStatus.Executing:
      return theme.colors.primary;
    case ToolCallStatus.Success:
      return theme.colors.success;
    case ToolCallStatus.Error:
      return theme.colors.error;
    case ToolCallStatus.Cancelled:
      return theme.colors.dim;
    default:
      return theme.colors.text;
  }
}

// === Sub-Components ===

/**
 * 用户消息渲染器
 */
const UserItemRenderer: React.FC<{ item: HistoryItemUser; theme: Theme }> = ({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.primary} bold>
        You
      </Text>
      <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.text}>{item.text}</Text>
    </Box>
  </Box>
);

/**
 * 助手消息渲染器
 */
const AssistantItemRenderer: React.FC<{
  item: HistoryItemAssistant;
  theme: Theme;
  maxLines: number;
}> = ({ item, theme, maxLines }) => {
  const { lines, hasMore } = truncateLines(item.text, maxLines);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.colors.secondary} bold>
          Assistant
        </Text>
        {item.isStreaming && (
          <>
            <Text> </Text>
            <Spinner color={theme.colors.accent} />
          </>
        )}
        <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        {lines.map((line, index) => (
          <Text key={index} color={theme.colors.text}>
            {line || " "}
          </Text>
        ))}
        {hasMore && (
          <Text dimColor>... ({item.text.split("\n").length - maxLines} more lines)</Text>
        )}
      </Box>
    </Box>
  );
};

/**
 * 系统消息渲染器
 */
const SystemItemRenderer: React.FC<{ item: HistoryItemSystem; theme: Theme }> = ({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.dim} bold>
        System
      </Text>
      <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
    </Box>
    <Box marginLeft={2}>
      <Text dimColor>{item.text}</Text>
    </Box>
  </Box>
);

/**
 * 工具调用渲染器
 */
const ToolCallRenderer: React.FC<{ tool: ToolCall; theme: Theme }> = ({ tool, theme }) => {
  const icon = getToolStatusIcon(tool.status);
  const color = getToolStatusColor(tool.status, theme);
  const duration = formatDuration(tool.startTime, tool.endTime);

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={color}>{icon} </Text>
        <Text color={theme.colors.text} bold>
          {tool.name}
        </Text>
        {tool.input && (
          <Text dimColor>
            {" "}
            {JSON.stringify(tool.input).slice(0, 50)}
            {JSON.stringify(tool.input).length > 50 ? "..." : ""}
          </Text>
        )}
      </Box>
      {tool.progress !== undefined && tool.status === ToolCallStatus.Executing && (
        <Box marginLeft={2}>
          <Text dimColor>Progress: {tool.progress}%</Text>
        </Box>
      )}
      {tool.error && (
        <Box marginLeft={2}>
          <Text color={theme.colors.error}>{tool.error}</Text>
        </Box>
      )}
      {duration && (
        <Box marginLeft={2}>
          <Text dimColor>Completed in {duration}</Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * 工具组渲染器
 */
const ToolGroupRenderer: React.FC<{ item: HistoryItemToolGroup; theme: Theme }> = ({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.accent} bold>
        Tools
      </Text>
      <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
    </Box>
    {item.tools.map((tool) => (
      <ToolCallRenderer key={tool.id} tool={tool} theme={theme} />
    ))}
  </Box>
);

/**
 * 思考内容渲染器
 */
const ThinkingItemRenderer: React.FC<{ item: HistoryItemThinking; theme: Theme }> = ({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.dim} italic>
        Thinking
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text dimColor italic>
        {item.text}
      </Text>
    </Box>
  </Box>
);

/**
 * 错误消息渲染器
 */
const ErrorItemRenderer: React.FC<{ item: HistoryItemError; theme: Theme }> = ({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.error} bold>
        ✗ Error
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.error}>{item.text}</Text>
    </Box>
  </Box>
);

/**
 * 信息消息渲染器
 */
const InfoItemRenderer: React.FC<{ item: HistoryItemInfo; theme: Theme }> = ({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.info} bold>
        {item.icon ?? "ℹ"} Info
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.info}>{item.text}</Text>
    </Box>
  </Box>
);

/**
 * 提示消息渲染器
 */
const HintItemRenderer: React.FC<{ item: HistoryItemHint; theme: Theme }> = ({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.hint} bold>
        💡 Hint
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text dimColor>{item.text}</Text>
    </Box>
  </Box>
);

// === Main Components ===

/**
 * 历史项渲染器
 * 根据类型分发到对应的渲染器
 */
export const HistoryItemRenderer: React.FC<HistoryItemRendererProps> = ({
  item,
  theme: themeProp,
  maxLines = 20,
}) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);

  switch (item.type) {
    case "user":
      return <UserItemRenderer item={item} theme={theme} />;
    case "assistant":
      return <AssistantItemRenderer item={item} theme={theme} maxLines={maxLines} />;
    case "system":
      return <SystemItemRenderer item={item} theme={theme} />;
    case "tool_group":
      return <ToolGroupRenderer item={item} theme={theme} />;
    case "thinking":
      return <ThinkingItemRenderer item={item} theme={theme} />;
    case "error":
      return <ErrorItemRenderer item={item} theme={theme} />;
    case "info":
      return <InfoItemRenderer item={item} theme={theme} />;
    case "hint":
      return <HintItemRenderer item={item} theme={theme} />;
    default:
      return (
        <Box>
          <Text dimColor>Unknown item type</Text>
        </Box>
      );
  }
};

/**
 * MessageList - 消息列表组件
 */
export const MessageList: React.FC<MessageListProps> = ({
  items,
  isLoading = false,
  maxLines = 20,
  isThinking = false,
  thinkingCharCount = 0,
  thinkingContent = "",
  streamingResponse = "",
  currentTool,
  toolInputCharCount = 0,
}) => {
  const theme = useMemo(() => getTheme("dark"), []);

  // When streaming, filter out the last assistant item to avoid double display
  // (streamingResponse shows the live content, history item would show the final result)
  const filteredItems = useMemo(() => {
    if (!streamingResponse) return items;

    // Find the last assistant item index
    let lastAssistantIndex = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]?.type === "assistant") {
        lastAssistantIndex = i;
        break;
      }
    }

    // Filter out the last assistant item if found
    if (lastAssistantIndex >= 0) {
      return items.filter((_, index) => index !== lastAssistantIndex);
    }
    return items;
  }, [items, streamingResponse]);

  if (items.length === 0 && !isLoading) {
    return (
      <Box paddingY={1}>
        <Text dimColor>No messages yet. Start typing to begin.</Text>
      </Box>
    );
  }

  // 确定加载状态文本
  let loadingText = "Thinking";
  let prefix = "";
  if (currentTool) {
    prefix = "[Tool] ";
    loadingText = toolInputCharCount > 0
      ? `${currentTool} (${toolInputCharCount} chars)`
      : `Executing ${currentTool}...`;
  } else if (isThinking) {
    // Show [Thinking] prefix when in thinking mode (with or without char count)
    prefix = "[Thinking] ";
    loadingText = thinkingCharCount > 0
      ? `(${thinkingCharCount} chars)`
      : "processing...";
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      {filteredItems.map((item) => (
        <HistoryItemRenderer key={item.id} item={item} theme={theme} maxLines={maxLines} />
      ))}

      {/* Thinking 内容显示 - 淡灰色 */}
      {/* 显示条件：响应进行中 + 有 thinking 内容 */}
      {isLoading && thinkingContent && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={theme.colors.dim} italic>Thinking</Text>
          </Box>
          <Box marginLeft={2}>
            <Text dimColor italic>{thinkingContent}</Text>
          </Box>
        </Box>
      )}

      {/* 流式响应显示 */}
      {streamingResponse && (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={theme.colors.secondary} bold>Assistant</Text>
          </Box>
          <Box marginLeft={2} flexDirection="column">
            {streamingResponse.split("\n").map((line, index) => (
              <Text key={index} color={theme.colors.text}>{line || " "}</Text>
            ))}
          </Box>
        </Box>
      )}

      {/* 加载指示器 - 只在没有流式内容时显示 */}
      {isLoading && !streamingResponse && !thinkingContent && (
        <Box>
          <Spinner theme={theme} />
          {prefix && <Text color={theme.colors.dim}> {prefix}</Text>}
          <Text color={theme.colors.accent}> {loadingText}…</Text>
        </Box>
      )}

      {/* 有 thinking 内容时显示简化的加载指示器 */}
      {isLoading && (streamingResponse || thinkingContent) && (
        <Box>
          <Spinner theme={theme} />
          {prefix && <Text color={theme.colors.dim}> {prefix}</Text>}
          <Text color={theme.colors.accent}> {loadingText}…</Text>
        </Box>
      )}
    </Box>
  );
};

// === Legacy Exports (for backward compatibility) ===

import type { LegacyMessageListProps, Message } from "../types.js";

/**
 * @deprecated Use MessageList with items prop instead
 */
export const LegacyMessageList: React.FC<LegacyMessageListProps> = ({ messages, isLoading }) => {
  // Convert legacy Message to HistoryItem
  const items: HistoryItem[] = messages.map((msg: Message) => {
    const base = {
      id: msg.id,
      timestamp: msg.timestamp,
    };

    switch (msg.role) {
      case "user":
        return { ...base, type: "user" as const, text: msg.content };
      case "assistant":
        return { ...base, type: "assistant" as const, text: msg.content };
      case "system":
        return { ...base, type: "system" as const, text: msg.content };
      default:
        return { ...base, type: "info" as const, text: msg.content };
    }
  });

  return <MessageList items={items} isLoading={isLoading} />;
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
