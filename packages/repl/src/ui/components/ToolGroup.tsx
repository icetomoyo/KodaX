/**
 * ToolGroup - Tool execution display component - 工具执行显示组件
 *
 * Reference Gemini CLI's tool execution display architecture implementation - 参考 Gemini CLI 的工具执行显示架构实现。
 * Display tool call status, progress, and results - 显示工具调用状态、进度和结果。
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";
import type { Theme } from "../types.js";
import { ToolCallStatus, type ToolCall } from "../types.js";

// === Types ===

export interface ToolGroupProps {
  /** List of tool calls - 工具调用列表 */
  tools: ToolCall[];
  /** Whether to collapse display - 是否折叠显示 */
  collapsed?: boolean;
  /** Custom title - 自定义标题 */
  title?: string;
  /** Theme - 主题 */
  theme?: Theme;
}

export interface ToolCallDisplayProps {
  /** Tool call - 工具调用 */
  tool: ToolCall;
  /** Whether collapsed - 是否折叠 */
  collapsed?: boolean;
  /** Theme - 主题 */
  theme?: Theme;
}

export interface ToolStatusBadgeProps {
  /** Status - 状态 */
  status: ToolCallStatus;
  /** Theme - 主题 */
  theme?: Theme;
}

export interface ToolProgressBarProps {
  /** Progress (0-100) - 进度 (0-100) */
  progress: number;
  /** Bar width - 条宽度 */
  width?: number;
  /** Theme - 主题 */
  theme?: Theme;
}

// === Helpers ===

/**
 * Get tool status icon - 获取工具状态图标
 */
function getStatusIcon(status: ToolCallStatus): string {
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
 * Get tool status color - 获取工具状态颜色
 */
function getStatusColor(status: ToolCallStatus, theme: Theme): string {
  switch (status) {
    case ToolCallStatus.Scheduled:
    case ToolCallStatus.Validating:
      return theme.colors.dim;
    case ToolCallStatus.AwaitingApproval:
      return theme.colors.accent;
    case ToolCallStatus.Executing:
      return theme.colors.primary;
    case ToolCallStatus.Success:
      return theme.colors.success ?? theme.colors.primary;
    case ToolCallStatus.Error:
      return theme.colors.error;
    case ToolCallStatus.Cancelled:
      return theme.colors.dim;
    default:
      return theme.colors.text;
  }
}

/**
 * Format duration - 格式化持续时间
 */
function formatDuration(startTime: number, endTime?: number): string {
  if (!endTime) return "";
  const ms = endTime - startTime;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format input summary - 格式化输入摘要
 */
function formatInputSummary(input?: Record<string, unknown>): string {
  if (!input) return "";
  const str = JSON.stringify(input);
  if (str.length <= 50) return str;
  return str.slice(0, 47) + "...";
}

// === Components ===

/**
 * Tool status badge - 工具状态徽章
 */
export const ToolStatusBadge: React.FC<ToolStatusBadgeProps> = ({ status, theme: themeProp }) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);
  const icon = getStatusIcon(status);
  const color = getStatusColor(status, theme);

  return (
    <Text color={color}>{icon}</Text>
  );
};

/**
 * Tool progress bar - 工具进度条
 */
export const ToolProgressBar: React.FC<ToolProgressBarProps> = ({
  progress,
  width = 20,
  theme: themeProp,
}) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);

  // Clamp progress to 0-100
  const clampedProgress = Math.max(0, Math.min(100, progress));
  const filledWidth = Math.round((clampedProgress / 100) * width);
  const emptyWidth = width - filledWidth;

  const filled = "█".repeat(filledWidth);
  const empty = "░".repeat(emptyWidth);

  return (
    <Box>
      <Text color={theme.colors.primary}>{filled}</Text>
      <Text dimColor>{empty}</Text>
      <Text> {clampedProgress}%</Text>
    </Box>
  );
};

/**
 * Tool call display component - 工具调用显示组件
 */
export const ToolCallDisplay: React.FC<ToolCallDisplayProps> = ({
  tool,
  collapsed = false,
  theme: themeProp,
}) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);

  const icon = getStatusIcon(tool.status);
  const color = getStatusColor(tool.status, theme);
  const inputSummary = formatInputSummary(tool.input);
  const duration = formatDuration(tool.startTime, tool.endTime);

  if (collapsed) {
    return (
      <Box>
        <Text color={color}>{icon} </Text>
        <Text color={theme.colors.text}>{tool.name}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      {/* Tool name and status - 工具名称和状态 */}
      <Box>
        <Text color={color}>{icon} </Text>
        <Text color={theme.colors.text} bold>
          {tool.name}
        </Text>
        {inputSummary && (
          <Text dimColor>
            {" "}
            {inputSummary}
          </Text>
        )}
      </Box>

      {/* Progress bar - 进度条 */}
      {tool.progress !== undefined && tool.status === ToolCallStatus.Executing && (
        <Box marginLeft={2}>
          <ToolProgressBar progress={tool.progress} theme={theme} />
        </Box>
      )}

      {/* Error message - 错误信息 */}
      {tool.error && (
        <Box marginLeft={2}>
          <Text color={theme.colors.error}>{tool.error}</Text>
        </Box>
      )}

      {/* Duration - 持续时间 */}
      {duration && tool.status !== ToolCallStatus.Executing && (
        <Box marginLeft={2}>
          <Text dimColor>Completed in {duration}</Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * Tool group display component - 工具组显示组件
 */
export const ToolGroup: React.FC<ToolGroupProps> = ({
  tools,
  collapsed = false,
  title,
  theme: themeProp,
}) => {
  const theme = themeProp ?? useMemo(() => getTheme("dark"), []);

  if (tools.length === 0) {
    return null;
  }

  // Calculate status statistics - 计算状态统计
  const statusCounts = useMemo(() => {
    const counts: Record<ToolCallStatus, number> = {
      [ToolCallStatus.Scheduled]: 0,
      [ToolCallStatus.Validating]: 0,
      [ToolCallStatus.AwaitingApproval]: 0,
      [ToolCallStatus.Executing]: 0,
      [ToolCallStatus.Success]: 0,
      [ToolCallStatus.Error]: 0,
      [ToolCallStatus.Cancelled]: 0,
    };

    for (const tool of tools) {
      counts[tool.status]++;
    }

    return counts;
  }, [tools]);

  const displayTitle = title ?? "Tools";

  // Collapsed mode: show summary - 折叠模式：显示摘要
  if (collapsed) {
    const successCount = statusCounts[ToolCallStatus.Success];
    const errorCount = statusCounts[ToolCallStatus.Error];
    const runningCount = statusCounts[ToolCallStatus.Executing] +
      statusCounts[ToolCallStatus.Scheduled] +
      statusCounts[ToolCallStatus.Validating];

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={theme.colors.accent} bold>
            {displayTitle}
          </Text>
          <Text dimColor>
            {" "}
            ({tools.length} tools
            {successCount > 0 && `, ${successCount} succeeded`}
            {errorCount > 0 && `, ${errorCount} failed`}
            {runningCount > 0 && `, ${runningCount} running`})
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Group title - 组标题 */}
      <Box>
        <Text color={theme.colors.accent} bold>
          {displayTitle}
        </Text>
        <Text dimColor>
          {" "}
          ({tools.length} {tools.length === 1 ? "tool" : "tools"})
        </Text>
      </Box>

      {/* Tool list - 工具列表 */}
      {tools.map((tool) => (
        <ToolCallDisplay key={tool.id} tool={tool} theme={theme} />
      ))}
    </Box>
  );
};

// === Exports ===

export default ToolGroup;
