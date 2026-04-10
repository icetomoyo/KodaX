/**
 * TextInput - Multi-line text input component - 澶氳鏂囨湰杈撳叆缁勪欢
 *
 * Display text content and render cursor - 鏄剧ず鏂囨湰鍐呭骞舵覆鏌撳厜鏍?
 */

import React, { useMemo, useState, useEffect } from "react";
import { Text, Box, useStdout } from "../tui.js";
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

/**
 * Maximum divider width (prevent performance issues with very wide terminals) - 鍒嗛殧绾挎渶澶у搴︼紙闃叉瓒呭缁堢鎬ц兘闂锛?
 */
const MAX_DIVIDER_WIDTH = 200;

/**
 * Generate divider line - 鐢熸垚鍒嗛殧绾?
 */
function generateDivider(width: number): string {
  const safeWidth = Math.min(MAX_DIVIDER_WIDTH, Math.max(1, width));
  return "-".repeat(safeWidth);
}

/**
 * Hook to get terminal width - 鑾峰彇缁堢瀹藉害鐨?Hook
 */
function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(() => {
    // Use stdout or process.stdout on initialization - 鍒濆鍖栨椂浣跨敤 stdout 鎴?process.stdout
    return stdout?.columns ?? process.stdout?.columns ?? 80;
  });

  useEffect(() => {
    const handleResize = () => {
      // Use process.stdout.columns instead of stdout in closure
      // because closure value may be stale - 浣跨敤 process.stdout.columns 鑰岄潪闂寘涓殑 stdout锛屽洜涓洪棴鍖呬腑鐨勫€煎彲鑳借繃鏃?
      const newWidth = process.stdout?.columns ?? stdout?.columns ?? 80;
      setWidth(newWidth);
    };

    // Listen for terminal resize events - 鐩戝惉缁堢 resize 浜嬩欢
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
  terminalFocused = true,
  isPasting = false,
  editingMode = "idle",
  theme: themeName = "dark",
  width: propWidth,
}) => {
  const theme = useMemo(() => getTheme(themeName), [themeName]);
  const terminalWidth = propWidth ?? useTerminalWidth();

  // Calculate prompt width (for alignment) - 璁＄畻鎻愮ず绗﹀搴︼紙鐢ㄤ簬瀵归綈锛?
  const promptWidth = stringWidth(prompt) + 1; // +1 for space

  // Calculate visual layout for wrapping - 璁＄畻瑙嗚甯冨眬鐢ㄤ簬鎹㈣
  const visualLayout = useMemo(() => {
    // Calculate available width for text (excluding prompt) - 璁＄畻鏂囨湰鍙敤瀹藉害锛堟帓闄ゆ彁绀虹锛?
    const availableWidth = Math.max(20, terminalWidth - promptWidth);

    return calculateVisualLayout(
      lines,
      availableWidth,
      cursorRow,
      cursorCol
    );
  }, [lines, terminalWidth, cursorRow, cursorCol, promptWidth]);

  // Calculate visual cursor position - 璁＄畻瑙嗚鍏夋爣浣嶇疆
  const visualCursor = useMemo(() => {
    if (!visualLayout) return null;

    const [visualRow, visualCol] = calculateVisualCursorFromLayout(
      visualLayout,
      [cursorRow, cursorCol]
    );
    return { row: visualRow, col: visualCol };
  }, [visualLayout, cursorRow, cursorCol]);

  // Use visual layout rendering for all input (including empty and single-line) - 鎵€鏈夎緭鍏ヤ娇鐢ㄨ瑙夊竷灞€娓叉煋锛堝寘鎷┖杈撳叆鍜屽崟琛岋級
  const divider = generateDivider(terminalWidth);
  const showCursor = focus && terminalFocused;
  const pasteHintVisible = isPasting && lines.some((line) => line.length > 0);

  // TypeScript non-null assertion: visualLayout and visualCursor are  // TypeScript 闈炵┖鏂█锛歷isualLayout 鍜?visualCursor 淇濊瘉闈炵┖
  const layout = visualLayout!;
  const vCursor = visualCursor!;

  return (
    <Box flexDirection="column" width={propWidth}>
      {/* Top divider - 椤堕儴鍒嗛殧绾?*/}
      <Text dimColor>{divider}</Text>
      {pasteHintVisible ? (
        <Box>
          <Text dimColor>{editingMode === "pasting" ? "Pasting input..." : "Editing input..."}</Text>
        </Box>
      ) : null}

      {/* Content lines - 鍐呭琛?*/}
      {layout.visualLines.length === 0 || (layout.visualLines.length === 1 && layout.visualLines[0] === "") ? (
        // Empty input - show placeholder and cursor - 绌鸿緭鍏?- 鏄剧ず鍗犱綅绗﹀拰鍏夋爣
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

          // Current line needs to show cursor - 褰撳墠琛岄渶瑕佹樉绀哄厜鏍?
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

          // Non-current line - 闈炲綋鍓嶈
          return (
            <Box key={visualRowIndex}>
              <Text color={theme.colors.dim}>{linePrompt} </Text>
              <Text color={theme.colors.text}>{visualLine}</Text>
            </Box>
          );
        })
      )}

      {/* Bottom divider - 搴曢儴鍒嗛殧绾?*/}
      <Text dimColor>{divider}</Text>
    </Box>
  );
};

/**
 * Single-line TextInput (simplified version) - 鍗曡 TextInput锛堢畝鍖栫増锛?
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

