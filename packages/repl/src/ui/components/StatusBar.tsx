/**
 * StatusBar - Bottom status bar component - 底部状态栏组件
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";
import type { StatusBarProps } from "../types.js";

export const StatusBar: React.FC<StatusBarProps> = ({
  sessionId,
  permissionMode,
  provider,
  model,
  tokenUsage,
  currentTool,
  thinking,
}) => {
  const theme = useMemo(() => getTheme("dark"), []);

  const displaySessionId = sessionId;

  // Map permission mode to display string with color hint
  const modeDisplay = thinking
    ? `${permissionMode.toUpperCase()}+think`
    : permissionMode.toUpperCase();

  // Color-code by permission mode
  const modeColor =
    permissionMode === "plan"
      ? "blue"
      : permissionMode === "default"
        ? "white"
        : permissionMode === "accept-edits"
          ? "cyan"
          : "magenta"; // auto-in-project

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
        <Text color={modeColor}>{modeDisplay}</Text>
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
  permissionMode: string;
  provider: string;
  model: string;
}> = ({ permissionMode, provider, model }) => {
  const theme = useMemo(() => getTheme("dark"), []);

  return (
    <Box>
      <Text color={theme.colors.primary} bold>
        [{permissionMode}]
      </Text>
      <Text dimColor>
        {" "}
        {provider}/{model}
      </Text>
    </Box>
  );
};

