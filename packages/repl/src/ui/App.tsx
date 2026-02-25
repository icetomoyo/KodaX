/**
 * App - KodaX CLI 根组件
 *
 * 整合所有 UI 组件，管理应用状态
 */

import React, { useState, useCallback, useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import { InputPrompt } from "./components/InputPrompt.js";
import { MessageList } from "./components/MessageList.js";
import { StatusBar } from "./components/StatusBar.js";
import { getTheme } from "./themes/index.js";
import type { AppProps, Message, AppState, HistoryItem } from "./types.js";

// 生成唯一 ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// 将 Message 转换为 HistoryItem
function messageToHistoryItem(msg: Message): HistoryItem {
  const base = { id: msg.id, timestamp: msg.timestamp };
  switch (msg.role) {
    case "user":
      return { ...base, type: "user", text: msg.content };
    case "assistant":
      return { ...base, type: "assistant", text: msg.content };
    case "system":
      return { ...base, type: "system", text: msg.content };
    default:
      return { ...base, type: "info", text: msg.content };
  }
}

export const App: React.FC<AppProps> = ({ model, provider, onSubmit }) => {
  const { stdout } = useStdout();
  const theme = useMemo(() => getTheme("dark"), []);

  // 应用状态
  const [state, setState] = useState<AppState>({
    messages: [],
    isLoading: false,
    sessionId: generateId(),
  });

  // Token 使用统计
  const [tokenUsage, setTokenUsage] = useState<{
    input: number;
    output: number;
    total: number;
  } | null>(null);

  // 当前执行的工具
  const [currentTool, setCurrentTool] = useState<string | undefined>();

  // 处理用户输入提交
  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim()) return;

      // 添加用户消息
      const userMessage: Message = {
        id: generateId(),
        role: "user",
        content: input,
        timestamp: Date.now(),
      };

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        isLoading: true,
      }));

      try {
        // 调用外部处理函数
        await onSubmit(input);

        // 添加助手响应 (实际实现中由外部添加)
      } catch (error) {
        // 添加错误消息
        const errorMessage: Message = {
          id: generateId(),
          role: "system",
          content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          timestamp: Date.now(),
        };

        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, errorMessage],
          isLoading: false,
        }));
      } finally {
        setState((prev) => ({
          ...prev,
          isLoading: false,
        }));
      }
    },
    [onSubmit]
  );

  // 公开方法：添加消息
  const addMessage = useCallback((role: Message["role"], content: string) => {
    const message: Message = {
      id: generateId(),
      role,
      content,
      timestamp: Date.now(),
    };

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, message],
    }));
  }, []);

  // 公开方法：更新 Token 使用
  const updateTokenUsage = useCallback((input: number, output: number) => {
    setTokenUsage({
      input,
      output,
      total: input + output,
    });
  }, []);

  // 公开方法：设置当前工具
  const setTool = useCallback((tool: string | undefined) => {
    setCurrentTool(tool);
  }, []);

  return (
    <Box flexDirection="column">
      {/* 消息列表区域 */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <MessageList
          items={state.messages.map(messageToHistoryItem)}
          isLoading={state.isLoading}
        />
      </Box>

      {/* 输入区域 */}
      <Box flexShrink={0}>
        <InputPrompt
          onSubmit={handleSubmit}
          prompt=">"
          focus={!state.isLoading}
        />
      </Box>

      {/* 状态栏 */}
      <Box flexShrink={0}>
        <StatusBar
          sessionId={state.sessionId}
          mode="code"
          provider={provider}
          model={model}
          tokenUsage={tokenUsage ?? undefined}
          currentTool={currentTool}
        />
      </Box>
    </Box>
  );
};

/**
 * 简化版 App - 仅用于测试
 */
export const SimpleApp: React.FC<{
  model: string;
  provider: string;
  onInput: (input: string) => void;
}> = ({ model, provider, onInput }) => {
  const theme = useMemo(() => getTheme("dark"), []);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={theme.colors.primary} bold>
          KodaX CLI
        </Text>
        <Text dimColor>
          {" "}
          - {provider}/{model}
        </Text>
      </Box>

      <InputPrompt
        onSubmit={onInput}
        placeholder="Type a message..."
        prompt=">"
      />
    </Box>
  );
};

// 导出公开方法类型
export interface AppHandle {
  addMessage: (role: Message["role"], content: string) => void;
  updateTokenUsage: (input: number, output: number) => void;
  setTool: (tool: string | undefined) => void;
}
