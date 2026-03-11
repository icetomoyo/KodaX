/**
 * InkREPL - Ink-based REPL Adapter
 *
 * Bridges Ink UI components with existing KodaX command processing logic.
 * Replaces the Node.js readline-based input with Ink's React components.
 *
 * Architecture based on Gemini CLI:
 * - Uses UIStateContext for global state
 * - Uses KeypressContext for priority-based keyboard handling
 * - Uses StreamingContext for streaming response management
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { render, Box, useApp, Text, Static, useInput, useStdout } from "ink";
import { InputPrompt } from "./components/InputPrompt.js";
import { MessageList } from "./components/MessageList.js";
import { ThinkingIndicator } from "./components/LoadingIndicator.js";
import { StatusBar } from "./components/StatusBar.js";
import { SuggestionsDisplay } from "./components/SuggestionsDisplay.js";
import {
  UIStateProvider,
  useUIState,
  useUIActions,
  StreamingProvider,
  useStreamingState,
  useStreamingActions,
  KeypressProvider,
  useKeypress,
} from "./contexts/index.js";
import { AutocompleteContextProvider, useAutocompleteContext } from "./hooks/index.js";
import { StreamingState, type HistoryItem, KeypressHandlerPriority } from "./types.js";
import {
  KodaXOptions,
  KodaXMessage,
  KodaXResult,
  runKodaX,
  KODAX_DEFAULT_PROVIDER,
  KodaXTerminalError,
  classifyError,
  ErrorCategory,
} from "@kodax/coding";
import { estimateTokens } from "@kodax/agent";
import {
  PermissionMode,
  ConfirmResult,
  createPermissionContext,
  computeConfirmTools,
  isToolCallAllowed,
  isAlwaysConfirmPath,
  isCommandOnProtectedPath,
  FILE_MODIFICATION_TOOLS,
  isBashWriteCommand,
  isBashReadCommand,
} from "../permission/index.js";
import type { PermissionContext } from "../permission/types.js";
import {
  InteractiveContext,
  createInteractiveContext,
  touchContext,
} from "../interactive/context.js";
import {
  parseCommand,
  executeCommand,
  CommandCallbacks,
  CurrentConfig,
} from "../interactive/commands.js";
import { getProviderModel } from "../common/utils.js";
import { KODAX_VERSION } from "../common/utils.js";
import { runWithPlanMode } from "../common/plan-mode.js";
import { saveAlwaysAllowToolPattern, loadAlwaysAllowTools, savePermissionModeUser } from "../common/permission-config.js";
import { initializeSkillRegistry, getSkillRegistry } from "@kodax/skills";
import { getTheme } from "./themes/index.js";
import chalk from "chalk";

// Extracted modules
import { MemorySessionStorage, type SessionStorage } from "./utils/session-storage.js";
import { processSpecialSyntax, isShellCommandSuccess } from "./utils/shell-executor.js";
import { extractTextContent, extractTitle } from "./utils/message-utils.js";
import { withCapture, ConsoleCapturer } from "./utils/console-capturer.js";

// REPL options
export interface InkREPLOptions extends KodaXOptions {
  storage?: SessionStorage;
}

// Ink REPL Props
interface InkREPLProps {
  options: InkREPLOptions;
  config: CurrentConfig;
  context: InteractiveContext;
  storage: SessionStorage;
  compactionInfo?: { contextWindow: number; triggerPercent: number; enabled: boolean };
  onExit: () => void;
}

// Banner Props
interface BannerProps {
  config: CurrentConfig;
  sessionId: string;
  workingDir: string;
  compactionInfo?: { contextWindow: number; triggerPercent: number; enabled: boolean };
}

/**
 * Banner component - displayed inside Ink UI so it's part of the alternate buffer
 */
const Banner: React.FC<BannerProps> = ({ config, sessionId, workingDir, compactionInfo }) => {
  const theme = getTheme("dark");
  const model = getProviderModel(config.provider) ?? config.provider;
  const terminalWidth = process.stdout.columns ?? 80;
  const dividerWidth = Math.min(60, terminalWidth - 4);

  const logoLines = [
    "  ██╗  ██╗  ██████╗  ██████╗    █████╗   ██╗  ██╗",
    "  ██║ ██╔╝ ██╔═══██╗ ██╔══██╗  ██╔══██╗  ╚██╗██╔╝",
    "  █████╔╝  ██║   ██║ ██║  ██║  ███████║   ╚███╔╝ ",
    "  ██╔═██╗  ██║   ██║ ██║  ██║  ██╔══██║   ██╔██╗ ",
    "  ██║  ██╗ ╚██████╔╝ ██████╔╝  ██║  ██║  ██╔╝ ██╗",
    "  ╚═╝  ╚═╝  ╚═════╝  ╚═════╝   ╚═╝  ╚═╝  ╚═╝  ╚═╝",
  ];

  // Compute compaction display values
  const ctxK = compactionInfo ? Math.round(compactionInfo.contextWindow / 1000) : 0;
  const triggerK = compactionInfo ? Math.round(compactionInfo.contextWindow * compactionInfo.triggerPercent / 100 / 1000) : 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Logo */}
      {logoLines.map((line, i) => (
        <Text key={i} color={theme.colors.primary}>
          {line}
        </Text>
      ))}

      {/* Version and Provider Info */}
      <Box>
        <Text bold color={theme.colors.text}>
          {"  v"}
          {KODAX_VERSION}
        </Text>
        <Text dimColor>
          {" | "}
        </Text>
        <Text color={theme.colors.success}>
          {config.provider}/{model}
        </Text>
        <Text dimColor>
          {" | "}
        </Text>
        <Text color={theme.colors.accent}>
          {config.permissionMode}
        </Text>
        {config.thinking && (
          <Text color={theme.colors.warning}>
            {" +think"}
          </Text>
        )}
      </Box>

      {/* Compaction Info */}
      {compactionInfo && (
        <Box>
          <Text dimColor>{"  Context: "}</Text>
          <Text dimColor>{ctxK}k</Text>
          <Text dimColor>{" | Compaction: "}</Text>
          <Text color={compactionInfo.enabled ? theme.colors.success : undefined} dimColor={!compactionInfo.enabled}>
            {compactionInfo.enabled ? "on" : "off"}
          </Text>
          <Text dimColor>{` @ ${compactionInfo.triggerPercent}% (${triggerK}k)`}</Text>
        </Box>
      )}

      {/* Divider */}
      <Text dimColor>
        {"  "}
        {"-".repeat(dividerWidth)}
      </Text>

      {/* Session Info */}
      <Box>
        <Text dimColor>{"  Session: "}</Text>
        <Text color={theme.colors.accent}>{sessionId}</Text>
        <Text dimColor>{" | Working: "}</Text>
        <Text dimColor>{workingDir}</Text>
      </Box>

      {/* Divider */}
      <Text dimColor>
        {"  "}
        {"-".repeat(dividerWidth)}
      </Text>
    </Box>
  );
};

/**
 * AutocompleteSuggestions - Renders autocomplete suggestions from context
 * Shows suggestions below input, reserves space after first appearance
 * 在输入框下方显示建议，首次出现后预留空间
 *
 * Behavior:
 * 1. No suggestions initially → no space reserved
 * 2. Suggestions appear → reserve 8 lines
 * 3. Suggestions disappear (Esc/input change) → keep 8 lines
 * 4. Message sent (submitCounter changes) → remove 8 lines
 */
const AutocompleteSuggestions: React.FC<{ submitCounter: number }> = ({
  submitCounter,
}) => {
  const autocomplete = useAutocompleteContext();

  // Track if we should reserve space (set true when suggestions first appear)
  // 跟踪是否应该预留空间（建议首次出现时设为 true）
  const [shouldReserveSpace, setShouldReserveSpace] = useState(false);

  // Track last submit counter to detect changes
  // 跟踪上次的提交计数器以检测变化
  const lastSubmitCounterRef = useRef(submitCounter);

  // Get suggestion state
  // 获取建议状态
  const hasSuggestions = useMemo(() => {
    if (!autocomplete) return false;
    const { state, suggestions } = autocomplete;
    return state.visible && suggestions.length > 0;
  }, [autocomplete]);

  // Update reserve space when suggestions appear
  // 当建议出现时更新预留空间
  useEffect(() => {
    if (hasSuggestions && !shouldReserveSpace) {
      setShouldReserveSpace(true);
    }
  }, [hasSuggestions, shouldReserveSpace]);

  // Clear space when message is sent (submitCounter changes)
  // 发送消息时清除空间（submitCounter 变化）
  useEffect(() => {
    if (submitCounter !== lastSubmitCounterRef.current) {
      lastSubmitCounterRef.current = submitCounter;
      if (shouldReserveSpace) {
        setShouldReserveSpace(false);
      }
    }
  }, [submitCounter, shouldReserveSpace]);

  // If context is not available, render nothing or placeholder
  // 如果 context 不可用，不渲染或渲染占位符
  if (!autocomplete) {
    return shouldReserveSpace ? <Box height={8} /> : null;
  }

  const { state, suggestions } = autocomplete;

  // Render suggestions or empty placeholder
  // 渲染建议或空占位符
  if (!hasSuggestions) {
    return shouldReserveSpace ? <Box height={8} /> : null;
  }

  return (
    <Box height={8}>
      <SuggestionsDisplay
        suggestions={suggestions}
        selectedIndex={state.selectedIndex}
        visible={state.visible}
        maxVisible={7}
        width={80}
      />
    </Box>
  );
};

/**
 * Inner REPL component that uses contexts
 */
const InkREPLInner: React.FC<InkREPLProps> = ({
  options,
  config,
  context,
  storage,
  onExit,
  compactionInfo,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { history } = useUIState();
  const { addHistoryItem, clearHistory: clearUIHistory } = useUIActions();

  // Get terminal dimensions for fixed layout - 获取终端尺寸用于固定布局
  const terminalHeight = stdout.rows || 24;
  const terminalWidth = stdout.columns || 80;

  // Issue 079: Limit visible history to last 20 conversation rounds
  // A "round" = one user input + AI response(s)
  // Full history remains in state, only rendering is limited
  const MAX_VISIBLE_ROUNDS = 20;
  const renderHistory = useMemo(() => {
    if (history.length === 0) return [];

    // Find the index where the last 20 rounds begin
    // Each round starts with a "user" type message
    let userCount = 0;
    let startIndex = 0;

    for (let i = 0; i < history.length; i++) {
      if (history[i].type === "user") {
        userCount++;
        // If this is the 21st user message, this is where we should start
        if (userCount > MAX_VISIBLE_ROUNDS) {
          startIndex = i;
          break;
        }
      }
    }

    // If we have less than or equal to MAX_VISIBLE_ROUNDS, show all
    return startIndex === 0 ? history : history.slice(startIndex);
  }, [history]);

  const streamingState = useStreamingState();
  const {
    startStreaming,
    stopStreaming,
    abort,
    startThinking,
    appendThinkingChars,
    appendThinkingContent,
    stopThinking,
    clearThinkingContent,
    setCurrentTool,
    appendToolInputChars,
    appendToolInputContent,
    clearResponse,
    appendResponse,
    getSignal,
    getFullResponse,
    getThinkingContent,
    startNewIteration,
    clearIterationHistory,
    startCompacting,
    stopCompacting,
    setMaxIter,
  } = useStreamingActions();

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [currentConfig, setCurrentConfig] = useState<CurrentConfig>(config);
  const [planMode, setPlanMode] = useState(false);
  const [isRunning, setIsRunning] = useState(true);
  const [showBanner, setShowBanner] = useState(true); // Show banner in Ink UI
  const [submitCounter, setSubmitCounter] = useState(0); // Counter to trigger clear on submit
  const [liveTokenCount, setLiveTokenCount] = useState<number | null>(null); // Live token count for real-time display

  // Confirmation dialog state - 确认对话框状态
  const [confirmRequest, setConfirmRequest] = useState<{
    tool: string;
    input: Record<string, unknown>;
    prompt: string;
  } | null>(null);
  const confirmResolveRef = useRef<((result: ConfirmResult) => void) | null>(null);

  // Issue 070: Calculate context token usage for status bar display
  // Issue 070: Calculate context token usage for status bar display
  // Issue 070: 计算上下文 token 使用量用于状态栏显示
  const contextUsage = useMemo(() => {
    if (!compactionInfo) return undefined;

    const { contextWindow, triggerPercent } = compactionInfo;
    // Use live token count during streaming, otherwise calculate from messages
    const currentTokens = liveTokenCount ?? estimateTokens(context.messages);

    return {
      currentTokens,
      contextWindow,
      triggerPercent,
    };
  }, [context.messages, compactionInfo, liveTokenCount]);

  // Refs for callbacks
  // Note: permissionMode and alwaysAllowTools are stored separately for permission checks
  const currentOptionsRef = useRef<InkREPLOptions>({
    ...options,
    session: {
      ...options.session,
      id: context.sessionId,
    },
  });
  // Permission-related refs (not part of KodaXOptions anymore)
  const permissionModeRef = useRef<PermissionMode>(currentConfig.permissionMode);
  const alwaysAllowToolsRef = useRef<string[]>(loadAlwaysAllowTools());

  // Double-ESC detection for interrupt - 双击 ESC 中断检测
  const lastEscPressRef = useRef<number>(0);
  const DOUBLE_ESC_INTERVAL = 500; // ms

  // Global interrupt handler - using Gemini CLI style isActive pattern - 全局中断处理器 - 使用 Gemini CLI 风格的 isActive 模式
  // Only subscribe during streaming to ensure keyboard events are captured correctly - 只在 streaming 期间订阅，确保键盘事件能被正确捕获
  // Reference: Gemini CLI useGeminiStream.ts useKeypress usage - 参考: Gemini CLI useGeminiStream.ts 中的 useKeypress 使用方式
  useKeypress(
    (key) => {
      // Ctrl+C immediately interrupts - Ctrl+C 立即中断
      if (key.ctrl && key.name === "c") {
        // Just abort - the catch block will handle saving the partial response
        // 只需中止 - catch 块会处理保存部分响应
        abort();
        stopThinking();
        clearThinkingContent();
        setCurrentTool(undefined);
        setIsLoading(false);
        console.log(chalk.yellow("\n[Interrupted]"));
        return true;
      }

      // ESC requires double-press to interrupt - ESC 需要双击才能中断
      if (key.name === "escape") {
        const now = Date.now();
        const timeSinceLastEsc = now - lastEscPressRef.current;

        if (timeSinceLastEsc < DOUBLE_ESC_INTERVAL) {
          // Double ESC: interrupt streaming - 双击 ESC：中断流
          lastEscPressRef.current = 0;
          abort();
          stopThinking();
          clearThinkingContent();
          setCurrentTool(undefined);
          setIsLoading(false);
          console.log(chalk.yellow("\n[Interrupted]"));
          return true;
        } else {
          // First ESC: just record the time - 第一次 ESC：只记录时间
          lastEscPressRef.current = now;
          return true; // Consume the event to prevent InputPrompt from handling
        }
      }

      return false;
    },
    {
      isActive: isLoading, // Only active during streaming - 只在 streaming 期间激活
      priority: KeypressHandlerPriority.Critical, // Use highest priority to ensure interrupt is handled first - 使用最高优先级，确保中断优先处理
    }
  );

  // Confirmation dialog keyboard handler - 确认对话框键盘处理
  useInput(
    (input, _key) => {
      if (!confirmRequest) return;

      const answer = input.toLowerCase();
      const isProtectedPath = !!confirmRequest.input._alwaysConfirm;

      if (answer === 'y' || answer === 'yes') {
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: true });
        confirmResolveRef.current = null;
      } else if (!isProtectedPath && (answer === 'a' || answer === 'always')) {
        // "Always" option not available for protected paths - 永久保护路径不提供 "always" 选项
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: true, always: true });
        confirmResolveRef.current = null;
      } else if (answer === 'n' || answer === 'no') {
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: false });
        confirmResolveRef.current = null;
      }
    },
    { isActive: !!confirmRequest }
  );

  // Sync history from context to UI
  // Re-sync when history is cleared (e.g., after /compact command)
  // Only sync if history is empty to avoid duplicates (Issue 046)
  useEffect(() => {
    if (context.messages.length > 0 && history.length === 0) {
      // Convert messages to history items
      // Skip messages with empty content (e.g., pure tool_result messages)
      for (const msg of context.messages) {
        const content = extractTextContent(msg.content);
        // Skip empty content to avoid showing blank or tool_result-only messages
        if (!content) continue;
        if (msg.role === "user") {
          addHistoryItem({
            type: "user",
            text: content,
          });
        } else if (msg.role === "assistant") {
          addHistoryItem({
            type: "assistant",
            text: content,
          });
        } else if (msg.role === "system") {
          // Handle system role messages (e.g., compaction summaries)
          addHistoryItem({
            type: "system",
            text: content,
          });
        }
      }
    }
  }, [context.messages.length, history.length, addHistoryItem]); // Re-run when messages or history changes

  // Preload skills on mount to ensure they're available for first /skill:xxx call
  // Issue 059: Skills lazy loading caused first skill invocation to fail
  // Issue 064: Must pass projectRoot to discover .kodax/skills/ in project directory
  useEffect(() => {
    void initializeSkillRegistry(context.gitRoot);
  }, [context.gitRoot]);

  // Process special syntax (shell commands, file references)
  // Create KodaXEvents for streaming updates
  const createStreamingEvents = useCallback((): import("@kodax/coding").KodaXEvents => ({
    onThinkingDelta: (text: string) => {
      // UI layer stores thinking content for display - UI 层存储 thinking 内容用于显示
      appendThinkingContent(text);
    },
    onThinkingEnd: (_thinking: string) => {
      stopThinking();
    },
    onTextDelta: (text: string) => {
      stopThinking();
      appendResponse(text);
    },
    onToolUseStart: (tool: { name: string; id: string }) => {
      setCurrentTool(tool.name);
    },
    onToolInputDelta: (_toolName: string, partialJson: string) => {
      appendToolInputChars(partialJson.length);
      appendToolInputContent(partialJson); // Issue 068 Phase 4: 追踪参数内容
    },
    onToolResult: () => {
      setCurrentTool(undefined);
    },
    onStreamEnd: () => {
      stopThinking();
      setCurrentTool(undefined);
    },
    onError: (error: Error) => {
      // Classify error to provide better user feedback
      const classification = classifyError(error);
      const categoryNames = ['Transient', 'Permanent', 'Tool Call ID', 'User Abort'];

      console.log(''); // Empty line for readability

      // 对于用户主动取消，静默返回，因为快捷键处理函数已经打印了 [Interrupted]
      if (classification.category === ErrorCategory.USER_ABORT) {
        return;
      }

      // Show error type and message
      const categoryName = categoryNames[classification.category] || 'Unknown';
      console.log(chalk.red(`❌ API Error (${categoryName}): ${error.message}`));

      // Show what's being done to recover
      if (classification.shouldCleanup) {
        console.log(chalk.cyan('   🧹 Cleaned incomplete tool calls'));
      }

      // Show next steps for user
      if (classification.category === ErrorCategory.PERMANENT) {
        console.log(chalk.yellow('   💡 This error requires manual intervention. Please check:'));
        if (error.message.includes('auth') || error.message.includes('401')) {
          console.log(chalk.yellow('      - Your API key is valid'));
          console.log(chalk.yellow('      - Run /config to check provider settings'));
        } else if (error.message.includes('400')) {
          console.log(chalk.yellow('      - The request parameters are correct'));
          console.log(chalk.yellow('      - Try restarting the conversation'));
        } else {
          console.log(chalk.yellow('      - The error details above'));
        }
      } else if (classification.category === ErrorCategory.TRANSIENT) {
        if (classification.retryable) {
          console.log(chalk.yellow(`   ⏳ Will automatically retry (up to ${classification.maxRetries} times)`));
        }
      } else if (classification.category === ErrorCategory.TOOL_CALL_ID) {
        console.log(chalk.green('   ✅ Session cleaned, ready to continue'));
      }

      console.log(''); // Empty line for readability
    },
    onRetry: (reason: string, attempt: number, maxAttempts: number) => {
      console.log(''); // Empty line for readability
      console.log(chalk.yellow(`⏳ ${reason}`));
      console.log(chalk.gray(`   Retry attempt ${attempt}/${maxAttempts}`));
      console.log(''); // Empty line for readability
    },
    onProviderRateLimit: (attempt: number, maxAttempts: number, delayMs: number) => {
      addHistoryItem({
        type: "info",
        icon: "⏳",
        text: `[Rate Limit] Retrying in ${delayMs / 1000}s (${attempt}/${maxAttempts})...`
      });
    },
    // Iteration start - called at the beginning of each agent iteration
    // 迭代开始 - 在每轮 agent 迭代开始时调用
    onIterationStart: (iter: number, maxIter: number) => {
      // Update max iterations if provided
      // 如果提供了最大迭代次数则更新
      if (maxIter) {
        setMaxIter(maxIter);
      }

      // Save current content to history and start fresh for new iteration
      // 保存当前内容到历史，开始新一轮
      // Fix: Always call startNewIteration to ensure currentIteration is properly set
      // 修复：始终调用 startNewIteration 以确保正确设置 currentIteration

      const prevThinking = iter > 1 ? getThinkingContent().trim() : "";
      const prevResponse = iter > 1 ? getFullResponse().trim() : "";

      // Always update iteration counter BEFORE adding to history 
      // This implicitly clears the text buffer so we don't double-render the old streaming 
      // content simultaneously with the new static HistoryItem!
      startNewIteration(iter);
      if (iter === 1) {
        startThinking();
      }

      if (iter > 1) {
        // Issue 076 fix: Save previous iteration content to persistent history BEFORE clearing
        // Issue 076 修复：在清空前将上一轮内容保存到持久历史记录

        // First, save thinking content (full content for history)
        // 首先保存 thinking 内容（完整内容用于历史记录）
        if (prevThinking) {
          addHistoryItem({
            type: "thinking",
            text: prevThinking,
          });
        }

        // Then, save response content
        // 然后保存响应内容
        if (prevResponse) {
          addHistoryItem({
            type: "assistant",
            text: prevResponse,
          });
        }
      }
    },
    // Permission hook - called before each tool execution
    // 权限钩子 - 在每个工具执行前调用
    beforeToolExecute: async (tool: string, input: Record<string, unknown>): Promise<boolean> => {
      const mode = currentConfig.permissionMode;
      const confirmTools = computeConfirmTools(mode);
      const alwaysAllowTools = alwaysAllowToolsRef.current;
      // Issue 052 fix: Read gitRoot from context prop, not options.context - Issue 052 修复：从 context prop 读取 gitRoot
      const gitRoot = context.gitRoot;

      // === 1. Plan mode: block modification tools ===
      // Block file modification tools and undo
      if (mode === 'plan' && (FILE_MODIFICATION_TOOLS.has(tool) || tool === 'undo')) {
        console.log(chalk.yellow(`[Blocked] Tool '${tool}' is not allowed in plan mode (read-only)`));
        return false;
      }

      // For bash in plan mode, only block write operations
      if (mode === 'plan' && tool === 'bash') {
        const command = (input.command as string) ?? '';
        if (isBashWriteCommand(command)) {
          console.log(chalk.yellow(`[Blocked] Bash write operation not allowed in plan mode: ${command.slice(0, 50)}...`));
          return false;
        }
        // Allow read-only bash commands
      }

      // === 2. Protected paths: always confirm ===
      // Issue 052: Check both file tools AND bash commands for protected paths
      if (gitRoot) {
        let isProtected = false;

        // Check file modification tools (write, edit)
        if (FILE_MODIFICATION_TOOLS.has(tool)) {
          const targetPath = input.path as string | undefined;
          if (targetPath && isAlwaysConfirmPath(targetPath, gitRoot)) {
            isProtected = true;
          }
        }

        // Check bash commands for protected paths in arguments
        if (tool === 'bash') {
          const command = input.command as string | undefined;
          if (command && isCommandOnProtectedPath(command, gitRoot)) {
            isProtected = true;
          }
        }

        if (isProtected) {
          const result = await showConfirmDialog(tool, { ...input, _alwaysConfirm: true });
          return result.confirmed;
        }
      }

      // === 3. Check if tool needs confirmation based on mode ===
      if (confirmTools.has(tool)) {
        // In accept-edits mode, check alwaysAllowTools for bash
        if (mode === 'accept-edits' && tool === 'bash') {
          if (isToolCallAllowed(tool, input, alwaysAllowTools)) {
            return true; // Auto-allowed
          }
        }

        // In plan mode, only explicitly safe read commands bypass the confirmation dialog.
        // Unknown or complex commands will still block for user confirmation.
        if (mode === 'plan' && tool === 'bash') {
          const command = (input.command as string) ?? '';
          if (isBashReadCommand(command)) {
            return true; // Auto-allowed for safe read-only exploration
          }
        }

        // Show confirmation dialog
        const result = await showConfirmDialog(tool, input);
        if (!result.confirmed) {
          // Issue 051 fix: Show cancellation feedback - Issue 051 修复：显示取消反馈
          console.log(chalk.yellow('[Cancelled] Operation cancelled by user'));
          return false;
        }

        // Handle "always" selection
        if (result.always) {
          if (mode === 'accept-edits') {
            saveAlwaysAllowToolPattern(tool, input, false);
            // Update ref for next tool calls in this session
            alwaysAllowToolsRef.current = loadAlwaysAllowTools();
          }
          if (mode === 'default') {
            // Switch to accept-edits mode
            const newMode: PermissionMode = 'accept-edits';
            setCurrentConfig((prev) => ({ ...prev, permissionMode: newMode }));
            permissionModeRef.current = newMode;
            savePermissionModeUser(newMode);
            console.log(chalk.dim(`\n[Permission mode switched to: ${newMode}]`));
          }
        }
      }

      return true;
    },
    // Issue 069: Ask user a question interactively - 交互式向用户提问
    askUser: async (options: import("@kodax/coding").AskUserQuestionOptions): Promise<string> => {
      // Display question and options
      console.log('');
      console.log(chalk.cyan('❓ ' + options.question));
      console.log('');

      options.options.forEach((opt, index) => {
        const num = (index + 1).toString().padStart(2, ' ');
        const desc = opt.description ? chalk.dim(` - ${opt.description}`) : '';
        console.log(`  ${chalk.yellow(num)}${chalk.bold('.')} ${opt.label}${desc}`);
      });

      console.log('');

      // Wait for user input using readline
      return new Promise((resolve) => {
        const readline = require('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const defaultHint = options.default ? ` (default: ${options.default})` : '';
        rl.question(chalk.dim(`Enter your choice [1-${options.options.length}]${defaultHint}: `), (answer: string) => {
          rl.close();

          // Handle default
          if (!answer.trim() && options.default) {
            resolve(options.default);
            return;
          }

          // Parse number
          const num = parseInt(answer.trim(), 10);
          if (num >= 1 && num <= options.options.length) {
            resolve(options.options[num - 1]!.value);
            return;
          }

          // Invalid input - return first option as fallback
          console.log(chalk.yellow(`Invalid choice. Using: ${options.options[0]!.label}`));
          resolve(options.options[0]!.value);
        });
      });
    },
    onCompactStart: () => {
      // Trigger the compacting UI indicator before actual compaction begins
      startCompacting();
    },
    // Compaction event - notification only, do NOT clear UI history here
    // 压缩事件 - 仅通知，不要在这里清理 UI 历史记录
    onCompact: (estimatedTokens: number) => {
      // Stop the indicator now that it's complete
      stopCompacting();

      // Auto-compaction happened during agent execution
      // Insert a minimal info message into the UI history
      const prevK = Math.round(estimatedTokens / 1000);
      addHistoryItem({
        type: "info",
        icon: "✨",
        text: `Context auto-compacted (was ~${prevK}k tokens)`,
      });
    },
    onCompactEnd: () => {
      // Just stop the indicator if compaction was skipped/aborted without changing the context
      stopCompacting();
    },
    // Iteration end - update live token count for real-time context usage display
    // 迭代结束 - 更新实时 token 计数用于上下文使用量显示
    onIterationEnd: (info: { iter: number; maxIter: number; tokenCount: number }) => {
      setLiveTokenCount(info.tokenCount);
    },
  }), [appendThinkingContent, stopThinking, appendResponse, setCurrentTool, appendToolInputChars, appendToolInputContent, startNewIteration, startThinking, currentConfig, context.gitRoot, startCompacting, stopCompacting]);

  // Helper function to show confirmation dialog
  // 显示确认对话框的辅助函数
  const showConfirmDialog = (tool: string, input: Record<string, unknown>): Promise<ConfirmResult> => {
    // Build confirmation prompt text - 构建确认提示文本
    let promptText: string;

    // Handle simple confirm dialog (used by project commands, etc.)
    // 处理简单确认对话框（用于 project 命令等）
    if (tool === "confirm" && input._message) {
      promptText = input._message as string;
    } else {
      const inputPreview = input.path
        ? ` ${input.path as string}`
        : input.command
          ? ` ${(input.command as string).slice(0, 60)}${(input.command as string).length > 60 ? '...' : ''}`
          : '';

      switch (tool) {
        case 'bash':
          promptText = `Execute bash command?${inputPreview}`;
          break;
        case 'write':
          promptText = `Write to file?${inputPreview}`;
          break;
        case 'edit':
          promptText = `Edit file?${inputPreview}`;
          break;
        default:
          promptText = `Execute ${tool}?`;
      }
    }

    // Return promise that resolves when user answers - 返回一个 Promise，当用户回答时 resolve
    return new Promise<ConfirmResult>((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmRequest({ tool, input, prompt: promptText });
    });
  };

  // Run agent round
  const runAgentRound = async (
    opts: KodaXOptions,
    prompt: string
  ): Promise<KodaXResult> => {
    const events = createStreamingEvents();

    // Get skills system prompt snippet for progressive disclosure (Issue 056)
    // 获取 skills 系统提示词片段用于渐进式披露
    // Issue 064: Pass projectRoot to prevent singleton reset
    const skillRegistry = getSkillRegistry(context.gitRoot);
    const skillsPrompt = skillRegistry.getSystemPromptSnippet();

    return runKodaX(
      {
        ...opts,
        session: {
          ...opts.session,
          initialMessages: context.messages,
        },
        context: {
          ...opts.context,
          skillsPrompt, // Inject skills into system prompt
        },
        events,
        abortSignal: getSignal(),
      },
      prompt
    );
  };

  // Handle user input submission
  const handleSubmit = useCallback(
    async (input: string) => {
      // Prevent concurrent execution: ignore input if agent is busy or waiting for tool confirmation
      // 防止并发执行：如果 Agent 正在执行或正在等待工具确认，则忽略新输入
      if (!input.trim() || !isRunning || isLoading || confirmRequest) return;

      // Banner remains visible - it will scroll up naturally as messages are added
      // (Removed showBanner toggle to keep layout stable)

      // Preserve interrupted streaming response before clearing
      // Use getFullResponse() to include buffered content not yet flushed to currentResponse
      // Issue: When user sends new message during streaming, partial content was lost
      const currentFullResponse = getFullResponse().trim();
      if (currentFullResponse) {
        addHistoryItem({
          type: "assistant",
          text: currentFullResponse + "\n\n[Interrupted]",
        });
      }

      // Add user message to UI history
      addHistoryItem({
        type: "user",
        text: input,
      });

      // Clear autocomplete suggestions space when message is sent
      // 发送消息时清除自动补全建议的预留空间
      setSubmitCounter(prev => prev + 1);

      setIsLoading(true);
      clearResponse();
      clearIterationHistory(); // Clear iteration history for new conversation - 清空迭代历史
      startStreaming();

      touchContext(context);

      // Wait for React to process the state update before continuing
      // This ensures user message is rendered before command output
      // 50ms is enough for React to batch and render state updates in Ink
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Process commands
      const parsed = parseCommand(input.trim());
      if (parsed) {
        // Create command callbacks
        const callbacks: CommandCallbacks = {
          exit: () => {
            setIsRunning(false);
            onExit();
            exit();
          },
          saveSession: async () => {
            if (context.messages.length > 0) {
              const title = extractTitle(context.messages);
              context.title = title;
              await storage.save(context.sessionId, {
                messages: context.messages,
                title,
                gitRoot: context.gitRoot ?? "",
              });
            }
          },
          loadSession: async (id: string) => {
            const loaded = await storage.load(id);
            if (loaded) {
              context.messages = loaded.messages;
              context.title = loaded.title;
              context.sessionId = id;
              console.log(chalk.green(`[Session loaded: ${id}]`));
              return true;
            }
            return false;
          },
          listSessions: async () => {
            const sessions = await storage.list();
            if (sessions.length === 0) {
              console.log(chalk.dim("\n[No saved sessions]"));
              return;
            }
            console.log(chalk.bold("\nRecent Sessions:\n"));
            for (const s of sessions.slice(0, 10)) {
              console.log(
                `  ${chalk.cyan(s.id)} ${chalk.dim(`(${s.msgCount} messages)`)} ${s.title.slice(0, 40)}`
              );
            }
            console.log();
          },
          clearHistory: () => {
            // Only clear UI history, not context.messages
            // context.messages should only be cleared by specific commands like /clear
            clearUIHistory();
          },
          printHistory: () => {
            if (context.messages.length === 0) {
              console.log(chalk.dim("\n[No conversation history]"));
              return;
            }
            console.log(chalk.bold("\nConversation History:\n"));
            const recent = context.messages.slice(-20);
            for (let i = 0; i < recent.length; i++) {
              const m = recent[i]!;
              const role = chalk.cyan(m.role.padEnd(10));
              const content = extractTextContent(m.content);
              const preview = content.slice(0, 60).replace(/\n/g, " ");
              const ellipsis = content.length > 60 ? "..." : "";
              console.log(
                `  ${(i + 1).toString().padStart(2)}. ${role} ${preview}${ellipsis}`
              );
            }
            console.log();
          },
          switchProvider: (provider: string) => {
            setCurrentConfig((prev) => ({ ...prev, provider }));
            currentOptionsRef.current.provider = provider;
          },
          setThinking: (enabled: boolean) => {
            setCurrentConfig((prev) => ({ ...prev, thinking: enabled }));
            currentOptionsRef.current.thinking = enabled;
          },
          setPermissionMode: (mode: PermissionMode) => {
            setCurrentConfig((prev) => ({ ...prev, permissionMode: mode }));
            permissionModeRef.current = mode;
          },
          deleteSession: async (id: string) => {
            await storage.delete?.(id);
          },
          deleteAllSessions: async () => {
            await storage.deleteAll?.();
          },
          setPlanMode: (enabled: boolean) => {
            setPlanMode(enabled);
          },
          createKodaXOptions: () => ({
            ...currentOptionsRef.current,
            provider: currentConfig.provider,
            thinking: currentConfig.thinking,
            events: createStreamingEvents(), // Include streaming events for /project commands
          }),
          // Start/stop compacting indicator - 开始/停止压缩指示器
          startCompacting: () => {
            startCompacting();
          },
          stopCompacting: () => {
            stopCompacting();
          },
          // Confirm dialog callback for interactive commands - 交互式命令的确认对话框回调
          confirm: async (message: string): Promise<boolean> => {
            const result = await showConfirmDialog("confirm", {
              _alwaysConfirm: true,
              _message: message,
            });
            return result.confirmed;
          },
          readline: null as unknown as ReturnType<
            typeof import("readline").createInterface
          >,
        };

        // Capture console.log output to add to history instead of
        // letting Ink render it in the wrong position
        const capturedOutput: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => {
          const output = args.map(arg =>
            typeof arg === 'string' ? arg : String(arg)
          ).join(' ');
          capturedOutput.push(output);
        };

        let skillContentToInject: string | undefined = undefined;
        let projectInitPromptToInject: string | undefined = undefined;

        try {
          const result = await executeCommand(parsed, context, callbacks, currentConfig);

          // Check if result contains skill content to inject
          if (typeof result === 'object' && result !== null && 'skillContent' in result) {
            skillContentToInject = result.skillContent;
          }
          // Check if result contains project init prompt to inject
          if (typeof result === 'object' && result !== null && 'projectInitPrompt' in result) {
            projectInitPromptToInject = result.projectInitPrompt;
          }
        } finally {
          console.log = originalLog;
        }

        // Add captured command output to history as info item
        if (capturedOutput.length > 0) {
          addHistoryItem({
            type: "info",
            text: capturedOutput.join('\n'),
          });
        }

        // If skill was invoked, inject its content and run agent
        if (skillContentToInject) {
          setIsLoading(false);
          stopStreaming();

          // Create enhanced prompt with skill content
          const enhancedPrompt = `${skillContentToInject}\n\nUser request: ${input.trim()}`;

          // Re-start streaming for skill execution
          setIsLoading(true);
          startStreaming();
          startThinking();

          try {
            const result = await runAgentRound(currentOptionsRef.current, enhancedPrompt);

            // Update context
            context.messages = result.messages;

            // Add assistant response to UI history
            const lastAssistant = result.messages[result.messages.length - 1];
            if (lastAssistant?.role === "assistant") {
              const content = extractTextContent(lastAssistant.content);
              if (content) {
                addHistoryItem({
                  type: "assistant",
                  text: content,
                });
              }
            }

            // Auto-save
            if (context.messages.length > 0) {
              const title = extractTitle(context.messages);
              context.title = title;
              await storage.save(context.sessionId, {
                messages: context.messages,
                title,
                gitRoot: context.gitRoot ?? "",
              });
            }
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));

            // Check if this is an abort error (user pressed Ctrl+C)
            const isAbortError = error.name === 'AbortError' ||
              error.message.includes('aborted') ||
              error.message.includes('ABORTED');

            console.log = originalLog;

            if (isAbortError) {
              // Save any unsaved streaming content
              const unsavedResponse = getFullResponse().trim();
              if (unsavedResponse) {
                addHistoryItem({
                  type: "assistant",
                  text: unsavedResponse + "\n\n[Interrupted]",
                });
              }
            } else {
              console.log(chalk.red(error.message));
              addHistoryItem({
                type: "error",
                text: error.message,
              });
            }
          } finally {
            setIsLoading(false);
            stopStreaming();
            clearThinkingContent();
          }

          return;
        }

        // If project init was invoked, run agent with init prompt
        if (projectInitPromptToInject) {
          setIsLoading(false);
          stopStreaming();

          // Re-start streaming for project init execution
          setIsLoading(true);
          startStreaming();
          startThinking();

          try {
            const result = await runAgentRound(currentOptionsRef.current, projectInitPromptToInject);

            // Update context
            context.messages = result.messages;

            // Add assistant response to UI history
            const lastAssistant = result.messages[result.messages.length - 1];
            if (lastAssistant?.role === "assistant") {
              const content = extractTextContent(lastAssistant.content);
              if (content) {
                addHistoryItem({
                  type: "assistant",
                  text: content,
                });
              }
            }

            // Auto-save
            if (context.messages.length > 0) {
              const title = extractTitle(context.messages);
              context.title = title;
              await storage.save(context.sessionId, {
                messages: context.messages,
                title,
                gitRoot: context.gitRoot ?? "",
              });
            }
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));

            // Check if this is an abort error (user pressed Ctrl+C)
            const isAbortError = error.name === 'AbortError' ||
              error.message.includes('aborted') ||
              error.message.includes('ABORTED');

            console.log = originalLog;

            if (isAbortError) {
              // Save any unsaved streaming content
              const unsavedResponse = getFullResponse().trim();
              if (unsavedResponse) {
                addHistoryItem({
                  type: "assistant",
                  text: unsavedResponse + "\n\n[Interrupted]",
                });
              }
            } else {
              console.log(chalk.red(error.message));
              addHistoryItem({
                type: "error",
                text: error.message,
              });
            }
          } finally {
            setIsLoading(false);
            stopStreaming();
            clearResponse();
            clearThinkingContent();
          }

          return;
        }

        setIsLoading(false);
        stopStreaming();
        return;
      }

      // Process special syntax
      const processed = await processSpecialSyntax(input.trim());

      // Skip if shell command was executed successfully
      if (
        input.trim().startsWith("!") &&
        (processed.startsWith("[Shell command executed:") ||
          processed.startsWith("[Shell:"))
      ) {
        setIsLoading(false);
        stopStreaming();
        return;
      }

      // Note: Do NOT push user message to context.messages here!
      // runKodaX (agent.ts:76) will add the prompt to messages automatically.
      // If we push here, the message gets duplicated (Issue 046).

      // Run with plan mode if enabled
      if (planMode) {
        try {
          await runWithPlanMode(processed, {
            ...currentOptionsRef.current,
            provider: currentConfig.provider,
            thinking: currentConfig.thinking,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));

          // Check if this is an abort error (user pressed Ctrl+C)
          const isAbortError = error.name === 'AbortError' ||
            error.message.includes('aborted') ||
            error.message.includes('ABORTED');

          if (isAbortError) {
            // Save any unsaved streaming content
            const unsavedResponse = getFullResponse().trim();
            if (unsavedResponse) {
              addHistoryItem({
                type: "assistant",
                text: unsavedResponse + "\n\n[Interrupted]",
              });
            }
          } else {
            console.log(chalk.red(`[Plan Mode Error] ${error.message}`));
            addHistoryItem({
              type: "error",
              text: error.message,
            });
          }
        }
        setIsLoading(false);
        stopStreaming();
        return;
      }

      // Run agent
      // Start thinking indicator - will be updated by onThinkingDelta with char count
      startThinking();

      // Capture console.log output to add to history instead of
      // letting Ink render it in the wrong position (Issue 045)
      const capturedOutput: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        const output = args.map(arg =>
          typeof arg === 'string' ? arg : String(arg)
        ).join(' ');
        capturedOutput.push(output);
      };

      try {
        const result = await runAgentRound(currentOptionsRef.current, processed);

        // Update context
        context.messages = result.messages;

        // Issue 076 fix: Save final iteration content to persistent history
        // This handles the case where the last iteration didn't trigger onIterationStart
        // Issue 076 修复：将最后一轮内容保存到持久历史记录
        // 这处理了最后一轮没有触发 onIterationStart 的情况
        const finalThinking = getThinkingContent().trim();
        const finalResponse = getFullResponse().trim();

        // Clear UI streaming state immediately so it doesn't render alongside the new history item
        clearThinkingContent();
        clearResponse();

        if (finalThinking) {
          addHistoryItem({
            type: "thinking",
            text: finalThinking,
          });
        }

        if (finalResponse) {
          addHistoryItem({
            type: "assistant",
            text: finalResponse,
          });
        }


        // Auto-save
        if (context.messages.length > 0) {
          const title = extractTitle(context.messages);
          context.title = title;
          await storage.save(context.sessionId, {
            messages: context.messages,
            title,
            gitRoot: context.gitRoot ?? "",
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        // Check if this is an abort error (user pressed Ctrl+C)
        // Abort errors should not be added to history - the Ctrl+C handler already saved the partial response
        const isAbortError = error.name === 'AbortError' ||
          error.message.includes('aborted') ||
          error.message.includes('ABORTED');

        if (isAbortError) {
          // Don't add abort error to history - already handled by Ctrl+C handler
          console.log = originalLog;
          // Still need to save any unsaved streaming content
          // Issue 076: Also save thinking content before it's cleared
          const unsavedThinking = getThinkingContent().trim();
          if (unsavedThinking) {
            addHistoryItem({
              type: "thinking",
              text: unsavedThinking,
            });
          }
          const unsavedResponse = getFullResponse().trim();
          if (unsavedResponse) {
            addHistoryItem({
              type: "assistant",
              text: unsavedResponse + "\n\n[Interrupted]",
            });
          }
        } else {
          // Note: No need to pop from context.messages here anymore.
          // Since we removed the pre-push (Issue 046 fix), context.messages
          // doesn't contain the new user message when runKodaX fails.

          let errorContent = error.message;
          if (
            error.message.includes("rate limit") ||
            error.message.includes("Rate limit")
          ) {
            errorContent = `[Rate Limit] ${error.message}\nSuggestion: Wait a moment and try again, or switch provider with /mode`;
          } else if (
            error.message.includes("API key") ||
            error.message.includes("not configured")
          ) {
            errorContent = `[Configuration Error] ${error.message}\nSuggestion: Set the required API key environment variable`;
          } else if (
            error.message.includes("network") ||
            error.message.includes("ECONNREFUSED") ||
            error.message.includes("ETIMEDOUT")
          ) {
            errorContent = `[Network Error] ${error.message}\nSuggestion: Check your internet connection`;
          } else if (
            error.message.includes("token") ||
            error.message.includes("context too long")
          ) {
            errorContent = `[Context Error] ${error.message}\nSuggestion: Use /clear to start fresh`;
          }

          console.log = originalLog;
          console.log(chalk.red(errorContent));

          // Add error to UI history
          addHistoryItem({
            type: "error",
            text: errorContent,
          });
        }
      } finally {
        // Restore console.log
        console.log = originalLog;

        // Add captured console output to history as info items
        if (capturedOutput.length > 0) {
          // Deduplicate identical captured log lines
          const uniqueOutput = capturedOutput.filter((item, pos, self) => {
            return self.indexOf(item) === pos;
          });

          addHistoryItem({
            type: "info",
            text: uniqueOutput.join('\n'),
          });
        }

        setIsLoading(false);
        stopStreaming();
        clearResponse(); // Fix: clear stale buffer to prevent ghost [Interrupted] on next submit
        clearThinkingContent();
        setLiveTokenCount(null); // Reset live token count, use context.messages for final calculation
      }
    },
    [
      isRunning,
      context,
      currentConfig,
      planMode,
      storage,
      exit,
      onExit,
      addHistoryItem,
      clearUIHistory,
      startStreaming,
      stopStreaming,
      clearResponse,
      createStreamingEvents,
      getSignal,
      getFullResponse,
      startCompacting,
      stopCompacting,
    ]
  );

  return (
    <Box flexDirection="column" width={terminalWidth} flexShrink={0} flexGrow={0}>
      {/* Banner - shown once at start, using Static to prevent re-rendering */}
      {showBanner && (
        <Static items={[1]}>
          {() => (
            <Banner
              key="banner"
              config={currentConfig}
              sessionId={context.sessionId}
              workingDir={options.context?.gitRoot || process.cwd()}
              compactionInfo={compactionInfo ?? undefined}
            />
          )}
        </Static>
      )}

      {/* Message History - flexGrow to fill remaining space */}
      {/* 消息历史 - 使用 flexGrow 填充剩余空间 */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {history.length > 0 && (
          <Box flexDirection="column">
            <MessageList
              items={renderHistory}
              isLoading={isLoading}
              isThinking={streamingState.isThinking}
              thinkingCharCount={streamingState.thinkingCharCount}
              thinkingContent={streamingState.thinkingContent}
              streamingResponse={streamingState.currentResponse}
              currentTool={streamingState.currentTool}
              toolInputCharCount={streamingState.toolInputCharCount}
              toolInputContent={streamingState.toolInputContent}
              iterationHistory={streamingState.iterationHistory}
              currentIteration={streamingState.currentIteration}
              isCompacting={streamingState.isCompacting}
            />
          </Box>
        )}

        {/* Loading/Thinking Indicator */}
        {isLoading && history.length === 0 && (
          <Box>
            <ThinkingIndicator message="Thinking" showSpinner />
          </Box>
        )}
      </Box>

      {/* Fixed bottom section: Input + Suggestions + Status */}
      {/* 固定底部区域: 输入 + 建议 + 状态 */}
      <Box flexDirection="column" flexShrink={0}>
        {/* Input Area - always at fixed position */}
        {/* 输入区域 - 始终在固定位置 */}
        <Box>
          <InputPrompt
            onSubmit={handleSubmit}
            prompt=">"
            focus={!isLoading}
            cwd={process.cwd()}
            gitRoot={options.context?.gitRoot || context.gitRoot}
          />
        </Box>

        {/* Autocomplete Suggestions - fixed 8-line container, expands downward */}
        {/* 自动补全建议 - 固定8行容器，向下扩展 */}
        <AutocompleteSuggestions submitCounter={submitCounter} />

        {/* Status Bar */}
        <Box>
          <StatusBar
            sessionId={context.sessionId}
            permissionMode={currentConfig.permissionMode}
            provider={currentConfig.provider}
            model={getProviderModel(currentConfig.provider) ?? currentConfig.provider}
            currentTool={streamingState.currentTool}
            thinking={currentConfig.thinking}
            thinkingCharCount={streamingState.thinkingCharCount}
            toolInputCharCount={streamingState.toolInputCharCount}
            toolInputContent={streamingState.toolInputContent}
            currentIteration={streamingState.currentIteration}
            maxIter={streamingState.maxIter}
            contextUsage={contextUsage}
            isCompacting={streamingState.isCompacting}
          />
        </Box>

        {/* Confirmation Dialog - 确认对话框 */}
        {confirmRequest && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="yellow"
            paddingX={1}
            marginTop={1}
          >
            <Text color="yellow" bold>
              [Confirm] {confirmRequest.prompt}
            </Text>
            {/* Don't show "always" option for protected paths - 永久保护路径不显示 "always" 选项 */}
            {confirmRequest.input._alwaysConfirm ? (
              <Text dimColor>
                Press (y) to confirm, (n) to cancel (protected path)
              </Text>
            ) : (
              <Text dimColor>
                Press (y) yes, (a) always yes for this tool, (n) no
              </Text>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
};

/**
 * InkREPL Component - Main REPL interface using Ink
 * Wrapped with context providers
 *
 * KeypressProvider provides centralized keyboard handling.
 * InputPrompt uses useKeypress from this context.
 * AutocompleteContextProvider shares autocomplete state between InputPrompt and InkREPL.
 */
const InkREPL: React.FC<InkREPLProps> = (props) => {
  const cwd = process.cwd();
  const gitRoot = props.options?.context?.gitRoot ?? undefined;

  return (
    <UIStateProvider>
      <StreamingProvider>
        <KeypressProvider>
          <AutocompleteContextProvider cwd={cwd} gitRoot={gitRoot}>
            <InkREPLInner {...props} />
          </AutocompleteContextProvider>
        </KeypressProvider>
      </StreamingProvider>
    </UIStateProvider>
  );
};

/**
 * Check if raw mode is supported (required for Ink)
 */
function isRawModeSupported(): boolean {
  return process.stdin.isTTY === true && typeof process.stdin.setRawMode === "function";
}

/**
 * Run Ink-based interactive mode
 */
export async function runInkInteractiveMode(options: InkREPLOptions): Promise<void> {
  // Check if raw mode is supported
  if (!isRawModeSupported()) {
    throw new KodaXTerminalError(
      "Interactive mode requires a TTY with raw mode support.",
      [
        "kodax -p \"your task\"    # Run a single task",
        "kodax -c               # Continue last session",
        "kodax -r               # Resume session",
      ]
    );
  }

  const storage = options.storage ?? new MemorySessionStorage();

  // Load config
  const { loadConfig, getGitRoot } = await import("../common/utils.js");
  const { loadCompactionConfig } = await import("../common/compaction-config.js");
  const { getProvider } = await import("@kodax/coding");

  const config = loadConfig();
  const initialProvider = options.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
  const initialThinking = options.thinking ?? config.thinking ?? false;
  // Load permission mode from config file (not from CLI options)
  // CLI is always YOLO mode; REPL uses config file for permission mode
  const initialPermissionMode: PermissionMode =
    (config.permissionMode as PermissionMode | undefined) ?? 'default';

  const currentConfig: CurrentConfig = {
    provider: initialProvider,
    thinking: initialThinking,
    permissionMode: initialPermissionMode,
  };

  // Handle session resume/load
  let sessionId = options.session?.id;
  let existingMessages: KodaXMessage[] = [];
  let sessionTitle = "";
  const gitRoot = (await getGitRoot().catch(() => null)) ?? undefined;

  // Load compaction config before rendering so the <Static> banner has it immediately
  let compactionInfo: { contextWindow: number; triggerPercent: number; enabled: boolean } | undefined;
  try {
    const compConfig = await loadCompactionConfig(gitRoot);
    const providerInstance = getProvider(initialProvider);
    const effectiveContextWindow = compConfig.contextWindow
      ?? providerInstance.getContextWindow?.()
      ?? 200000;

    compactionInfo = {
      contextWindow: effectiveContextWindow,
      triggerPercent: compConfig.triggerPercent,
      enabled: compConfig.enabled,
    };
  } catch {
    // Silently ignore configuration loading errors for banner
  }

  // -r <id>: Load specific session
  if (options.session?.id && !options.session.resume) {
    const loaded = await storage.load(options.session.id);
    if (loaded) {
      existingMessages = loaded.messages;
      sessionTitle = loaded.title;
      sessionId = options.session.id;
      console.log(chalk.green(`[Session loaded: ${options.session.id}]`));
    }
  }
  // -c or autoResume: Load most recent session
  else if (options.session?.resume || options.session?.autoResume) {
    const sessions = await storage.list(gitRoot);
    if (sessions.length > 0) {
      const recentSession = sessions[0];
      if (recentSession) {
        const loaded = await storage.load(recentSession.id);
        if (loaded) {
          existingMessages = loaded.messages;
          sessionTitle = loaded.title;
          sessionId = recentSession.id;
          console.log(chalk.green(`[Continuing session: ${recentSession.id}]`));
        }
      }
    }
  }

  // Create context with loaded session
  const context = await createInteractiveContext({
    sessionId,
    gitRoot,
    existingMessages,
  });
  context.title = sessionTitle;

  // Note: Banner is now shown inside Ink component (Banner.tsx)
  // This ensures it's visible in the alternate buffer

  try {
    // Render Ink app
    // Issue 058/060: Ink 6.x options to reduce flickering
    const { waitUntilExit } = render(
      <InkREPL
        options={options}
        config={currentConfig}
        context={context}
        storage={storage}
        compactionInfo={compactionInfo}
        onExit={() => {
          console.log(chalk.dim("\n[Exiting KodaX...]"));
        }}
      />,
      {
        stdout: process.stdout,
        stdin: process.stdin,
        exitOnCtrlC: false,
        patchConsole: true,  // Route console.log through Ink so command output is visible
        // Note: incrementalRendering disabled - causes cursor positioning issues with custom TextInput
        // Ink 6.x still has synchronized updates (auto-enabled) which helps reduce flickering
        maxFps: 30,          // Ink 6.3.0+: Limit frame rate to reduce flickering
      }
    );

    // Wait for exit
    await waitUntilExit();
  } catch (error) {
    // If Ink fails due to raw mode, throw terminal error
    if (error instanceof Error && error.message.includes("Raw mode")) {
      throw new KodaXTerminalError(
        "Interactive mode failed to start.",
        [
          "kodax -p \"your task\"    # Run a single task",
          "kodax -c               # Continue last session",
        ]
      );
    } else {
      throw error;
    }
  }
}
