/**
 * InputPrompt - 输入提示组件
 *
 * 集成多行输入、历史导航、键盘快捷键
 */

import React, { useEffect, useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "./TextInput.js";
import { useTextBuffer } from "../hooks/useTextBuffer.js";
import { useInputHistory } from "../hooks/useInputHistory.js";
import { getTheme } from "../themes/index.js";
import type { InputPromptProps } from "../types.js";

export const InputPrompt: React.FC<InputPromptProps> = ({
  onSubmit,
  placeholder = "Type... (\\+Enter=newline, Enter=send)",
  prompt = ">",
  focus = true,
  initialValue = "",
}) => {
  const theme = getTheme("dark");
  const [isFirstLine, setIsFirstLine] = useState(true);

  // 输入历史
  const { add: addHistory, navigateUp, navigateDown, reset: resetHistory } = useInputHistory();

  // 文本缓冲区
  const { text, cursor, lines, setText, clear, move, insert, backspace, newline, delete: deleteChar } = useTextBuffer({
    initialValue,
    onSubmit: (submittedText) => {
      addHistory(submittedText);
      onSubmit(submittedText);
      setIsFirstLine(true);
    },
  });

  // 更新 isFirstLine 状态
  useEffect(() => {
    setIsFirstLine(cursor.row === 0);
  }, [cursor.row]);

  // 处理提交
  const handleSubmit = useCallback(() => {
    if (text.trim()) {
      addHistory(text);
      onSubmit(text);
      clear();
      setIsFirstLine(true);
    }
  }, [text, addHistory, onSubmit, clear]);

  // 处理换行（删除行尾的反斜杠）
  const handleLineContinuation = useCallback(() => {
    const currentLine = lines[cursor.row] ?? "";
    if (currentLine.endsWith("\\")) {
      // 删除反斜杠
      backspace();
    }
    newline();
  }, [lines, cursor.row, backspace, newline]);

  // 键盘输入处理
  useInput(
    (char, key) => {
      if (!focus) return;

      // Ctrl+C 清空或退出
      if (key.ctrl && char === "c") {
        if (text.length > 0) {
          clear();
          resetHistory();
        }
        return;
      }

      // 处理上下键历史导航
      // 连贯历史导航：
      // - 上箭头在第一行任意位置 → 加载上一条历史
      // - 下箭头在最后一行末尾 → 加载下一条历史
      // - 否则 → 移动光标
      if (key.upArrow) {
        if (cursor.row === 0) {
          // 第一行 → 加载上一条历史
          const historyText = navigateUp();
          if (historyText !== null) {
            setText(historyText);
          }
        } else {
          move("up");
        }
        return;
      }

      if (key.downArrow) {
        const lineCount = lines.length;
        const currentLineLength = lines[cursor.row]?.length ?? 0;
        const isLastLine = cursor.row === lineCount - 1;
        const isAtEnd = cursor.col >= currentLineLength;

        if (isLastLine && isAtEnd) {
          // 最后一行末尾 → 加载下一条历史
          const historyText = navigateDown();
          if (historyText !== null) {
            setText(historyText);
          } else {
            clear();
          }
        } else {
          move("down");
        }
        return;
      }

      // 左右方向键
      if (key.leftArrow) {
        move("left");
        return;
      }
      if (key.rightArrow) {
        move("right");
        return;
      }

      // 退格键 - 检查多种情况
      // 1. Ink 检测到的 key.backspace
      // 2. \x7f (DEL, ASCII 127) - 某些终端的 Backspace 发送此字符
      // 3. \x08 (BS, ASCII 8) - 另一种 Backspace 字符
      // 4. Ctrl+H - 某些终端将其映射为 Backspace
      // 注意：必须在 key.delete 检查之前，因为某些终端将 Backspace 识别为 Delete
      if (key.backspace || char === "\x7f" || char === "\x08" || (key.ctrl && char === "h")) {
        backspace();
        return;
      }

      // Delete 键（删除光标后的字符）
      // 注意：某些终端的 Backspace 被识别为 key.delete=true 且 char=""
      // 真正的 Delete 键通常会有特定的字符序列
      // 所以当 key.delete=true 且 char 为空时，应该当作 Backspace 处理
      if (key.delete) {
        if (!char || char === "") {
          // Backspace 被错误识别为 Delete，删除光标前的字符
          backspace();
        } else {
          // 真正的 Delete 键，删除光标后的字符
          deleteChar();
        }
        return;
      }

      // 换行检测 - 多种方式
      // 1. Shift+Enter (key.shift + key.return)
      // 2. Ctrl+Enter (key.ctrl + key.return)
      // 3. 单独的 \n 字符 (某些终端的 Shift+Enter 不被 Ink 正确识别)
      const isNewline = (key.return && key.shift) ||
                        (key.return && key.ctrl) ||
                        (char === "\n" && !key.return);

      if (isNewline) {
        newline();
        return;
      }

      // 回车提交
      if (key.return) {

        // 检查是否需要换行 (行尾是 \)
        const currentLine = lines[cursor.row] ?? "";
        if (currentLine.endsWith("\\")) {
          handleLineContinuation();
          return;
        }

        // 提交
        handleSubmit();
        return;
      }

      // Ctrl 组合键
      if (key.ctrl) {
        switch (char) {
          case "a":
            move("home");
            return;
          case "e":
            move("end");
            return;
        }
        return;
      }

      // 普通字符输入（排除控制字符）
      if (char && !key.meta && char.charCodeAt(0) >= 32) {
        insert(char);
        return;
      }
    },
    { isActive: focus }
  );

  return (
    <Box flexDirection="column" marginY={1}>
      <TextInput
        lines={lines}
        cursorRow={cursor.row}
        cursorCol={cursor.col}
        prompt={prompt}
        placeholder={placeholder}
        focus={focus}
        theme="dark"
      />
    </Box>
  );
};

/**
 * 简化版 InputPrompt - 单行模式
 */
export const SimpleInputPrompt: React.FC<{
  onSubmit: (text: string) => void;
  placeholder?: string;
  prompt?: string;
}> = ({ onSubmit, placeholder, prompt = ">" }) => {
  const [value, setValue] = useState("");
  const [cursorCol, setCursorCol] = useState(0);

  useInput((char, key) => {
    if (key.return) {
      if (value.trim()) {
        onSubmit(value);
        setValue("");
        setCursorCol(0);
      }
      return;
    }

    if (key.backspace && cursorCol > 0) {
      const before = [...value].slice(0, cursorCol - 1).join("");
      const after = [...value].slice(cursorCol).join("");
      setValue(before + after);
      setCursorCol(cursorCol - 1);
      return;
    }

    if (key.leftArrow && cursorCol > 0) {
      setCursorCol(cursorCol - 1);
      return;
    }

    if (key.rightArrow && cursorCol < [...value].length) {
      setCursorCol(cursorCol + 1);
      return;
    }

    if (char && !key.ctrl && !key.meta && char.charCodeAt(0) >= 32) {
      const before = [...value].slice(0, cursorCol).join("");
      const after = [...value].slice(cursorCol).join("");
      setValue(before + char + after);
      setCursorCol(cursorCol + 1);
    }
  });

  const theme = getTheme("dark");

  if (!value) {
    return (
      <Box>
        <Text color={theme.colors.primary}>{prompt} </Text>
        {placeholder && <Text dimColor>{placeholder}</Text>}
        <Text backgroundColor={theme.colors.primary}> </Text>
      </Box>
    );
  }

  const beforeCursor = [...value].slice(0, cursorCol).join("");
  const cursorChar = [...value][cursorCol] ?? " ";
  const afterCursor = [...value].slice(cursorCol + 1).join("");

  return (
    <Box>
      <Text color={theme.colors.primary}>{prompt} </Text>
      <Text>{beforeCursor}</Text>
      <Text backgroundColor={theme.colors.primary} color="#000000">
        {cursorChar}
      </Text>
      <Text>{afterCursor}</Text>
    </Box>
  );
};
