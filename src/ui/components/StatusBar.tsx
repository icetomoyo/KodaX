/**
 * StatusBar - 底部状态栏组件
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

  // 简短会话 ID - 显示格式为 YYYYMMDD_HHMM (13 字符)
  // 如果 ID 格式是 YYYYMMDD_HHMMSS，我们取前 13 个字符
  // 如果 ID 较短，显示全部
  const shortSessionId = sessionId.length > 13
    ? sessionId.slice(0, 13)
    : sessionId;

  // 构建模式指示器
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
      {/* 左侧：会话信息 */}
      <Box>
        <Text color={theme.colors.primary} bold>
          KodaX
        </Text>
        <Text dimColor> | </Text>
        <Text color={theme.colors.accent}>{modeStr}</Text>
        <Text dimColor> | </Text>
        <Text dimColor>{shortSessionId}</Text>
      </Box>

      {/* 中间：当前工具 */}
      {currentTool && (
        <Box>
          <Text color={theme.colors.warning}>⏳ {currentTool}</Text>
        </Box>
      )}

      {/* 右侧：模型和 Token 使用 */}
      <Box>
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
 * 简化版状态栏
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
