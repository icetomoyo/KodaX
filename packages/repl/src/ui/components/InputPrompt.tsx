/**
 * InputPrompt - 输入提示组件
 *
 * 集成多行输入、历史导航、键盘快捷键
 * 使用 centralized KeypressContext 进行键盘事件处理
 *
 * 参考: Gemini CLI InputPrompt 架构
 */

import React, { useEffect, useState, useCallback } from "react";
import { Box, Text, useApp } from "ink";
import { TextInput } from "./TextInput.js";
import { useTextBuffer } from "../hooks/useTextBuffer.js";
import { useInputHistory } from "../hooks/useInputHistory.js";
import { useKeypress } from "../contexts/KeypressContext.js";
import { getTheme } from "../themes/index.js";
import { KeypressHandlerPriority, type InputPromptProps } from "../types.js";

export const InputPrompt: React.FC<InputPromptProps> = ({
  onSubmit,
  placeholder = "Type a message...",
  prompt = ">",
  focus = true,
  initialValue = "",
}) => {
  const theme = getTheme("dark");
  const { exit } = useApp();
  const [isFirstLine, setIsFirstLine] = useState(true);

  // 输入历史
  const { add: addHistory, navigateUp, navigateDown, reset: resetHistory, saveTempInput } = useInputHistory();

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

  // 键盘输入处理 - 使用 centralized KeypressContext
  // 参考 Gemini CLI: 使用优先级系统注册处理器
  useKeypress(
    KeypressHandlerPriority.High, // 高优先级，确保输入组件优先处理
    (key) => {
      if (!focus) return false;

      // Ctrl+C 清空或退出
      if (key.ctrl && key.name === "c") {
        if (text.length > 0) {
          clear();
          resetHistory();
        } else {
          // 没有文字时退出程序
          exit();
        }
        return true;
      }

      // ESC 键 - 清空输入
      if (key.name === "escape") {
        if (text.length > 0) {
          clear();
          resetHistory();
        }
        return true;
      }

      // 处理上下键历史导航
      if (key.name === "up") {
        if (cursor.row === 0) {
          // 第一行 → 加载上一条历史
          saveTempInput(text);
          const historyText = navigateUp();
          if (historyText !== null) {
            setText(historyText);
          }
        } else {
          move("up");
        }
        return true;
      }

      if (key.name === "down") {
        const lineCount = lines.length;
        const isLastLine = cursor.row === lineCount - 1;

        if (isLastLine) {
          // 最后一行 → 加载下一条历史
          const historyText = navigateDown();
          // navigateDown 返回 string（可能是空字符串）或 null（表示没有导航）
          // 参考 Gemini CLI/OpenCode: 总是更新文本，包括空字符串
          if (historyText !== null) {
            setText(historyText);
          }
          // 如果返回 null，说明已经在最新位置，不做任何操作
        } else {
          move("down");
        }
        return true;
      }

      // 左右方向键
      if (key.name === "left") {
        move("left");
        return true;
      }
      if (key.name === "right") {
        move("right");
        return true;
      }

      // Backspace 键 - 删除光标前的字符
      // 使用 centralized parser，\b 和 \x7f 都正确识别为 backspace
      if (key.name === "backspace") {
        backspace();
        return true;
      }

      // Delete 键 - 删除光标后的字符
      // 只有真正的 Delete 键（\x1b[3~）才会触发这个
      if (key.name === "delete") {
        deleteChar();
        return true;
      }

      // 换行 - Shift+Enter, Ctrl+Enter, 或 Ctrl+J (newline)
      // 参考 Gemini CLI: 多种方式插入换行
      if (
        (key.name === "return" && key.shift) ||
        (key.name === "return" && key.ctrl) ||
        key.name === "newline"  // Ctrl+J 或终端发送的 \n
      ) {
        newline();
        return true;
      }

      // 回车提交
      if (key.name === "return") {
        // 检查是否需要换行 (行尾是 \)
        const currentLine = lines[cursor.row] ?? "";
        if (currentLine.endsWith("\\")) {
          handleLineContinuation();
          return true;
        }

        // 提交
        handleSubmit();
        return true;
      }

      // Ctrl 组合键
      if (key.ctrl) {
        switch (key.name) {
          case "a":
            move("home");
            return true;
          case "e":
            move("end");
            return true;
        }
        return true;
      }

      // 普通字符输入（排除控制字符）
      // 使用 insertable 属性判断是否可插入
      if (key.insertable && !key.ctrl && !key.meta) {
        insert(key.sequence);
        return true;
      }

      return false;
    },
    [focus, text, cursor, lines, clear, resetHistory, saveTempInput, navigateUp, navigateDown, setText, move, backspace, deleteChar, newline, handleSubmit, handleLineContinuation, insert]
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

  useKeypress(
    KeypressHandlerPriority.High,
    (key) => {
      if (key.name === "return") {
        if (value.trim()) {
          onSubmit(value);
          setValue("");
          setCursorCol(0);
        }
        return true;
      }

      if (key.name === "backspace" && cursorCol > 0) {
        const before = [...value].slice(0, cursorCol - 1).join("");
        const after = [...value].slice(cursorCol).join("");
        setValue(before + after);
        setCursorCol(cursorCol - 1);
        return true;
      }

      if (key.name === "left" && cursorCol > 0) {
        setCursorCol(cursorCol - 1);
        return true;
      }

      if (key.name === "right" && cursorCol < [...value].length) {
        setCursorCol(cursorCol + 1);
        return true;
      }

      if (key.insertable && !key.ctrl && !key.meta) {
        const before = [...value].slice(0, cursorCol).join("");
        const after = [...value].slice(cursorCol).join("");
        setValue(before + key.sequence + after);
        setCursorCol(cursorCol + 1);
        return true;
      }

      return false;
    },
    [value, cursorCol, onSubmit]
  );

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
