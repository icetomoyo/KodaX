/**
 * TextInput - 多行文本输入组件
 *
 * 显示文本内容并渲染光标
 */

import React, { useMemo } from "react";
import { Text, Box } from "ink";
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
 * 获取可视光标位置（考虑宽字符）
 */
function getVisualCursorPos(line: string, col: number): number {
  const textBeforeCursor = [...line].slice(0, col).join("");
  return stringWidth(textBeforeCursor);
}

export const TextInput: React.FC<TextInputProps> = ({
  lines,
  cursorRow,
  cursorCol,
  prompt = ">",
  placeholder = "Type your message...",
  focus = true,
  theme: themeName = "dark",
  width,
}) => {
  const theme = useMemo(() => getTheme(themeName), [themeName]);

  // 处理空输入
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    return (
      <Box>
        <Text color={theme.colors.primary}>{prompt} </Text>
        <Text dimColor>{placeholder}</Text>
        {focus && <Text backgroundColor={theme.colors.primary}> </Text>}
      </Box>
    );
  }

  // 渲染多行
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((line, rowIndex) => {
        const isCurrentLine = rowIndex === cursorRow;
        const linePrompt = rowIndex === 0 ? prompt : "...";

        // 当前行需要显示光标
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

        // 非当前行
        return (
          <Box key={rowIndex}>
            <Text color={theme.colors.dim}>{linePrompt} </Text>
            <Text color={theme.colors.text}>{line}</Text>
          </Box>
        );
      })}
    </Box>
  );
};

/**
 * 单行 TextInput（简化版）
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
        {focus && <Text backgroundColor={theme.colors.primary}> </Text>}
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
