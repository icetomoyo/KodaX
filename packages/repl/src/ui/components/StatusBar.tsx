/**
 * StatusBar - Bottom status bar component - 底部状态栏组件
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";
import type { StatusBarProps } from "../types.js";

export const StatusBar: React.FC<StatusBarProps> = ({
  sessionId,
  mode,
  provider,
  model,
  tokenUsage,
  currentTool,
  thinking,
  auto,
}) => {
  const theme = useMemo(() => getTheme("dark"), []);

  // Display full Session ID (YYYYMMDD_HHMMSS format, 15 chars)
  // No truncation, preserve complete time information - 显示完整 Session ID (YYYYMMDD_HHMMSS 格式，15 字符)，不截断，保留完整时间信息
  const displaySessionId = sessionId;

  // Build mode indicators - 构建模式指示器
  const modeIndicators: string[] = [];
  if (thinking) modeIndicators.push("think");
  if (auto) modeIndicators.push("auto");
  const modeStr = modeIndicators.length > 0
    ? `${mode.toUpperCase()}+${modeIndicators.join(",")}`
    : mode.toUpperCase();

  return (
    <Box
      borderStyle="single"
      borderColor={theme.colors.dim}
      paddingX={1}
      justifyContent="space-between"
    >
      {/* Left side: session info - 左侧：会话信息 */}
      <Box>
        <Text color={theme.colors.primary} bold>
          KodaX
        </Text>
        <Text dimColor> | </Text>
        <Text color={theme.colors.accent}>{modeStr}</Text>
        <Text dimColor> | </Text>
        <Text dimColor>{displaySessionId}</Text>
      </Box>

      {/* Middle: current tool - 中间：当前工具 */}
      {currentTool && (
        <Box>
          <Text color={theme.colors.warning}>⏳ {currentTool}</Text>
        </Box>
      )}

      {/* Right side: model and token usage - 右侧：模型和 Token 使用 */}
      <Box>
        <Text dimColor>| </Text>
        <Text color={theme.colors.secondary}>
          {provider}/{model}
        </Text>
        {tokenUsage && (
          <>
            <Text dimColor> | </Text>
            <Text dimColor>
              {tokenUsage.input}→{tokenUsage.output} ({tokenUsage.total})
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
};

/**
 * Simplified status bar - 简化版状态栏
 */
export const SimpleStatusBar: React.FC<{
  mode: "code" | "ask";
  provider: string;
  model: string;
}> = ({ mode, provider, model }) => {
  const theme = useMemo(() => getTheme("dark"), []);

  return (
    <Box>
      <Text color={theme.colors.primary} bold>
        [{mode}]
      </Text>
      <Text dimColor>
        {" "}
        {provider}/{model}
      </Text>
    </Box>
  );
};
