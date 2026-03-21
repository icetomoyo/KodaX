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
import { PendingInputsIndicator } from "./components/PendingInputsIndicator.js";
import { StatusBar, getStatusBarText } from "./components/StatusBar.js";
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
  KodaXReasoningMode,
  KodaXResult,
  runKodaX,
  KODAX_DEFAULT_PROVIDER,
  KodaXTerminalError,
  classifyError,
  ErrorCategory,
  loadAgentsFiles,
} from "@kodax/coding";
import type { AgentsFile } from "@kodax/coding";
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
  generateSessionId,
  touchContext,
} from "../interactive/context.js";
import {
  parseCommand,
  executeCommand,
  CommandCallbacks,
  CurrentConfig,
} from "../interactive/commands.js";
import type { CommandInvocationRequest } from "../commands/types.js";
import {
  formatReasoningCapabilityShort,
  getProviderModel,
  getProviderReasoningCapability,
} from "../common/utils.js";
import { KODAX_VERSION } from "../common/utils.js";
import { runWithPlanMode } from "../common/plan-mode.js";
import { saveAlwaysAllowToolPattern, loadAlwaysAllowTools, savePermissionModeUser } from "../common/permission-config.js";
import { initializeSkillRegistry, getSkillRegistry } from "@kodax/skills";
import { getTheme } from "./themes/index.js";
import chalk from "chalk";
import {
  ShortcutsProvider,
  useShortcutsContext,
  GlobalShortcuts,
} from "./shortcuts/index.js";
import { prepareInvocationExecution } from "../interactive/invocation-runtime.js";

// Extracted modules
import { MemorySessionStorage, type SessionStorage } from "./utils/session-storage.js";
import { processSpecialSyntax, isShellCommandSuccess } from "./utils/shell-executor.js";
import {
  extractHistorySeedsFromMessage,
  extractTextContent,
  extractTitle,
  resolveAssistantHistoryText,
} from "./utils/message-utils.js";
import { withCapture, ConsoleCapturer } from "./utils/console-capturer.js";
import { emitRetryHistoryItem } from "./utils/retry-history.js";
import { calculateViewportBudget } from "./utils/viewport-budget.js";
import { formatPendingInputsSummary, MAX_PENDING_INPUTS } from "./utils/pending-inputs.js";
import { runQueuedPromptSequence } from "./utils/queued-prompt-sequence.js";
import { capHistoryByTranscriptRows, sliceHistoryToRecentRounds } from "./utils/transcript-layout.js";
import {
  getAskUserDialogTitle,
  resolveAskUserDismissChoice,
  shouldSwitchToAcceptEdits,
  toSelectOptions,
  type SelectOption,
} from "./utils/ask-user.js";
import { HELP_BAR_SEGMENTS } from "./constants/layout.js";

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

interface ReviewSnapshot {
  items: HistoryItem[];
  isLoading: boolean;
  isThinking: boolean;
  thinkingCharCount: number;
  thinkingContent: string;
  currentResponse: string;
  currentTool?: string;
  toolInputCharCount: number;
  toolInputContent: string;
  iterationHistory: import("./contexts/StreamingContext.js").IterationRecord[];
  currentIteration: number;
  isCompacting: boolean;
}

const PLAN_MODE_BLOCK_GUIDANCE =
  "Do not try to modify files while planning. Finish the plan first, then use ask_user_question with intent \"plan-handoff\" to ask whether this session should switch to accept-edits and continue.";

function resolveInitialReasoningMode(
  options: Pick<KodaXOptions, 'reasoningMode' | 'thinking'>,
  config: { reasoningMode?: KodaXReasoningMode; thinking?: boolean },
): KodaXReasoningMode {
  if (options.reasoningMode) {
    return options.reasoningMode;
  }
  if (config.reasoningMode) {
    return config.reasoningMode;
  }
  if (options.thinking === true || config.thinking === true) {
    return 'auto';
  }
  return 'off';
}

/**
 * Banner component - displayed inside Ink UI so it's part of the alternate buffer
 */
const Banner: React.FC<BannerProps> = ({ config, sessionId, workingDir, compactionInfo }) => {
  const theme = getTheme("dark");
  const model = config.model ?? getProviderModel(config.provider) ?? config.provider;
  const reasoningCapability = getProviderReasoningCapability(config.provider);
  const reasoningCapabilityShort = formatReasoningCapabilityShort(reasoningCapability);
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
          {` [${reasoningCapabilityShort}]`}
        </Text>
        <Text dimColor>
          {" | "}
        </Text>
        <Text color={theme.colors.accent}>
          {config.permissionMode}
        </Text>
        <Text dimColor>
          {" | "}
        </Text>
        <Text color={config.parallel ? theme.colors.success : theme.colors.dim}>
          {config.parallel ? "parallel" : "serial"}
        </Text>
        {config.reasoningMode !== 'off' && (
          <Text color={theme.colors.warning}>
            {` +reason:${config.reasoningMode}`}
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
 * 在建议首次出现后继续预留固定高度，避免消息区和底部区来回跳动
 *
 *
 * Behavior:
 * 1. No suggestions initially -> no space reserved
 * 2. Suggestions appear -> reserve 8 lines
 * 3. Suggestions disappear (Esc/input change) -> keep 8 lines
 * 4. Message sent (submitCounter changes) -> remove 8 lines
 */
const AutocompleteSuggestions: React.FC<{
  reserveSpace: boolean;
  width: number;
  hidden?: boolean;
}> = ({ reserveSpace, width, hidden = false }) => {
  const autocomplete = useAutocompleteContext();

  if (hidden) {
    return null;
  }

  if (!autocomplete) {
    return reserveSpace ? <Box height={8} /> : null;
  }

  const { state, suggestions } = autocomplete;
  const hasSuggestions = state.visible && suggestions.length > 0;
  if (!hasSuggestions) {
    return reserveSpace ? <Box height={8} /> : null;
  }

  return (
    <Box height={8}>
      <SuggestionsDisplay
        suggestions={suggestions}
        selectedIndex={state.selectedIndex}
        visible={state.visible}
        maxVisible={7}
        width={Math.max(20, width - 2)}
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
  const { addHistoryItem, clearHistory: clearUIHistory, setSessionId } = useUIActions();

  // Get terminal dimensions for fixed layout.
  const terminalWidth = stdout.columns || 80;

  // Issue 079: Limit visible history to last 20 conversation rounds
  // A "round" = one user input + AI response(s)
  // Full history remains in state, only rendering is limited
  const MAX_VISIBLE_ROUNDS = 20;
  const REVIEW_VISIBLE_ROUNDS = 50;
  const REVIEW_MAX_TRANSCRIPT_ROWS = 4000;
  const renderHistory = useMemo(() => {
    return sliceHistoryToRecentRounds(history, MAX_VISIBLE_ROUNDS);
  }, [history]);
  const reviewHistory = useMemo(() => {
    const recentRounds = sliceHistoryToRecentRounds(history, REVIEW_VISIBLE_ROUNDS);
    return capHistoryByTranscriptRows(
      recentRounds,
      terminalWidth,
      REVIEW_MAX_TRANSCRIPT_ROWS
    );
  }, [history, terminalWidth]);

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
    addPendingInput,
    removeLastPendingInput,
    shiftPendingInput,
  } = useStreamingActions();

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [currentConfig, setCurrentConfig] = useState<CurrentConfig>(config);
  const [planMode, setPlanMode] = useState(false);
  const [isRunning, setIsRunning] = useState(true);
  const [showBanner, setShowBanner] = useState(true); // Show banner in Ink UI
  const [submitCounter, setSubmitCounter] = useState(0); // Counter to trigger clear on submit
  const [canQueueFollowUps, setCanQueueFollowUps] = useState(false);
  const [liveTokenCount, setLiveTokenCount] = useState<number | null>(null); // Live token count for real-time display
  const lastCompactionTokensBeforeRef = useRef<number | null>(null);
  const [isInputEmpty, setIsInputEmpty] = useState(true); // Track if input is empty for ? shortcut
  const [inputText, setInputText] = useState("");
  const [isReviewingHistory, setIsReviewingHistory] = useState(false);
  const [historyScrollOffset, setHistoryScrollOffset] = useState(0);
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewSnapshot | null>(null);

  // Shortcuts context.
  const { showHelp, toggleHelp, setShowHelp } = useShortcutsContext();

  // Handle input change and keep the latest text for viewport budgeting.
  const handleInputChange = useCallback((text: string) => {
    setInputText(text);
    setIsInputEmpty(text.trim().length === 0);
  }, []);

  const autocomplete = useAutocompleteContext();
  const hasVisibleSuggestions = useMemo(() => {
    if (!autocomplete) return false;
    return autocomplete.state.visible && autocomplete.suggestions.length > 0;
  }, [autocomplete]);
  const [shouldReserveSuggestionsSpace, setShouldReserveSuggestionsSpace] = useState(false);
  const lastSubmitCounterRef = useRef(submitCounter);

  // 建议一旦出现，就持续预留 8 行，直到用户真正提交一条消息。
  useEffect(() => {
    if (hasVisibleSuggestions && !shouldReserveSuggestionsSpace) {
      setShouldReserveSuggestionsSpace(true);
    }
  }, [hasVisibleSuggestions, shouldReserveSuggestionsSpace]);

  // 提交后再释放预留空间，这样 Esc/输入变化不会让底部高度瞬间收缩。
  useEffect(() => {
    if (submitCounter !== lastSubmitCounterRef.current) {
      lastSubmitCounterRef.current = submitCounter;
      if (shouldReserveSuggestionsSpace) {
        setShouldReserveSuggestionsSpace(false);
      }
    }
  }, [submitCounter, shouldReserveSuggestionsSpace]);

  // Confirmation dialog state.
  const [confirmRequest, setConfirmRequest] = useState<{
    tool: string;
    input: Record<string, unknown>;
    prompt: string;
  } | null>(null);
  const confirmResolveRef = useRef<((result: ConfirmResult) => void) | null>(null);
  const [uiRequest, setUiRequest] = useState<
    | {
      kind: "select";
      title: string;
      options: SelectOption[];
      buffer: string;
      error?: string;
    }
    | {
      kind: "input";
      prompt: string;
      defaultValue?: string;
      buffer: string;
      error?: string;
    }
    | null
  >(null);
  const uiResolveRef = useRef<((value: string | undefined) => void) | null>(null);

  // Issue 070: Calculate context token usage for status bar display
  // Issue 070: Calculate context token usage for status bar display
  // Issue 070: calculate context token usage for the status bar.
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

  const confirmInstruction = useMemo(() => {
    if (!confirmRequest) return undefined;
    const isProtectedPath = !!confirmRequest.input._alwaysConfirm;
    const canAlways = currentConfig.permissionMode === "accept-edits" && !isProtectedPath;

    if (isProtectedPath) {
      return "Press (y) to confirm, (n) to cancel (protected path)";
    }
    if (canAlways) {
      return "Press (y) yes, (a) always yes for this tool, (n) no";
    }
    return "Press (y) yes, (n) no";
  }, [confirmRequest, currentConfig.permissionMode]);

  const isAwaitingUserInteraction = !!confirmRequest || !!uiRequest;
  const isLivePaused = isReviewingHistory || isAwaitingUserInteraction;
  const suggestionsReservedForLayout = shouldReserveSuggestionsSpace && !isReviewingHistory;

  const createReviewSnapshot = useCallback((): ReviewSnapshot => ({
    items: isReviewingHistory ? reviewHistory : renderHistory,
    isLoading,
    isThinking: streamingState.isThinking,
    thinkingCharCount: streamingState.thinkingCharCount,
    thinkingContent: streamingState.thinkingContent,
    currentResponse: streamingState.currentResponse,
    currentTool: streamingState.currentTool,
    toolInputCharCount: streamingState.toolInputCharCount,
    toolInputContent: streamingState.toolInputContent,
    iterationHistory: streamingState.iterationHistory,
    currentIteration: streamingState.currentIteration,
    isCompacting: streamingState.isCompacting,
  }), [
    renderHistory,
    reviewHistory,
    isReviewingHistory,
    isLoading,
    streamingState.isThinking,
    streamingState.thinkingCharCount,
    streamingState.thinkingContent,
    streamingState.currentResponse,
    streamingState.currentTool,
    streamingState.toolInputCharCount,
    streamingState.toolInputContent,
    streamingState.iterationHistory,
    streamingState.currentIteration,
    streamingState.isCompacting,
  ]);

  useEffect(() => {
    if (isLivePaused) {
      setReviewSnapshot((prev) => prev ?? createReviewSnapshot());
      return;
    }

    setReviewSnapshot(null);
  }, [isLivePaused, createReviewSnapshot]);

  const displaySnapshot = reviewSnapshot;
  const displayItems = displaySnapshot?.items ?? renderHistory;
  const displayIsLoading = isAwaitingUserInteraction
    ? false
    : displaySnapshot?.isLoading ?? isLoading;
  const displayStreamingState = {
    isThinking: displaySnapshot?.isThinking ?? streamingState.isThinking,
    thinkingCharCount: displaySnapshot?.thinkingCharCount ?? streamingState.thinkingCharCount,
    thinkingContent: displaySnapshot?.thinkingContent ?? streamingState.thinkingContent,
    currentResponse: displaySnapshot?.currentResponse ?? streamingState.currentResponse,
    currentTool: displaySnapshot?.currentTool ?? streamingState.currentTool,
    toolInputCharCount: displaySnapshot?.toolInputCharCount ?? streamingState.toolInputCharCount,
    toolInputContent: displaySnapshot?.toolInputContent ?? streamingState.toolInputContent,
    iterationHistory: displaySnapshot?.iterationHistory ?? streamingState.iterationHistory,
    currentIteration: displaySnapshot?.currentIteration ?? streamingState.currentIteration,
    isCompacting: displaySnapshot?.isCompacting ?? streamingState.isCompacting,
  };

  const reviewHintText = useMemo(() => {
    if (!isReviewingHistory) return undefined;
    return "Reviewing history - live updates paused | Wheel/PgUp/PgDn/j/k scroll | Esc/End/Ctrl+Y/Alt+Z resume";
  }, [isReviewingHistory]);

  const statusBarProps = useMemo(() => ({
    sessionId: context.sessionId,
    permissionMode: currentConfig.permissionMode,
    parallel: currentConfig.parallel,
    provider: currentConfig.provider,
    model: currentConfig.model ?? getProviderModel(currentConfig.provider) ?? currentConfig.provider,
    currentTool: displayStreamingState.currentTool,
    thinking: currentConfig.thinking,
    reasoningMode: currentConfig.reasoningMode,
    reasoningCapability: formatReasoningCapabilityShort(
      getProviderReasoningCapability(currentConfig.provider),
    ),
    isThinkingActive: displayStreamingState.isThinking,
    thinkingCharCount: displayStreamingState.thinkingCharCount,
    toolInputCharCount: displayStreamingState.toolInputCharCount,
    toolInputContent: displayStreamingState.toolInputContent,
    currentIteration: displayStreamingState.currentIteration,
    maxIter: streamingState.maxIter,
    contextUsage,
    isCompacting: displayStreamingState.isCompacting,
    showBusyStatus: !isLivePaused,
  }), [
    context.sessionId,
    currentConfig.permissionMode,
    currentConfig.parallel,
    currentConfig.provider,
    currentConfig.model,
    currentConfig.thinking,
    currentConfig.reasoningMode,
    displayStreamingState.currentTool,
    displayStreamingState.isThinking,
    displayStreamingState.thinkingCharCount,
    displayStreamingState.toolInputCharCount,
    displayStreamingState.toolInputContent,
    displayStreamingState.currentIteration,
    streamingState.maxIter,
    displayStreamingState.isCompacting,
    contextUsage,
    isLivePaused,
  ]);

  const statusBarText = useMemo(() => getStatusBarText(statusBarProps), [statusBarProps]);
  const pendingInputSummary = useMemo(
    () => formatPendingInputsSummary(streamingState.pendingInputs),
    [streamingState.pendingInputs]
  );
  const terminalRows = stdout.rows || process.stdout.rows || 24;
  const viewportBudget = useMemo(
    // 统一预算所有底部区块占用的行数，消息区只拿剩余可见行，避免最后一行被布局副作用裁掉。
    () => calculateViewportBudget({
      terminalRows,
      terminalWidth,
      inputText,
      pendingInputSummary,
      suggestionsReserved: suggestionsReservedForLayout,
      showHelp,
      statusBarText,
      confirmPrompt: confirmRequest?.prompt,
      confirmInstruction,
      reviewHint: reviewHintText,
      uiRequest: uiRequest
        ? uiRequest.kind === "select"
          ? {
              kind: "select" as const,
              title: uiRequest.title,
              options: uiRequest.options.map((option) => ({
                label: option.label,
                description: option.description,
              })),
              buffer: uiRequest.buffer,
              error: uiRequest.error,
            }
          : {
              kind: "input" as const,
              prompt: uiRequest.prompt,
              defaultValue: uiRequest.defaultValue,
              buffer: uiRequest.buffer,
              error: uiRequest.error,
            }
        : null,
    }),
    [
      terminalRows,
      terminalWidth,
      inputText,
      pendingInputSummary,
      suggestionsReservedForLayout,
      showHelp,
      statusBarText,
      confirmRequest,
      confirmInstruction,
      reviewHintText,
      uiRequest,
    ]
  );
  const reviewPageSize = useMemo(
    () => Math.max(1, viewportBudget.messageRows - 2),
    [viewportBudget.messageRows]
  );
  const reviewWheelStep = useMemo(
    () => Math.max(3, Math.floor(reviewPageSize / 4)),
    [reviewPageSize]
  );

  const enterHistoryReview = useCallback((nextOffset?: number) => {
    setIsReviewingHistory(true);
    setHistoryScrollOffset((prev) => nextOffset ?? prev);
  }, []);

  const exitHistoryReview = useCallback(() => {
    setIsReviewingHistory(false);
    setHistoryScrollOffset(0);
  }, []);

  useEffect(() => {
    if (!process.stdout.isTTY) {
      return;
    }

    if (!isReviewingHistory) {
      return;
    }

    process.stdout.write("\x1b[?1000h\x1b[?1006h");

    return () => {
      try {
        process.stdout.write("\x1b[?1000l\x1b[?1006l");
      } catch {
        // Ignore terminal cleanup failures.
      }
    };
  }, [isReviewingHistory]);

  // Refs for callbacks
  // Note: permissionMode and alwaysAllowTools are stored separately for permission checks
  const currentOptionsRef = useRef<InkREPLOptions>({
    ...options,
    parallel: currentConfig.parallel,
    thinking: currentConfig.thinking,
    reasoningMode: currentConfig.reasoningMode,
    session: {
      ...options.session,
      id: context.sessionId,
    },
  });
  // Permission-related refs (not part of KodaXOptions anymore)
  const permissionModeRef = useRef<PermissionMode>(currentConfig.permissionMode);
  const alwaysAllowToolsRef = useRef<string[]>(loadAlwaysAllowTools());

  const setSessionPermissionMode = useCallback((mode: PermissionMode) => {
    setCurrentConfig((prev) => ({ ...prev, permissionMode: mode }));
    permissionModeRef.current = mode;
  }, []);
  const pendingInputsRef = useRef<string[]>(streamingState.pendingInputs);
  const userInterruptedRef = useRef(false);

  useEffect(() => {
    pendingInputsRef.current = streamingState.pendingInputs;
  }, [streamingState.pendingInputs]);

  // Double-ESC detection for interrupt handling.
  const lastEscPressRef = useRef<number>(0);
  const DOUBLE_ESC_INTERVAL = 500; // ms

  // Global interrupt handler using the Gemini CLI style isActive pattern.
  // Only subscribe during streaming so keyboard events are captured correctly.
  // Reference: Gemini CLI useGeminiStream.ts useKeypress usage.
  useKeypress(
    KeypressHandlerPriority.Critical,
    (key) => {
      if (!isLoading) {
        return false;
      }

      // Ctrl+C immediately interrupts.
      if (key.ctrl && key.name === "c") {
        // Just abort - the catch block will handle saving the partial response

        userInterruptedRef.current = true;
        abort();
        stopThinking();
        clearThinkingContent();
        setCurrentTool(undefined);
        setIsLoading(false);
        console.log(chalk.yellow("\n[Interrupted]"));
        return true;
      }

      // ESC requires a double-press to interrupt.
      if (key.name === "escape") {
        if (isReviewingHistory || isAwaitingUserInteraction) {
          return false;
        }

        if (isInputEmpty && streamingState.pendingInputs.length > 0) {
          removeLastPendingInput();
          lastEscPressRef.current = 0;
          return true;
        }

        if (!isInputEmpty) {
          return false;
        }

        const now = Date.now();
        const timeSinceLastEsc = now - lastEscPressRef.current;

        if (timeSinceLastEsc < DOUBLE_ESC_INTERVAL) {
          // Double ESC: interrupt streaming.
          lastEscPressRef.current = 0;
          userInterruptedRef.current = true;
          abort();
          stopThinking();
          clearThinkingContent();
          setCurrentTool(undefined);
          setIsLoading(false);
          console.log(chalk.yellow("\n[Interrupted]"));
          return true;
        }

        // First ESC: record the time only.
        lastEscPressRef.current = now;
        return true; // Consume the event to prevent InputPrompt from handling
      }

      return false;
    },
    [
      isLoading,
      isReviewingHistory,
      isAwaitingUserInteraction,
      isInputEmpty,
      streamingState.pendingInputs.length,
      removeLastPendingInput,
      abort,
      stopThinking,
      clearThinkingContent,
      setCurrentTool,
      setIsLoading,
    ]
  );

  useKeypress(
    KeypressHandlerPriority.Critical,
    (key) => {
      const hasTranscript = displayItems.length > 0 || !!displayStreamingState.currentResponse || !!displayStreamingState.thinkingContent;

      if ((key.ctrl && key.name === "y") || (key.meta && key.name === "z")) {
        if (!isReviewingHistory) {
          if (!hasTranscript) return true;
          enterHistoryReview(0);
          return true;
        }

        exitHistoryReview();
        return true;
      }

      if (key.name === "pageup") {
        if (!hasTranscript) return true;

        setIsReviewingHistory(true);
        setHistoryScrollOffset((prev) => prev + reviewPageSize);
        return true;
      }

      if (!isReviewingHistory) {
        return false;
      }

      if (key.name === "escape") {
        exitHistoryReview();
        return true;
      }

      if (key.name === "end") {
        exitHistoryReview();
        return true;
      }

      if (key.name === "home") {
        setHistoryScrollOffset(1_000_000);
        return true;
      }

      if (key.name === "pagedown") {
        if (historyScrollOffset === 0) {
          exitHistoryReview();
          return true;
        }

        setHistoryScrollOffset((prev) => Math.max(0, prev - reviewPageSize));
        return true;
      }

      if (key.name === "wheelup") {
        setHistoryScrollOffset((prev) => prev + reviewWheelStep);
        return true;
      }

      if (key.name === "wheeldown") {
        if (historyScrollOffset === 0) {
          exitHistoryReview();
          return true;
        }

        setHistoryScrollOffset((prev) => Math.max(0, prev - reviewWheelStep));
        return true;
      }

      if (key.name === "j" || key.name === "down") {
        setHistoryScrollOffset((prev) => Math.max(0, prev - 1));
        return true;
      }

      if (key.name === "k" || key.name === "up") {
        setHistoryScrollOffset((prev) => prev + 1);
        return true;
      }

      return false;
    },
    [
      isReviewingHistory,
      displayItems,
      displayStreamingState.currentResponse,
      displayStreamingState.thinkingContent,
      historyScrollOffset,
      reviewPageSize,
      reviewWheelStep,
      enterHistoryReview,
      exitHistoryReview,
    ]
  );

  // Confirmation dialog keyboard handler.
  useInput(
    (input, _key) => {
      if (!confirmRequest) return;

      const answer = input.toLowerCase();
      const isProtectedPath = !!confirmRequest.input._alwaysConfirm;
      // "Always" is only available in accept-edits mode.
      const canAlways = currentConfig.permissionMode === 'accept-edits' && !isProtectedPath;

      if (answer === 'y' || answer === 'yes') {
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: true });
        confirmResolveRef.current = null;
      } else if (canAlways && (answer === 'a' || answer === 'always')) {
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

  const resolveUIRequest = useCallback((value: string | undefined) => {
    setUiRequest(null);
    uiResolveRef.current?.(value);
    uiResolveRef.current = null;
  }, []);

  const showSelectDialogWithOptions = useCallback((title: string, options: SelectOption[]): Promise<string | undefined> => {
    if (options.length === 0) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      uiResolveRef.current = resolve;
      setUiRequest({
        kind: "select",
        title,
        options,
        buffer: "",
      });
    });
  }, []);

  const showSelectDialog = useCallback((title: string, options: string[]): Promise<string | undefined> => {
    return showSelectDialogWithOptions(
      title,
      options.map((option) => ({ label: option, value: option })),
    );
  }, [showSelectDialogWithOptions]);

  const showInputDialog = useCallback((prompt: string, defaultValue?: string): Promise<string | undefined> => {
    return new Promise((resolve) => {
      uiResolveRef.current = resolve;
      setUiRequest({
        kind: "input",
        prompt,
        defaultValue,
        buffer: "",
      });
    });
  }, []);

  useInput(
    (input, key) => {
      if (!uiRequest) return;

      if (key.escape) {
        resolveUIRequest(undefined);
        return;
      }

      if (uiRequest.kind === "select") {
        if (key.return) {
          const trimmed = uiRequest.buffer.trim();
          if (trimmed === "" || trimmed === "0") {
            resolveUIRequest(undefined);
            return;
          }

          const index = Number.parseInt(trimmed, 10) - 1;
          if (Number.isNaN(index) || index < 0 || index >= uiRequest.options.length) {
            setUiRequest((prev) =>
              prev && prev.kind === "select"
                ? {
                  ...prev,
                  error: `Invalid choice. Enter 1-${prev.options.length}, or 0 to cancel.`,
                }
                : prev
            );
            return;
          }

          resolveUIRequest(uiRequest.options[index]?.value);
          return;
        }

        if (key.backspace || key.delete) {
          setUiRequest((prev) =>
            prev && prev.kind === "select"
              ? { ...prev, buffer: prev.buffer.slice(0, -1), error: undefined }
              : prev
          );
          return;
        }

        if (/^[0-9]$/.test(input)) {
          setUiRequest((prev) =>
            prev && prev.kind === "select"
              ? { ...prev, buffer: prev.buffer + input, error: undefined }
              : prev
          );
        }

        return;
      }

      if (key.return) {
        const trimmed = uiRequest.buffer.trim();
        resolveUIRequest(trimmed === "" ? uiRequest.defaultValue ?? undefined : trimmed);
        return;
      }

      if (key.backspace || key.delete) {
        setUiRequest((prev) =>
          prev && prev.kind === "input"
            ? { ...prev, buffer: prev.buffer.slice(0, -1), error: undefined }
            : prev
        );
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        setUiRequest((prev) =>
          prev && prev.kind === "input"
            ? { ...prev, buffer: prev.buffer + input, error: undefined }
            : prev
        );
      }
    },
    { isActive: !!uiRequest }
  );

  // Sync history from context to UI
  // Re-sync when history is cleared (e.g., after /compact command)
  // Only sync if history is empty to avoid duplicates (Issue 046)
  useEffect(() => {
    if (context.messages.length > 0 && history.length === 0) {
      for (const msg of context.messages) {
        const historySeeds = extractHistorySeedsFromMessage(msg);
        for (const item of historySeeds) {
          addHistoryItem(item);
        }
      }
    }
  }, [context.messages, history.length, addHistoryItem]);

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
      // The UI layer stores thinking content for display.
      appendThinkingChars(text.length);
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
      appendToolInputContent(partialJson); // Issue 068 Phase 4: track tool input content.
    },
    onToolResult: () => {
      setCurrentTool(undefined);
    },
    onStreamEnd: () => {
      stopThinking();
      setCurrentTool(undefined);
    },
    hasPendingInputs: () => pendingInputsRef.current.length > 0,
    onError: (error: Error) => {
      // Classify error to provide better user feedback
      const classification = classifyError(error);
      const categoryNames = ['Transient', 'Permanent', 'Tool Call ID', 'User Abort'];

      console.log(''); // Empty line for readability


      if (classification.category === ErrorCategory.USER_ABORT) {
        return;
      }

      // Show error type and message
      const categoryName = categoryNames[classification.category] || 'Unknown';
      console.log(chalk.red(`\u274C API Error (${categoryName}): ${error.message}`));

      // Show what's being done to recover
      if (classification.shouldCleanup) {
        console.log(chalk.cyan('   \u{1F9F9} Cleaned incomplete tool calls'));
      }

      // Show next steps for user
      if (classification.category === ErrorCategory.PERMANENT) {
        console.log(chalk.yellow('   \u{1F4A1} This error requires manual intervention. Please check:'));
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
          console.log(chalk.yellow(`   \u23F3 Will automatically retry (up to ${classification.maxRetries} times)`));
        }
      } else if (classification.category === ErrorCategory.TOOL_CALL_ID) {
        console.log(chalk.green('   \u2705 Session cleaned, ready to continue'));
      }

      console.log(''); // Empty line for readability
    },
    onRetry: (reason: string, attempt: number, maxAttempts: number) => {
      emitRetryHistoryItem(addHistoryItem, reason, attempt, maxAttempts);
    },
    onProviderRateLimit: (attempt: number, maxAttempts: number, delayMs: number) => {
      addHistoryItem({
        type: "info",
        icon: "\u23F3",
        text: `[Rate Limit] Retrying in ${delayMs / 1000}s (${attempt}/${maxAttempts})...`
      });
    },
    // Iteration start - called at the beginning of each agent iteration
    // Iteration start: called at the beginning of each agent iteration.
    onIterationStart: (iter: number, maxIter: number) => {
      // Update max iterations if provided

      if (maxIter) {
        setMaxIter(maxIter);
      }

      // Save current content to history and start fresh for new iteration
      // Save current content to history before starting the next round.
      // Fix: Always call startNewIteration to ensure currentIteration is properly set
      // Always call startNewIteration so currentIteration stays correct.

      const prevThinking = iter > 1 ? getThinkingContent().trim() : "";
      const prevResponse = iter > 1 ? getFullResponse().trim() : "";

      // Always update iteration counter BEFORE adding to history 
      // This implicitly clears the text buffer so we don't double-render the old streaming 
      // content simultaneously with the new static HistoryItem!
      startNewIteration(iter);
      startThinking();

      if (iter > 1) {
        // Issue 076 fix: Save previous iteration content to persistent history BEFORE clearing
        // Issue 076.

        // First, save thinking content (full content for history)

        if (prevThinking) {
          addHistoryItem({
            type: "thinking",
            text: prevThinking,
          });
        }

        // Then, save response content

        if (prevResponse) {
          addHistoryItem({
            type: "assistant",
            text: prevResponse,
          });
        }
      }
    },
    // Permission hook - called before each tool execution

    beforeToolExecute: async (tool: string, input: Record<string, unknown>): Promise<boolean | string> => {
      const mode = permissionModeRef.current; // Read the latest value from the ref, not currentConfig.permissionMode.
      const confirmTools = computeConfirmTools(mode);
      const alwaysAllowTools = alwaysAllowToolsRef.current;
      // Issue 052 fix: Read gitRoot from context prop, not options.context.
      const gitRoot = context.gitRoot;

      // === 1. Plan mode: block modification tools ===
      // Block file modification tools and undo
      if (mode === 'plan' && (FILE_MODIFICATION_TOOLS.has(tool) || tool === 'undo')) {
        return `[Blocked] Tool '${tool}' is not allowed in plan mode (read-only). ${PLAN_MODE_BLOCK_GUIDANCE}`;
      }

      // For bash in plan mode, only block write operations
      if (mode === 'plan' && tool === 'bash') {
        const command = (input.command as string) ?? '';
        if (isBashWriteCommand(command)) {
          return `[Blocked] Bash write operation not allowed in plan mode: ${command.slice(0, 50)}... ${PLAN_MODE_BLOCK_GUIDANCE}`;
        }
      }

      // === 2. Safe read-only bash commands: auto-allowed BEFORE protected path check ===
      // Issue 085: All modes should allow safe read commands without confirmation
      // Safe read-only bash commands are auto-allowed before protected path checks.
      if (tool === 'bash') {
        const command = (input.command as string) ?? '';
        if (isBashReadCommand(command)) {
          return true; // Auto-allowed for safe read-only commands in all modes
        }
      }

      // === 3. Protected paths: always confirm ===
      // Issue 052: Check both file tools AND bash commands for protected paths
      // Note: This runs AFTER safe read check, so only non-whitelisted bash commands are affected
      if (gitRoot) {
        let isProtected = false;

        // Check file modification tools (write, edit)
        if (FILE_MODIFICATION_TOOLS.has(tool)) {
          const targetPath = input.path as string | undefined;
          if (targetPath && isAlwaysConfirmPath(targetPath, gitRoot)) {
            isProtected = true;
          }
        }

        // Check bash commands for protected paths in arguments (only for non-read commands now)
        if (tool === 'bash') {
          const command = input.command as string | undefined;
          if (command && isCommandOnProtectedPath(command, gitRoot)) {
            isProtected = true;
          }
        }

        if (isProtected) {
          const result = await showConfirmDialog(tool, { ...input, _alwaysConfirm: true });

          // === RACE CONDITION FIX: Re-evaluate permission mode ===
          if (permissionModeRef.current === 'plan' && (FILE_MODIFICATION_TOOLS.has(tool) || tool === 'undo')) {
            return false;
          }

          if (permissionModeRef.current === 'plan' && tool === 'bash') {
            const command = (input.command as string) ?? '';
            if (isBashWriteCommand(command)) {
              return false;
            }
          }

          return result.confirmed;
        }
      }

      // === 4. Check if tool needs confirmation based on mode ===
      if (confirmTools.has(tool)) {
        // In accept-edits mode, check alwaysAllowTools for bash
        if (mode === 'accept-edits' && tool === 'bash') {
          if (isToolCallAllowed(tool, input, alwaysAllowTools)) {
            return true; // Auto-allowed
          }
        }

        // Show confirmation dialog
        const result = await showConfirmDialog(tool, input);

        // === RACE CONDITION FIX: Re-evaluate permission mode ===
        // The user might have pressed Ctrl+O to switch to 'plan' mode
        // WHILE the confirmation dialog was open and waiting.
        if (permissionModeRef.current === 'plan' && (FILE_MODIFICATION_TOOLS.has(tool) || tool === 'undo')) {
          return false;
        }

        if (permissionModeRef.current === 'plan' && tool === 'bash') {
          const command = (input.command as string) ?? '';
          if (isBashWriteCommand(command)) {
            return false;
          }
        }

        if (!result.confirmed) {
          // Issue 051: show cancellation feedback.
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
          // In plan mode, we don't save always-allow patterns
        }
      }

      return true;
    },
    // Issue 069: Ask user a question interactively.
    askUser: async (options: import("@kodax/coding").AskUserQuestionOptions): Promise<string> => {
      const selectedValue = await showSelectDialogWithOptions(
        getAskUserDialogTitle(options),
        toSelectOptions(options.options),
      );
      const resolvedValue = selectedValue ?? resolveAskUserDismissChoice(options);

      if (shouldSwitchToAcceptEdits(permissionModeRef.current, options, resolvedValue)) {
        setSessionPermissionMode("accept-edits");
      }

      return resolvedValue;
    },
    onCompactStart: () => {
      // Trigger the compacting UI indicator before actual compaction begins
      startCompacting();
    },
    onCompactStats: (info: { tokensBefore: number; tokensAfter: number }) => {
      lastCompactionTokensBeforeRef.current = info.tokensBefore;
      setLiveTokenCount(info.tokensAfter);
    },
    // Compaction event - notification only, do NOT clear UI history here

    onCompact: (estimatedTokens: number) => {
      // Stop the indicator now that it's complete
      stopCompacting();

      // Auto-compaction happened during agent execution
      // Insert a minimal info message into the UI history
      const tokensBefore = lastCompactionTokensBeforeRef.current ?? estimatedTokens;
      lastCompactionTokensBeforeRef.current = null;
      const prevK = Math.round(tokensBefore / 1000);
      addHistoryItem({
        type: "info",
        icon: "\u2728",
        text: `Context auto-compacted (was ~${prevK}k tokens)`,
      });
    },
    onCompactEnd: () => {
      // Just stop the indicator if compaction was skipped/aborted without changing the context
      lastCompactionTokensBeforeRef.current = null;
      stopCompacting();
    },
    // Iteration end - update live token count for real-time context usage display

    onIterationEnd: (info: { iter: number; maxIter: number; tokenCount: number }) => {
      setLiveTokenCount(info.tokenCount);
    },
  }), [appendThinkingChars, appendThinkingContent, stopThinking, appendResponse, setCurrentTool, appendToolInputChars, appendToolInputContent, startNewIteration, startThinking, currentConfig, context.gitRoot, startCompacting, stopCompacting, addHistoryItem]);

  // Helper function to show confirmation dialog

  const showConfirmDialog = (tool: string, input: Record<string, unknown>): Promise<ConfirmResult> => {
    // Build confirmation prompt text.
    let promptText: string;

    // Handle simple confirm dialog (used by project commands, etc.)
    // Handle the simple confirmation dialog used by project commands and similar flows.
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

    // Return a promise that resolves when the user answers.
    return new Promise<ConfirmResult>((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmRequest({ tool, input, prompt: promptText });
    });
  };

  // Run agent round
  const runAgentRound = async (
    opts: KodaXOptions,
    prompt: string,
    initialMessages: KodaXMessage[] = context.messages
  ): Promise<KodaXResult> => {
    const events = createStreamingEvents();

    // Get skills system prompt snippet for progressive disclosure (Issue 056)

    // Issue 064: Pass projectRoot to prevent singleton reset
    const skillRegistry = getSkillRegistry(context.gitRoot);
    const skillsPrompt = skillRegistry.getSystemPromptSnippet();

    return runKodaX(
      {
        ...opts,
        session: {
          ...opts.session,
          initialMessages,
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

  const persistContextState = useCallback(async () => {
    if (context.messages.length === 0) {
      return;
    }

    const title = extractTitle(context.messages);
    context.title = title;
    await storage.save(context.sessionId, {
      messages: context.messages,
      title,
      gitRoot: context.gitRoot ?? "",
    });
  }, [context, storage]);

  const recordCompletedAgentRound = useCallback(async (result: KodaXResult) => {
    context.messages = result.messages;

    const finalThinking = getThinkingContent().trim();
    const finalResponse = resolveAssistantHistoryText(result.messages, getFullResponse());

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
        text: result.interrupted ? `${finalResponse}\n\n[Interrupted]` : finalResponse,
      });
    }

    await persistContextState();
  }, [
    addHistoryItem,
    clearResponse,
    clearThinkingContent,
    context,
    getFullResponse,
    getThinkingContent,
    persistContextState,
  ]);

  const stageQueuedPrompt = useCallback(async (prompt: string) => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return;
    }

    addHistoryItem({
      type: "user",
      text: normalizedPrompt,
    });
    setSubmitCounter((prev) => prev + 1);
    touchContext(context);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }, [addHistoryItem, context]);

  const runQueueableAgentSequence = useCallback(async (
    initialPrompt: string,
    runRound: (prompt: string) => Promise<KodaXResult>,
  ) => {
    userInterruptedRef.current = false;
    setCanQueueFollowUps(true);
    try {
      return await runQueuedPromptSequence({
        initialPrompt,
        runRound,
        shiftPendingPrompt: shiftPendingInput,
        onRoundComplete: async (result) => {
          await recordCompletedAgentRound(result);
        },
        onBeforeQueuedRound: async (prompt) => {
          userInterruptedRef.current = false;
          await stageQueuedPrompt(prompt);
        },
        shouldContinue: (result) => !userInterruptedRef.current && result.success !== false,
      });
    } finally {
      setCanQueueFollowUps(false);
    }
  }, [recordCompletedAgentRound, shiftPendingInput, stageQueuedPrompt]);

  const appendLastAssistantToHistory = useCallback((messages: KodaXMessage[]) => {
    const lastAssistant = messages[messages.length - 1];
    if (lastAssistant?.role !== "assistant") {
      return;
    }

    const historySeeds = extractHistorySeedsFromMessage(lastAssistant);
    for (const item of historySeeds) {
      addHistoryItem(item);
    }
  }, [addHistoryItem]);

  const executeInvocation = useCallback(async (
    invocation: CommandInvocationRequest,
    rawInput: string
  ) => {
    const prepared = await prepareInvocationExecution(
      {
        ...currentOptionsRef.current,
        provider: currentConfig.provider,
        parallel: currentConfig.parallel,
        thinking: currentConfig.thinking,
        reasoningMode: currentConfig.reasoningMode,
      },
      invocation,
      rawInput,
      (message) => addHistoryItem({ type: "info", text: message })
    );

    if (prepared.mode === "manual") {
      if (prepared.manualOutput) {
        addHistoryItem({ type: "info", text: prepared.manualOutput });
      }
      await prepared.finalize();
      return;
    }

    if (!prepared.prompt || !prepared.options) {
      await prepared.finalize();
      return;
    }

    try {
      if (planMode) {
        await runWithPlanMode(prepared.prompt, prepared.options);
        await prepared.finalize();
        return;
      }

      const initialMessages = prepared.mode === "fork" ? [] : context.messages;
      const result = await runAgentRound(prepared.options, prepared.prompt, initialMessages);

      if (prepared.mode === "fork") {
        const lastAssistant = result.messages.slice().reverse().find((msg) => msg.role === "assistant");
        if (lastAssistant) {
          context.messages.push({
            role: "assistant",
            content: lastAssistant.content,
          });
          for (const item of extractHistorySeedsFromMessage(lastAssistant)) {
            addHistoryItem(item);
          }
        }
      } else {
        context.messages = result.messages;
        appendLastAssistantToHistory(result.messages);
      }

      await persistContextState();
      await prepared.finalize();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await prepared.finalize(error);
      throw error;
    }
  }, [
    addHistoryItem,
    appendLastAssistantToHistory,
    context,
    currentConfig.provider,
    currentConfig.thinking,
    planMode,
    persistContextState,
    runAgentRound,
  ]);

  // Handle user input submission
  const handleSubmit = useCallback(
    async (input: string) => {
      // Prevent concurrent execution: ignore input if agent is busy or waiting for tool confirmation
      // Prevent concurrent execution while the agent is busy or awaiting confirmation.
      if (!input.trim() || !isRunning || confirmRequest || uiRequest) return;

      // Hide help panel when submitting.
      setShowHelp(false);

      if (isLoading) {
        if (!canQueueFollowUps) {
          return;
        }
        if (streamingState.pendingInputs.length >= MAX_PENDING_INPUTS) {
          addHistoryItem({
            type: "info",
            icon: "\u23F3",
            text: `Queued follow-up limit reached (${MAX_PENDING_INPUTS}). Wait for the next round or press Esc to remove the latest item.`,
          });
          return;
        }
        addPendingInput(input);
        setInputText("");
        setIsInputEmpty(true);
        setSubmitCounter(prev => prev + 1);
        touchContext(context);
        return;
      }

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
      setInputText("");
      setIsInputEmpty(true);

      // Clear autocomplete suggestions space when message is sent
      // Clear reserved autocomplete space once a message is sent.
      setSubmitCounter(prev => prev + 1);

      setIsLoading(true);
      userInterruptedRef.current = false;
      clearResponse();
      clearIterationHistory(); // Clear iteration history for a new conversation.
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
          startNewSession: () => {
            const nextSessionId = generateSessionId();
            const now = new Date().toISOString();
            context.sessionId = nextSessionId;
            context.title = "";
            context.createdAt = now;
            context.lastAccessed = now;
            currentOptionsRef.current.session = {
              ...currentOptionsRef.current.session,
              id: nextSessionId,
            };
            setSessionId(nextSessionId);
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
          switchProvider: (provider: string, model?: string) => {
            setCurrentConfig((prev) => ({ ...prev, provider, model }));
            currentOptionsRef.current.provider = provider;
            currentOptionsRef.current.model = model;
          },
          setThinking: (enabled: boolean) => {
            const reasoningMode: KodaXReasoningMode = enabled ? 'auto' : 'off';
            setCurrentConfig((prev) => ({
              ...prev,
              thinking: enabled,
              reasoningMode,
            }));
            currentOptionsRef.current.thinking = enabled;
            currentOptionsRef.current.reasoningMode = reasoningMode;
          },
          setReasoningMode: (mode: KodaXReasoningMode) => {
            const thinking = mode !== 'off';
            setCurrentConfig((prev) => ({
              ...prev,
              thinking,
              reasoningMode: mode,
            }));
            currentOptionsRef.current.thinking = thinking;
            currentOptionsRef.current.reasoningMode = mode;
          },
          setParallel: (enabled: boolean) => {
            // Persistence is handled by the command layer; this callback only syncs runtime state and UI.
            setCurrentConfig((prev) => ({
              ...prev,
              parallel: enabled,
            }));
            currentOptionsRef.current.parallel = enabled;
          },
          setPermissionMode: (mode: PermissionMode) => {
            setSessionPermissionMode(mode);
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
            model: currentConfig.model,
            parallel: currentConfig.parallel,
            thinking: currentConfig.thinking,
            reasoningMode: currentConfig.reasoningMode,
            events: createStreamingEvents(), // Include streaming events for /project commands
          }),
          reloadAgentsFiles: async (): Promise<AgentsFile[]> => {
            return loadAgentsFiles({
              cwd: process.cwd(),
              projectRoot: context.gitRoot ?? undefined,
            });
          },
          // Start and stop the compacting indicator.
          startCompacting: () => {
            startCompacting();
          },
          stopCompacting: () => {
            stopCompacting();
          },
          // Confirmation callback for interactive commands.
          confirm: async (message: string): Promise<boolean> => {
            const result = await showConfirmDialog("confirm", {
              _alwaysConfirm: true,
              _message: message,
            });
            return result.confirmed;
          },
          // UI context for interactive dialogs.
          ui: {
            select: async (title: string, options: string[]): Promise<string | undefined> => {
              // Route through Ink-managed dialog state instead of reading stdin directly.
              return showSelectDialog(title, options);
              // TODO: Implement Ink-based select dialog
              // For now, use simple console-based selection
              console.log(`\n${title}`);
              console.log('\u2500'.repeat(title.length));
              options.forEach((option, index) => {
                console.log(`  ${index + 1}. ${option}`);
              });
              console.log('  0. Cancel');
              console.log('');

              // Use Ink's input to get selection
              return new Promise((resolve) => {
                const handleInput = (data: string) => {
                  const trimmed = data.trim();
                  if (trimmed === '0' || trimmed === '') {
                    resolve(undefined);
                    return;
                  }
                  const index = parseInt(trimmed, 10) - 1;
                  if (isNaN(index) || index < 0 || index >= options.length) {
                    console.log('Invalid choice.');
                    resolve(undefined);
                    return;
                  }
                  resolve(options[index]);
                };
                // Note: This is a temporary implementation
                // A proper implementation would use Ink components
                process.stdin.once('data', handleInput);
              });
            },
            confirm: async (message: string): Promise<boolean> => {
              const result = await showConfirmDialog("confirm", {
                _alwaysConfirm: true,
                _message: message,
              });
              return result.confirmed;
            },
            input: async (prompt: string, defaultValue?: string): Promise<string | undefined> => {
              // Route through Ink-managed dialog state instead of reading stdin directly.
              return showInputDialog(prompt, defaultValue);
              // TODO: Implement Ink-based input dialog
              // For now, use simple console-based input
              const promptText = defaultValue ? `${prompt} [${defaultValue}]: ` : `${prompt}: `;
              console.log(promptText);

              return new Promise((resolve) => {
                const handleInput = (data: string) => {
                  const trimmed = data.trim();
                  if (trimmed === '' && defaultValue !== undefined) {
                    resolve(defaultValue);
                    return;
                  }
                  resolve(trimmed || undefined);
                };
                process.stdin.once('data', handleInput);
              });
            },
          },
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

        let invocationToExecute: CommandInvocationRequest | undefined = undefined;
        let projectInitPromptToInject: string | undefined = undefined;

        try {
          const result = await executeCommand(parsed, context, callbacks, currentConfig);

          // Check if result contains invocation metadata to execute
          if (typeof result === 'object' && result !== null && 'invocation' in result) {
            invocationToExecute = result.invocation;
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

        // If a skill/prompt command returned an invocation request, execute it now
        if (invocationToExecute) {
          setIsLoading(false);
          stopStreaming();

          // Re-start streaming for skill execution
          setIsLoading(true);
          startStreaming();
          startThinking();

          try {
            await executeInvocation(invocationToExecute, input.trim());
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
            await runQueueableAgentSequence(
              projectInitPromptToInject,
              async (prompt) => runAgentRound(currentOptionsRef.current, prompt),
            );
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
            parallel: currentConfig.parallel,
            thinking: currentConfig.thinking,
            reasoningMode: currentConfig.reasoningMode,
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
        await runQueueableAgentSequence(
          processed,
          async (prompt) => runAgentRound(currentOptionsRef.current, prompt),
        );
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
      canQueueFollowUps,
      streamingState.pendingInputs.length,
      storage,
      confirmRequest,
      uiRequest,
      exit,
      onExit,
      addHistoryItem,
      clearUIHistory,
      startStreaming,
      stopStreaming,
      clearResponse,
      createStreamingEvents,
      executeInvocation,
      getSignal,
      getFullResponse,
      getThinkingContent,
      appendLastAssistantToHistory,
      persistContextState,
      runQueueableAgentSequence,
      startCompacting,
      stopCompacting,
    ]
  );

  return (
    <Box flexDirection="column" width={terminalWidth} flexShrink={0} flexGrow={0}>
      {/* Global Shortcuts - registers keyboard shortcuts (Issue 083) */}
      <GlobalShortcuts
        currentConfig={currentConfig}
        setCurrentConfig={setCurrentConfig}
        isLoading={isLoading}
        abort={abort}
        stopThinking={stopThinking}
        clearThinkingContent={clearThinkingContent}
        setCurrentTool={setCurrentTool}
        setIsLoading={setIsLoading}
        onToggleHelp={toggleHelp}
        setShowHelp={setShowHelp}
        onSetThinking={(enabled) => {
          currentOptionsRef.current.thinking = enabled;
        }}
        onSetReasoningMode={(mode) => {
          currentOptionsRef.current.reasoningMode = mode;
          currentOptionsRef.current.thinking = mode !== 'off';
        }}
        onSetPermissionMode={(mode) => {
          setSessionPermissionMode(mode);
        }}
        isInputEmpty={isInputEmpty}
        onSavePermissionMode={savePermissionModeUser}
      />

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

      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {displayItems.length > 0 && (
          <Box flexDirection="column">
            {/* 保留完整 transcript，避免响应结束后只剩最后一屏内容。 */}
            <MessageList
              items={displayItems}
              isLoading={displayIsLoading}
              isThinking={displayStreamingState.isThinking}
              thinkingCharCount={displayStreamingState.thinkingCharCount}
              thinkingContent={displayStreamingState.thinkingContent}
              streamingResponse={displayStreamingState.currentResponse}
              currentTool={displayStreamingState.currentTool}
              toolInputCharCount={displayStreamingState.toolInputCharCount}
              toolInputContent={displayStreamingState.toolInputContent}
              iterationHistory={displayStreamingState.iterationHistory}
              currentIteration={displayStreamingState.currentIteration}
              isCompacting={displayStreamingState.isCompacting}
              viewportRows={viewportBudget.messageRows}
              viewportWidth={terminalWidth}
              scrollOffset={historyScrollOffset}
              animateSpinners={!isLivePaused}
              windowed={isReviewingHistory}
            />
          </Box>
        )}

        {/* Loading/Thinking Indicator */}
        {displayIsLoading && displayItems.length === 0 && (
          <Box>
            <ThinkingIndicator message="Thinking" showSpinner />
          </Box>
        )}
      </Box>

      {/* Fixed bottom section: Input + Suggestions + Status */}
      {/* Fixed bottom section: Input + Suggestions + Status */}
      <Box flexDirection="column" flexShrink={0}>
        {/* Input Area - always at fixed position */}
        {/* Input area - always at a fixed position */}
        <Box flexDirection="column">
          <PendingInputsIndicator pendingInputs={streamingState.pendingInputs} />
          <InputPrompt
            onSubmit={handleSubmit}
            prompt=">"
            placeholder={isReviewingHistory
              ? "Reviewing history... Press Esc, End, Ctrl+Y, or Alt+Z to resume."
              : isLoading
              ? canQueueFollowUps
                ? "Queue a follow-up for the next round..."
                : "Agent is busy..."
              : "Type a message..."}
            focus={!confirmRequest && !uiRequest && !isReviewingHistory}
            cwd={process.cwd()}
            gitRoot={options.context?.gitRoot || context.gitRoot}
            onInputChange={handleInputChange}
          />
        </Box>

        {/* Autocomplete Suggestions - fixed 8-line container, expands downward */}

        {/* 这里始终占据预算层计算出来的高度，不把消息区的裁切交给 Ink 自己“碰运气”。 */}
        <AutocompleteSuggestions
          reserveSpace={suggestionsReservedForLayout}
          width={terminalWidth}
          hidden={isReviewingHistory}
        />

        {/* Keyboard Shortcuts Help Bar - shown when ? is pressed (Issue 083) */}
        {/* Keyboard shortcuts help bar - shown when ? is pressed */}
        {showHelp && (
          <Box flexDirection="column" paddingX={1}>
            <Text dimColor>
              {HELP_BAR_SEGMENTS.map((segment, index) => (
                <Text key={`${segment.text}-${index}`} color={segment.color} bold={segment.bold}>
                  {segment.text}
                </Text>
              ))}
            </Text>
          </Box>
        )}

        {/* Spacer between help and status bar */}
        {showHelp && <Box><Text> </Text></Box>}

        {reviewHintText && (
          <Box paddingX={1}>
            <Text dimColor>{reviewHintText}</Text>
          </Box>
        )}

        {/* Status Bar */}
        <Box>
          {/* 状态栏渲染和预算共用同一份文本格式化规则，尽量减少窄终端下的换行偏差。 */}
          <StatusBar {...statusBarProps} />
        </Box>

        {/* Confirmation dialog */}
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
            {confirmInstruction && (
              <Text dimColor>{confirmInstruction}</Text>
            )}
          </Box>
        )}

        {uiRequest && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            marginTop={1}
          >
            {uiRequest.kind === "select" ? (
              <>
                <Text color="cyan" bold>
                  [Select] {uiRequest.title}
                </Text>
                {/* 选项列表按 viewport budget 截断，保证输入区和最新消息至少还能保住一部分可见。 */}
                {uiRequest.options.slice(0, viewportBudget.visibleSelectOptions).map((option, index) => (
                  <Text key={`${option.value}-${index}`} dimColor>
                    {`${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`}
                  </Text>
                ))}
                {uiRequest.options.length > viewportBudget.visibleSelectOptions && (
                  <Text dimColor>{`${uiRequest.options.length - viewportBudget.visibleSelectOptions} more choices...`}</Text>
                )}
                <Text dimColor>{`Choice: ${uiRequest.buffer || "(type a number)"}`}</Text>
                <Text dimColor>Press Enter to confirm, Esc to cancel</Text>
              </>
            ) : (
              <>
                <Text color="cyan" bold>
                  [Input] {uiRequest.prompt}
                </Text>
                {uiRequest.defaultValue !== undefined && (
                  <Text dimColor>{`Default: ${uiRequest.defaultValue}`}</Text>
                )}
                <Text dimColor>{`Value: ${uiRequest.buffer || "(type your response)"}`}</Text>
                <Text dimColor>Press Enter to confirm, Esc to cancel</Text>
              </>
            )}
            {uiRequest.error && <Text color="red">{uiRequest.error}</Text>}
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
 * ShortcutsProvider provides centralized shortcuts management (Issue 083).
 */
const InkREPL: React.FC<InkREPLProps> = (props) => {
  const cwd = process.cwd();
  const gitRoot = props.options?.context?.gitRoot ?? undefined;

  return (
    <UIStateProvider>
      <StreamingProvider>
        <KeypressProvider>
          <ShortcutsProvider>
            <AutocompleteContextProvider cwd={cwd} gitRoot={gitRoot}>
              <InkREPLInner {...props} />
            </AutocompleteContextProvider>
          </ShortcutsProvider>
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
  const { resolveProvider, registerCustomProviders } = await import("@kodax/coding");

  const config = loadConfig();

  // Initialize custom providers from config.
  if (config.customProviders?.length) {
    registerCustomProviders(config.customProviders);
  }

  const initialProvider = options.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
  const initialModel = options.model ?? config.model;
  const initialReasoningMode = resolveInitialReasoningMode(options, config);
  const initialThinking = initialReasoningMode !== 'off';
  const initialParallel = options.parallel ?? config.parallel ?? false;
  // Load permission mode from config file (not from CLI options)
  // CLI is always YOLO mode; REPL uses config file for permission mode
  const initialPermissionMode: PermissionMode =
    (config.permissionMode as PermissionMode | undefined) ?? 'accept-edits';

  const currentConfig: CurrentConfig = {
    provider: initialProvider,
    model: initialModel,
    thinking: initialThinking,
    reasoningMode: initialReasoningMode,
    parallel: initialParallel,
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
    const providerInstance = resolveProvider(initialProvider);
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
