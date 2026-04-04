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
import clipboard from "clipboardy";
import { AmaWorkStrip, formatAmaWorkStripText } from "./components/AmaWorkStrip.js";
import { StatusBar } from "./components/StatusBar.js";
import { FullscreenTranscriptLayout } from "./components/FullscreenTranscriptLayout.js";
import { TranscriptViewport } from "./components/TranscriptViewport.js";
import { PromptComposer } from "./components/PromptComposer.js";
import { PromptFooter } from "./components/PromptFooter.js";
import { PromptHelpMenu } from "./components/PromptHelpMenu.js";
import { PromptSuggestionsSurface } from "./components/PromptSuggestionsSurface.js";
import { DialogSurface } from "./components/DialogSurface.js";
import { BackgroundTaskBar } from "./components/BackgroundTaskBar.js";
import { QueuedCommandsSurface } from "./components/QueuedCommandsSurface.js";
import { StatusNoticesSurface } from "./components/StatusNoticesSurface.js";
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
import {
  StreamingState,
  ToolCallStatus,
  type CreatableHistoryItem,
  type HistoryItem,
  type ToolCall,
  KeypressHandlerPriority,
} from "./types.js";
import {
  applySessionCompaction,
  buildSessionTree,
  createSessionLineage,
  KodaXOptions,
  KodaXMessage,
  KodaXManagedTaskStatusEvent,
  KodaXReasoningMode,
  KodaXResult,
  KodaXSessionUiHistoryItem,
  mergeArtifactLedger,
  runManagedTask,
  KODAX_DEFAULT_PROVIDER,
  KodaXTerminalError,
  classifyError,
  ErrorCategory,
  loadAgentsFiles,
  resolveRepoIntelligenceRuntimeConfig,
} from "@kodax/coding";
import type {
  AgentsFile,
  CompactionUpdate,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLineage,
} from "@kodax/coding";
import { estimateTokens } from "@kodax/agent";
import {
  PermissionMode,
  ConfirmResult,
  createPermissionContext,
  computeConfirmTools,
  normalizePermissionMode,
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
import {
  enforceSessionTransitionGuard,
} from "../interactive/session-guardrails.js";
import { formatSessionTree } from "../interactive/session-tree.js";
import type { CommandInvocationRequest } from "../commands/types.js";
import {
  formatReasoningCapabilityShort,
  getProviderModel,
  getProviderReasoningCapability,
} from "../common/utils.js";
import { buildToolConfirmationPrompt } from "../common/tool-confirmation.js";
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
import { processSpecialSyntax, isShellCommandHandled } from "./utils/shell-executor.js";
import {
  extractHistorySeedsFromMessage,
  resolveCompletedAssistantText,
  sanitizeUserFacingAssistantText,
  isControlPlaneOnlyAssistantText,
  extractTextContent,
  extractTitle,
} from "./utils/message-utils.js";
import { withCapture, ConsoleCapturer } from "./utils/console-capturer.js";
import { emitRetryHistoryItem } from "./utils/retry-history.js";
import {
  formatManagedTaskBreadcrumb,
  formatManagedTaskLiveStatusLabel,
  mergeLiveThinkingContent,
} from "./utils/live-streaming.js";
import { buildManagedRunContext } from "./utils/managed-run-context.js";
import { formatToolCallInlineText } from "./utils/tool-display.js";
import { calculateViewportBudget } from "./utils/viewport-budget.js";
import {
  buildTranscriptBrowseHint,
  closeTranscriptSearch,
  createTranscriptDisplayState,
  enterTranscriptHistory,
  exitTranscriptHistory,
  jumpTranscriptToLatest,
  openTranscriptSearch,
  setTranscriptSearchMatchIndex,
  setTranscriptScrollAnchor,
  setTranscriptSelectedItem,
  setTranscriptStickyPromptVisible,
  shouldPauseLiveTranscript,
  shouldWindowTranscript,
  supportsTranscriptMouseHistory,
  toggleTranscriptVerbosityState,
} from "./utils/transcript-state.js";
import { detectTerminalHostProfile } from "./utils/terminal-host-profile.js";
import { formatPendingInputsSummary, MAX_PENDING_INPUTS } from "./utils/pending-inputs.js";
import { runQueuedPromptSequence } from "./utils/queued-prompt-sequence.js";
import {
  buildHistoryItemTranscriptSections,
  capHistoryByTranscriptRows,
  resolveScrollOffsetForTranscriptItem,
  sliceHistoryToRecentRounds,
} from "./utils/transcript-layout.js";
import {
  buildTranscriptSearchSummary,
  buildTranscriptCopyText,
  buildTranscriptSelectionSummary,
  buildTranscriptToolInputCopyText,
  createTranscriptSearchIndex,
  getSelectableTranscriptItemIds,
  moveTranscriptSelection,
  resolveTranscriptSearchMatchIndex,
  searchTranscriptIndex,
  stepTranscriptSearchMatch,
} from "./utils/transcript-search.js";
import {
  getAskUserDialogTitle,
  resolveAskUserDismissChoice,
  shouldSwitchToAcceptEdits,
  toSelectOptions,
  type SelectOption,
} from "./utils/ask-user.js";
import { buildHelpBarSegments } from "./constants/layout.js";
import { buildStatusBarViewModel } from "./view-models/status-bar.js";
import { buildBackgroundTaskViewModel } from "./view-models/background-task.js";

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
  activeToolCalls: ToolCall[];
  toolInputCharCount: number;
  toolInputContent: string;
  lastLiveActivityLabel?: string;
  workStripText?: string;
  iterationHistory: import("./contexts/StreamingContext.js").IterationRecord[];
  currentIteration: number;
  isCompacting: boolean;
}

type StreamingEvents = import("@kodax/coding").KodaXEvents & {
  onCompactedMessages?: (messages: KodaXMessage[], update?: CompactionUpdate) => void;
};

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

export function buildManagedTaskTranscriptItems(result: KodaXResult): string[] {
  const task = result.managedTask;
  if (!task) {
    return [];
  }

  const isInterruptedCancellation = (entry: NonNullable<KodaXResult["managedTask"]>["evidence"]["entries"][number]): boolean => {
    if (!result.interrupted && !task.verdict.signalReason?.includes("Orchestration cancelled")) {
      return false;
    }
    const signalReason = entry.signalReason?.trim() ?? "";
    const summary = entry.summary?.trim() ?? "";
    const output = entry.output?.trim() ?? "";
    const cancelledSignal = signalReason.includes("Orchestration cancelled");
    const cancelledSummary = summary.includes("Orchestration cancelled");
    const emptyOrPlaceholderOutput = !output || summary === "No textual output produced.";
    return (
      (entry.status !== "completed" && (cancelledSignal || cancelledSummary || emptyOrPlaceholderOutput))
      || ((cancelledSignal || cancelledSummary) && emptyOrPlaceholderOutput)
    );
  };

  const routingTranscript = buildManagedTaskRoutingTranscript(task);

  const orderByAssignment = new Map(
    task.roleAssignments.map((assignment, index) => [assignment.id, index]),
  );
  const finalAssignmentId = task.verdict.decidedByAssignmentId;
  const finalRound = Math.max(
    0,
    ...task.evidence.entries
      .filter((entry) => entry.assignmentId === finalAssignmentId)
      .map((entry) => entry.round ?? 1),
  );

  const evidenceTranscripts = [...task.evidence.entries]
    .sort((left, right) => {
      const roundDelta = (left.round ?? 1) - (right.round ?? 1);
      if (roundDelta !== 0) {
        return roundDelta;
      }
      return (orderByAssignment.get(left.assignmentId) ?? 0) - (orderByAssignment.get(right.assignmentId) ?? 0);
    })
    .filter((entry) => !isInterruptedCancellation(entry))
    .filter((entry) => result.interrupted || !(
      entry.assignmentId === finalAssignmentId
      && (entry.round ?? 1) === finalRound
    ))
    .map((entry) => {
      const rawOutput = entry.output?.trim() ?? "";
      const rawSummary = entry.summary?.trim() ?? "";
      const sanitizedOutput = rawOutput ? sanitizeUserFacingAssistantText(rawOutput) : "";
      const sanitizedSummary = rawSummary ? sanitizeUserFacingAssistantText(rawSummary) : "";
      const fallbackText = entry.role === 'scout'
        ? sanitizedSummary
          ? `Scout completed: ${sanitizedSummary}`
          : 'Scout completed.'
        : sanitizedSummary;
      return {
        entry,
        text: sanitizedSummary || sanitizedOutput || fallbackText,
      };
    })
    .filter(({ text }) => Boolean(text))
    .map(({ entry, text }) => {
      const labelSuffix = entry.role === "scout"
        ? " Preflight"
        : (entry.round ?? 1) > 1
          ? ` Round ${entry.round}`
          : "";
      return `[${entry.title ?? entry.assignmentId}${labelSuffix}]\n${text}`;
    });
  return [
    ...(routingTranscript ? [routingTranscript] : []),
    ...evidenceTranscripts,
  ];
}

function buildManagedTaskRoutingTranscript(task: NonNullable<KodaXResult["managedTask"]>): string | undefined {
  const raw = task.runtime?.rawRoutingDecision;
  const final = task.runtime?.finalRoutingDecision;
  if (!raw || !final) {
    return undefined;
  }

  const lines = [
    "[Routing]",
    `AMA routing: raw=${raw.harnessProfile}(${raw.routingSource ?? "unknown"}) -> final=${final.harnessProfile}`,
    `Primary task: ${raw.primaryTask}`,
    `Review target: ${final.reviewTarget ?? "general"}`,
    `Review scale: ${final.reviewScale ?? "unknown"}`,
    `Solo boundary: ${raw.soloBoundaryConfidence?.toFixed(2) ?? "n/a"}`,
    `Independent QA: ${raw.needsIndependentQA ? "yes" : "no"}`,
    task.runtime?.qualityAssuranceMode
      ? `Quality assurance: ${task.runtime.qualityAssuranceMode}`
      : undefined,
    task.runtime?.budget
      ? `Adaptive budget: rounds=${task.runtime.budget.plannedRounds} total=${task.runtime.budget.totalBudget} reserve=${task.runtime.budget.reserveBudget}`
      : undefined,
    task.runtime?.routingOverrideReason
      ? `Override reason: ${task.runtime.routingOverrideReason}`
      : undefined,
    final.upgradeCeiling ? `Upgrade ceiling: ${final.upgradeCeiling}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
}

function truncateToolPreview(value: string, maxLength = 240): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}

function truncateToolOutputPreview(value: string, maxLength = 800): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}

function formatManagedLiveActivityLabel(label: string | undefined, workerTitle?: string): string | undefined {
  if (!label || !workerTitle) {
    return label;
  }
  const escapedWorkerTitle = workerTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return label
    .replace(new RegExp(`^\\[Tools\\]\\s+\\[${escapedWorkerTitle}\\]\\s+`, "i"), "[Tools] ")
    .replace(new RegExp(`^\\[Thinking\\]\\s+\\[${escapedWorkerTitle}\\]\\s*`, "i"), "[Thinking] ")
    .replace(new RegExp(`^\\[${escapedWorkerTitle}\\]\\s+thinking\\b`, "i"), "[Thinking]")
    .trim();
}

function formatManagedLiveToolLabel(tool: ToolCall, workerTitle?: string): string {
  return formatManagedLiveActivityLabel(
    `[Tools] ${formatToolCallInlineText(tool)}`,
    workerTitle,
  ) ?? `[Tools] ${formatToolCallInlineText(tool)}`;
}

function stripToolRolePrefix(toolName: string): string {
  return toolName
    .replace(/^\[[^\]]+\]\s+/, "")
    .replace(/^[A-Za-z][A-Za-z0-9_-]*:\s*/, "")
    .trim();
}

function normalizeToolNameForMatch(toolName: string): string {
  return stripToolRolePrefix(toolName).toLowerCase();
}

function sanitizeInterruptedAssistantText(text: string): string {
  if (isControlPlaneOnlyAssistantText(text)) {
    return "";
  }
  return sanitizeUserFacingAssistantText(text).trim();
}

export function buildInterruptedPersistenceItems(
  thinking: string,
  fullResponse: string,
  options?: {
    toolCalls?: readonly ToolCall[];
    toolNames?: readonly string[];
    infoItems?: readonly string[];
  },
): CreatableHistoryItem[] {
  const items: CreatableHistoryItem[] = [];
  const infoItems = options?.infoItems ?? [];
  const interruptedRoundItems = buildRoundHistoryItems({
    thinking,
    toolCalls: options?.toolCalls,
    toolNames: options?.toolNames,
  });

  for (const infoText of infoItems) {
    const normalized = infoText.trim();
    if (!normalized) {
      continue;
    }
    items.push({
      type: "info",
      text: normalized,
    });
  }

  items.push(...interruptedRoundItems);

  const unsavedResponse = sanitizeInterruptedAssistantText(fullResponse);
  if (unsavedResponse) {
    items.push({
      type: "assistant",
      text: `${unsavedResponse}\n\n[Interrupted]`,
    });
  }

  return items;
}

export function buildRoundHistoryItems({
  thinking,
  response,
  toolCalls,
  toolNames,
}: {
  thinking?: string;
  response?: string;
  toolCalls?: readonly ToolCall[];
  toolNames?: readonly string[];
}): CreatableHistoryItem[] {
  const items: CreatableHistoryItem[] = [];
  const normalizedThinking = thinking?.trim() ?? "";
  const normalizedResponse = response?.trim() ?? "";
  const normalizedToolCalls = toolCalls && toolCalls.length > 0 ? [...toolCalls] : [];
  const normalizedToolNames = toolNames && toolNames.length > 0 ? [...toolNames] : [];

  if (normalizedThinking) {
    items.push({
      type: "thinking",
      text: normalizedThinking,
    });
  }

  if (normalizedToolCalls.length > 0) {
    items.push({
      type: "tool_group",
      tools: normalizedToolCalls,
    });
  } else if (!normalizedThinking && !normalizedResponse && normalizedToolNames.length > 0) {
    items.push({
      type: "info",
      icon: "*",
      text: `Tools: ${normalizedToolNames.join(", ")}`,
    });
  }

  if (normalizedResponse) {
    items.push({
      type: "assistant",
      text: normalizedResponse,
    });
  }

  return items;
}

export function shouldShowStatusBarBusyStatus({
  agentMode,
  isLivePaused,
  isLoading,
}: {
  agentMode: string;
  isLivePaused: boolean;
  isLoading: boolean;
}): boolean {
  if (isLivePaused) {
    return false;
  }
  if (agentMode === "ama" && isLoading) {
    return false;
  }
  return true;
}

export function buildAmaWorkStripFromStatus(
  status: Pick<KodaXManagedTaskStatusEvent, "agentMode" | "childFanoutClass" | "childFanoutCount"> | null | undefined,
  isLoading: boolean,
): string | undefined {
  if (!isLoading || !status || status.agentMode !== "ama") {
    return undefined;
  }
  return formatAmaWorkStripText(status.childFanoutClass, status.childFanoutCount);
}

function toPersistedUiHistoryItem(
  item: { type: HistoryItem["type"]; text?: string },
): KodaXSessionUiHistoryItem | undefined {
  if (item.type === "tool_group") {
    return undefined;
  }

  const text = typeof item.text === "string" ? item.text.trimEnd() : "";
  if (!text) {
    return undefined;
  }

  return {
    type: item.type,
    text,
  };
}

function serializeUiHistorySnapshot(
  items: readonly HistoryItem[],
): KodaXSessionUiHistoryItem[] {
  return items
    .map((item) => toPersistedUiHistoryItem(item))
    .filter((item): item is KodaXSessionUiHistoryItem => Boolean(item));
}

function serializeCreatableHistoryItems(
  items: readonly CreatableHistoryItem[],
): KodaXSessionUiHistoryItem[] {
  return items
    .map((item) => toPersistedUiHistoryItem(item))
    .filter((item): item is KodaXSessionUiHistoryItem => Boolean(item));
}

export function appendPersistedUiHistorySnapshot(
  currentHistory: readonly KodaXSessionUiHistoryItem[],
  items: readonly CreatableHistoryItem[],
): KodaXSessionUiHistoryItem[] {
  if (items.length === 0) {
    return [...currentHistory];
  }
  return [
    ...currentHistory,
    ...serializeCreatableHistoryItems(items),
  ];
}

function logSessionTransitionGuard(
  status: "warn" | "block",
  headline: string,
  details: string[],
): void {
  console.log((status === "block" ? chalk.red : chalk.yellow)(headline));
  details.forEach((detail) => console.log(chalk.dim(detail)));
}

/**
 * Banner component - displayed inside Ink UI so it's part of the alternate buffer
 */
const Banner: React.FC<BannerProps> = ({ config, sessionId, workingDir, compactionInfo }) => {
  const theme = getTheme("dark");
  const model = config.model ?? getProviderModel(config.provider) ?? config.provider;
  const reasoningCapability = getProviderReasoningCapability(config.provider, config.model);
  const reasoningCapabilityShort = formatReasoningCapabilityShort(reasoningCapability);
  const terminalWidth = process.stdout.columns ?? 80;
  const dividerWidth = Math.min(60, terminalWidth - 4);

  const logoLines = [
    "  _  __          _        __  __",
    " | |/ /___   __| | __ _ \\ \\/ /",
    " | ' // _ \\\\ / _` |/ _` | \\\\  / ",
    " | . \\ (_) | (_| | (_| | /  \\ ",
    " |_|\\_\\___/ \\__,_|\\__,_|/_/\\_\\",
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
        <Text color={theme.colors.primary}>
          {config.agentMode.toUpperCase()}
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
          {config.parallel ? "parallel" : "sequential"}
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
  const historyRef = useRef(history);
  const persistedUiHistoryRef = useRef<KodaXSessionUiHistoryItem[]>(
    serializeUiHistorySnapshot(history),
  );

  useEffect(() => {
    historyRef.current = history;
    persistedUiHistoryRef.current = serializeUiHistorySnapshot(history);
  }, [history]);

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
    clearToolInputContent,
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
  const terminalHostProfile = useMemo(() => detectTerminalHostProfile(), []);
  const lastCompactionTokensBeforeRef = useRef<number | null>(null);
  const persistContextStateRef = useRef<((uiHistoryOverride?: KodaXSessionUiHistoryItem[]) => Promise<void>) | null>(null);
  const persistContextStateQueueRef = useRef<Promise<void>>(Promise.resolve());
  const appendHistoryItemsWithPersistenceRef = useRef<((items: readonly CreatableHistoryItem[]) => void) | null>(null);
  const interruptPersistenceQueuedRef = useRef(false);
  const [isInputEmpty, setIsInputEmpty] = useState(true); // Track if input is empty for ? shortcut
  const [inputText, setInputText] = useState("");
  const [transcriptDisplayState, setTranscriptDisplayState] = useState(() => (
    createTranscriptDisplayState(terminalHostProfile)
  ));
  const [historyScrollOffset, setHistoryScrollOffset] = useState(0);
  const [expandedTranscriptItemIds, setExpandedTranscriptItemIds] = useState<Set<string>>(() => new Set());
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewSnapshot | null>(null);
  const [managedTaskStatus, setManagedTaskStatus] = useState<KodaXManagedTaskStatusEvent | null>(null);
  const [lastLiveActivityLabel, setLastLiveActivityLabel] = useState<string | undefined>(undefined);
  const [visibleWorkStripText, setVisibleWorkStripText] = useState<string | undefined>(undefined);
  const managedTaskStatusRef = useRef<KodaXManagedTaskStatusEvent | null>(null);
  const managedTaskBreadcrumbRef = useRef<string | null>(null);
  const showWorkStripTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hideWorkStripTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const iterationToolsRef = useRef<string[]>([]);
  const iterationToolCallsRef = useRef<ToolCall[]>([]);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCall[]>([]);
  const activeToolCallsRef = useRef<ToolCall[]>([]);

  const setLiveToolCalls = useCallback((nextToolCalls: ToolCall[]) => {
    activeToolCallsRef.current = nextToolCalls;
    setActiveToolCalls(nextToolCalls);
  }, []);

  const upsertIterationToolCall = useCallback((nextTool: ToolCall) => {
    const existingIndex = iterationToolCallsRef.current.findIndex((tool) => tool.id === nextTool.id);
    if (existingIndex === -1) {
      iterationToolCallsRef.current = [...iterationToolCallsRef.current, nextTool];
      return;
    }
    iterationToolCallsRef.current = iterationToolCallsRef.current.map((tool) => (
      tool.id === nextTool.id ? nextTool : tool
    ));
  }, []);

  const findLatestExecutingTool = useCallback((toolName?: string): ToolCall | undefined => {
    const executingTools = activeToolCallsRef.current.filter((tool) => tool.status === ToolCallStatus.Executing);
    if (executingTools.length === 0) {
      return undefined;
    }

    if (toolName) {
      const normalizedName = normalizeToolNameForMatch(toolName);
      for (let index = executingTools.length - 1; index >= 0; index -= 1) {
        const candidate = executingTools[index];
        if (normalizeToolNameForMatch(candidate.name) === normalizedName) {
          return candidate;
        }
      }
    }

    return executingTools[executingTools.length - 1];
  }, []);

  const syncCurrentToolFromLiveCalls = useCallback(() => {
    const latestExecutingTool = findLatestExecutingTool();
    setCurrentTool(latestExecutingTool ? stripToolRolePrefix(latestExecutingTool.name) : undefined);
  }, [findLatestExecutingTool, setCurrentTool]);

  const addLiveToolCall = useCallback((toolCall: ToolCall) => {
    upsertIterationToolCall(toolCall);
    setLiveToolCalls([
      ...activeToolCallsRef.current.filter((tool) => tool.id !== toolCall.id),
      toolCall,
    ]);
    syncCurrentToolFromLiveCalls();
    return toolCall;
  }, [setLiveToolCalls, syncCurrentToolFromLiveCalls, upsertIterationToolCall]);

  const updateLiveToolCallById = useCallback((toolId: string, updater: (tool: ToolCall) => ToolCall) => {
    const current = activeToolCallsRef.current.find((tool) => tool.id === toolId);
    if (!current) {
      return null;
    }
    const next = updater(current);
    upsertIterationToolCall(next);
    setLiveToolCalls(activeToolCallsRef.current.map((tool) => (
      tool.id === toolId ? next : tool
    )));
    syncCurrentToolFromLiveCalls();
    return next;
  }, [setLiveToolCalls, syncCurrentToolFromLiveCalls, upsertIterationToolCall]);

  const updateExecutingTool = useCallback((
    toolId: string | undefined,
    toolName: string | undefined,
    updater: (tool: ToolCall) => ToolCall,
  ) => {
    if (toolId) {
      const updated = updateLiveToolCallById(toolId, updater);
      if (updated) {
        return updated;
      }
    }
    const target = findLatestExecutingTool(toolName);
    if (!target) {
      return null;
    }
    return updateLiveToolCallById(target.id, updater);
  }, [findLatestExecutingTool, updateLiveToolCallById]);

  const finalizeLiveToolCall = useCallback((
    toolId: string | undefined,
    status: ToolCallStatus,
    error?: string,
    output?: unknown,
    fallbackToolName?: string,
  ) => {
    const resolvedToolId = toolId ?? findLatestExecutingTool(fallbackToolName)?.id;
    if (!resolvedToolId) {
      return null;
    }
    return updateLiveToolCallById(resolvedToolId, (tool) => ({
      ...tool,
      status,
      endTime: Date.now(),
      error,
      output,
    }));
  }, [findLatestExecutingTool, updateLiveToolCallById]);

  const finalizeAllExecutingToolCalls = useCallback((
    status: ToolCallStatus,
    resolvePatch: (tool: ToolCall) => Pick<ToolCall, "error" | "output">,
  ): ToolCall[] => {
    const finalizedAt = Date.now();
    const updates = new Map<string, ToolCall>();
    for (const tool of activeToolCallsRef.current) {
      if (tool.status !== ToolCallStatus.Executing) {
        continue;
      }
      const patch = resolvePatch(tool);
      updates.set(tool.id, {
        ...tool,
        status,
        endTime: finalizedAt,
        ...patch,
      });
    }

    if (updates.size === 0) {
      return [];
    }

    iterationToolCallsRef.current = iterationToolCallsRef.current.map((tool) => (
      updates.get(tool.id) ?? tool
    ));
    setLiveToolCalls(activeToolCallsRef.current.map((tool) => updates.get(tool.id) ?? tool));
    syncCurrentToolFromLiveCalls();
    return [...updates.values()];
  }, [setLiveToolCalls, syncCurrentToolFromLiveCalls]);

  const resetLiveToolCalls = useCallback(() => {
    setLiveToolCalls([]);
  }, [setLiveToolCalls]);

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
  const clearWorkStripTimers = useCallback(() => {
    if (showWorkStripTimeoutRef.current) {
      clearTimeout(showWorkStripTimeoutRef.current);
      showWorkStripTimeoutRef.current = null;
    }
    if (hideWorkStripTimeoutRef.current) {
      clearTimeout(hideWorkStripTimeoutRef.current);
      hideWorkStripTimeoutRef.current = null;
    }
  }, []);

  // Keep reserving suggestion space after the first appearance so the footer
  // layout does not jump while the user edits the prompt.
  useEffect(() => {
    if (hasVisibleSuggestions && !shouldReserveSuggestionsSpace) {
      setShouldReserveSuggestionsSpace(true);
    }
  }, [hasVisibleSuggestions, shouldReserveSuggestionsSpace]);

  // Only release reserved suggestion space after submit so inline suggestion
  // visibility changes do not collapse the footer immediately.
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
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historySearchSelectedIndex, setHistorySearchSelectedIndex] = useState(0);
  const lastHistorySearchQueryRef = useRef("");

  // Issue 070: Calculate context token usage for status bar display
  // Issue 070: Calculate context token usage for status bar display
  // Issue 070: calculate context token usage for the status bar.
  const contextUsage = useMemo(() => {
    if (!compactionInfo) return undefined;

    const { contextWindow, triggerPercent } = compactionInfo;
    const currentTokens =
      liveTokenCount ??
      context.contextTokenSnapshot?.currentTokens ??
      estimateTokens(context.messages);

    return {
      currentTokens,
      contextWindow,
      triggerPercent,
    };
  }, [context.messages, context.contextTokenSnapshot, compactionInfo, liveTokenCount]);

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

  const isHistorySearchActive = transcriptDisplayState.searchMode === "history";
  const isAwaitingUserInteraction = !!confirmRequest || !!uiRequest || isHistorySearchActive;
  const isReviewingHistory = transcriptDisplayState.followMode === "browsing-history";
  const isTranscriptVerbose = transcriptDisplayState.verbosity === "verbose";
  const transcriptOwnsViewport = shouldWindowTranscript(transcriptDisplayState);
  const isLivePaused = shouldPauseLiveTranscript(transcriptDisplayState) || isAwaitingUserInteraction;
  const suggestionsReservedForLayout = shouldReserveSuggestionsSpace && !isReviewingHistory;

  const createReviewSnapshot = useCallback((): ReviewSnapshot => ({
    items: isReviewingHistory ? reviewHistory : renderHistory,
    isLoading,
    isThinking: streamingState.isThinking,
    thinkingCharCount: streamingState.thinkingCharCount,
    thinkingContent: streamingState.thinkingContent,
    currentResponse: streamingState.currentResponse,
    currentTool: streamingState.currentTool,
    activeToolCalls,
    toolInputCharCount: streamingState.toolInputCharCount,
    toolInputContent: streamingState.toolInputContent,
    lastLiveActivityLabel,
    workStripText: visibleWorkStripText,
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
    activeToolCalls,
    streamingState.toolInputCharCount,
    streamingState.toolInputContent,
    lastLiveActivityLabel,
    visibleWorkStripText,
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
    activeToolCalls: displaySnapshot?.activeToolCalls ?? activeToolCalls,
    toolInputCharCount: displaySnapshot?.toolInputCharCount ?? streamingState.toolInputCharCount,
    toolInputContent: displaySnapshot?.toolInputContent ?? streamingState.toolInputContent,
    lastLiveActivityLabel: displaySnapshot?.lastLiveActivityLabel ?? lastLiveActivityLabel,
    iterationHistory: displaySnapshot?.iterationHistory ?? streamingState.iterationHistory,
    currentIteration: displaySnapshot?.currentIteration ?? streamingState.currentIteration,
    isCompacting: displaySnapshot?.isCompacting ?? streamingState.isCompacting,
  };
  const rawWorkStripText = useMemo(
    () => buildAmaWorkStripFromStatus(managedTaskStatus, isLoading),
    [managedTaskStatus, isLoading],
  );
  const displayWorkStripText = displaySnapshot?.workStripText ?? visibleWorkStripText;
  const selectableTranscriptItemIds = useMemo(
    () => getSelectableTranscriptItemIds(displayItems),
    [displayItems],
  );
  const selectedTranscriptItemId = transcriptDisplayState.selectedItemId;
  const selectedTranscriptItem = useMemo(
    () => displayItems.find((item) => item.id === selectedTranscriptItemId),
    [displayItems, selectedTranscriptItemId],
  );
  const selectedTranscriptItemIndex = selectedTranscriptItemId
    ? selectableTranscriptItemIds.indexOf(selectedTranscriptItemId)
    : -1;
  const selectedTranscriptItemSummary = useMemo(
    () => buildTranscriptSelectionSummary(selectedTranscriptItem),
    [selectedTranscriptItem],
  );
  const transcriptSearchIndex = useMemo(
    () => createTranscriptSearchIndex(displayItems),
    [displayItems],
  );
  const historySearchMatches = useMemo(
    () => searchTranscriptIndex(transcriptSearchIndex, historySearchQuery),
    [transcriptSearchIndex, historySearchQuery],
  );
  const clampedHistorySearchSelectedIndex = useMemo(
    () => Math.min(historySearchSelectedIndex, Math.max(0, historySearchMatches.length - 1)),
    [historySearchMatches.length, historySearchSelectedIndex],
  );
  const historySearchStatusText = useMemo(
    () => buildTranscriptSearchSummary(historySearchMatches, clampedHistorySearchSelectedIndex),
    [clampedHistorySearchSelectedIndex, historySearchMatches],
  );
  const isSelectedTranscriptItemExpanded = selectedTranscriptItemId
    ? expandedTranscriptItemIds.has(selectedTranscriptItemId)
    : false;
  const canCopySelectedToolInput = selectedTranscriptItem?.type === "tool_group";

  useEffect(() => {
    if (rawWorkStripText) {
      if (hideWorkStripTimeoutRef.current) {
        clearTimeout(hideWorkStripTimeoutRef.current);
        hideWorkStripTimeoutRef.current = null;
      }
      if (visibleWorkStripText === rawWorkStripText) {
        return;
      }
      if (visibleWorkStripText) {
        if (showWorkStripTimeoutRef.current) {
          clearTimeout(showWorkStripTimeoutRef.current);
          showWorkStripTimeoutRef.current = null;
        }
        setVisibleWorkStripText(rawWorkStripText);
        return;
      }
      if (showWorkStripTimeoutRef.current) {
        clearTimeout(showWorkStripTimeoutRef.current);
      }
      showWorkStripTimeoutRef.current = setTimeout(() => {
        setVisibleWorkStripText(rawWorkStripText);
        showWorkStripTimeoutRef.current = null;
      }, 400);
      return;
    }

    if (!visibleWorkStripText) {
      if (showWorkStripTimeoutRef.current) {
        clearTimeout(showWorkStripTimeoutRef.current);
        showWorkStripTimeoutRef.current = null;
      }
      return;
    }

    if (showWorkStripTimeoutRef.current) {
      clearTimeout(showWorkStripTimeoutRef.current);
      showWorkStripTimeoutRef.current = null;
    }
    if (hideWorkStripTimeoutRef.current) {
      clearTimeout(hideWorkStripTimeoutRef.current);
    }
    hideWorkStripTimeoutRef.current = setTimeout(() => {
      setVisibleWorkStripText(undefined);
      hideWorkStripTimeoutRef.current = null;
    }, 300);
  }, [clearWorkStripTimers, rawWorkStripText, visibleWorkStripText]);

  useEffect(() => () => {
    clearWorkStripTimers();
  }, [clearWorkStripTimers]);

  const reviewHintText = useMemo(() => {
    return buildTranscriptBrowseHint(transcriptDisplayState);
  }, [transcriptDisplayState]);

  const stickyPromptText = useMemo(() => {
    if (!transcriptDisplayState.supportsStickyPrompt || !transcriptDisplayState.stickyPromptVisible) {
      return undefined;
    }

    if (isHistorySearchActive) {
      const query = historySearchQuery.trim();
      return query
        ? `Searching transcript for "${query}"`
        : "Searching transcript history";
    }

    if (isAwaitingUserInteraction) {
      return "Interaction active - transcript follow is paused";
    }

    if (isReviewingHistory) {
      return "Browsing transcript history";
    }

    return undefined;
  }, [
    historySearchQuery,
    isAwaitingUserInteraction,
    isHistorySearchActive,
    isReviewingHistory,
    transcriptDisplayState.stickyPromptVisible,
    transcriptDisplayState.supportsStickyPrompt,
  ]);

  const jumpToLatestText = useMemo(() => {
    if (!transcriptOwnsViewport || !transcriptDisplayState.supportsViewportChrome) {
      return undefined;
    }
    if (!transcriptDisplayState.jumpToLatestAvailable) {
      return undefined;
    }
    return "Jump to latest: End";
  }, [
    transcriptDisplayState.jumpToLatestAvailable,
    transcriptDisplayState.supportsViewportChrome,
    transcriptOwnsViewport,
  ]);

  useEffect(() => {
    setTranscriptDisplayState((prev) => {
      let next = setTranscriptScrollAnchor(prev, historyScrollOffset);
      next = setTranscriptStickyPromptVisible(next, isReviewingHistory || isAwaitingUserInteraction);
      next = setTranscriptSearchMatchIndex(next, clampedHistorySearchSelectedIndex);
      return next;
    });
  }, [
    clampedHistorySearchSelectedIndex,
    historyScrollOffset,
    isAwaitingUserInteraction,
    isReviewingHistory,
  ]);

  useEffect(() => {
    if (historySearchSelectedIndex === clampedHistorySearchSelectedIndex) {
      return;
    }
    setHistorySearchSelectedIndex(clampedHistorySearchSelectedIndex);
  }, [clampedHistorySearchSelectedIndex, historySearchSelectedIndex]);

  useEffect(() => {
    if (!isHistorySearchActive) {
      lastHistorySearchQueryRef.current = historySearchQuery;
      return;
    }

    if (historySearchQuery === lastHistorySearchQueryRef.current) {
      return;
    }

    lastHistorySearchQueryRef.current = historySearchQuery;
    const nextIndex = resolveTranscriptSearchMatchIndex(
      transcriptSearchIndex,
      historySearchMatches,
      transcriptDisplayState.searchAnchorItemId,
    );
    setHistorySearchSelectedIndex(nextIndex);
  }, [
    historySearchMatches,
    historySearchQuery,
    isHistorySearchActive,
    transcriptDisplayState.searchAnchorItemId,
    transcriptSearchIndex,
  ]);

  const statusBarProps = useMemo(() => ({
    sessionId: context.sessionId,
    permissionMode: currentConfig.permissionMode,
    agentMode: currentConfig.agentMode,
    parallel: currentConfig.parallel,
    provider: currentConfig.provider,
    model: currentConfig.model ?? getProviderModel(currentConfig.provider) ?? currentConfig.provider,
    currentTool: displayStreamingState.currentTool,
    activeToolCount: displayStreamingState.activeToolCalls.filter((tool) => tool.status === ToolCallStatus.Executing).length,
    thinking: currentConfig.thinking,
    reasoningMode: currentConfig.reasoningMode,
            reasoningCapability: formatReasoningCapabilityShort(
              getProviderReasoningCapability(currentConfig.provider, currentConfig.model),
            ),
    isThinkingActive: displayStreamingState.isThinking,
    thinkingCharCount: displayStreamingState.thinkingCharCount,
    toolInputCharCount: displayStreamingState.toolInputCharCount,
    toolInputContent: displayStreamingState.toolInputContent,
    currentIteration: displayStreamingState.currentIteration,
    maxIter: streamingState.maxIter,
    contextUsage,
    isCompacting: displayStreamingState.isCompacting,
    showBusyStatus: shouldShowStatusBarBusyStatus({
      agentMode: currentConfig.agentMode,
      isLivePaused,
      isLoading: displayIsLoading,
    }),
    managedPhase: displayIsLoading ? managedTaskStatus?.phase : undefined,
    managedHarnessProfile: displayIsLoading ? managedTaskStatus?.harnessProfile : undefined,
    managedWorkerTitle: displayIsLoading ? managedTaskStatus?.activeWorkerTitle : undefined,
    managedRound: displayIsLoading ? managedTaskStatus?.currentRound : undefined,
    managedMaxRounds: displayIsLoading ? managedTaskStatus?.maxRounds : undefined,
    managedGlobalWorkBudget: displayIsLoading ? managedTaskStatus?.globalWorkBudget : undefined,
    managedBudgetUsage: displayIsLoading ? managedTaskStatus?.budgetUsage : undefined,
    managedBudgetApprovalRequired: displayIsLoading ? managedTaskStatus?.budgetApprovalRequired : undefined,
  }), [
    context.sessionId,
    currentConfig.permissionMode,
    currentConfig.agentMode,
    currentConfig.parallel,
    currentConfig.provider,
    currentConfig.model,
    currentConfig.thinking,
    currentConfig.reasoningMode,
    displayStreamingState.currentTool,
    displayStreamingState.activeToolCalls,
    displayStreamingState.isThinking,
    displayStreamingState.thinkingCharCount,
    displayStreamingState.toolInputCharCount,
    displayStreamingState.toolInputContent,
    displayStreamingState.currentIteration,
    streamingState.maxIter,
    displayStreamingState.isCompacting,
    contextUsage,
    isLivePaused,
    displayIsLoading,
    managedTaskStatus,
  ]);

  const statusBarViewModel = useMemo(
    () => buildStatusBarViewModel(statusBarProps),
    [statusBarProps],
  );
  const statusBarText = statusBarViewModel.text;
  const pendingInputSummary = useMemo(
    () => formatPendingInputsSummary(streamingState.pendingInputs),
    [streamingState.pendingInputs]
  );
  const footerHeaderLeft = useMemo(() => {
    if (historySearchQuery.trim()) {
      return `Search: ${historySearchQuery.trim()}`;
    }
    if (streamingState.pendingInputs.length > 0) {
      return `Queued follow-ups: ${streamingState.pendingInputs.length}`;
    }
    return undefined;
  }, [historySearchQuery, streamingState.pendingInputs.length]);
  const footerHeaderRight = useMemo(() => {
    const hostMode = transcriptDisplayState.supportsFullscreenLayout ? "fullscreen" : "fallback";
    return `${terminalHostProfile} | ${transcriptDisplayState.verbosity} | ${hostMode}`;
  }, [terminalHostProfile, transcriptDisplayState.supportsFullscreenLayout, transcriptDisplayState.verbosity]);
  const backgroundTaskViewModel = useMemo(
    () => buildBackgroundTaskViewModel({
      isLoading: displayIsLoading,
      activeWorkerTitle: managedTaskStatus?.activeWorkerTitle,
      activePhase: managedTaskStatus?.phase ?? (currentConfig.agentMode === "ama" ? "AMA active" : "Working"),
      parallelText: displayWorkStripText,
    }),
    [currentConfig.agentMode, displayIsLoading, displayWorkStripText, managedTaskStatus],
  );
  const useOverlaySurface =
    transcriptDisplayState.supportsOverlaySurface
    && transcriptDisplayState.supportsSearchViewport
    && transcriptOwnsViewport;
  const historySearchBudgetState = useMemo(
    () => (
      isHistorySearchActive
        ? {
            query: historySearchQuery,
            matches: historySearchMatches.map((match) => ({
              itemId: match.itemId,
              excerpt: match.excerpt,
            })),
            selectedIndex: clampedHistorySearchSelectedIndex,
          }
        : null
    ),
    [clampedHistorySearchSelectedIndex, historySearchMatches, historySearchQuery, isHistorySearchActive],
  );
  const terminalRows = stdout.rows || process.stdout.rows || 24;
  const viewportBudget = useMemo(
    // Budget transcript, footer, overlay, status, and task slots together so
    // the viewport always receives a stable number of visible rows.
    () => calculateViewportBudget({
      terminalRows,
      terminalWidth,
      inputText,
      footerHeaderText: footerHeaderRight,
      pendingInputSummary,
      statusNoticeSummary: footerHeaderLeft,
      workStripText: displayWorkStripText,
      suggestionsReserved: suggestionsReservedForLayout,
      suggestionsMode: useOverlaySurface ? "overlay" : "inline",
      showHelp,
      statusBarText,
      confirmPrompt: confirmRequest?.prompt,
      confirmInstruction,
      dialogMode: useOverlaySurface ? "overlay" : "inline",
      historySearch: historySearchBudgetState
        ? {
            query: historySearchBudgetState.query,
            selectedExcerpt:
              historySearchBudgetState.matches[historySearchBudgetState.selectedIndex]?.excerpt,
            matchCount: historySearchBudgetState.matches.length,
          }
        : null,
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
      footerHeaderRight,
      pendingInputSummary,
      footerHeaderLeft,
      displayWorkStripText,
      suggestionsReservedForLayout,
      useOverlaySurface,
      showHelp,
      statusBarText,
      confirmRequest,
      confirmInstruction,
      historySearchBudgetState,
      reviewHintText,
      uiRequest,
    ]
  );
  const suggestionsSurface = useMemo(
    () => (
      <PromptSuggestionsSurface
        reserveSpace={suggestionsReservedForLayout}
        width={terminalWidth}
        hidden={isReviewingHistory || isHistorySearchActive}
        mode={useOverlaySurface ? "overlay" : "inline"}
      />
    ),
    [
      suggestionsReservedForLayout,
      terminalWidth,
      isReviewingHistory,
      isHistorySearchActive,
      useOverlaySurface,
    ],
  );
  const reviewPageSize = useMemo(
    () => Math.max(1, viewportBudget.messageRows - 2),
    [viewportBudget.messageRows]
  );
  const reviewWheelStep = useMemo(
    () => Math.max(3, Math.floor(reviewPageSize / 4)),
    [reviewPageSize]
  );
  const transcriptMaxLines = isTranscriptVerbose || isReviewingHistory ? 1000 : 12;

  const alignTranscriptSelection = useCallback((itemId: string | undefined) => {
    if (!itemId) {
      return;
    }
    const sections = buildHistoryItemTranscriptSections(
      displayItems,
      terminalWidth,
      transcriptMaxLines,
      isTranscriptVerbose || isReviewingHistory,
      expandedTranscriptItemIds,
    );
    const nextOffset = resolveScrollOffsetForTranscriptItem(
      sections,
      itemId,
      viewportBudget.messageRows,
    );
    setHistoryScrollOffset(nextOffset);
  }, [
    displayItems,
    terminalWidth,
    transcriptMaxLines,
    isTranscriptVerbose,
    isReviewingHistory,
    expandedTranscriptItemIds,
    viewportBudget.messageRows,
  ]);

  const selectTranscriptItem = useCallback((itemId: string | undefined) => {
    setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, itemId));
    if (itemId) {
      alignTranscriptSelection(itemId);
    }
  }, [alignTranscriptSelection]);

  const cycleTranscriptSelection = useCallback((direction: "prev" | "next") => {
    const nextItemId = moveTranscriptSelection(
      selectableTranscriptItemIds,
      selectedTranscriptItemId,
      direction,
    );
    if (nextItemId) {
      selectTranscriptItem(nextItemId);
    }
  }, [selectableTranscriptItemIds, selectedTranscriptItemId, selectTranscriptItem]);

  const toggleSelectedTranscriptDetail = useCallback(() => {
    if (!selectedTranscriptItemId) {
      return;
    }
    setExpandedTranscriptItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(selectedTranscriptItemId)) {
        next.delete(selectedTranscriptItemId);
      } else {
        next.add(selectedTranscriptItemId);
      }
      return next;
    });
  }, [selectedTranscriptItemId]);

  const copySelectedTranscriptItem = useCallback(async () => {
    if (!selectedTranscriptItem) {
      return;
    }
    const copyText = buildTranscriptCopyText(selectedTranscriptItem);
    if (!copyText) {
      return;
    }
    try {
      await clipboard.write(copyText);
      addHistoryItem({
        type: "info",
        text: "Copied selected transcript entry to clipboard.",
      });
    } catch (error) {
      addHistoryItem({
        type: "error",
        text: `Failed to copy transcript entry: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [addHistoryItem, selectedTranscriptItem]);

  const copySelectedTranscriptToolInput = useCallback(async () => {
    if (!selectedTranscriptItem) {
      return;
    }

    const copyText = buildTranscriptToolInputCopyText(selectedTranscriptItem);
    if (!copyText) {
      return;
    }

    try {
      await clipboard.write(copyText);
      addHistoryItem({
        type: "info",
        text: "Copied selected tool input to clipboard.",
      });
    } catch (error) {
      addHistoryItem({
        type: "error",
        text: `Failed to copy tool input: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [addHistoryItem, selectedTranscriptItem]);

  const openHistorySearchSurface = useCallback(() => {
    if (!displayItems.length || confirmRequest || uiRequest) {
      return;
    }
    const anchorItemId = selectedTranscriptItemId ?? displayItems[displayItems.length - 1]?.id;
    setTranscriptDisplayState((prev) => openTranscriptSearch(prev, {
      anchorItemId,
      initialMatchIndex: 0,
    }));
    setHistorySearchQuery("");
    setHistorySearchSelectedIndex(0);
  }, [confirmRequest, displayItems, selectedTranscriptItemId, uiRequest]);

  const closeHistorySearchSurface = useCallback((options?: { restoreFollowMode?: boolean }) => {
    setTranscriptDisplayState((prev) =>
      closeTranscriptSearch(prev, { restoreFollowMode: options?.restoreFollowMode ?? true }),
    );
    setHistorySearchQuery("");
    setHistorySearchSelectedIndex(0);
  }, []);
  const historySearchDialogState = useMemo(
    () => (
      isHistorySearchActive
        ? {
            query: historySearchQuery,
            matches: historySearchMatches.map((match) => ({
              itemId: match.itemId,
              excerpt: match.excerpt,
            })),
            selectedIndex: clampedHistorySearchSelectedIndex,
          }
        : null
    ),
    [clampedHistorySearchSelectedIndex, historySearchMatches, historySearchQuery, isHistorySearchActive],
  );

  const dialogConfirmState = useMemo(
    () => (
      confirmRequest
        ? { prompt: confirmRequest.prompt, instruction: confirmInstruction }
        : null
    ),
    [confirmInstruction, confirmRequest],
  );

  const dialogRequestState = useMemo(() => {
    if (!uiRequest) {
      return null;
    }
    if (uiRequest.kind === "select") {
      return {
        kind: "select" as const,
        title: uiRequest.title,
        options: uiRequest.options,
        buffer: uiRequest.buffer,
        error: uiRequest.error,
        visibleSelectOptions: viewportBudget.visibleSelectOptions,
      };
    }
    return {
      kind: "input" as const,
      prompt: uiRequest.prompt,
      defaultValue: uiRequest.defaultValue,
      buffer: uiRequest.buffer,
      error: uiRequest.error,
    };
  }, [uiRequest, viewportBudget.visibleSelectOptions]);
  const dialogSurface = useMemo(
    () => (
      <DialogSurface
        confirm={dialogConfirmState}
        request={dialogRequestState}
        historySearch={historySearchDialogState}
      />
    ),
    [dialogConfirmState, dialogRequestState, historySearchDialogState],
  );
  const overlaySurface = useMemo(() => {
    if (!useOverlaySurface) {
      return undefined;
    }
    return (
      <Box flexDirection="column">
        {suggestionsSurface}
        {dialogSurface}
      </Box>
    );
  }, [dialogSurface, suggestionsSurface, useOverlaySurface]);

  const enterHistoryReview = useCallback(() => {
    setTranscriptDisplayState((prev) => enterTranscriptHistory(prev));
  }, []);

  const exitHistoryReview = useCallback(() => {
    setTranscriptDisplayState((prev) => jumpTranscriptToLatest(exitTranscriptHistory(prev)));
    setHistoryScrollOffset(0);
    setHistorySearchQuery("");
    setHistorySearchSelectedIndex(0);
  }, []);

  useEffect(() => {
    if (!isReviewingHistory) {
      return;
    }
    if (selectedTranscriptItemId && selectableTranscriptItemIds.includes(selectedTranscriptItemId)) {
      return;
    }
    const fallbackItemId = selectableTranscriptItemIds[selectableTranscriptItemIds.length - 1];
    setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, fallbackItemId));
  }, [isReviewingHistory, selectableTranscriptItemIds, selectedTranscriptItemId]);

  useEffect(() => {
    if (!process.stdout.isTTY) {
      return;
    }

    if (!supportsTranscriptMouseHistory(transcriptDisplayState)) {
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
  }, [transcriptDisplayState]);

  // Refs for callbacks
  // Note: permissionMode and alwaysAllowTools are stored separately for permission checks
  const currentOptionsRef = useRef<InkREPLOptions>({
    ...options,
    parallel: currentConfig.parallel,
    thinking: currentConfig.thinking,
    reasoningMode: currentConfig.reasoningMode,
    agentMode: currentConfig.agentMode,
    context: {
      ...options.context,
      repoIntelligenceMode: currentConfig.repoIntelligenceMode,
      repoIntelligenceTrace: currentConfig.repoIntelligenceTrace,
    },
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
  const toggleTranscriptVerbosity = useCallback(() => {
    setTranscriptDisplayState((prev) => toggleTranscriptVerbosityState(prev));
  }, []);
  const pendingInputsRef = useRef<string[]>(streamingState.pendingInputs);
  const userInterruptedRef = useRef(false);

  const queueInterruptedPersistence = useCallback(() => {
    if (interruptPersistenceQueuedRef.current) {
      return;
    }
    const latestBreadcrumb = managedTaskBreadcrumbRef.current?.trim();
    const lastHistoryItem = historyRef.current.length > 0
      ? historyRef.current[historyRef.current.length - 1]
      : undefined;
    const lastHistoryText = lastHistoryItem && "text" in lastHistoryItem && typeof lastHistoryItem.text === "string"
      ? lastHistoryItem.text.trim()
      : undefined;
    const interruptedItems = buildInterruptedPersistenceItems(
      getThinkingContent(),
      getFullResponse(),
      {
        toolCalls: iterationToolCallsRef.current,
        toolNames: iterationToolsRef.current,
        infoItems: latestBreadcrumb && latestBreadcrumb !== lastHistoryText
          ? [latestBreadcrumb]
          : [],
      },
    );

    if (interruptedItems.length === 0) {
      return;
    }

    interruptPersistenceQueuedRef.current = true;
    appendHistoryItemsWithPersistenceRef.current?.(interruptedItems);
  }, [getFullResponse, getThinkingContent]);

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
        queueInterruptedPersistence();
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
          queueInterruptedPersistence();
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
      queueInterruptedPersistence,
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
      const hasTranscript = displayItems.length > 0
        || !!displayStreamingState.currentResponse
        || !!displayStreamingState.thinkingContent
        || displayStreamingState.activeToolCalls.length > 0;

      if ((key.ctrl && key.name === "y") || (key.meta && key.name === "z")) {
        if (!isReviewingHistory) {
          if (!hasTranscript) return true;
          enterHistoryReview();
          return true;
        }

        exitHistoryReview();
        return true;
      }

      if (key.name === "pageup") {
        if (!hasTranscript) return true;

        enterHistoryReview();
        setHistoryScrollOffset((prev) => prev + reviewPageSize);
        return true;
      }

      if (!isReviewingHistory) {
        return false;
      }

      if (transcriptDisplayState.searchMode === "history") {
        if (key.name === "escape") {
          closeHistorySearchSurface({ restoreFollowMode: true });
          return true;
        }
        if (key.name === "backspace") {
          setHistorySearchQuery((prev) => prev.slice(0, -1));
          setHistorySearchSelectedIndex(0);
          return true;
        }
        if (key.name === "down") {
          setHistorySearchSelectedIndex((prev) =>
            stepTranscriptSearchMatch(historySearchMatches.length, prev, "next"),
          );
          return true;
        }
        if (key.name === "up") {
          setHistorySearchSelectedIndex((prev) =>
            stepTranscriptSearchMatch(historySearchMatches.length, prev, "prev"),
          );
          return true;
        }
        if (key.name === "enter") {
          const match = historySearchMatches[clampedHistorySearchSelectedIndex];
          if (match) {
            selectTranscriptItem(match.itemId);
            closeHistorySearchSurface({ restoreFollowMode: false });
          }
          return true;
        }
        if (key.insertable && key.sequence) {
          setHistorySearchQuery((prev) => prev + key.sequence);
          setHistorySearchSelectedIndex(0);
          return true;
        }
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
        if (!supportsTranscriptMouseHistory(transcriptDisplayState)) {
          return false;
        }
        setHistoryScrollOffset((prev) => prev + reviewWheelStep);
        return true;
      }

      if (key.name === "wheeldown") {
        if (!supportsTranscriptMouseHistory(transcriptDisplayState)) {
          return false;
        }
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

      if (key.name === "left") {
        cycleTranscriptSelection("prev");
        return true;
      }

      if (key.name === "right") {
        cycleTranscriptSelection("next");
        return true;
      }

      if (!key.ctrl && !key.meta && !key.shift && key.name === "c") {
        void copySelectedTranscriptItem();
        return true;
      }

      if (!key.ctrl && !key.meta && !key.shift && key.name === "i") {
        void copySelectedTranscriptToolInput();
        return true;
      }

      if (!key.ctrl && !key.meta && !key.shift && key.name === "v") {
        toggleSelectedTranscriptDetail();
        return true;
      }

      return false;
    },
    [
      isReviewingHistory,
      displayItems,
      displayStreamingState.currentResponse,
      displayStreamingState.thinkingContent,
      displayStreamingState.activeToolCalls,
      historyScrollOffset,
      reviewPageSize,
      reviewWheelStep,
      enterHistoryReview,
      exitHistoryReview,
      transcriptDisplayState,
      clampedHistorySearchSelectedIndex,
      historySearchMatches,
      openHistorySearchSurface,
      closeHistorySearchSurface,
      cycleTranscriptSelection,
      copySelectedTranscriptItem,
      copySelectedTranscriptToolInput,
      toggleSelectedTranscriptDetail,
      selectTranscriptItem,
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
      if (context.uiHistory?.length) {
        for (const item of context.uiHistory) {
          addHistoryItem({
            type: item.type,
            text: item.text,
          });
        }
        return;
      }

      for (const msg of context.messages) {
        const historySeeds = extractHistorySeedsFromMessage(msg);
        for (const item of historySeeds) {
          addHistoryItem(item);
        }
      }
    }
  }, [context.messages, context.uiHistory, history.length, addHistoryItem]);

  // Preload skills on mount to ensure they're available for first /skill:xxx call
  // Issue 059: Skills lazy loading caused first skill invocation to fail
  // Issue 064: Must pass projectRoot to discover .kodax/skills/ in project directory
  useEffect(() => {
    void initializeSkillRegistry(context.gitRoot);
  }, [context.gitRoot]);

  // Process special syntax (shell commands, file references)
  // Create KodaXEvents for streaming updates
  const createStreamingEvents = useCallback((): StreamingEvents => ({
    onThinkingDelta: (text: string) => {
      if (streamingState.currentTool) {
        setCurrentTool(undefined);
        clearToolInputContent();
      }
      setLastLiveActivityLabel(
        formatManagedLiveActivityLabel(
          managedTaskStatusRef.current?.activeWorkerTitle
            ? `[${managedTaskStatusRef.current.activeWorkerTitle}] [Thinking]`
            : "[Thinking]",
          managedTaskStatusRef.current?.activeWorkerTitle,
        ),
      );
      // The UI layer stores thinking content for display.
      appendThinkingChars(text.length);
      appendThinkingContent(text);
    },
    onThinkingEnd: (thinking: string) => {
      const currentThinking = getThinkingContent();
      const mergedThinking = mergeLiveThinkingContent(currentThinking, thinking);
      if (mergedThinking && mergedThinking !== currentThinking) {
        clearThinkingContent();
        startThinking();
        appendThinkingChars(mergedThinking.length);
        appendThinkingContent(mergedThinking);
      }
      stopThinking();
    },
    onTextDelta: (text: string) => {
      if (streamingState.currentTool) {
        setCurrentTool(undefined);
        clearToolInputContent();
      }
      stopThinking();
      setLastLiveActivityLabel(undefined);
      appendResponse(text);
    },
    onToolUseStart: (tool: { name: string; id: string; input?: Record<string, unknown> }) => {
      if (!iterationToolsRef.current.includes(tool.name)) {
        iterationToolsRef.current = [...iterationToolsRef.current, tool.name];
      }
      const rolePrefix = managedTaskStatusRef.current?.activeWorkerTitle
        ? `[${managedTaskStatusRef.current.activeWorkerTitle}] `
        : "";
      const toolCall: ToolCall = {
        id: tool.id,
        name: `${rolePrefix}${tool.name}`,
        status: ToolCallStatus.Executing,
        startTime: Date.now(),
        input: tool.input,
      };
      addLiveToolCall(toolCall);
      setLastLiveActivityLabel(
        formatManagedLiveToolLabel(toolCall, managedTaskStatusRef.current?.activeWorkerTitle),
      );
    },
    onToolInputDelta: (
      toolName: string,
      partialJson: string,
      meta?: { toolId?: string },
    ) => {
      appendToolInputChars(partialJson.length);
      appendToolInputContent(partialJson); // Issue 068 Phase 4: track tool input content.
      const updatedTool = updateExecutingTool(meta?.toolId, toolName, (tool) => {
        const currentPreview = tool.preview ?? "";
        const preview = truncateToolPreview(`${currentPreview}${partialJson}`);
        return {
          ...tool,
          preview: preview || undefined,
          input: tool.input
            ? (preview ? { ...tool.input, preview } : { ...tool.input })
            : (preview ? { preview } : undefined),
        };
      });
      if (updatedTool) {
        setLastLiveActivityLabel(
          formatManagedLiveToolLabel(updatedTool, managedTaskStatusRef.current?.activeWorkerTitle),
        );
      }
    },
    onToolResult: (result) => {
      const content = typeof result.content === "string" ? result.content : String(result.content ?? "");
      const trimmedContent = truncateToolOutputPreview(content);
      if (/^\[(?:Tool Error|Error)\]/.test(content)) {
        const finalizedTool = finalizeLiveToolCall(
          result.id,
          ToolCallStatus.Error,
          trimmedContent,
          trimmedContent,
          result.name,
        );
        if (finalizedTool) {
          setLastLiveActivityLabel(
            formatManagedLiveToolLabel(finalizedTool, managedTaskStatusRef.current?.activeWorkerTitle),
          );
        }
        return;
      }
      if (/^\[(?:Cancelled|Blocked)\]/.test(content)) {
        const finalizedTool = finalizeLiveToolCall(
          result.id,
          ToolCallStatus.Cancelled,
          undefined,
          trimmedContent,
          result.name,
        );
        if (finalizedTool) {
          setLastLiveActivityLabel(
            formatManagedLiveToolLabel(finalizedTool, managedTaskStatusRef.current?.activeWorkerTitle),
          );
        }
        return;
      }
      const finalizedTool = finalizeLiveToolCall(
        result.id,
        ToolCallStatus.Success,
        undefined,
        trimmedContent || undefined,
        result.name,
      );
      if (finalizedTool) {
        setLastLiveActivityLabel(
          formatManagedLiveToolLabel(finalizedTool, managedTaskStatusRef.current?.activeWorkerTitle),
        );
      }
    },
    onStreamEnd: () => {
      const finalizedTools = finalizeAllExecutingToolCalls(
        ToolCallStatus.Cancelled,
        () => ({ error: "Stream ended before the tool completed.", output: undefined }),
      );
      const lastFinalizedTool = finalizedTools[finalizedTools.length - 1];
      if (lastFinalizedTool) {
        setLastLiveActivityLabel(
          formatManagedLiveToolLabel(lastFinalizedTool, managedTaskStatusRef.current?.activeWorkerTitle),
        );
      }
      stopThinking();
      clearToolInputContent();
      setCurrentTool(undefined);
    },
    hasPendingInputs: () => pendingInputsRef.current.length > 0,
    onError: (error: Error) => {
      const latestExecutingTool = findLatestExecutingTool();
      if (latestExecutingTool?.name) {
        setLastLiveActivityLabel(
          formatManagedLiveToolLabel(latestExecutingTool, managedTaskStatusRef.current?.activeWorkerTitle),
        );
      }
      const finalizedTools = finalizeAllExecutingToolCalls(
        ToolCallStatus.Error,
        () => ({ error: error.message, output: undefined }),
      );
      const lastFinalizedTool = finalizedTools[finalizedTools.length - 1];
      if (lastFinalizedTool) {
        setLastLiveActivityLabel(
          formatManagedLiveToolLabel(lastFinalizedTool, managedTaskStatusRef.current?.activeWorkerTitle),
        );
      }
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
    onManagedTaskStatus: (status) => {
      managedTaskStatusRef.current = status;
      setManagedTaskStatus(status);
      const liveStatusLabel = formatManagedTaskLiveStatusLabel(status);
      if (liveStatusLabel) {
        setLastLiveActivityLabel(liveStatusLabel);
      }
      const breadcrumb = formatManagedTaskBreadcrumb(status);
      if (breadcrumb && breadcrumb !== managedTaskBreadcrumbRef.current) {
        const breadcrumbItem: CreatableHistoryItem = {
          type: "info",
          icon: ">",
          text: breadcrumb,
        };
        if (appendHistoryItemsWithPersistenceRef.current) {
          appendHistoryItemsWithPersistenceRef.current([breadcrumbItem]);
        } else {
          addHistoryItem(breadcrumbItem);
        }
        managedTaskBreadcrumbRef.current = breadcrumb;
      }
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

      if (managedTaskStatusRef.current?.globalWorkBudget) {
        const nextManagedStatus: KodaXManagedTaskStatusEvent = {
          ...managedTaskStatusRef.current,
          budgetUsage: Math.min(
            managedTaskStatusRef.current.globalWorkBudget,
            (managedTaskStatusRef.current.budgetUsage ?? 0) + 1,
          ),
        };
        managedTaskStatusRef.current = nextManagedStatus;
        setManagedTaskStatus(nextManagedStatus);
      }

      // Save current content to history and start fresh for new iteration
      // Save current content to history before starting the next round.
      // Fix: Always call startNewIteration to ensure currentIteration is properly set
      // Always call startNewIteration so currentIteration stays correct.

      const prevThinking = iter > 1 ? getThinkingContent().trim() : "";
      const prevResponse = iter > 1 ? sanitizeInterruptedAssistantText(getFullResponse()) : "";
      const prevTools = iter > 1 ? [...iterationToolsRef.current] : [];
      const prevToolCalls = iter > 1 ? [...iterationToolCallsRef.current] : [];

      // Always update iteration counter BEFORE adding to history 
      // This implicitly clears the text buffer so we don't double-render the old streaming 
      // content simultaneously with the new static HistoryItem!
      startNewIteration(iter);
      iterationToolsRef.current = [];
      iterationToolCallsRef.current = [];
      resetLiveToolCalls();
      clearToolInputContent();
      setCurrentTool(undefined);
      setLastLiveActivityLabel(
        formatManagedLiveActivityLabel(
          managedTaskStatusRef.current?.activeWorkerTitle
            ? `[Thinking] [${managedTaskStatusRef.current.activeWorkerTitle}]`
            : undefined,
          managedTaskStatusRef.current?.activeWorkerTitle,
        ),
      );
      startThinking();

      if (iter > 1) {
        // Issue 076 fix: Save previous iteration content to persistent history BEFORE clearing
        // Issue 076.
        const previousRoundItems = buildRoundHistoryItems({
          thinking: prevThinking,
          response: prevResponse,
          toolCalls: prevToolCalls,
          toolNames: prevTools,
        });
        if (appendHistoryItemsWithPersistenceRef.current) {
          appendHistoryItemsWithPersistenceRef.current(previousRoundItems);
        } else {
          for (const item of previousRoundItems) {
            addHistoryItem(item);
          }
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
        // The user might have toggled transcript verbosity or permission mode mid-session.
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
    onCompactedMessages: (messages: KodaXMessage[], update?: CompactionUpdate) => {
      context.messages = messages;
      if (update?.artifactLedger && update.artifactLedger.length > 0) {
        context.artifactLedger = mergeArtifactLedger(
          context.artifactLedger ?? [],
          update.artifactLedger,
        );
      }
      context.lineage = update?.anchor
        ? applySessionCompaction(context.lineage, messages, update.anchor)
        : createSessionLineage(messages, context.lineage);
      const currentTokens = estimateTokens(messages);
      context.contextTokenSnapshot = {
        currentTokens,
        baselineEstimatedTokens: currentTokens,
        source: 'estimate',
      };
      touchContext(context);
      setLiveTokenCount(currentTokens);
      void persistContextStateRef.current?.().catch(() => {});
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

    onIterationEnd: (info: {
      iter: number;
      maxIter: number;
      tokenCount: number;
      contextTokenSnapshot?: import("@kodax/coding").KodaXContextTokenSnapshot;
    }) => {
      context.contextTokenSnapshot = info.contextTokenSnapshot;
      setLiveTokenCount(info.tokenCount);
    },
  }), [
    appendThinkingChars,
    appendThinkingContent,
    stopThinking,
    appendResponse,
    setCurrentTool,
    appendToolInputChars,
    appendToolInputContent,
    clearToolInputContent,
    startNewIteration,
    startThinking,
    currentConfig,
    context,
    startCompacting,
    stopCompacting,
    addHistoryItem,
    clearThinkingContent,
    getThinkingContent,
    getFullResponse,
    setLastLiveActivityLabel,
    addLiveToolCall,
    updateExecutingTool,
    finalizeLiveToolCall,
    finalizeAllExecutingToolCalls,
    findLatestExecutingTool,
    resetLiveToolCalls,
    streamingState.currentTool,
  ]);

  // Helper function to show confirmation dialog

  const showConfirmDialog = (tool: string, input: Record<string, unknown>): Promise<ConfirmResult> => {
    const promptText = buildToolConfirmationPrompt(tool, input);

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
    const managedRunContext = buildManagedRunContext(
      opts.context,
      context.gitRoot,
      context.contextTokenSnapshot,
      skillsPrompt,
    );

    return runManagedTask(
      {
        ...opts,
        session: {
          ...opts.session,
          initialMessages,
        },
        context: managedRunContext,
        events,
        abortSignal: getSignal(),
      },
      prompt
    );
  };

  const persistContextState = useCallback(async (uiHistoryOverride?: KodaXSessionUiHistoryItem[]) => {
    if (context.messages.length === 0) {
      return;
    }

    const title = extractTitle(context.messages);
    const persistedUiHistory = uiHistoryOverride ?? persistedUiHistoryRef.current;
    persistedUiHistoryRef.current = persistedUiHistory;
    context.title = title;
    context.uiHistory = persistedUiHistory;
    context.lineage = createSessionLineage(context.messages, context.lineage);
    await storage.save(context.sessionId, {
      messages: context.messages,
      title,
      gitRoot: context.gitRoot ?? "",
      uiHistory: persistedUiHistory,
      lineage: context.lineage,
      artifactLedger: context.artifactLedger,
    });
  }, [context, storage]);

  const persistContextStateInBackground = useCallback((uiHistoryOverride?: KodaXSessionUiHistoryItem[]) => {
    if (uiHistoryOverride !== undefined) {
      persistedUiHistoryRef.current = uiHistoryOverride;
    }
    const queuedSave = persistContextStateQueueRef.current
      .catch(() => {})
      .then(() => persistContextState(uiHistoryOverride));
    persistContextStateQueueRef.current = queuedSave.catch(() => {});
    return queuedSave;
  }, [persistContextState]);

  const requestGracefulExit = useCallback(() => {
    void (async () => {
      await persistContextStateQueueRef.current.catch(() => {});
      setIsRunning(false);
      onExit();
      exit();
    })();
  }, [exit, onExit]);

  useEffect(() => {
    persistContextStateRef.current = persistContextStateInBackground;
    return () => {
      persistContextStateRef.current = null;
    };
  }, [persistContextStateInBackground]);

  const persistHistoryAdditionsInBackground = useCallback((items: readonly CreatableHistoryItem[]) => {
    if (items.length === 0) {
      return;
    }
    const nextUiHistory = appendPersistedUiHistorySnapshot(persistedUiHistoryRef.current, items);
    persistedUiHistoryRef.current = nextUiHistory;
    void persistContextStateInBackground(nextUiHistory);
  }, [persistContextStateInBackground]);

  const appendHistoryItemsWithPersistence = useCallback((items: readonly CreatableHistoryItem[]) => {
    if (items.length === 0) {
      return;
    }
    for (const item of items) {
      addHistoryItem(item);
    }
    persistHistoryAdditionsInBackground(items);
  }, [addHistoryItem, persistHistoryAdditionsInBackground]);

  useEffect(() => {
    appendHistoryItemsWithPersistenceRef.current = appendHistoryItemsWithPersistence;
    return () => {
      appendHistoryItemsWithPersistenceRef.current = null;
    };
  }, [appendHistoryItemsWithPersistence]);

  const recordCompletedAgentRound = useCallback(async (result: KodaXResult) => {
    context.messages = result.messages;
    context.contextTokenSnapshot = result.contextTokenSnapshot;

    const finalThinking = getThinkingContent().trim();
    const finalResponse = resolveCompletedAssistantText(
      result.messages,
      getFullResponse(),
      result.managedTask?.verdict.summary,
      result.lastText,
    );
    const managedTranscriptItems = buildManagedTaskTranscriptItems(result);
    const roundHistoryItems = buildRoundHistoryItems({
      thinking: finalThinking,
      response: undefined,
      toolCalls: iterationToolCallsRef.current,
      toolNames: iterationToolsRef.current,
    });
    const persistedAdditions: CreatableHistoryItem[] = [
      ...roundHistoryItems,
      ...managedTranscriptItems.map((text) => ({ type: "info" as const, text })),
      ...(finalResponse
        ? [{
            type: "assistant" as const,
            text: result.interrupted ? `${finalResponse}\n\n[Interrupted]` : finalResponse,
          }]
        : []),
    ];
    const nextUiHistory = [
      ...serializeUiHistorySnapshot(history),
      ...serializeCreatableHistoryItems(persistedAdditions),
    ];

    clearThinkingContent();
    clearResponse();

    for (const item of roundHistoryItems) {
      addHistoryItem(item);
    }

    for (const transcript of managedTranscriptItems) {
      addHistoryItem({
        type: "info",
        text: transcript,
      });
    }

    if (finalResponse) {
      addHistoryItem({
        type: "assistant",
        text: result.interrupted ? `${finalResponse}\n\n[Interrupted]` : finalResponse,
        });
    }

    iterationToolsRef.current = [];
    iterationToolCallsRef.current = [];
    resetLiveToolCalls();
    clearToolInputContent();
    setCurrentTool(undefined);
    setLastLiveActivityLabel(undefined);
    clearIterationHistory();

    // Persist session state off the critical UI path so the spinner can stop
    // as soon as the final answer is on screen.
    void persistContextStateInBackground(nextUiHistory).catch(() => {});
  }, [
    addHistoryItem,
    clearIterationHistory,
    clearToolInputContent,
    clearResponse,
    clearThinkingContent,
    context,
    getFullResponse,
    getThinkingContent,
    history,
    persistContextStateInBackground,
    resetLiveToolCalls,
    setCurrentTool,
    setLastLiveActivityLabel,
    streamingState.currentIteration,
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
    interruptPersistenceQueuedRef.current = false;
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
          interruptPersistenceQueuedRef.current = false;
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
      const persistedHistoryBase = serializeUiHistorySnapshot(history);
      const persistedAdditions: CreatableHistoryItem[] = [];

      if (prepared.mode === "fork") {
        const lastAssistant = result.messages.slice().reverse().find((msg) => msg.role === "assistant");
        if (lastAssistant) {
          context.messages.push({
            role: "assistant",
            content: lastAssistant.content,
          });
          for (const item of extractHistorySeedsFromMessage(lastAssistant)) {
            addHistoryItem(item);
            persistedAdditions.push(item);
          }
        }
      } else {
        context.messages = result.messages;
        context.contextTokenSnapshot = result.contextTokenSnapshot;
        appendLastAssistantToHistory(result.messages);
        const lastAssistant = result.messages[result.messages.length - 1];
        if (lastAssistant?.role === "assistant") {
          for (const item of extractHistorySeedsFromMessage(lastAssistant)) {
            persistedAdditions.push(item);
          }
        }
      }

      await persistContextState([
        ...persistedHistoryBase,
        ...serializeCreatableHistoryItems(persistedAdditions),
      ]);
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
      const currentFullResponse = sanitizeInterruptedAssistantText(getFullResponse());
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
      interruptPersistenceQueuedRef.current = false;
      setManagedTaskStatus(null);
      managedTaskStatusRef.current = null;
      managedTaskBreadcrumbRef.current = null;
      setLastLiveActivityLabel(undefined);
      clearWorkStripTimers();
      setVisibleWorkStripText(undefined);
      iterationToolsRef.current = [];
      iterationToolCallsRef.current = [];
      resetLiveToolCalls();
      clearResponse();
      clearToolInputContent();
      setCurrentTool(undefined);
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
            requestGracefulExit();
          },
          saveSession: async () => {
            if (context.messages.length > 0) {
              const title = extractTitle(context.messages);
              context.title = title;
              context.lineage = createSessionLineage(context.messages, context.lineage);
              await storage.save(context.sessionId, {
                messages: context.messages,
                title,
                gitRoot: context.gitRoot ?? "",
                uiHistory: serializeUiHistorySnapshot(history),
                lineage: context.lineage,
                artifactLedger: context.artifactLedger,
              });
            }
          },
          startNewSession: () => {
            const nextSessionId = generateSessionId();
            const now = new Date().toISOString();
            context.sessionId = nextSessionId;
            context.title = "";
            context.uiHistory = [];
            context.contextTokenSnapshot = undefined;
            context.lineage = undefined;
            context.artifactLedger = undefined;
            context.createdAt = now;
            context.lastAccessed = now;
            currentOptionsRef.current.session = {
              ...currentOptionsRef.current.session,
              id: nextSessionId,
            };
            setLiveTokenCount(null);
            clearUIHistory();
            setSessionId(nextSessionId);
          },
          loadSession: async (id: string) => {
            const loaded = await storage.load(id);
            if (loaded) {
              const allowed = enforceSessionTransitionGuard(
                currentConfig,
                "Resuming a saved session",
                logSessionTransitionGuard,
              );
              if (!allowed) {
                return "blocked";
              }
              context.messages = loaded.messages;
              context.uiHistory = loaded.uiHistory;
              context.lineage = loaded.lineage;
              context.artifactLedger = loaded.artifactLedger;
              context.title = loaded.title;
              context.sessionId = id;
              context.contextTokenSnapshot = undefined;
              setLiveTokenCount(null);
              clearUIHistory();
              setSessionId(id);
              console.log(chalk.green(`[Session loaded: ${id}]`));
              return "loaded";
            }
            return "missing";
          },
          listSessions: async () => {
            const sessions = await storage.list(context.gitRoot ?? undefined);
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
            context.uiHistory = [];
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
          setAgentMode: (mode) => {
            setCurrentConfig((prev) => ({
              ...prev,
              agentMode: mode,
            }));
            currentOptionsRef.current.agentMode = mode;
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
          setRepoIntelligenceRuntime: (update) => {
            setCurrentConfig((prev) => ({
              ...prev,
              ...(update.mode !== undefined ? { repoIntelligenceMode: update.mode } : {}),
              ...(update.endpoint !== undefined ? { repointelEndpoint: update.endpoint ?? undefined } : {}),
              ...(update.bin !== undefined ? { repointelBin: update.bin ?? undefined } : {}),
              ...(update.trace !== undefined ? { repoIntelligenceTrace: update.trace } : {}),
            }));
            if (update.mode !== undefined) {
              process.env.KODAX_REPO_INTELLIGENCE_MODE = update.mode;
              currentOptionsRef.current.context = {
                ...currentOptionsRef.current.context,
                repoIntelligenceMode: update.mode,
              };
            }
            if (update.trace !== undefined) {
              if (update.trace) {
                process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
              } else {
                delete process.env.KODAX_REPO_INTELLIGENCE_TRACE;
              }
              currentOptionsRef.current.context = {
                ...currentOptionsRef.current.context,
                repoIntelligenceTrace: update.trace,
              };
            }
            if (update.endpoint !== undefined) {
              if (update.endpoint) {
                process.env.KODAX_REPOINTEL_ENDPOINT = update.endpoint;
              } else {
                delete process.env.KODAX_REPOINTEL_ENDPOINT;
              }
            }
            if (update.bin !== undefined) {
              if (update.bin) {
                process.env.KODAX_REPOINTEL_BIN = update.bin;
              } else {
                delete process.env.KODAX_REPOINTEL_BIN;
              }
            }
          },
          deleteSession: async (id: string) => {
            await storage.delete?.(id);
          },
          deleteAllSessions: async () => {
            await storage.deleteAll?.(context.gitRoot ?? undefined);
          },
          printSessionTree: async () => {
            const lineage = await storage.getLineage?.(context.sessionId);
            if (!lineage) {
              console.log(chalk.dim("\n[No session tree available for this session]"));
              return;
            }

            const lines = formatSessionTree(buildSessionTree(lineage));
            console.log(chalk.bold("\nSession Tree:\n"));
            lines.forEach((line) => console.log(`  ${line}`));
            console.log();
          },
          switchSessionBranch: async (selector: string) => {
            const allowed = enforceSessionTransitionGuard(
              currentConfig,
              "Switching session branches",
              logSessionTransitionGuard,
            );
            if (!allowed) {
              return "blocked";
            }

            const loaded = await storage.setActiveEntry?.(
              context.sessionId,
              selector,
              { summarizeCurrentBranch: true },
            );
            if (!loaded) {
              return "missing";
            }

            context.messages = loaded.messages;
            context.uiHistory = loaded.uiHistory;
            context.title = loaded.title;
            context.contextTokenSnapshot = undefined;
            setLiveTokenCount(null);
            clearUIHistory();
            console.log(chalk.green(`\n[Switched to tree entry: ${selector}]`));
            console.log(chalk.dim(`  Messages: ${loaded.messages.length}`));
            return "switched";
          },
          labelSessionBranch: async (selector: string, label?: string) => {
            const updated = await storage.setLabel?.(context.sessionId, selector, label);
            if (!updated) {
              return false;
            }

            const action = label && label.trim()
              ? `checkpoint label set: ${label.trim()}`
              : "checkpoint label cleared";
            console.log(chalk.green(`\n[${action}]`));
            return true;
          },
          forkSession: async (selector?: string) => {
            const allowed = enforceSessionTransitionGuard(
              currentConfig,
              "Forking a session branch",
              logSessionTransitionGuard,
            );
            if (!allowed) {
              return "blocked";
            }

            const forked = await storage.fork?.(context.sessionId, selector);
            if (!forked) {
              return "failed";
            }

            context.sessionId = forked.sessionId;
            context.messages = forked.data.messages;
            context.uiHistory = forked.data.uiHistory;
            context.title = forked.data.title;
            context.contextTokenSnapshot = undefined;
            const now = new Date().toISOString();
            context.createdAt = now;
            context.lastAccessed = now;
            currentOptionsRef.current.session = {
              ...currentOptionsRef.current.session,
              id: forked.sessionId,
            };
            setLiveTokenCount(null);
            clearUIHistory();
            setSessionId(forked.sessionId);
            console.log(chalk.green(`\n[Forked session: ${forked.sessionId}]`));
            console.log(chalk.dim(`  Messages: ${forked.data.messages.length}`));
            return "forked";
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
            agentMode: currentConfig.agentMode,
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
              queueInterruptedPersistence();
            } else {
              console.log(chalk.red(error.message));
              appendHistoryItemsWithPersistence([{
                type: "error",
                text: error.message,
              }]);
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
              queueInterruptedPersistence();
            } else {
              console.log(chalk.red(error.message));
              appendHistoryItemsWithPersistence([{
                type: "error",
                text: error.message,
              }]);
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
        isShellCommandHandled(processed)
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
            agentMode: currentConfig.agentMode,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));

          // Check if this is an abort error (user pressed Ctrl+C)
          const isAbortError = error.name === 'AbortError' ||
            error.message.includes('aborted') ||
            error.message.includes('ABORTED');

          if (isAbortError) {
            queueInterruptedPersistence();
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
        // Abort errors themselves should not be added to history.
        const isAbortError = error.name === 'AbortError' ||
          error.message.includes('aborted') ||
          error.message.includes('ABORTED');

        if (isAbortError) {
          console.log = originalLog;
          queueInterruptedPersistence();
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
          appendHistoryItemsWithPersistence([{
            type: "error",
            text: errorContent,
          }]);
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
      resetLiveToolCalls,
      clearWorkStripTimers,
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
        onToggleTranscriptVerbosity={toggleTranscriptVerbosity}
        onOpenTranscriptSearch={openHistorySearchSurface}
        canOpenTranscriptSearch={!confirmRequest && !uiRequest}
        onSetAgentMode={(mode) => {
          currentOptionsRef.current.agentMode = mode;
        }}
        onSetPermissionMode={(mode) => {
          setSessionPermissionMode(mode);
        }}
        onSetParallel={(enabled) => {
          currentOptionsRef.current.parallel = enabled;
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


      <FullscreenTranscriptLayout
        width={terminalWidth}
        stickyHeaderText={stickyPromptText}
        jumpToLatestText={jumpToLatestText}
        transcript={
          <TranscriptViewport
            items={displayItems}
            isLoading={displayIsLoading}
            isThinking={displayStreamingState.isThinking}
            thinkingCharCount={displayStreamingState.thinkingCharCount}
            thinkingContent={displayStreamingState.thinkingContent}
            streamingResponse={displayStreamingState.currentResponse}
            currentTool={displayStreamingState.currentTool}
            activeToolCalls={displayStreamingState.activeToolCalls}
            toolInputCharCount={displayStreamingState.toolInputCharCount}
            toolInputContent={displayStreamingState.toolInputContent}
            iterationHistory={displayStreamingState.iterationHistory}
            currentIteration={displayStreamingState.currentIteration}
            isCompacting={displayStreamingState.isCompacting}
            agentMode={currentConfig.agentMode}
            managedPhase={displayIsLoading ? managedTaskStatus?.phase : undefined}
            managedHarnessProfile={displayIsLoading ? managedTaskStatus?.harnessProfile : undefined}
            managedWorkerTitle={displayIsLoading ? managedTaskStatus?.activeWorkerTitle : undefined}
            managedRound={displayIsLoading ? managedTaskStatus?.currentRound : undefined}
            managedMaxRounds={displayIsLoading ? managedTaskStatus?.maxRounds : undefined}
            managedGlobalWorkBudget={displayIsLoading ? managedTaskStatus?.globalWorkBudget : undefined}
            managedBudgetUsage={displayIsLoading ? managedTaskStatus?.budgetUsage : undefined}
            managedBudgetApprovalRequired={displayIsLoading ? managedTaskStatus?.budgetApprovalRequired : undefined}
            lastLiveActivityLabel={displayStreamingState.lastLiveActivityLabel}
            viewportRows={viewportBudget.messageRows}
            viewportWidth={terminalWidth}
            scrollOffset={historyScrollOffset}
            animateSpinners={!isLivePaused}
            windowed={transcriptOwnsViewport}
            maxLines={transcriptMaxLines}
            showFullThinking={isTranscriptVerbose || isReviewingHistory}
            showDetailedTools={isTranscriptVerbose || isReviewingHistory}
            selectedItemId={selectedTranscriptItemId}
            expandedItemKeys={expandedTranscriptItemIds}
            browseHintText={reviewHintText}
            selectedSummary={isReviewingHistory ? selectedTranscriptItemSummary?.summary : undefined}
            selectedIndex={Math.max(0, selectedTranscriptItemIndex)}
            selectedTotal={selectableTranscriptItemIds.length}
            selectedKindLabel={isReviewingHistory ? selectedTranscriptItemSummary?.kindLabel : undefined}
            selectedDetailExpanded={isReviewingHistory ? isSelectedTranscriptItemExpanded : false}
            canCopySelection={isReviewingHistory && Boolean(selectedTranscriptItemId)}
            canCopyToolInput={isReviewingHistory && canCopySelectedToolInput}
            canToggleSelectionDetail={isReviewingHistory && Boolean(selectedTranscriptItemId)}
            searchStatusText={!useOverlaySurface ? historySearchStatusText : undefined}
            searchMatchCount={!useOverlaySurface ? historySearchMatches.length : 0}
          />
        }
        overlay={overlaySurface}
        footer={
          <PromptFooter
            headerRight={footerHeaderRight ? <Text dimColor>{footerHeaderRight}</Text> : undefined}
            pendingInputs={<QueuedCommandsSurface pendingInputs={streamingState.pendingInputs} />}
            composer={
              <PromptComposer
                onSubmit={handleSubmit}
                prompt=">"
                placeholder={isReviewingHistory
                  ? "Browsing transcript history... Press Esc, End, Ctrl+Y, or Alt+Z to resume."
                  : isLoading
                  ? canQueueFollowUps
                    ? "Queue a follow-up for the next round..."
                    : "Agent is busy..."
                  : "Type a message..."}
                focus={!confirmRequest && !uiRequest && !isReviewingHistory && !isHistorySearchActive}
                cwd={process.cwd()}
                gitRoot={options.context?.gitRoot || context.gitRoot}
                onInputChange={handleInputChange}
              />
            }
            suggestions={useOverlaySurface ? undefined : suggestionsSurface}
            helpMenu={showHelp ? (
              <PromptHelpMenu segments={buildHelpBarSegments()} />
            ) : undefined}
            taskBar={transcriptDisplayState.supportsFullscreenLayout ? (
              <BackgroundTaskBar
                primaryText={backgroundTaskViewModel.primaryText}
                parallelText={backgroundTaskViewModel.parallelText}
              />
            ) : (
              <AmaWorkStrip text={backgroundTaskViewModel.parallelText} />
            )}
            statusNotices={footerHeaderLeft ? (
              <StatusNoticesSurface notices={[footerHeaderLeft]} />
            ) : undefined}
            statusLine={<Box><StatusBar {...statusBarProps} /></Box>}
            dialogSurface={useOverlaySurface ? undefined : dialogSurface}
          />
        }
      />
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
  const { prepareRuntimeConfig, getGitRoot } = await import("../common/utils.js");
  const { loadCompactionConfig } = await import("../common/compaction-config.js");
  const { resolveProvider } = await import("@kodax/coding");

  const config = prepareRuntimeConfig();

  const initialProvider = options.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
  const initialModel = options.model ?? config.model;
  const initialReasoningMode = resolveInitialReasoningMode(options, config);
  const initialAgentMode = options.agentMode ?? config.agentMode ?? 'ama';
  const initialThinking = initialReasoningMode !== 'off';
  const initialParallel = options.parallel ?? config.parallel ?? false;
  // Load permission mode from config file (not from CLI options)
  // CLI is always YOLO mode; REPL uses config file for permission mode
  const initialPermissionMode: PermissionMode =
    normalizePermissionMode(config.permissionMode, 'accept-edits') ?? 'accept-edits';
  const repoIntelligenceRuntime = resolveRepoIntelligenceRuntimeConfig();

  const currentConfig: CurrentConfig = {
    provider: initialProvider,
    model: initialModel,
    thinking: initialThinking,
    reasoningMode: initialReasoningMode,
    agentMode: initialAgentMode,
    parallel: initialParallel,
    permissionMode: initialPermissionMode,
    repoIntelligenceMode: repoIntelligenceRuntime.mode,
    repointelEndpoint: repoIntelligenceRuntime.endpoint,
    repointelBin: repoIntelligenceRuntime.bin,
    repoIntelligenceTrace: repoIntelligenceRuntime.trace,
  };

  // Handle session resume/load
  let sessionId = options.session?.id;
  let existingMessages: KodaXMessage[] = [];
  let existingUiHistory: KodaXSessionUiHistoryItem[] | undefined;
  let existingLineage: KodaXSessionLineage | undefined;
  let existingArtifactLedger: KodaXSessionArtifactLedgerEntry[] | undefined;
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
      existingUiHistory = loaded.uiHistory;
      existingLineage = loaded.lineage;
      existingArtifactLedger = loaded.artifactLedger;
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
          existingUiHistory = loaded.uiHistory;
          existingLineage = loaded.lineage;
          existingArtifactLedger = loaded.artifactLedger;
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
    existingUiHistory,
    existingLineage,
    existingArtifactLedger,
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
