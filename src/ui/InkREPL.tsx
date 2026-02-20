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
import { render, Box, useApp, Text } from "ink";
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
} from "./contexts/index.js";
import { StreamingState, type HistoryItem } from "./types.js";
import {
  KodaXOptions,
  KodaXMessage,
  KodaXResult,
  runKodaX,
  KODAX_DEFAULT_PROVIDER,
  KodaXTerminalError,
} from "../core/index.js";
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
import { getProviderModel } from "../cli/utils.js";
import { KODAX_VERSION } from "../cli/utils.js";
import { runWithPlanMode } from "../cli/plan-mode.js";
import { getTheme } from "./themes/index.js";
import chalk from "chalk";
import * as childProcess from "child_process";
import * as util from "util";

const execAsync = util.promisify(childProcess.exec);

// === Helper Functions ===

/**
 * Extract text content from a message (handles both string and array content)
 */
function extractTextContent(content: string | unknown[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    // Extract text from text blocks
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
        textParts.push(String(block.text));
      }
    }
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }
  return "[Complex content]";
}

// Extended session storage interface
interface SessionStorage {
  save(
    id: string,
    data: { messages: KodaXMessage[]; title: string; gitRoot: string }
  ): Promise<void>;
  load(
    id: string
  ): Promise<{ messages: KodaXMessage[]; title: string; gitRoot: string } | null>;
  list(
    gitRoot?: string
  ): Promise<Array<{ id: string; title: string; msgCount: number }>>;
  delete?(id: string): Promise<void>;
  deleteAll?(): Promise<void>;
}

// Simple in-memory session storage
class MemorySessionStorage implements SessionStorage {
  private sessions = new Map<
    string,
    { messages: KodaXMessage[]; title: string; gitRoot: string }
  >();

  async save(
    id: string,
    data: { messages: KodaXMessage[]; title: string; gitRoot: string }
  ): Promise<void> {
    this.sessions.set(id, data);
  }

  async load(
    id: string
  ): Promise<{ messages: KodaXMessage[]; title: string; gitRoot: string } | null> {
    return this.sessions.get(id) ?? null;
  }

  async list(
    _gitRoot?: string
  ): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    return Array.from(this.sessions.entries()).map(([id, data]) => ({
      id,
      title: data.title,
      msgCount: data.messages.length,
    }));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteAll(): Promise<void> {
    this.sessions.clear();
  }
}

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
          {config.mode}
        </Text>
        {config.thinking && (
          <Text color={theme.colors.warning}>
            {" +think"}
          </Text>
        )}
        {config.auto && (
          <Text color="magenta">
            {" +auto"}
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
    startThinking,
    appendThinkingChars,
    appendThinkingContent,
    stopThinking,
    setCurrentTool,
    appendToolInputChars,
    clearResponse,
    appendResponse,
  } = useStreamingActions();

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [currentConfig, setCurrentConfig] = useState<CurrentConfig>(config);
  const [planMode, setPlanMode] = useState(false);
  const [isRunning, setIsRunning] = useState(true);
  const [showBanner, setShowBanner] = useState(true); // Show banner in Ink UI

  // Refs for callbacks
  const currentOptionsRef = useRef<InkREPLOptions>({
    ...options,
    mode: currentConfig.mode,
    session: {
      ...options.session,
      id: context.sessionId,
    },
  });

  // Sync history from context to UI on mount
  useEffect(() => {
    if (context.messages.length > 0) {
      // Convert legacy messages to history items
      for (const msg of context.messages) {
        const content = extractTextContent(msg.content);
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
  const processSpecialSyntax = async (input: string): Promise<string> => {
    // !command syntax: execute shell command
    if (input.startsWith("!")) {
      const command = input.slice(1).trim();
      if (!command) {
        return "[Shell: No command provided]";
      }

      try {
        console.log(chalk.dim(`\n[Executing: ${command}]`));
        const { stdout: cmdStdout, stderr } = await execAsync(command, {
          maxBuffer: 1024 * 1024,
          timeout: 30000,
        });

        let result = "";
        if (cmdStdout) result += cmdStdout;
        if (stderr) result += (result ? "\n" : "") + `[stderr] ${stderr}`;

        const maxLength = 8000;
        if (result.length > maxLength) {
          result = result.slice(0, maxLength) + "\n...[output truncated]";
        }

        console.log(chalk.dim(result || "[No output]"));
        console.log();

        return `[Shell command executed: ${command}]\n\nOutput:\n${result || "(no output)"}`;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        let errorMessage = err.message;
        const maxLength = 4000;
        if (errorMessage.length > maxLength) {
          errorMessage = errorMessage.slice(0, maxLength) + "\n...[error truncated]";
        }

        console.log(chalk.red(`\n[Shell Error: ${errorMessage}]`));
        console.log();

        return `[Shell command failed: ${command}]\n\nError: ${errorMessage}`;
      }
    }

    return input;
  };

  // Extract title from messages
  const extractTitle = (msgs: KodaXMessage[]): string => {
    const firstUser = msgs.find((m) => m.role === "user");
    if (firstUser) {
      const content =
        typeof firstUser.content === "string" ? firstUser.content : "";
      return content.slice(0, 50) + (content.length > 50 ? "..." : "");
    }
    return "Untitled Session";
  };

  // Create KodaXEvents for streaming updates
  const createStreamingEvents = useCallback((): import("../core/types.js").KodaXEvents => ({
    onThinkingDelta: (text: string) => {
      // UI 层存储 thinking 内容用于显示
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
  }), [appendThinkingContent, stopThinking, appendResponse, setCurrentTool, appendToolInputChars]);

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

      // Also print to console for non-Ink output
      console.log(chalk.cyan(`You: ${input}`));
      console.log();

      setIsLoading(true);
      clearResponse();
      startStreaming();

      touchContext(context);

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
          setAuto: (enabled: boolean) => {
            setCurrentConfig((prev) => ({ ...prev, auto: enabled }));
            currentOptionsRef.current.auto = enabled;
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
            auto: currentConfig.auto,
            mode: currentConfig.mode,
          }),
          readline: null as unknown as ReturnType<
            typeof import("readline").createInterface
          >,
        };

        await executeCommand(parsed, context, callbacks, currentConfig);
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

      // Add to context
      context.messages.push({ role: "user", content: processed });

      // Sync options mode
      currentOptionsRef.current.mode = currentConfig.mode;

      // Run with plan mode if enabled
      if (planMode) {
        try {
          await runWithPlanMode(processed, {
            ...currentOptionsRef.current,
            provider: currentConfig.provider,
            thinking: currentConfig.thinking,
            auto: currentConfig.auto,
            mode: currentConfig.mode,
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

      try {
        const result = await runAgentRound(currentOptionsRef.current, processed);

        // Update context
        context.messages = result.messages;

        // Add assistant response to UI history
        const lastAssistant = result.messages[result.messages.length - 1];
        if (lastAssistant?.role === "assistant") {
          const content = extractTextContent(lastAssistant.content);
          addHistoryItem({
            type: "assistant",
            text: content,
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
        context.messages.pop(); // Remove failed user message

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

        console.log(chalk.red(errorContent));

        // Add error to UI history
        addHistoryItem({
          type: "error",
          text: errorContent,
        });
      } finally {
        setIsLoading(false);
        stopStreaming();
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
    ]
  );

  return (
    <Box flexDirection="column">
      {/* Banner - shown once at start */}
      {showBanner && (
        <Banner
          config={currentConfig}
          sessionId={context.sessionId}
          workingDir={options.context?.gitRoot || process.cwd()}
        />
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
          placeholder="Type your message... (Enter: submit, \\+Enter: newline)"
          prompt=">"
          focus={!isLoading}
        />
      </Box>

      {/* Status Bar */}
      <Box flexShrink={0} marginTop={1}>
        <StatusBar
          sessionId={context.sessionId}
          mode={currentConfig.mode ?? "code"}
          provider={currentConfig.provider}
          model={getProviderModel(currentConfig.provider) ?? currentConfig.provider}
          currentTool={streamingState.currentTool}
          thinking={currentConfig.thinking}
          auto={currentConfig.auto}
        />
      </Box>
    </Box>
  );
};

/**
 * InkREPL Component - Main REPL interface using Ink
 * Wrapped with context providers
 *
 * Note: KeypressProvider is not used here because InputPrompt
 * uses useInput directly. Having both would conflict.
 */
const InkREPL: React.FC<InkREPLProps> = (props) => {
  return (
    <UIStateProvider>
      <StreamingProvider>
        <InkREPLInner {...props} />
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
 * Print startup banner (called BEFORE starting Ink to avoid re-rendering)
 */
function printStartupBanner(config: CurrentConfig, sessionId: string, workingDir: string): void {
  const model = getProviderModel(config.provider) ?? config.provider;
  const terminalWidth = process.stdout.columns ?? 80;
  const dividerWidth = Math.min(60, terminalWidth - 4);

  const logo = `  ██╗  ██╗  ██████╗  ██████╗    █████╗   ██╗  ██╗
  ██║ ██╔╝ ██╔═══██╗ ██╔══██╗  ██╔══██╗  ╚██╗██╔╝
  █████╔╝  ██║   ██║ ██║  ██║  ███████║   ╚███╔╝
  ██╔═██╗  ██║   ██║ ██║  ██║  ██╔══██║   ██╔██╗
  ██║  ██╗ ╚██████╔╝ ██████╔╝  ██║  ██║  ██╔╝ ██╗
  ╚═╝  ╚═╝  ╚═════╝  ╚═════╝   ╚═╝  ╚═╝  ╚═╝  ╚═╝`;

  console.log(chalk.cyan(logo));
  console.log();

  // Version and Provider Info
  let infoLine = chalk.white.bold(`  v${KODAX_VERSION}`) + chalk.dim(" | ");
  infoLine += chalk.green(`${config.provider}/${model}`) + chalk.dim(" | ");
  infoLine += chalk.cyan(config.mode);
  if (config.thinking) infoLine += chalk.yellow(" +think");
  if (config.auto) infoLine += chalk.magenta(" +auto");
  console.log(infoLine);

  // Divider
  console.log(chalk.dim(`  ${"-".repeat(dividerWidth)}`));

  // Session Info
  console.log(
    chalk.dim("  Session: ") + chalk.cyan(sessionId) +
    chalk.dim(" | Working: ") + chalk.dim(workingDir)
  );

  // Divider
  console.log(chalk.dim(`  ${"-".repeat(dividerWidth)}`));
  console.log();
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
  const { loadConfig, getGitRoot } = await import("../cli/utils.js");
  const config = loadConfig();
  const initialProvider = options.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
  const initialThinking = options.thinking ?? config.thinking ?? false;
  const initialAuto = options.auto ?? config.auto ?? false;

  const currentConfig: CurrentConfig = {
    provider: initialProvider,
    thinking: initialThinking,
    auto: initialAuto,
    mode: "code",
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
