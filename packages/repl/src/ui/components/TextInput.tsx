/**
 * TextInput - Multi-line text input component - 多行文本输入组件
 *
 * Display text content and render cursor - 显示文本内容并渲染光标
 */

import React, { useMemo, useState, useEffect } from "react";
import { Text, Box, useStdout } from "ink";
import stringWidth from "string-width";
import { getTheme } from "../themes/index.js";

export interface TextInputProps {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  prompt?: string;
  placeholder?: string;
  focus?: boolean;
  theme?: string;
  width?: number;
}

/**
 * Get visual cursor position (considering wide characters) - 获取可视光标位置（考虑宽字符）
 */
function getVisualCursorPos(line: string, col: number): number {
  const textBeforeCursor = [...line].slice(0, col).join("");
  return stringWidth(textBeforeCursor);
}

/**
 * Maximum divider width (prevent performance issues with very wide terminals) - 分隔线最大宽度（防止超宽终端性能问题）
 */
const MAX_DIVIDER_WIDTH = 200;

/**
 * Generate divider line - 生成分隔线
 */
function generateDivider(width: number): string {
  const safeWidth = Math.min(MAX_DIVIDER_WIDTH, Math.max(1, width));
  return "-".repeat(safeWidth);
}

/**
 * Hook to get terminal width - 获取终端宽度的 Hook
 */
function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(() => {
    // Use stdout or process.stdout on initialization - 初始化时使用 stdout 或 process.stdout
    return stdout?.columns ?? process.stdout?.columns ?? 80;
  });

  useEffect(() => {
    const handleResize = () => {
      // Use process.stdout.columns instead of stdout in closure
      // because closure value may be stale - 使用 process.stdout.columns 而非闭包中的 stdout，因为闭包中的值可能过时
      const newWidth = process.stdout?.columns ?? stdout?.columns ?? 80;
      setWidth(newWidth);
    };

    // Listen for terminal resize events - 监听终端 resize 事件
    process.stdout?.on("resize", handleResize);

    return () => {
      process.stdout?.off("resize", handleResize);
    };
  }, [stdout]);

  return width;
}

export const TextInput: React.FC<TextInputProps> = ({
  lines,
  cursorRow,
  cursorCol,
  prompt = ">",
  placeholder = "Type your message...",
  focus = true,
  theme: themeName = "dark",
  width: propWidth,
}) => {
  const theme = useMemo(() => getTheme(themeName), [themeName]);
  const terminalWidth = propWidth ?? useTerminalWidth();

  // Calculate prompt width (for alignment) - 计算提示符宽度（用于对齐）
  const promptWidth = stringWidth(prompt) + 1; // +1 for space

  // Handle empty input - cursor displays after prompt with one space - 处理空输入 - 光标显示在提示符之后，空一格
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    return (
      <Box>
        <Text color={theme.colors.primary}>{prompt} </Text>
        {focus ? (
          <Text backgroundColor={theme.colors.primary} color="#000000"> </Text>
        ) : (
          <Text> </Text>
        )}
        <Text dimColor>{placeholder}</Text>
      </Box>
    );
  }

  // Single line input - 单行输入
  if (lines.length === 1) {
    const line = lines[0] ?? "";
    const beforeCursor = [...line].slice(0, cursorCol).join("");
    const cursorChar = [...line][cursorCol] ?? " ";
    const afterCursor = [...line].slice(cursorCol + 1).join("");

    return (
      <Box>
        <Text color={theme.colors.primary}>{prompt} </Text>
        <Text color={theme.colors.text}>{beforeCursor}</Text>
        {focus && (
          <>
            <Text backgroundColor={theme.colors.primary} color="#000000">
              {cursorChar}
            </Text>
            <Text color={theme.colors.text}>{afterCursor}</Text>
          </>
        )}
        {!focus && <Text color={theme.colors.text}>{line}</Text>}
      </Box>
    );
  }

  // Multi-line input - use divider style - 多行输入 - 使用分隔线样式
  const divider = generateDivider(terminalWidth);

  return (
    <Box flexDirection="column" width={propWidth}>
      {/* Top divider - 顶部分隔线 */}
      <Text dimColor>{divider}</Text>

      {/* Content lines - 内容行 */}
      {lines.map((line, rowIndex) => {
        const isCurrentLine = rowIndex === cursorRow;
        const linePrompt = rowIndex === 0 ? prompt : " ".repeat(promptWidth - 1);

        // Current line needs to show cursor - 当前行需要显示光标
        if (isCurrentLine && focus) {
          const beforeCursor = [...line].slice(0, cursorCol).join("");
          const cursorChar = [...line][cursorCol] ?? " ";
          const afterCursor = [...line].slice(cursorCol + 1).join("");

          return (
            <Box key={rowIndex}>
              <Text color={theme.colors.primary}>{linePrompt} </Text>
              <Text color={theme.colors.text}>{beforeCursor}</Text>
              <Text backgroundColor={theme.colors.primary} color="#000000">
                {cursorChar}
              </Text>
              <Text color={theme.colors.text}>{afterCursor}</Text>
            </Box>
          );
        }

        // Non-current line - 非当前行
        return (
          <Box key={rowIndex}>
            <Text color={theme.colors.dim}>{linePrompt} </Text>
            <Text color={theme.colors.text}>{line}</Text>
          </Box>
        );
      })}

      {/* Bottom divider - 底部分隔线 */}
      <Text dimColor>{divider}</Text>
    </Box>
  );
};

/**
 * Single-line TextInput (simplified version) - 单行 TextInput（简化版）
 */
export const SingleLineTextInput: React.FC<{
  value: string;
  cursorCol: number;
  prompt?: string;
  placeholder?: string;
  focus?: boolean;
  theme?: string;
}> = ({ value, cursorCol, prompt = ">", placeholder, focus = true, theme: themeName = "dark" }) => {
  const theme = useMemo(() => getTheme(themeName), [themeName]);

  if (!value) {
    return (
      <Box>
        <Text color={theme.colors.primary}>{prompt} </Text>
        {placeholder && <Text dimColor>{placeholder}</Text>}
        {focus && <Text backgroundColor={theme.colors.primary} color="#000000"> </Text>}
      </Box>
    );
  }

  const beforeCursor = [...value].slice(0, cursorCol).join("");
  const cursorChar = [...value][cursorCol] ?? " ";
  const afterCursor = [...value].slice(cursorCol + 1).join("");

  return (
    <Box>
      <Text color={theme.colors.primary}>{prompt} </Text>
      <Text color={theme.colors.text}>{beforeCursor}</Text>
      <Text backgroundColor={theme.colors.primary} color="#000000">
        {cursorChar}
      </Text>
      <Text color={theme.colors.text}>{afterCursor}</Text>
    </Box>
  );
};
