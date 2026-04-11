/**
 * App - KodaX CLI root component.
 *
 * Integrates all UI components and manages application state.
 */

import React, { useState, useCallback, useMemo } from "react";
import { Box, Text, useStdout } from "./tui.js";
import { InputPrompt } from "./components/InputPrompt.js";
import { MessageList } from "./components/MessageList.js";
import { StatusBar } from "./components/StatusBar.js";
import { getTheme } from "./themes/index.js";
import type { AppProps, Message, AppState, HistoryItem } from "./types.js";

// Generate unique ID.
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Convert Message to HistoryItem.
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

export const App: React.FC<AppProps> = ({
  model,
  provider,
  onSubmit,
  permissionMode = "accept-edits",
  agentMode = "ama",
}) => {
  const { stdout } = useStdout();
  const theme = useMemo(() => getTheme("dark"), []);

  void stdout;
  void theme;

  // Application state.
  const [state, setState] = useState<AppState>({
    messages: [],
    isLoading: false,
    sessionId: generateId(),
  });

  // Token usage statistics.
  const [tokenUsage, setTokenUsage] = useState<{
    input: number;
    output: number;
    total: number;
  } | null>(null);

  // Current executing tool.
  const [currentTool, setCurrentTool] = useState<string | undefined>();

  // Handle user input submission.
  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim()) {
        return;
      }

      // Add the user message.
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
        // Call the external handler.
        await onSubmit(input);

        // Assistant responses are added externally in the real app.
      } catch (error) {
        // Add the error message.
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
    [onSubmit],
  );

  // Public method: add message.
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

  // Public method: update token usage.
  const updateTokenUsage = useCallback((input: number, output: number) => {
    setTokenUsage({
      input,
      output,
      total: input + output,
    });
  }, []);

  // Public method: set the current tool.
  const setTool = useCallback((tool: string | undefined) => {
    setCurrentTool(tool);
  }, []);

  void addMessage;
  void updateTokenUsage;
  void setTool;

  return (
    <Box flexDirection="column">
      {/* Message list area */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <MessageList
          items={state.messages.map(messageToHistoryItem)}
          isLoading={state.isLoading}
        />
      </Box>

      {/* Input area */}
      <Box flexShrink={0}>
        <InputPrompt
          onSubmit={handleSubmit}
          prompt=">"
          focus={!state.isLoading}
        />
      </Box>

      {/* Status bar */}
      <Box flexShrink={0}>
        <StatusBar
          sessionId={state.sessionId}
          permissionMode={permissionMode}
          agentMode={agentMode}
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
 * Simplified App for testing only.
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

// Export public method types.
export interface AppHandle {
  addMessage: (role: Message["role"], content: string) => void;
  updateTokenUsage: (input: number, output: number) => void;
  setTool: (tool: string | undefined) => void;
}
