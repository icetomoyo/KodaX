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

import React, { useState, useCallback, useRef, useEffect } from "react";
import { render, Box, useApp, Text, Static, useInput } from "ink";
import { InputPrompt } from "./components/InputPrompt.js";
import { MessageList } from "./components/MessageList.js";
import { ThinkingIndicator } from "./components/LoadingIndicator.js";
import { StatusBar } from "./components/StatusBar.js";
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
import { StreamingState, type HistoryItem, KeypressHandlerPriority } from "./types.js";
import {
  KodaXOptions,
  KodaXMessage,
  KodaXResult,
  runKodaX,
  KODAX_DEFAULT_PROVIDER,
  KodaXTerminalError,
  PermissionMode,
} from "@kodax/core";
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
  onExit: () => void;
}

// Banner Props
interface BannerProps {
  config: CurrentConfig;
  sessionId: string;
  workingDir: string;
}

/**
 * Banner component - displayed inside Ink UI so it's part of the alternate buffer
 */
const Banner: React.FC<BannerProps> = ({ config, sessionId, workingDir }) => {
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
 * Inner REPL component that uses contexts
 */
const InkREPLInner: React.FC<InkREPLProps> = ({
  options,
  config,
  context,
  storage,
  onExit,
}) => {
  const { exit } = useApp();
  const { history } = useUIState();
  const { addHistoryItem, clearHistory: clearUIHistory } = useUIActions();
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
    clearResponse,
    appendResponse,
    getSignal,
  } = useStreamingActions();

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [currentConfig, setCurrentConfig] = useState<CurrentConfig>(config);
  const [planMode, setPlanMode] = useState(false);
  const [isRunning, setIsRunning] = useState(true);
  const [showBanner, setShowBanner] = useState(true); // Show banner in Ink UI

  // Confirmation dialog state - 确认对话框状态
  const [confirmRequest, setConfirmRequest] = useState<{
    tool: string;
    input: Record<string, unknown>;
    prompt: string;
  } | null>(null);
  const confirmResolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  // Refs for callbacks
  const currentOptionsRef = useRef<InkREPLOptions>({
    ...options,
    permissionMode: currentConfig.permissionMode,
    session: {
      ...options.session,
      id: context.sessionId,
    },
  });

  // Global interrupt handler - using Gemini CLI style isActive pattern - 全局中断处理器 - 使用 Gemini CLI 风格的 isActive 模式
  // Only subscribe during streaming to ensure keyboard events are captured correctly - 只在 streaming 期间订阅，确保键盘事件能被正确捕获
  // Reference: Gemini CLI useGeminiStream.ts useKeypress usage - 参考: Gemini CLI useGeminiStream.ts 中的 useKeypress 使用方式
  useKeypress(
    (key) => {
      // Ctrl+C or ESC interrupts current operation - Ctrl+C 或 ESC 中断当前操作
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        // Use abort() instead of stopStreaming() to truly abort API request - 使用 abort() 而不是 stopStreaming() 来真正中止 API 请求
        abort();
        stopThinking();
        clearThinkingContent();
        setCurrentTool(undefined);
        setIsLoading(false);
        console.log(chalk.yellow("\n[Interrupted]"));
        return true;
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
      if (answer === 'y' || answer === 'yes') {
        setConfirmRequest(null);
        confirmResolveRef.current?.(true);
        confirmResolveRef.current = null;
      } else if (answer === 'n' || answer === 'no') {
        setConfirmRequest(null);
        confirmResolveRef.current?.(false);
        confirmResolveRef.current = null;
      }
    },
    { isActive: !!confirmRequest }
  );

  // Sync history from context to UI on mount
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
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount

  // Process special syntax (shell commands, file references)
  // Create KodaXEvents for streaming updates
  const createStreamingEvents = useCallback((): import("@kodax/core").KodaXEvents => ({
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
    },
    onToolResult: () => {
      setCurrentTool(undefined);
    },
    onStreamEnd: () => {
      stopThinking();
      setCurrentTool(undefined);
    },
    onError: (error: Error) => {
      console.log(chalk.red(`[Stream Error] ${error.message}`));
    },
    onConfirm: async (tool: string, input: Record<string, unknown>) => {
      // Build confirmation prompt text - 构建确认提示文本
      const inputPreview = input.path
        ? ` ${input.path as string}`
        : input.command
          ? ` ${(input.command as string).slice(0, 60)}${(input.command as string).length > 60 ? '...' : ''}`
          : '';

      let promptText: string;
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

      // Return promise that resolves when user answers - 返回一个 Promise，当用户回答时 resolve
      return new Promise<boolean>((resolve) => {
        confirmResolveRef.current = resolve;
        setConfirmRequest({ tool, input, prompt: promptText });
      });
    },
  }), [appendThinkingContent, stopThinking, appendResponse, setCurrentTool, appendToolInputChars, confirmRequest]);

  // Run agent round
  const runAgentRound = async (
    opts: KodaXOptions,
    prompt: string
  ): Promise<KodaXResult> => {
    const events = createStreamingEvents();
    return runKodaX(
      {
        ...opts,
        session: {
          ...opts.session,
          initialMessages: context.messages,
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
      if (!input.trim() || !isRunning) return;

      // Banner remains visible - it will scroll up naturally as messages are added
      // (Removed showBanner toggle to keep layout stable)

      // Add user message to UI history
      addHistoryItem({
        type: "user",
        text: input,
      });

      setIsLoading(true);
      clearResponse();
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
            context.messages = [];
            clearUIHistory();
            console.log(chalk.dim("[Conversation cleared]"));
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
            currentOptionsRef.current.permissionMode = mode;
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
            permissionMode: currentConfig.permissionMode,
          }),
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

        try {
          await executeCommand(parsed, context, callbacks, currentConfig);
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

      // Sync options permissionMode
      currentOptionsRef.current.permissionMode = currentConfig.permissionMode;

      // Run with plan mode if enabled
      if (planMode) {
        try {
          await runWithPlanMode(processed, {
            ...currentOptionsRef.current,
            provider: currentConfig.provider,
            thinking: currentConfig.thinking,
            permissionMode: currentConfig.permissionMode,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.log(chalk.red(`[Plan Mode Error] ${error.message}`));
          addHistoryItem({
            type: "error",
            text: error.message,
          });
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

        // Add assistant response to UI history
        const lastAssistant = result.messages[result.messages.length - 1];
        if (lastAssistant?.role === "assistant") {
          const content = extractTextContent(lastAssistant.content);
          // Only add if there's actual content to display
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
      } finally {
        // Restore console.log
        console.log = originalLog;

        // Add captured console output to history as info items
        if (capturedOutput.length > 0) {
          addHistoryItem({
            type: "info",
            text: capturedOutput.join('\n'),
          });
        }

        setIsLoading(false);
        stopStreaming();
        clearThinkingContent();
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
    ]
  );

  return (
    <Box flexDirection="column">
      {/* Banner - shown once at start, using Static to prevent re-rendering */}
      {showBanner && (
        <Static items={[1]}>
          {() => (
            <Banner
              key="banner"
              config={currentConfig}
              sessionId={context.sessionId}
              workingDir={options.context?.gitRoot || process.cwd()}
            />
          )}
        </Static>
      )}

      {/* Message History */}
      {history.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <MessageList
            items={history}
            isLoading={isLoading}
            isThinking={streamingState.isThinking}
            thinkingCharCount={streamingState.thinkingCharCount}
            thinkingContent={streamingState.thinkingContent}
            streamingResponse={streamingState.currentResponse}
            currentTool={streamingState.currentTool}
            toolInputCharCount={streamingState.toolInputCharCount}
          />
        </Box>
      )}

      {/* Loading/Thinking Indicator */}
      {isLoading && history.length === 0 && (
        <Box marginBottom={1}>
          <ThinkingIndicator message="Thinking" showSpinner />
        </Box>
      )}

      {/* Input Area */}
      <Box flexShrink={0}>
        <InputPrompt
          onSubmit={handleSubmit}
          prompt=">"
          focus={!isLoading}
        />
      </Box>

      {/* Status Bar */}
      <Box flexShrink={0} marginTop={1}>
        <StatusBar
          sessionId={context.sessionId}
          permissionMode={currentConfig.permissionMode}
          provider={currentConfig.provider}
          model={getProviderModel(currentConfig.provider) ?? currentConfig.provider}
          currentTool={streamingState.currentTool}
          thinking={currentConfig.thinking}
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
          <Text dimColor>
            Press (y) to confirm, (n) to cancel
          </Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * InkREPL Component - Main REPL interface using Ink
 * Wrapped with context providers
 *
 * KeypressProvider provides centralized keyboard handling.
 * InputPrompt uses useKeypress from this context.
 */
const InkREPL: React.FC<InkREPLProps> = (props) => {
  return (
    <UIStateProvider>
      <StreamingProvider>
        <KeypressProvider>
          <InkREPLInner {...props} />
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
  const config = loadConfig();
  const initialProvider = options.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
  const initialThinking = options.thinking ?? config.thinking ?? false;
  const initialPermissionMode: PermissionMode =
    options.permissionMode ?? (config.permissionMode as PermissionMode | undefined) ?? 'default';

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
    const { waitUntilExit } = render(
      <InkREPL
        options={options}
        config={currentConfig}
        context={context}
        storage={storage}
        onExit={() => {
          console.log(chalk.dim("\n[Exiting KodaX...]"));
        }}
      />,
      {
        stdout: process.stdout,
        stdin: process.stdin,
        exitOnCtrlC: false,
        patchConsole: true,  // Route console.log through Ink so command output is visible
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
