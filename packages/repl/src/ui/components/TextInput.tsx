/**
 * TextInput - Multi-line text input component - 多行文本输入组件
 *
 * Display text content and render cursor - 显示文本内容并渲染光标
 */

import React, { useMemo, useState, useEffect } from "react";
import { Text, Box, useStdout } from "ink";
import stringWidth from "string-width";
import { getTheme } from "../themes/index.js";
import {
  calculateVisualLayout,
  calculateVisualCursorFromLayout,
  splitAtVisualColumn,
  splitByCodePoints,
} from "../utils/textUtils.js";

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

  // Calculate visual layout for wrapping - 计算视觉布局用于换行
  const visualLayout = useMemo(() => {
    // Calculate available width for text (excluding prompt) - 计算文本可用宽度（排除提示符）
    const availableWidth = Math.max(20, terminalWidth - promptWidth);

    return calculateVisualLayout(
      lines,
      availableWidth,
      cursorRow,
      cursorCol
    );
  }, [lines, terminalWidth, cursorRow, cursorCol, promptWidth]);

  // Calculate visual cursor position - 计算视觉光标位置
  const visualCursor = useMemo(() => {
    if (!visualLayout) return null;

    const [visualRow, visualCol] = calculateVisualCursorFromLayout(
      visualLayout,
      [cursorRow, cursorCol]
    );
    return { row: visualRow, col: visualCol };
  }, [visualLayout, cursorRow, cursorCol]);

  // Use visual layout rendering for all input (including empty and single-line) - 所有输入使用视觉布局渲染（包括空输入和单行）
  const divider = generateDivider(terminalWidth);

  // TypeScript non-null assertion: visualLayout and visualCursor are  // TypeScript 非空断言：visualLayout 和 visualCursor 保证非空
  const layout = visualLayout!;
  const vCursor = visualCursor!;

  return (
    <Box flexDirection="column" width={propWidth}>
      {/* Top divider - 顶部分隔线 */}
      <Text dimColor>{divider}</Text>

      {/* Content lines - 内容行 */}
      {layout.visualLines.length === 0 || (layout.visualLines.length === 1 && layout.visualLines[0] === "") ? (
        // Empty input - show placeholder and cursor - 空输入 - 显示占位符和光标
        <Box>
          <Text color={theme.colors.primary}>{prompt} </Text>
          {focus ? (
            <>
              <Text backgroundColor={theme.colors.primary} color="#000000"> </Text>
              <Text dimColor>{placeholder}</Text>
            </>
          ) : (
            <Text dimColor>{placeholder}</Text>
          )}
        </Box>
      ) : (
        layout.visualLines.map((visualLine, visualRowIndex) => {
          const isCurrentVisualLine = visualRowIndex === vCursor.row;
          const linePrompt = visualRowIndex === 0 ? prompt : " ".repeat(promptWidth - 1);

          // Current line needs to show cursor - 当前行需要显示光标
          if (isCurrentVisualLine && focus) {
            const { before, current, after } = splitAtVisualColumn(visualLine, vCursor.col);
            const cursorChar = current || " ";

            return (
              <Box key={visualRowIndex}>
                <Text color={theme.colors.primary}>{linePrompt} </Text>
                <Text color={theme.colors.text}>{before}</Text>
                <Text backgroundColor={theme.colors.primary} color="#000000">
                  {cursorChar}
                </Text>
                <Text color={theme.colors.text}>{after}</Text>
              </Box>
            );
          }

          // Non-current line - 非当前行
          return (
            <Box key={visualRowIndex}>
              <Text color={theme.colors.dim}>{linePrompt} </Text>
              <Text color={theme.colors.text}>{visualLine}</Text>
            </Box>
          );
        })
      )}

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

  const chars = splitByCodePoints(value);
  const beforeCursor = chars.slice(0, cursorCol).join("");
  const cursorChar = chars[cursorCol] ?? " ";
  const afterCursor = chars.slice(cursorCol + 1).join("");

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
