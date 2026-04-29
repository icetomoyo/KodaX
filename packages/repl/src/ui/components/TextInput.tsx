/**
 * TextInput - Multi-line text input component.
 *
 * Display text content and render cursor.
 */

import React, { useMemo } from "react";
import { Text, Box, useTerminalSize } from "../tui.js";
import stringWidth from "string-width";
import { getTheme } from "../themes/index.js";
import type { PromptEditingMode } from "../types.js";
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
  terminalFocused?: boolean;
  isPasting?: boolean;
  editingMode?: PromptEditingMode;
  theme?: string;
  width?: number;
}

const MAX_DIVIDER_WIDTH = 200;

function generateDivider(width: number): string {
  const safeWidth = Math.min(MAX_DIVIDER_WIDTH, Math.max(1, width));
  return "-".repeat(safeWidth);
}

/**
 * Hook to get terminal width via the renderer-owned terminal size context.
 *
 * FEATURE_057 Track E: previously this hook subscribed to `process.stdout`
 * directly, bypassing the substrate's owned stdout. With Track E ownership
 * purification, all terminal-size reads go through `useTerminalSize`, which
 * resolves the renderer's owned stdout and tracks resize via the listener
 * mounted by `TuiRuntimeProvider` at runtime mount.
 */
function useTerminalWidth(): number {
  return useTerminalSize().columns;
}

export const TextInput: React.FC<TextInputProps> = ({
  lines,
  cursorRow,
  cursorCol,
  prompt = ">",
  placeholder = "Type your message...",
  focus = true,
  terminalFocused = true,
  isPasting = false,
  editingMode = "idle",
  theme: themeName = "dark",
  width: propWidth,
}) => {
  const theme = useMemo(() => getTheme(themeName), [themeName]);
  // Always invoke the hook (React rules of hooks): the short-circuit form
  // `propWidth ?? useTerminalWidth()` would skip the hook when `propWidth`
  // is supplied, breaking React's hook-order invariant if a single instance
  // toggles between supplying / not supplying `width`.
  const contextTerminalWidth = useTerminalWidth();
  const terminalWidth = propWidth ?? contextTerminalWidth;

  const promptWidth = stringWidth(prompt) + 1;

  const visualLayout = useMemo(() => {
    const availableWidth = Math.max(20, terminalWidth - promptWidth);

    return calculateVisualLayout(
      lines,
      availableWidth,
      cursorRow,
      cursorCol
    );
  }, [lines, terminalWidth, cursorRow, cursorCol, promptWidth]);

  const visualCursor = useMemo(() => {
    if (!visualLayout) return null;

    const [visualRow, visualCol] = calculateVisualCursorFromLayout(
      visualLayout,
      [cursorRow, cursorCol]
    );
    return { row: visualRow, col: visualCol };
  }, [visualLayout, cursorRow, cursorCol]);

  const divider = generateDivider(terminalWidth);
  const showCursor = focus && terminalFocused;
  const pasteHintVisible = isPasting && lines.some((line) => line.length > 0);

  const layout = visualLayout!;
  const vCursor = visualCursor!;

  return (
    <Box flexDirection="column" width={propWidth}>
      <Text dimColor>{divider}</Text>
      {pasteHintVisible ? (
        <Box>
          <Text dimColor>{editingMode === "pasting" ? "Pasting input..." : "Editing input..."}</Text>
        </Box>
      ) : null}

      {layout.visualLines.length === 0 || (layout.visualLines.length === 1 && layout.visualLines[0] === "") ? (
        <Box>
          <Text color={theme.colors.primary}>{prompt} </Text>
          {showCursor ? (
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

          if (isCurrentVisualLine && showCursor) {
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

          return (
            <Box key={visualRowIndex}>
              <Text color={theme.colors.dim}>{linePrompt} </Text>
              <Text color={theme.colors.text}>{visualLine}</Text>
            </Box>
          );
        })
      )}

      <Text dimColor>{divider}</Text>
    </Box>
  );
};

/**
 * Single-line TextInput (simplified version).
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
