/**
 * InputPrompt - 输入提示组件
 *
 * 集成多行输入、历史导航、键盘快捷键
 */

import React, { useEffect, useState, useCallback } from "react";
import { Box, Text, useInput, type Key } from "ink";
import { TextInput } from "./TextInput.js";
import { useTextBuffer } from "../hooks/useTextBuffer.js";
import { useInputHistory } from "../hooks/useInputHistory.js";
import { getTheme } from "../themes/index.js";
import type { InputPromptProps } from "../types.js";

export const InputPrompt: React.FC<InputPromptProps> = ({
  onSubmit,
  placeholder = "Type your message... (Enter: submit, \\+Enter: newline)",
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

      // 处理上下键历史导航（仅在第一行且光标在行首时）
      if (key.upArrow) {
        if (isFirstLine && cursor.row === 0) {
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
        if (isFirstLine && cursor.row === 0) {
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

      // Delete 键（删除光标后的字符）
      if (key.delete) {
        deleteChar();
        return;
      }

      // 退格
      if (key.backspace || (key.ctrl && char === "h")) {
        backspace();
        return;
      }

      // 回车
      if (key.return) {
        // Shift+Enter 始终换行
        if (key.shift) {
          newline();
          return;
        }

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

      {/* 多行提示 */}
      {lines.length > 1 && (
        <Box marginLeft={2}>
          <Text dimColor>
            Lines: {lines.length} | Ctrl+C: clear | Enter: submit
          </Text>
        </Box>
      )}
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
