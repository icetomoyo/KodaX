/**
 * InkREPL - Ink-based REPL Adapter
 *
 * Bridges Ink UI components with existing KodaX command processing logic.
 * Replaces the Node.js readline-based input with Ink's React components.
 */

import React, { useState, useCallback, useRef } from "react";
import { render, Box, Text, useApp } from "ink";
import { InputPrompt } from "./components/InputPrompt.js";
import { SessionHistory } from "./components/SessionHistory.js";
import type { Message } from "./types.js";
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
import chalk from "chalk";
import * as childProcess from "child_process";
import * as util from "util";

const execAsync = util.promisify(childProcess.exec);

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

/**
 * InkREPL Component - Main REPL interface using Ink
 */
const InkREPL: React.FC<InkREPLProps> = ({
  options,
  config,
  context,
  storage,
  onExit,
}) => {
  const { exit } = useApp();

  // State
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentConfig, setCurrentConfig] = useState<CurrentConfig>(config);
  const [planMode, setPlanMode] = useState(false);
  const [isRunning, setIsRunning] = useState(true);

  // Refs for callbacks
  const currentOptionsRef = useRef<InkREPLOptions>({
    ...options,
    mode: currentConfig.mode,
    session: {
      ...options.session,
      id: context.sessionId,
    },
  });

  // Convert KodaXMessage to UI Message
  const kodaxMessageToUIMessage = (msg: KodaXMessage): Message => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role: msg.role as "user" | "assistant" | "system",
    content:
      typeof msg.content === "string" ? msg.content : "[Complex content]",
    timestamp: Date.now(),
  });

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

  // Run agent round
  const runAgentRound = async (
    opts: KodaXOptions,
    prompt: string
  ): Promise<KodaXResult> => {
    return runKodaX(
      {
        ...opts,
        session: {
          ...opts.session,
          initialMessages: context.messages,
        },
      },
      prompt
    );
  };

  // Handle user input submission
  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim() || !isRunning) return;

      // Add user message to UI
      const userMessage: Message = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        role: "user",
        content: input,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

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
              // Update UI messages
              setMessages(loaded.messages.map(kodaxMessageToUIMessage));
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
            setMessages([]);
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
              const content =
                typeof m.content === "string" ? m.content : "[Complex content]";
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
          const errorMessage: Message = {
            id: `${Date.now()}-error`,
            role: "system",
            content: `[Plan Mode Error] ${error.message}`,
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, errorMessage]);
        }
        setIsLoading(false);
        return;
      }

      // Run agent
      try {
        const result = await runAgentRound(currentOptionsRef.current, processed);

        // Update context
        context.messages = result.messages;

        // Add assistant response to UI
        const lastMessage = result.messages[result.messages.length - 1];
        if (lastMessage && lastMessage.role === "assistant") {
          const assistantMessage: Message = {
            id: `${Date.now()}-assistant`,
            role: "assistant",
            content:
              typeof lastMessage.content === "string"
                ? lastMessage.content
                : "[Complex content]",
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, assistantMessage]);
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

        const errorMessage: Message = {
          id: `${Date.now()}-error`,
          role: "system",
          content: errorContent,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsLoading(false);
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
    ]
  );

  return (
    <Box flexDirection="column">
      {/* Session History - Show when resuming session with messages */}
      {context.messages && context.messages.length > 0 && (
        <SessionHistory
          messages={context.messages.slice(-5).map((m) => ({
            role: m.role,
            content: m.content,
          }))}
          maxDisplay={5}
          maxLength={100}
        />
      )}

      {/* Message List - only grow if there are messages */}
      {messages.length > 0 || isLoading ? (
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          {messages.map((msg) => (
            <Box key={msg.id} marginBottom={1}>
              <Text
                color={
                  msg.role === "user"
                    ? "cyan"
                    : msg.role === "assistant"
                      ? "green"
                      : "yellow"
                }
                bold
              >
                {msg.role === "user"
                  ? "You"
                  : msg.role === "assistant"
                    ? "Assistant"
                    : "System"}
                :{" "}
              </Text>
              <Text dimColor={msg.role === "system"}>
                {msg.content.slice(0, 200)}
                {msg.content.length > 200 ? "..." : ""}
              </Text>
            </Box>
          ))}
          {isLoading && (
            <Box>
              <Text dimColor>Thinking...</Text>
            </Box>
          )}
        </Box>
      ) : null}

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
      <Box flexShrink={0}>
        <Text dimColor>
          Session: {context.sessionId} | Mode: {currentConfig.mode} |
          Provider: {currentConfig.provider}
          {currentConfig.thinking ? " | Thinking" : ""}
          {currentConfig.auto ? " | Auto" : ""}
          {planMode ? " | Plan" : ""}
        </Text>
      </Box>
    </Box>
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
  const { loadConfig } = await import("../cli/utils.js");
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

  // Create context
  const context = await createInteractiveContext({
    sessionId: options.session?.id,
    gitRoot: undefined,
  });

  // Print banner BEFORE starting Ink (to avoid re-rendering on every state change)
  printStartupBanner(
    currentConfig,
    context.sessionId,
    options.context?.gitRoot || process.cwd()
  );

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
        patchConsole: false,  // Don't patch console to allow command output to work
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
