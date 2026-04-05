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
import { render, Box, useApp, Text, Static, useStdout, useTerminalWrite } from "./tui.js";
import { AlternateScreen, type ScrollBoxHandle, type ScrollBoxWindow } from "../tui/index.js";
import { AmaWorkStrip } from "./components/AmaWorkStrip.js";
import { StatusBar } from "./components/StatusBar.js";
import { FullscreenTranscriptLayout } from "./components/FullscreenTranscriptLayout.js";
import { TranscriptModeFooter } from "./components/TranscriptModeFooter.js";
import { PromptTranscriptSurface } from "./components/PromptTranscriptSurface.js";
import { TranscriptModeSurface } from "./components/TranscriptModeSurface.js";
import { buildMessageActionsText } from "./components/MessageActions.js";
import { buildMessageSelectorText } from "./components/MessageSelector.js";
import { PromptComposer } from "./components/PromptComposer.js";
import {
  PromptFooter,
  PromptFooterLeftSide,
  PromptFooterRightSide,
} from "./components/PromptFooter.js";
import { PromptHelpMenu } from "./components/PromptHelpMenu.js";
import { PromptSuggestionsSurface } from "./components/PromptSuggestionsSurface.js";
import { DialogSurface } from "./components/DialogSurface.js";
import { BackgroundTaskBar } from "./components/BackgroundTaskBar.js";
import { QueuedCommandsSurface } from "./components/QueuedCommandsSurface.js";
import { NotificationsSurface } from "./components/NotificationsSurface.js";
import { StatusNoticesSurface } from "./components/StatusNoticesSurface.js";
import { StashNotice } from "./components/StashNotice.js";
import { buildFooterHeaderViewModel } from "./view-models/footer-header.js";
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
import { copyTextToClipboard } from "../common/clipboard.js";
import { initializeSkillRegistry, getSkillRegistry } from "@kodax/skills";
import { getTheme } from "./themes/index.js";
import { KODAX_BANNER_LOGO_LINES } from "./constants/banner-logo.js";
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
import { emitRecoveryHistoryItem, emitRetryHistoryItem } from "./utils/retry-history.js";
import {
  formatManagedTaskBreadcrumb,
  formatManagedTaskLiveStatusLabel,
  mergeLiveThinkingContent,
} from "./utils/live-streaming.js";
import { buildManagedRunContext } from "./utils/managed-run-context.js";
import { formatToolCallInlineText } from "./utils/tool-display.js";
import { calculateViewportBudget } from "./utils/viewport-budget.js";
import { calculateVisualLayout } from "./utils/textUtils.js";
import {
  closeTranscriptSearch,
  createTranscriptDisplayState,
  enterTranscriptMode,
  exitTranscriptMode,
  jumpTranscriptToLatest,
  openTranscriptSearch,
  resolveTranscriptSelectedItemId,
  setTranscriptPendingLiveUpdates,
  setTranscriptSearchMatchIndex,
  setTranscriptScrollAnchor,
  setTranscriptSelectedItem,
  setTranscriptStickyPromptVisible,
  shouldPauseLiveTranscript,
  shouldWindowTranscript,
} from "./utils/transcript-state.js";
import {
  detectTerminalHostProfile,
  resolveEffectiveTuiRendererMode,
  resolveFullscreenPolicy,
  type EffectiveTuiRendererMode,
  type FullscreenPolicy,
} from "./utils/terminal-host-profile.js";
import { formatPendingInputsSummary, MAX_PENDING_INPUTS } from "./utils/pending-inputs.js";
import { runQueuedPromptSequence } from "./utils/queued-prompt-sequence.js";
import {
  buildTranscriptRenderModel,
  capHistoryByTranscriptRows,
  resolveVisibleTranscriptRows,
  sliceHistoryToRecentRounds,
  type TranscriptRow,
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
  buildTranscriptChromeModel,
  incrementTranscriptScrollOffset,
  resolveTranscriptPageSize,
  resolveTranscriptSearchAnchorItemId,
  resolveTranscriptSelectionOffset,
  resolveTranscriptWheelStep,
} from "./utils/transcript-scroll-controller.js";
import {
  buildTranscriptRowIndexByKey,
  buildTranscriptScreenBuffer,
  type TranscriptScreenBuffer,
  type TranscriptScreenPoint,
} from "../tui/core/screen.js";
import {
  clampTranscriptScreenHit,
  hitTestTranscriptScreen,
} from "../tui/core/hit-test.js";
import {
  buildTranscriptScreenSelection,
  buildTranscriptScreenSelectionSummary,
  type TranscriptTextSelection,
} from "../tui/core/selection.js";
import { resolveTranscriptDragEdgeScrollDirection } from "../tui/core/scroll.js";
import {
  getAskUserDialogTitle,
  resolveAskUserDismissChoice,
  shouldSwitchToAcceptEdits,
  toSelectOptions,
  type SelectOption,
} from "./utils/ask-user.js";
import { buildHelpMenuSections } from "./constants/layout.js";
import { buildStatusBarViewModel } from "./view-models/status-bar.js";
import {
  buildAmaSummaryViewModel,
  buildAmaWorkStripFromStatus as buildAmaWorkStripTextFromStatus,
} from "./view-models/ama-summary.js";
import {
  buildTranscriptSearchViewModel,
  buildTranscriptSelectionRuntimeState,
  buildTranscriptSelectionViewModel,
} from "./view-models/transcript-viewport.js";

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
  rendererMode: EffectiveTuiRendererMode;
  fullscreenPolicy: FullscreenPolicy;
  onExit: () => void;
}

// Banner Props
interface BannerProps {
  config: CurrentConfig;
  sessionId: string;
  workingDir: string;
  terminalWidth: number;
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

interface TranscriptMouseSelectionState {
  anchor: TranscriptScreenPoint;
  focus: TranscriptScreenPoint;
  didDrag: boolean;
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
  isLivePaused,
  isLoading,
  hasSpinnerLiveness,
}: {
  isLivePaused: boolean;
  isLoading: boolean;
  hasSpinnerLiveness: boolean;
}): boolean {
  if (isLivePaused) {
    return false;
  }
  if (isLoading && hasSpinnerLiveness) {
    return false;
  }
  return isLoading;
}

export function buildAmaWorkStripFromStatus(
  status: Pick<KodaXManagedTaskStatusEvent, "agentMode" | "childFanoutClass" | "childFanoutCount"> | null | undefined,
  isLoading: boolean,
): string | undefined {
  return buildAmaWorkStripTextFromStatus(status, isLoading);
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

const MAX_PERSISTED_UI_HISTORY_ITEMS = 150;
const MAX_PERSISTED_UI_HISTORY_ROUNDS = 50;

export function trimPersistedUiHistorySnapshot(
  items: readonly KodaXSessionUiHistoryItem[],
): KodaXSessionUiHistoryItem[] {
  if (items.length === 0) {
    return [];
  }

  const userIndices: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.type === "user") {
      userIndices.push(index);
    }
  }

  let trimmed = [...items];
  if (userIndices.length > MAX_PERSISTED_UI_HISTORY_ROUNDS) {
    const startIndex = userIndices[userIndices.length - MAX_PERSISTED_UI_HISTORY_ROUNDS] ?? 0;
    trimmed = items.slice(startIndex);
  }

  if (trimmed.length > MAX_PERSISTED_UI_HISTORY_ITEMS) {
    const windowed = trimmed.slice(-MAX_PERSISTED_UI_HISTORY_ITEMS);
    const firstUserIndex = windowed.findIndex((item) => item.type === "user");
    trimmed = firstUserIndex > 0 ? windowed.slice(firstUserIndex) : windowed;
  }

  return [...trimmed];
}

function normalizePersistedUiHistory(
  items: readonly KodaXSessionUiHistoryItem[] | undefined,
): KodaXSessionUiHistoryItem[] | undefined {
  if (!items) {
    return undefined;
  }

  return trimPersistedUiHistorySnapshot(items);
}

function serializeUiHistorySnapshot(
  items: readonly HistoryItem[],
): KodaXSessionUiHistoryItem[] {
  return trimPersistedUiHistorySnapshot(items
    .map((item) => toPersistedUiHistoryItem(item))
    .filter((item): item is KodaXSessionUiHistoryItem => Boolean(item)));
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
    return trimPersistedUiHistorySnapshot(currentHistory);
  }
  return trimPersistedUiHistorySnapshot([
    ...currentHistory,
    ...serializeCreatableHistoryItems(items),
  ]);
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
const Banner: React.FC<BannerProps> = ({
  config,
  sessionId,
  workingDir,
  terminalWidth,
  compactionInfo,
}) => {
  const theme = getTheme("dark");
  const model = config.model ?? getProviderModel(config.provider) ?? config.provider;
  const reasoningCapability = getProviderReasoningCapability(config.provider, config.model);
  const reasoningCapabilityShort = formatReasoningCapabilityShort(reasoningCapability);
  const dividerWidth = Math.min(60, terminalWidth - 4);

  // Compute compaction display values
  const ctxK = compactionInfo ? Math.round(compactionInfo.contextWindow / 1000) : 0;
  const triggerK = compactionInfo ? Math.round(compactionInfo.contextWindow * compactionInfo.triggerPercent / 100 / 1000) : 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Logo */}
      {KODAX_BANNER_LOGO_LINES.map((line, i) => (
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

function countWrappedBannerRows(text: string, width: number): number {
  return Math.max(
    1,
    calculateVisualLayout(
      text.length > 0 ? text.split("\n") : [""],
      Math.max(1, width),
      0,
      0,
    ).visualLines.length,
  );
}

function estimateBannerRows(props: BannerProps): number {
  const model = props.config.model ?? getProviderModel(props.config.provider) ?? props.config.provider;
  const reasoningCapability = getProviderReasoningCapability(
    props.config.provider,
    props.config.model,
  );
  const reasoningCapabilityShort = formatReasoningCapabilityShort(reasoningCapability);
  const dividerWidth = Math.min(60, props.terminalWidth - 4);
  const ctxK = props.compactionInfo ? Math.round(props.compactionInfo.contextWindow / 1000) : 0;
  const triggerK = props.compactionInfo
    ? Math.round(props.compactionInfo.contextWindow * props.compactionInfo.triggerPercent / 100 / 1000)
    : 0;
  const versionLine = `  v${KODAX_VERSION} | ${props.config.provider}/${model} [${reasoningCapabilityShort}] | ${props.config.agentMode.toUpperCase()} | ${props.config.permissionMode} | ${props.config.parallel ? "parallel" : "sequential"}${props.config.reasoningMode !== "off" ? ` +reason:${props.config.reasoningMode}` : ""}`;
  const compactionLine = props.compactionInfo
    ? `  Context: ${ctxK}k | Compaction: ${props.compactionInfo.enabled ? "on" : "off"} @ ${props.compactionInfo.triggerPercent}% (${triggerK}k)`
    : undefined;
  const sessionLine = `  Session: ${props.sessionId} | Working: ${props.workingDir}`;
  const dividerLine = `  ${"-".repeat(dividerWidth)}`;
  const lines = [
    ...KODAX_BANNER_LOGO_LINES,
    versionLine,
    ...(compactionLine ? [compactionLine] : []),
    dividerLine,
    sessionLine,
    dividerLine,
  ];

  return lines.reduce(
    (sum, line) => sum + countWrappedBannerRows(line, props.terminalWidth),
    0,
  ) + 1;
}

/**
 * Inner REPL component that uses contexts
 */
const InkREPLInner: React.FC<InkREPLProps> = ({
  options,
  config,
  context,
  storage,
  rendererMode,
  fullscreenPolicy,
  onExit,
  compactionInfo,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const writeTerminal = useTerminalWrite();
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
  const persistContextStateRunnerRef = useRef<Promise<void> | null>(null);
  const pendingPersistContextStateRef = useRef<{
    requested: boolean;
    uiHistoryOverride: KodaXSessionUiHistoryItem[] | undefined;
  }>({
    requested: false,
    uiHistoryOverride: undefined,
  });
  const appendHistoryItemsWithPersistenceRef = useRef<((items: readonly CreatableHistoryItem[]) => void) | null>(null);
  const interruptPersistenceQueuedRef = useRef(false);
  const [isInputEmpty, setIsInputEmpty] = useState(true); // Track if input is empty for ? shortcut
  const [inputText, setInputText] = useState("");
  const [transcriptDisplayState, setTranscriptDisplayState] = useState(() => (
    createTranscriptDisplayState(terminalHostProfile, {
      rendererMode,
    })
  ));
  const [historyScrollOffset, setHistoryScrollOffset] = useState(0);
  const [transcriptScrollHeight, setTranscriptScrollHeight] = useState(0);
  const transcriptScrollRef = useRef<ScrollBoxHandle | null>(null);
  const transcriptScrollWindowRef = useRef<ScrollBoxWindow | null>(null);
  const transcriptVisibleRowsRef = useRef<TranscriptRow[]>([]);
  const transcriptScreenBufferRef = useRef<TranscriptScreenBuffer | null>(null);
  const mouseSelectionRef = useRef<TranscriptMouseSelectionState | null>(null);
  const [transcriptTextSelection, setTranscriptTextSelection] = useState<TranscriptTextSelection | undefined>(undefined);
  const [selectionCopyNotice, setSelectionCopyNotice] = useState<string | undefined>(undefined);
  const [expandedTranscriptItemIds, setExpandedTranscriptItemIds] = useState<Set<string>>(() => new Set());
  const [transcriptSnapshot, setTranscriptSnapshot] = useState<ReviewSnapshot | null>(null);
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
  const lastAutoCopiedTranscriptItemIdRef = useRef<string | undefined>(undefined);

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
  const isTranscriptMode = transcriptDisplayState.surface === "transcript";
  const isAwaitingUserInteraction = !!confirmRequest || !!uiRequest || isHistorySearchActive;
  const transcriptMaxLines = isTranscriptMode ? 1000 : 12;
  const transcriptOwnsViewport = shouldWindowTranscript(transcriptDisplayState);
  const isLivePaused = shouldPauseLiveTranscript(transcriptDisplayState);
  const suggestionsReservedForLayout = shouldReserveSuggestionsSpace && !isTranscriptMode;

  const createTranscriptSnapshot = useCallback((): ReviewSnapshot => ({
    items: reviewHistory,
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
    if (isTranscriptMode) {
      setTranscriptSnapshot((prev) => prev ?? createTranscriptSnapshot());
      return;
    }

    setTranscriptSnapshot(null);
  }, [createTranscriptSnapshot, isTranscriptMode]);

  const pendingTranscriptUpdateCount = useMemo(() => {
    if (!isTranscriptMode || !transcriptSnapshot) {
      return 0;
    }

    let pending = Math.max(0, reviewHistory.length - transcriptSnapshot.items.length);
    if (isLoading !== transcriptSnapshot.isLoading) {
      pending += 1;
    }
    if (streamingState.currentResponse !== transcriptSnapshot.currentResponse) {
      pending += 1;
    }
    if (streamingState.thinkingContent !== transcriptSnapshot.thinkingContent) {
      pending += 1;
    }
    if (activeToolCalls.length !== transcriptSnapshot.activeToolCalls.length) {
      pending += 1;
    }

    return pending;
  }, [
    activeToolCalls.length,
    isLoading,
    isTranscriptMode,
    reviewHistory.length,
    streamingState.currentResponse,
    streamingState.thinkingContent,
    transcriptSnapshot,
  ]);

  const displaySnapshot = isTranscriptMode ? transcriptSnapshot : null;
  const displayItems = displaySnapshot?.items ?? (isTranscriptMode ? reviewHistory : renderHistory);
  const displayIsLoading = displaySnapshot?.isLoading ?? isLoading;
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
  const transcriptStreamingState = fullscreenPolicy.streamingPreview
    ? displayStreamingState
    : {
      ...displayStreamingState,
      isThinking: false,
      thinkingCharCount: 0,
      thinkingContent: "",
      currentResponse: "",
      currentTool: undefined,
      activeToolCalls: [] as ToolCall[],
      toolInputCharCount: 0,
      toolInputContent: "",
      lastLiveActivityLabel: undefined,
      iterationHistory: [],
      currentIteration: displayStreamingState.currentIteration,
    };
  const ownedTranscriptRenderModel = useMemo(
    () => transcriptOwnsViewport
      ? buildTranscriptRenderModel({
        items: displayItems,
        viewportWidth: terminalWidth,
        isLoading: displayIsLoading,
        maxLines: transcriptMaxLines,
        isThinking: transcriptStreamingState.isThinking,
        thinkingCharCount: transcriptStreamingState.thinkingCharCount,
        thinkingContent: transcriptStreamingState.thinkingContent,
        streamingResponse: transcriptStreamingState.currentResponse,
        currentTool: transcriptStreamingState.currentTool,
        activeToolCalls: transcriptStreamingState.activeToolCalls,
        toolInputCharCount: transcriptStreamingState.toolInputCharCount,
        toolInputContent: transcriptStreamingState.toolInputContent,
        iterationHistory: transcriptStreamingState.iterationHistory,
        currentIteration: transcriptStreamingState.currentIteration,
        isCompacting: transcriptStreamingState.isCompacting,
        managedAgentMode: currentConfig.agentMode,
        managedPhase: displayIsLoading ? managedTaskStatus?.phase : undefined,
        managedHarnessProfile: displayIsLoading ? managedTaskStatus?.harnessProfile : undefined,
        managedWorkerTitle: displayIsLoading ? managedTaskStatus?.activeWorkerTitle : undefined,
        managedRound: displayIsLoading ? managedTaskStatus?.currentRound : undefined,
        managedMaxRounds: displayIsLoading ? managedTaskStatus?.maxRounds : undefined,
        managedGlobalWorkBudget: displayIsLoading ? managedTaskStatus?.globalWorkBudget : undefined,
        managedBudgetUsage: displayIsLoading ? managedTaskStatus?.budgetUsage : undefined,
        managedBudgetApprovalRequired: displayIsLoading ? managedTaskStatus?.budgetApprovalRequired : undefined,
        lastLiveActivityLabel: transcriptStreamingState.lastLiveActivityLabel,
        windowed: true,
        showFullThinking: isTranscriptMode,
        showDetailedTools: isTranscriptMode,
        expandedItemKeys: expandedTranscriptItemIds,
      })
      : undefined,
    [
      currentConfig.agentMode,
      displayIsLoading,
      displayItems,
      expandedTranscriptItemIds,
      isTranscriptMode,
      managedTaskStatus?.activeWorkerTitle,
      managedTaskStatus?.budgetApprovalRequired,
      managedTaskStatus?.budgetUsage,
      managedTaskStatus?.currentRound,
      managedTaskStatus?.globalWorkBudget,
      managedTaskStatus?.harnessProfile,
      managedTaskStatus?.maxRounds,
      managedTaskStatus?.phase,
      terminalWidth,
      transcriptMaxLines,
      transcriptOwnsViewport,
      transcriptStreamingState.activeToolCalls,
      transcriptStreamingState.currentIteration,
      transcriptStreamingState.currentResponse,
      transcriptStreamingState.currentTool,
      transcriptStreamingState.isCompacting,
      transcriptStreamingState.isThinking,
      transcriptStreamingState.iterationHistory,
      transcriptStreamingState.lastLiveActivityLabel,
      transcriptStreamingState.thinkingCharCount,
      transcriptStreamingState.thinkingContent,
      transcriptStreamingState.toolInputCharCount,
      transcriptStreamingState.toolInputContent,
    ],
  );
  const amaSummaryViewModel = useMemo(
    () => buildAmaSummaryViewModel({
      status: managedTaskStatus,
      isLoading,
      agentMode: currentConfig.agentMode,
    }),
    [currentConfig.agentMode, isLoading, managedTaskStatus],
  );
  const rawWorkStripText = amaSummaryViewModel.workStripText;
  const displayWorkStripText = displaySnapshot?.workStripText ?? visibleWorkStripText;
  const selectableTranscriptItemIds = useMemo(
    () => getSelectableTranscriptItemIds(displayItems),
    [displayItems],
  );
  const selectedTranscriptItemId = useMemo(
    () => resolveTranscriptSelectedItemId(
      transcriptDisplayState,
      selectableTranscriptItemIds,
      transcriptDisplayState.selectedItemId,
    ),
    [selectableTranscriptItemIds, transcriptDisplayState],
  );
  const selectedTranscriptItem = useMemo(
    () => displayItems.find((item) => item.id === selectedTranscriptItemId),
    [displayItems, selectedTranscriptItemId],
  );
  const transcriptSelectionRuntime = useMemo(
    () => buildTranscriptSelectionRuntimeState({
      state: transcriptDisplayState,
      selectableItemIds: selectableTranscriptItemIds,
      selectedItemId: selectedTranscriptItemId,
      selectedItemType: selectedTranscriptItem?.type,
      isExpanded: selectedTranscriptItemId
        ? expandedTranscriptItemIds.has(selectedTranscriptItemId)
        : false,
    }),
    [
      expandedTranscriptItemIds,
      selectableTranscriptItemIds,
      selectedTranscriptItem?.type,
      selectedTranscriptItemId,
      transcriptDisplayState,
    ],
  );
  const supportsTranscriptSelection = transcriptSelectionRuntime.selectionEnabled;
  const supportsTranscriptCopyOnSelect = transcriptSelectionRuntime.copyCapabilities.copyOnSelect;
  const selectedTranscriptItemIndex = transcriptSelectionRuntime.selectedItemIndex;
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
  const clampedHistorySearchSelectedIndex = useMemo(() => {
    if (historySearchMatches.length === 0) {
      return 0;
    }
    if (historySearchSelectedIndex < 0) {
      return -1;
    }
    return Math.min(historySearchSelectedIndex, historySearchMatches.length - 1);
  }, [historySearchMatches.length, historySearchSelectedIndex]);
  const historySearchStatusText = useMemo(
    () => buildTranscriptSearchSummary(historySearchMatches, clampedHistorySearchSelectedIndex),
    [clampedHistorySearchSelectedIndex, historySearchMatches],
  );
  const historySearchDetailText = useMemo(() => {
    if (!isHistorySearchActive) {
      return undefined;
    }

    const trimmedQuery = historySearchQuery.trim();
    if (!trimmedQuery) {
      return "Type to search transcript";
    }

    if (historySearchMatches.length === 0) {
      return "No matches yet";
    }

    if (clampedHistorySearchSelectedIndex < 0) {
      return `${historySearchMatches.length} matches · use n/N or Enter to jump`;
    }

    return historySearchMatches[clampedHistorySearchSelectedIndex]?.excerpt;
  }, [
    clampedHistorySearchSelectedIndex,
    historySearchMatches,
    historySearchQuery,
    isHistorySearchActive,
  ]);
  const isSelectedTranscriptItemExpanded = transcriptSelectionRuntime.detailState === "expanded";
  const canCycleTranscriptSelection =
    transcriptSelectionRuntime.navigationCapabilities.selection;
  const canCopySelectedTranscriptItem =
    transcriptSelectionRuntime.copyCapabilities.message;
  const canCopySelectedToolInput =
    transcriptSelectionRuntime.copyCapabilities.toolInput;
  const canToggleSelectedTranscriptDetail =
    transcriptSelectionRuntime.toggleDetail;

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

  const transcriptChrome = useMemo(
    () => buildTranscriptChromeModel({
      state: transcriptDisplayState,
      ownsViewport: transcriptOwnsViewport,
      isAwaitingUserInteraction,
      isHistorySearchActive,
      isTranscriptMode,
      historySearchQuery,
    }),
    [
      historySearchQuery,
      isAwaitingUserInteraction,
      isHistorySearchActive,
      isTranscriptMode,
      transcriptDisplayState,
      transcriptOwnsViewport,
    ],
  );

  useEffect(() => {
    setTranscriptDisplayState((prev) => {
      let next = setTranscriptScrollAnchor(prev, historyScrollOffset);
      next = setTranscriptPendingLiveUpdates(next, pendingTranscriptUpdateCount);
      next = setTranscriptStickyPromptVisible(
        next,
        isTranscriptMode || isHistorySearchActive || isAwaitingUserInteraction,
      );
      next = setTranscriptSearchMatchIndex(next, clampedHistorySearchSelectedIndex);
      return next;
    });
  }, [
    clampedHistorySearchSelectedIndex,
    historyScrollOffset,
    isAwaitingUserInteraction,
    isHistorySearchActive,
    isTranscriptMode,
    pendingTranscriptUpdateCount,
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
  const showTaskBarSpinner = displayIsLoading
    && !isLivePaused
    && !fullscreenPolicy.transcriptSpinnerAnimation;

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
      isLivePaused,
      isLoading: displayIsLoading,
      hasSpinnerLiveness: !isLivePaused && (
        fullscreenPolicy.transcriptSpinnerAnimation || showTaskBarSpinner
      ),
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
    fullscreenPolicy.transcriptSpinnerAnimation,
    showTaskBarSpinner,
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
  const footerHeaderViewModel = useMemo(
    () => buildFooterHeaderViewModel({
      isHistorySearchActive,
      isTranscriptMode,
      pendingInputCount: streamingState.pendingInputs.length,
      buffering: transcriptDisplayState.buffering,
      pendingLiveUpdates: pendingTranscriptUpdateCount,
    }),
    [
      isHistorySearchActive,
      isTranscriptMode,
      pendingTranscriptUpdateCount,
      streamingState.pendingInputs.length,
      transcriptDisplayState.buffering,
    ],
  );
  const footerLeftItems = footerHeaderViewModel.leftItems;
  const footerRightItems = footerHeaderViewModel.rightItems;
  const footerHeaderSummary = footerHeaderViewModel.summary;
  const baseFooterNotices = useMemo(() => {
    const notices: string[] = [];
    if (historySearchQuery.trim()) {
      notices.push(`Search: ${historySearchQuery.trim()}`);
    }
    if (streamingState.pendingInputs.length > 0) {
      notices.push(`Queued follow-ups: ${streamingState.pendingInputs.length}`);
    }
    return notices;
  }, [historySearchQuery, streamingState.pendingInputs.length]);
  const footerNotifications = useMemo(() => {
    const notifications: Array<{
      id: string;
      text: string;
      tone?: "info" | "warning" | "accent";
    }> = [];
    if (
      historySearchQuery.trim().length > 0
      && isHistorySearchActive
      && historySearchMatches.length === 0
    ) {
      notifications.push({
        id: "search-empty",
        text: "No transcript matches yet",
        tone: "info",
      });
    }
    if (streamingState.pendingInputs.length >= MAX_PENDING_INPUTS) {
      notifications.push({
        id: "queue-full",
        text: `Queued follow-up limit reached (${MAX_PENDING_INPUTS})`,
        tone: "warning",
      });
    }
    return notifications;
  }, [
    historySearchMatches.length,
    historySearchQuery,
    isHistorySearchActive,
    streamingState.pendingInputs.length,
  ]);
  const footerNotificationSummary = useMemo(
    () => footerNotifications.map((notification) => notification.text).join(" | "),
    [footerNotifications],
  );
  const stashNoticeText = useMemo(() => {
    if (!inputText.trim()) {
      return undefined;
    }
    if (isTranscriptMode || isHistorySearchActive) {
      return "Draft preserved while viewing transcript";
    }
    return undefined;
  }, [inputText, isHistorySearchActive, isTranscriptMode]);
  const backgroundTaskViewModel = useMemo(
    () => buildAmaSummaryViewModel({
      status: managedTaskStatus,
      isLoading: displayIsLoading,
      agentMode: currentConfig.agentMode,
      parallelTextOverride: displayWorkStripText,
      currentTool: displayStreamingState.currentTool,
      toolInputCharCount: displayStreamingState.toolInputCharCount,
      toolInputContent: displayStreamingState.toolInputContent,
      liveActivityLabel: displayStreamingState.lastLiveActivityLabel,
      isThinkingActive: displayStreamingState.isThinking,
    }).backgroundTask,
    [
      currentConfig.agentMode,
      displayIsLoading,
      displayStreamingState.currentTool,
      displayStreamingState.isThinking,
      displayStreamingState.lastLiveActivityLabel,
      displayStreamingState.toolInputCharCount,
      displayStreamingState.toolInputContent,
      displayWorkStripText,
      managedTaskStatus,
    ],
  );
  const useOverlaySurface =
    transcriptDisplayState.supportsOverlaySurface
    && transcriptDisplayState.supportsSearchViewport
    && transcriptOwnsViewport;
  const transcriptSelectionState = useMemo(
    () => buildTranscriptSelectionViewModel({
      runtime: transcriptSelectionRuntime,
      itemSummary: selectedTranscriptItemSummary,
    }),
    [
      selectedTranscriptItemSummary,
      transcriptSelectionRuntime,
    ],
  );
  const transcriptSearchState = useMemo(
    () => buildTranscriptSearchViewModel({
      query: historySearchQuery,
      matches: historySearchMatches,
      currentMatchIndex: clampedHistorySearchSelectedIndex,
      anchorItemId: transcriptDisplayState.searchAnchorItemId,
      statusText: historySearchStatusText,
      useOverlaySurface,
    }),
    [
      clampedHistorySearchSelectedIndex,
      historySearchMatches,
      historySearchQuery,
      historySearchStatusText,
      transcriptDisplayState.searchAnchorItemId,
      useOverlaySurface,
    ],
  );
  const promptFooterNotices = useMemo(() => {
    const notices = [...baseFooterNotices];
    if (selectionCopyNotice) {
      notices.unshift(selectionCopyNotice);
    }
    return notices;
  }, [baseFooterNotices, selectionCopyNotice]);
  const transcriptFooterSelectionSummary = useMemo(() => {
    const textSelectionSummary = buildTranscriptScreenSelectionSummary(transcriptTextSelection);
    return textSelectionSummary
      ? textSelectionSummary
      : buildMessageSelectorText(transcriptSelectionState ?? {});
  }, [transcriptTextSelection, transcriptSelectionState]);
  const transcriptFooterActionSummary = useMemo(
    () =>
      buildMessageActionsText({
        copyMessage: Boolean(transcriptTextSelection) || transcriptSelectionRuntime.copyCapabilities.message,
        copyToolInput: transcriptSelectionRuntime.copyCapabilities.toolInput,
        copyOnSelect: transcriptSelectionRuntime.copyCapabilities.copyOnSelect,
        toggleDetail: transcriptSelectionRuntime.toggleDetail,
        selectionNavigation: transcriptSelectionRuntime.navigationCapabilities.selection,
        matchNavigation: Boolean(historySearchStatusText) && historySearchMatches.length > 0,
      }),
    [
      historySearchMatches.length,
      historySearchStatusText,
      transcriptTextSelection,
      transcriptSelectionRuntime.copyCapabilities.copyOnSelect,
      transcriptSelectionRuntime.copyCapabilities.message,
      transcriptSelectionRuntime.copyCapabilities.toolInput,
      transcriptSelectionRuntime.navigationCapabilities.selection,
      transcriptSelectionRuntime.toggleDetail,
    ],
  );
  const transcriptFooterSecondaryText = useMemo(() => {
    const parts = isHistorySearchActive
      ? [historySearchDetailText]
      : [
          transcriptFooterSelectionSummary,
          transcriptFooterActionSummary,
          ...baseFooterNotices.filter((notice) => !notice.startsWith("Search: ")),
        ];
    const normalizedParts = parts.filter((value): value is string => Boolean(value && value.trim().length > 0));
    return normalizedParts.join(" · ");
  }, [
    baseFooterNotices,
    historySearchDetailText,
    isHistorySearchActive,
    transcriptFooterActionSummary,
    transcriptFooterSelectionSummary,
  ]);
  const normalizedTranscriptFooterSecondaryText = useMemo(
    () => transcriptFooterSecondaryText?.replaceAll(" 路 ", " | "),
    [transcriptFooterSecondaryText],
  );
  const transcriptFooterBudgetNotices = useMemo(() => {
    const notices: string[] = [];
    if (normalizedTranscriptFooterSecondaryText) {
      notices.push(normalizedTranscriptFooterSecondaryText);
    }
    if (selectionCopyNotice) {
      notices.push(selectionCopyNotice);
    }
    return notices;
  }, [normalizedTranscriptFooterSecondaryText, selectionCopyNotice]);
  const activeFooterNotices = isTranscriptMode
    ? transcriptFooterBudgetNotices
    : promptFooterNotices;
  const terminalRows = stdout.rows || process.stdout.rows || 24;
  const bannerProps = useMemo<BannerProps>(() => ({
    config: currentConfig,
    sessionId: context.sessionId,
    workingDir: options.context?.gitRoot || process.cwd(),
    terminalWidth,
    compactionInfo: compactionInfo ?? undefined,
  }), [
    compactionInfo,
    context.sessionId,
    currentConfig,
    options.context?.gitRoot,
    terminalWidth,
  ]);
  const bannerRows = useMemo(
    () => (fullscreenPolicy.enabled && showBanner ? estimateBannerRows(bannerProps) : 0),
    [bannerProps, fullscreenPolicy.enabled, showBanner],
  );
  const fullscreenBannerRows = fullscreenPolicy.enabled && showBanner ? bannerRows : 0;
  const budgetedTerminalRows = terminalRows;
  const footerBudgetInputText = isTranscriptMode ? "" : inputText;
  const footerBudgetPendingInputSummary = isTranscriptMode ? undefined : pendingInputSummary;
  const footerBudgetWorkStripText = isTranscriptMode ? undefined : displayWorkStripText;
  const footerBudgetShowHelp = isTranscriptMode ? false : showHelp;
  const viewportBudget = useMemo(
    // Budget transcript, footer, overlay, status, and task slots together so
    // the viewport always receives a stable number of visible rows.
    () => calculateViewportBudget({
      terminalRows: budgetedTerminalRows,
      terminalWidth,
      inputText: footerBudgetInputText,
      footerHeaderText: footerHeaderSummary,
      pendingInputSummary: footerBudgetPendingInputSummary,
      stashNoticeSummary: stashNoticeText,
      notificationSummary: footerNotificationSummary,
      statusNoticeSummary: activeFooterNotices.join(" | "),
      workStripText: footerBudgetWorkStripText,
      suggestionsReserved: suggestionsReservedForLayout,
      suggestionsMode: useOverlaySurface ? "overlay" : "inline",
      showHelp: footerBudgetShowHelp,
      statusBarText,
      confirmPrompt: confirmRequest?.prompt,
      confirmInstruction,
      dialogMode: useOverlaySurface ? "overlay" : "inline",
      reviewHint: fullscreenPolicy.enabled && transcriptOwnsViewport
        ? undefined
        : transcriptChrome.browseHintText,
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
      budgetedTerminalRows,
      terminalWidth,
      footerBudgetInputText,
      footerHeaderSummary,
      footerBudgetPendingInputSummary,
      stashNoticeText,
      footerNotificationSummary,
      activeFooterNotices,
      footerBudgetWorkStripText,
      suggestionsReservedForLayout,
      useOverlaySurface,
      footerBudgetShowHelp,
      statusBarText,
      confirmRequest,
      confirmInstruction,
      fullscreenPolicy.enabled,
      transcriptChrome.browseHintText,
      transcriptOwnsViewport,
      uiRequest,
    ]
  );
  const suggestionsSurface = useMemo(
    () => (
      <PromptSuggestionsSurface
        reserveSpace={suggestionsReservedForLayout}
        width={terminalWidth}
        hidden={isTranscriptMode}
        mode={useOverlaySurface ? "overlay" : "inline"}
      />
    ),
    [
      suggestionsReservedForLayout,
      terminalWidth,
      isTranscriptMode,
      useOverlaySurface,
    ],
  );
  const reviewPageSize = useMemo(
    () => resolveTranscriptPageSize(viewportBudget.messageRows),
    [viewportBudget.messageRows],
  );
  const reviewWheelStep = useMemo(
    () => resolveTranscriptWheelStep(reviewPageSize),
    [reviewPageSize],
  );
  const transcriptAnimateSpinners = !isLivePaused && fullscreenPolicy.transcriptSpinnerAnimation;
  const effectiveTranscriptBaseScrollHeight = ownedTranscriptRenderModel?.rows.length ?? transcriptScrollHeight;
  const effectiveTranscriptScrollHeight = fullscreenPolicy.enabled
    ? effectiveTranscriptBaseScrollHeight + fullscreenBannerRows
    : effectiveTranscriptBaseScrollHeight;
  const transcriptRowIndexByKey = useMemo(
    () => buildTranscriptRowIndexByKey(ownedTranscriptRenderModel?.rows ?? []),
    [ownedTranscriptRenderModel?.rows],
  );
  const handleTranscriptMetricsChange = useCallback((metrics: {
    scrollHeight: number;
    viewportHeight: number;
  }) => {
    if (!ownedTranscriptRenderModel) {
      setTranscriptScrollHeight(metrics.scrollHeight);
    }
  }, [ownedTranscriptRenderModel]);
  const rebuildTranscriptScreenBuffer = useCallback((
    rows = transcriptVisibleRowsRef.current,
    window = transcriptScrollWindowRef.current,
  ) => {
    if (!window || rows.length === 0) {
      transcriptScreenBufferRef.current = null;
      return;
    }

    const stickyHeaderRows = transcriptChrome.stickyHeader?.visible && transcriptChrome.stickyHeader.label
      ? 1
      : 0;
    const bannerVisibleRows = showBanner && window.start < fullscreenBannerRows
      ? fullscreenBannerRows
      : 0;
    transcriptScreenBufferRef.current = buildTranscriptScreenBuffer(rows, {
      allRows: ownedTranscriptRenderModel?.rows ?? rows,
      rowIndexByKey: transcriptRowIndexByKey,
      topOffsetRows: stickyHeaderRows + bannerVisibleRows,
      viewportHeight: window.viewportHeight,
      animateSpinners: transcriptAnimateSpinners,
    });
  }, [
    fullscreenBannerRows,
    ownedTranscriptRenderModel?.rows,
    showBanner,
    transcriptAnimateSpinners,
    transcriptChrome.stickyHeader,
    transcriptRowIndexByKey,
  ]);
  const handleTranscriptWindowChange = useCallback((window: ScrollBoxWindow) => {
    transcriptScrollWindowRef.current = window;
    rebuildTranscriptScreenBuffer(transcriptVisibleRowsRef.current, window);
  }, [rebuildTranscriptScreenBuffer]);
  const handleVisibleTranscriptRowsChange = useCallback((rows: TranscriptRow[]) => {
    transcriptVisibleRowsRef.current = rows;
    rebuildTranscriptScreenBuffer(rows);
  }, [rebuildTranscriptScreenBuffer]);
  const clearTranscriptMouseSelection = useCallback(() => {
    mouseSelectionRef.current = null;
    setTranscriptTextSelection(undefined);
  }, []);

  useEffect(() => {
    rebuildTranscriptScreenBuffer();
  }, [rebuildTranscriptScreenBuffer]);

  useEffect(() => {
    const maxScrollOffset = Math.max(0, effectiveTranscriptScrollHeight - viewportBudget.messageRows);
    setHistoryScrollOffset((prev) => Math.min(prev, maxScrollOffset));
  }, [effectiveTranscriptScrollHeight, viewportBudget.messageRows]);

  useEffect(() => {
    if (!selectionCopyNotice) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setSelectionCopyNotice(undefined);
    }, 2000);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [selectionCopyNotice]);

  const scrollTranscriptTo = useCallback((nextScrollOffset: number) => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTo(nextScrollOffset);
      return;
    }

    setHistoryScrollOffset(Math.max(0, nextScrollOffset));
  }, []);

  const scrollTranscriptBy = useCallback((delta: number) => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollBy(delta);
      return;
    }

    setHistoryScrollOffset((prev) => incrementTranscriptScrollOffset(prev, delta));
  }, []);

  const scrollTranscriptToBottom = useCallback(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollToBottom();
      return;
    }

    setHistoryScrollOffset(0);
  }, []);
  const showClipboardNotice = useCallback((message: string | undefined) => {
    const trimmedMessage = message?.trim();
    if (!trimmedMessage) {
      return;
    }
    setSelectionCopyNotice(trimmedMessage);
  }, []);
  const buildClipboardFailureNotice = useCallback((prefix: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return `${prefix}: ${message}`;
  }, []);
  const copySelectedTranscriptText = useCallback(async (selectionOverride?: TranscriptTextSelection) => {
    const selection = selectionOverride ?? transcriptTextSelection;
    if (!selection) {
      return false;
    }

    const copyText = selection.text.trimEnd();
    if (!copyText) {
      return false;
    }

    try {
      await copyTextToClipboard(copyText, { terminalWrite: writeTerminal });
      showClipboardNotice(
        `Copied ${selection.rowCount} selected line${selection.rowCount === 1 ? "" : "s"} to clipboard.`,
      );
      return true;
    } catch (error) {
      showClipboardNotice(
        buildClipboardFailureNotice("Failed to copy transcript selection", error),
      );
      return false;
    }
  }, [buildClipboardFailureNotice, showClipboardNotice, transcriptTextSelection, writeTerminal]);

  const alignTranscriptSelection = useCallback((itemId: string | undefined) => {
    if (!itemId) {
      return;
    }
    const nextOffset = resolveTranscriptSelectionOffset({
      items: displayItems,
      terminalWidth,
      transcriptMaxLines,
      viewportRows: viewportBudget.messageRows,
      itemId,
      expandedItemKeys: expandedTranscriptItemIds,
      showDetailedTools: isTranscriptMode,
    });
    scrollTranscriptTo(nextOffset);
  }, [
    displayItems,
    terminalWidth,
    transcriptMaxLines,
    isTranscriptMode,
    expandedTranscriptItemIds,
    scrollTranscriptTo,
    viewportBudget.messageRows,
  ]);

  const selectTranscriptItem = useCallback((itemId: string | undefined) => {
    setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, itemId));
    if (itemId) {
      alignTranscriptSelection(itemId);
    }
  }, [alignTranscriptSelection]);

  const cycleTranscriptSelection = useCallback((direction: "prev" | "next") => {
    if (!canCycleTranscriptSelection) {
      return;
    }
    const nextItemId = moveTranscriptSelection(
      selectableTranscriptItemIds,
      selectedTranscriptItemId,
      direction,
    );
    if (nextItemId) {
      selectTranscriptItem(nextItemId);
    }
  }, [canCycleTranscriptSelection, selectableTranscriptItemIds, selectedTranscriptItemId, selectTranscriptItem]);

  const toggleSelectedTranscriptDetail = useCallback(() => {
    if (!canToggleSelectedTranscriptDetail || !selectedTranscriptItemId) {
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
  }, [canToggleSelectedTranscriptDetail, selectedTranscriptItemId]);

  const copySelectedTranscriptItem = useCallback(async () => {
    if (!canCopySelectedTranscriptItem || !selectedTranscriptItem) {
      return;
    }
    const copyText = buildTranscriptCopyText(selectedTranscriptItem);
    if (!copyText) {
      return;
    }
    try {
      await copyTextToClipboard(copyText, { terminalWrite: writeTerminal });
      showClipboardNotice("Copied selected transcript entry to clipboard.");
    } catch (error) {
      showClipboardNotice(
        buildClipboardFailureNotice("Failed to copy transcript entry", error),
      );
    }
  }, [
    buildClipboardFailureNotice,
    canCopySelectedTranscriptItem,
    selectedTranscriptItem,
    showClipboardNotice,
    writeTerminal,
  ]);

  const copySelectedTranscriptToolInput = useCallback(async () => {
    if (!canCopySelectedToolInput || !selectedTranscriptItem) {
      return;
    }

    const copyText = buildTranscriptToolInputCopyText(selectedTranscriptItem);
    if (!copyText) {
      return;
    }

    try {
      await copyTextToClipboard(copyText, { terminalWrite: writeTerminal });
      showClipboardNotice("Copied selected tool input to clipboard.");
    } catch (error) {
      showClipboardNotice(
        buildClipboardFailureNotice("Failed to copy tool input", error),
      );
    }
  }, [
    buildClipboardFailureNotice,
    canCopySelectedToolInput,
    selectedTranscriptItem,
    showClipboardNotice,
    writeTerminal,
  ]);
  const resolveTranscriptMouseTarget = useCallback((row: number, column: number) => {
    if (!fullscreenPolicy.enabled || !transcriptOwnsViewport) {
      return undefined;
    }

    const buffer = transcriptScreenBufferRef.current;
    return buffer ? hitTestTranscriptScreen(buffer, row, column) : undefined;
  }, [fullscreenPolicy.enabled, transcriptOwnsViewport]);
  const updateTranscriptMouseSelection = useCallback((
    anchorPoint: TranscriptScreenPoint,
    focusPoint: TranscriptScreenPoint,
    options?: {
      selectFullRowOnCollapsed?: boolean;
      updateSelectedItem?: boolean;
    },
  ) => {
    const nextSelection = buildTranscriptScreenSelection(
      ownedTranscriptRenderModel?.rows ?? transcriptVisibleRowsRef.current,
      anchorPoint,
      focusPoint,
      {
      animateSpinners: transcriptAnimateSpinners,
      selectFullRowOnCollapsed: options?.selectFullRowOnCollapsed,
      },
    );
    setTranscriptTextSelection(nextSelection);

    const focusedRow = (ownedTranscriptRenderModel?.rows ?? transcriptVisibleRowsRef.current)[
      Math.max(0, Math.min(focusPoint.modelRowIndex, (ownedTranscriptRenderModel?.rows ?? transcriptVisibleRowsRef.current).length - 1))
    ];
    if (options?.updateSelectedItem && focusedRow?.itemId) {
      setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, focusedRow.itemId));
    }
    return nextSelection;
  }, [ownedTranscriptRenderModel?.rows, transcriptAnimateSpinners]);

  const openHistorySearchSurface = useCallback(() => {
    if (!isTranscriptMode || !displayItems.length || confirmRequest || uiRequest) {
      return;
    }
    clearTranscriptMouseSelection();
    const anchorItemId = resolveTranscriptSearchAnchorItemId(
      {
        items: displayItems,
        selectedItemId: selectedTranscriptItemId,
        renderModel: ownedTranscriptRenderModel,
        terminalWidth,
        transcriptMaxLines,
        viewportRows: viewportBudget.messageRows,
        scrollOffset: historyScrollOffset,
        expandedItemKeys: expandedTranscriptItemIds,
        showDetailedTools: isTranscriptMode,
        preferViewportAnchor: true,
      },
    );
    setTranscriptDisplayState((prev) => openTranscriptSearch(prev, {
      anchorItemId,
      initialMatchIndex: 0,
    }));
    setHistorySearchQuery("");
    setHistorySearchSelectedIndex(0);
  }, [
    confirmRequest,
    displayItems,
    expandedTranscriptItemIds,
    historyScrollOffset,
    isTranscriptMode,
    selectedTranscriptItemId,
    ownedTranscriptRenderModel,
    terminalWidth,
    transcriptMaxLines,
    uiRequest,
    viewportBudget.messageRows,
    clearTranscriptMouseSelection,
    isTranscriptMode,
  ]);

  const closeHistorySearchSurface = useCallback(() => {
    setTranscriptDisplayState((prev) => closeTranscriptSearch(prev));
    setHistorySearchQuery("");
    setHistorySearchSelectedIndex(0);
    clearTranscriptMouseSelection();
  }, [clearTranscriptMouseSelection]);
  const disarmHistorySearchSelection = useCallback(() => {
    if (!isHistorySearchActive || historySearchMatches.length === 0) {
      return;
    }
    setHistorySearchSelectedIndex(-1);
  }, [historySearchMatches.length, isHistorySearchActive]);

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
      />
    ),
    [dialogConfirmState, dialogRequestState],
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
  const exitTranscriptModeSurface = useCallback(() => {
    setTranscriptDisplayState((prev) => jumpTranscriptToLatest(exitTranscriptMode(prev)));
    scrollTranscriptToBottom();
    setHistorySearchQuery("");
    setHistorySearchSelectedIndex(0);
    clearTranscriptMouseSelection();
  }, [clearTranscriptMouseSelection, scrollTranscriptToBottom]);

  const toggleTranscriptMode = useCallback(() => {
    if (isTranscriptMode) {
      exitTranscriptModeSurface();
      return;
    }

    setTranscriptDisplayState((prev) => enterTranscriptMode(prev));
    setHistorySearchQuery("");
    setHistorySearchSelectedIndex(0);
    clearTranscriptMouseSelection();
  }, [clearTranscriptMouseSelection, exitTranscriptModeSurface, isTranscriptMode]);

  useEffect(() => {
    if (supportsTranscriptSelection || !transcriptDisplayState.selectedItemId) {
      return;
    }

    setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, undefined));
  }, [supportsTranscriptSelection, transcriptDisplayState.selectedItemId]);

  useEffect(() => {
    if (!isTranscriptMode || !supportsTranscriptSelection) {
      return;
    }
    if (selectedTranscriptItemId && selectableTranscriptItemIds.includes(selectedTranscriptItemId)) {
      return;
    }
    const fallbackItemId = selectableTranscriptItemIds[selectableTranscriptItemIds.length - 1];
    setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, fallbackItemId));
  }, [isTranscriptMode, selectableTranscriptItemIds, selectedTranscriptItemId, supportsTranscriptSelection]);

  useEffect(() => {
    if (!isTranscriptMode || !canCopySelectedTranscriptItem || !supportsTranscriptCopyOnSelect) {
      lastAutoCopiedTranscriptItemIdRef.current = undefined;
      return;
    }

    if (transcriptTextSelection) {
      return;
    }

    if (!selectedTranscriptItemId || !selectedTranscriptItem) {
      return;
    }

    if (!lastAutoCopiedTranscriptItemIdRef.current) {
      lastAutoCopiedTranscriptItemIdRef.current = selectedTranscriptItemId;
      return;
    }

    if (lastAutoCopiedTranscriptItemIdRef.current === selectedTranscriptItemId) {
      return;
    }

    lastAutoCopiedTranscriptItemIdRef.current = selectedTranscriptItemId;
    const copyText = buildTranscriptCopyText(selectedTranscriptItem);
    if (!copyText) {
      return;
    }

    void copyTextToClipboard(copyText, { terminalWrite: writeTerminal }).catch(() => {
      // Ignore clipboard failures for passive copy-on-select.
    });
  }, [
    isTranscriptMode,
    selectedTranscriptItem,
    selectedTranscriptItemId,
    canCopySelectedTranscriptItem,
    supportsTranscriptCopyOnSelect,
    transcriptTextSelection,
    writeTerminal,
  ]);

  useEffect(() => {
    if (fullscreenPolicy.enabled) {
      return;
    }

    if (stdout?.isTTY !== true) {
      return;
    }

    if (!fullscreenPolicy.mouseWheel) {
      return;
    }

    stdout.write?.("\x1b[?1000h\x1b[?1006h");

    return () => {
      try {
        stdout.write?.("\x1b[?1000l\x1b[?1006l");
      } catch {
        // Ignore terminal cleanup failures.
      }
    };
  }, [fullscreenPolicy.enabled, fullscreenPolicy.mouseWheel, stdout]);

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
        if (isTranscriptMode || isAwaitingUserInteraction) {
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
      isTranscriptMode,
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

      if (
        key.name === "mouse"
        && key.mouse
        && fullscreenPolicy.mouseClicks
        && transcriptDisplayState.supportsMouseTracking
      ) {
        if (key.mouse.button !== "left") {
          return false;
        }

        const target = resolveTranscriptMouseTarget(key.mouse.row, key.mouse.column);
        if (key.mouse.action === "press") {
          if (!target || !hasTranscript) {
            clearTranscriptMouseSelection();
            return false;
          }

          disarmHistorySearchSelection();
          mouseSelectionRef.current = {
            anchor: target.point,
            focus: target.point,
            didDrag: false,
          };
          setTranscriptTextSelection(undefined);
          if (isTranscriptMode && target.screenRow.row.itemId) {
            setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, target.screenRow.row.itemId));
          }
          return true;
        }

        if (!mouseSelectionRef.current) {
          return false;
        }

        if (key.mouse.action === "drag") {
          const buffer = transcriptScreenBufferRef.current;
          const edgeScrollDirection = buffer
            ? resolveTranscriptDragEdgeScrollDirection(buffer, key.mouse.row)
            : 0;
          if (edgeScrollDirection !== 0) {
            scrollTranscriptBy(edgeScrollDirection);
          }
          const dragTarget = target ?? (buffer
            ? clampTranscriptScreenHit(buffer, key.mouse.row, key.mouse.column)
            : undefined);
          if (!dragTarget) {
            return false;
          }
          mouseSelectionRef.current = {
            ...mouseSelectionRef.current,
            focus: dragTarget.point,
            didDrag: true,
          };
          updateTranscriptMouseSelection(
            mouseSelectionRef.current.anchor,
            dragTarget.point,
            { updateSelectedItem: isTranscriptMode },
          );
          return true;
        }

        if (key.mouse.action === "release") {
          const fallbackPoint = mouseSelectionRef.current.focus;
          const releaseTarget = target ?? (transcriptScreenBufferRef.current
            ? clampTranscriptScreenHit(
              transcriptScreenBufferRef.current,
              key.mouse.row,
              key.mouse.column,
            )
            : undefined);
          const focusPoint = releaseTarget?.point ?? fallbackPoint;
          const nextSelection = {
            anchor: mouseSelectionRef.current.anchor,
            focus: focusPoint,
            didDrag: mouseSelectionRef.current.didDrag,
          };
          mouseSelectionRef.current = null;
          if (!nextSelection.didDrag) {
            setTranscriptTextSelection(undefined);
            if (isTranscriptMode && releaseTarget?.screenRow.row.itemId) {
              setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, releaseTarget.screenRow.row.itemId));
            }
            return true;
          }
          const nextTextSelection = updateTranscriptMouseSelection(
            nextSelection.anchor,
            nextSelection.focus,
            {
              selectFullRowOnCollapsed: false,
              updateSelectedItem: isTranscriptMode,
            },
          );
          if (nextTextSelection) {
            void copySelectedTranscriptText(nextTextSelection);
          }
          return true;
        }
      }

      if (key.name === "pageup") {
        if (!hasTranscript) return true;
        disarmHistorySearchSelection();
        scrollTranscriptBy(reviewPageSize);
        return true;
      }

      if (key.name === "wheelup") {
        if (!transcriptDisplayState.supportsWheelHistory || !hasTranscript) {
          return false;
        }
        disarmHistorySearchSelection();
        scrollTranscriptBy(reviewWheelStep);
        return true;
      }

      if (key.name === "wheeldown") {
        if (!transcriptDisplayState.supportsWheelHistory) {
          return false;
        }
        if (historyScrollOffset === 0) {
          return true;
        }

        disarmHistorySearchSelection();
        scrollTranscriptBy(-reviewWheelStep);
        return true;
      }

      if (transcriptDisplayState.searchMode === "history") {
        if (key.name === "escape") {
          closeHistorySearchSurface();
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
        if (key.name === "enter" || key.name === "return") {
          const match = historySearchMatches[clampedHistorySearchSelectedIndex];
          if (match) {
            selectTranscriptItem(match.itemId);
            closeHistorySearchSurface();
          }
          return true;
        }
        if (key.insertable && key.sequence) {
          setHistorySearchQuery((prev) => prev + key.sequence);
          setHistorySearchSelectedIndex(0);
          return true;
        }
      }

      if (
        isTranscriptMode
        && !isHistorySearchActive
        && !key.ctrl
        && !key.meta
        && key.insertable
        && key.sequence === "/"
      ) {
        openHistorySearchSurface();
        return true;
      }

      if (isTranscriptMode && (!key.ctrl && !key.meta) && key.name === "q") {
        exitTranscriptModeSurface();
        return true;
      }

      if (isTranscriptMode && key.name === "escape") {
        exitTranscriptModeSurface();
        return true;
      }

      if (key.name === "home") {
        disarmHistorySearchSelection();
        scrollTranscriptTo(Math.max(0, effectiveTranscriptScrollHeight - viewportBudget.messageRows));
        return true;
      }

      if (key.name === "pagedown") {
        disarmHistorySearchSelection();
        scrollTranscriptBy(-reviewPageSize);
        return true;
      }

      if (key.name === "end") {
        if (isTranscriptMode) {
          exitTranscriptModeSurface();
          return true;
        }
        scrollTranscriptToBottom();
        clearTranscriptMouseSelection();
        return true;
      }

      if (!isTranscriptMode) {
        return false;
      }

      if (key.name === "j" || key.name === "down") {
        disarmHistorySearchSelection();
        scrollTranscriptBy(-1);
        return true;
      }

      if (key.name === "k" || key.name === "up") {
        disarmHistorySearchSelection();
        scrollTranscriptBy(1);
        return true;
      }

      if (!key.ctrl && !key.meta && key.name === "g" && key.shift) {
        scrollTranscriptToBottom();
        return true;
      }

      if (!key.ctrl && !key.meta && key.name === "g" && !key.shift) {
        scrollTranscriptTo(Math.max(0, effectiveTranscriptScrollHeight - viewportBudget.messageRows));
        return true;
      }

      if (key.name === "left") {
        if (!canCycleTranscriptSelection) {
          return false;
        }
        cycleTranscriptSelection("prev");
        return true;
      }

      if (key.name === "right") {
        if (!canCycleTranscriptSelection) {
          return false;
        }
        cycleTranscriptSelection("next");
        return true;
      }

      if (!key.ctrl && !key.meta && !key.shift && key.name === "c") {
        if (transcriptTextSelection) {
          void copySelectedTranscriptText();
          return true;
        }
        if (!canCopySelectedTranscriptItem) {
          return false;
        }
        void copySelectedTranscriptItem();
        return true;
      }

      if (!key.ctrl && !key.meta && !key.shift && key.name === "i") {
        if (!canCopySelectedToolInput) {
          return false;
        }
        void copySelectedTranscriptToolInput();
        return true;
      }

      if (!key.ctrl && !key.meta && !key.shift && key.name === "v") {
        if (!canToggleSelectedTranscriptDetail) {
          return false;
        }
        toggleSelectedTranscriptDetail();
        return true;
      }

      if (!key.ctrl && !key.meta && key.name === "n") {
        if (historySearchMatches.length === 0) {
          return false;
        }
        setHistorySearchSelectedIndex((prev) => {
          const nextIndex = stepTranscriptSearchMatch(
            historySearchMatches.length,
            prev,
            key.shift ? "prev" : "next",
          );
          const match = historySearchMatches[nextIndex];
          if (match) {
            selectTranscriptItem(match.itemId);
          }
          return nextIndex;
        });
        return true;
      }

      return false;
    },
    [
      isTranscriptMode,
      displayItems,
      displayStreamingState.currentResponse,
      displayStreamingState.thinkingContent,
      displayStreamingState.activeToolCalls,
      historyScrollOffset,
      effectiveTranscriptScrollHeight,
      reviewPageSize,
      reviewWheelStep,
      exitTranscriptModeSurface,
      transcriptDisplayState,
      scrollTranscriptBy,
      scrollTranscriptTo,
      scrollTranscriptToBottom,
      canCycleTranscriptSelection,
      clampedHistorySearchSelectedIndex,
      clearTranscriptMouseSelection,
      copySelectedTranscriptText,
      historySearchMatches,
      openHistorySearchSurface,
      closeHistorySearchSurface,
      disarmHistorySearchSelection,
      cycleTranscriptSelection,
      canCopySelectedTranscriptItem,
      copySelectedTranscriptItem,
      canCopySelectedToolInput,
      copySelectedTranscriptToolInput,
      canToggleSelectedTranscriptDetail,
      toggleSelectedTranscriptDetail,
      fullscreenPolicy.mouseClicks,
      selectTranscriptItem,
      transcriptTextSelection,
      resolveTranscriptMouseTarget,
      transcriptDisplayState.supportsMouseTracking,
      updateTranscriptMouseSelection,
      viewportBudget.messageRows,
    ]
  );

  // Confirmation dialog keyboard handler.
  useKeypress(
    (key) => {
      if (!confirmRequest) return false;

      const answer = key.sequence.trim().toLowerCase();
      const isProtectedPath = !!confirmRequest.input._alwaysConfirm;
      // "Always" is only available in accept-edits mode.
      const canAlways = currentConfig.permissionMode === "accept-edits" && !isProtectedPath;

      if (answer === "y" || answer === "yes") {
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: true });
        confirmResolveRef.current = null;
        return true;
      }

      if (canAlways && (answer === "a" || answer === "always")) {
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: true, always: true });
        confirmResolveRef.current = null;
        return true;
      }

      if (answer === "n" || answer === "no" || key.name === "escape") {
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: false });
        confirmResolveRef.current = null;
        return true;
      }

      return key.insertable || key.name === "return";
    },
    {
      isActive: !!confirmRequest,
      priority: KeypressHandlerPriority.Critical,
    },
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

  useKeypress(
    (key) => {
      if (!uiRequest) return false;

      if (key.name === "escape") {
        resolveUIRequest(undefined);
        return true;
      }

      if (uiRequest.kind === "select") {
        if (key.name === "return") {
          const trimmed = uiRequest.buffer.trim();
          if (trimmed === "" || trimmed === "0") {
            resolveUIRequest(undefined);
            return true;
          }

          const index = Number.parseInt(trimmed, 10) - 1;
          if (Number.isNaN(index) || index < 0 || index >= uiRequest.options.length) {
            setUiRequest((prev) =>
              prev && prev.kind === "select"
                ? {
                  ...prev,
                  error: `Invalid choice. Enter 1-${prev.options.length}, or 0 to cancel.`,
                }
                : prev,
            );
            return true;
          }

          resolveUIRequest(uiRequest.options[index]?.value);
          return true;
        }

        if (key.name === "backspace" || key.name === "delete") {
          setUiRequest((prev) =>
            prev && prev.kind === "select"
              ? { ...prev, buffer: prev.buffer.slice(0, -1), error: undefined }
              : prev,
          );
          return true;
        }

        if (/^[0-9]+$/.test(key.sequence)) {
          setUiRequest((prev) =>
            prev && prev.kind === "select"
              ? { ...prev, buffer: prev.buffer + key.sequence, error: undefined }
              : prev,
          );
          return true;
        }

        return key.insertable || key.isPasted === true;
      }

      if (key.name === "return") {
        const trimmed = uiRequest.buffer.trim();
        resolveUIRequest(trimmed === "" ? uiRequest.defaultValue ?? undefined : trimmed);
        return true;
      }

      if (key.name === "backspace" || key.name === "delete") {
        setUiRequest((prev) =>
          prev && prev.kind === "input"
            ? { ...prev, buffer: prev.buffer.slice(0, -1), error: undefined }
            : prev,
        );
        return true;
      }

      if ((key.insertable || key.isPasted === true) && !key.ctrl && !key.meta) {
        setUiRequest((prev) =>
          prev && prev.kind === "input"
            ? { ...prev, buffer: prev.buffer + key.sequence, error: undefined }
            : prev,
        );
        return true;
      }

      return false;
    },
    {
      isActive: !!uiRequest,
      priority: KeypressHandlerPriority.Critical,
    },
  );

  // Sync history from context to UI
  // Re-sync when history is cleared (e.g., after /compact command)
  // Only sync if history is empty to avoid duplicates (Issue 046)
  useEffect(() => {
    if (context.messages.length > 0 && history.length === 0) {
      if (context.uiHistory?.length) {
        const persistedHistory = trimPersistedUiHistorySnapshot(context.uiHistory);
        if (persistedHistory.length !== context.uiHistory.length) {
          context.uiHistory = persistedHistory;
        }
        for (const item of persistedHistory) {
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
    onProviderRecovery: (event) => {
      emitRecoveryHistoryItem(addHistoryItem, event);
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
        // The user might have toggled transcript mode or permission mode mid-session.
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

  const reconcileContextLineage = useCallback((messages: readonly KodaXMessage[]): KodaXSessionLineage => {
    const nextLineage = createSessionLineage([...messages], context.lineage);
    context.lineage = nextLineage;
    return nextLineage;
  }, [context]);

  const persistContextState = useCallback(async (uiHistoryOverride?: KodaXSessionUiHistoryItem[]) => {
    if (context.messages.length === 0) {
      return;
    }

    const title = extractTitle(context.messages);
    const persistedUiHistory = trimPersistedUiHistorySnapshot(
      uiHistoryOverride ?? persistedUiHistoryRef.current,
    );
    persistedUiHistoryRef.current = persistedUiHistory;
    context.title = title;
    context.uiHistory = persistedUiHistory;
    const lineage = context.lineage ?? reconcileContextLineage(context.messages);
    context.lineage = lineage;
    await storage.save(context.sessionId, {
      messages: context.messages,
      title,
      gitRoot: context.gitRoot ?? "",
      uiHistory: persistedUiHistory,
      lineage,
      artifactLedger: context.artifactLedger,
    });
  }, [context, reconcileContextLineage, storage]);

  const flushPendingPersistContextState = useCallback(() => {
    if (persistContextStateRunnerRef.current) {
      return persistContextStateRunnerRef.current;
    }

    const run = (async () => {
      try {
        while (pendingPersistContextStateRef.current.requested) {
          pendingPersistContextStateRef.current.requested = false;
          const nextUiHistory = pendingPersistContextStateRef.current.uiHistoryOverride;
          pendingPersistContextStateRef.current.uiHistoryOverride = undefined;
          await persistContextState(nextUiHistory);
        }
      } finally {
        persistContextStateRunnerRef.current = null;
        if (pendingPersistContextStateRef.current.requested) {
          void flushPendingPersistContextState();
        }
      }
    })();

    persistContextStateRunnerRef.current = run;
    persistContextStateQueueRef.current = run;
    return run;
  }, [persistContextState]);

  const persistContextStateInBackground = useCallback((uiHistoryOverride?: KodaXSessionUiHistoryItem[]) => {
    if (uiHistoryOverride !== undefined) {
      const trimmedUiHistory = trimPersistedUiHistorySnapshot(uiHistoryOverride);
      persistedUiHistoryRef.current = trimmedUiHistory;
      pendingPersistContextStateRef.current.uiHistoryOverride = trimmedUiHistory;
    }
    pendingPersistContextStateRef.current.requested = true;
    return flushPendingPersistContextState();
  }, [flushPendingPersistContextState]);

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

  const appendHistoryItemsToCurrentSnapshot = useCallback((items: readonly CreatableHistoryItem[]) => {
    if (items.length === 0) {
      return;
    }
    for (const item of items) {
      addHistoryItem(item);
    }
    persistedUiHistoryRef.current = appendPersistedUiHistorySnapshot(
      persistedUiHistoryRef.current,
      items,
    );
  }, [addHistoryItem]);

  useEffect(() => {
    appendHistoryItemsWithPersistenceRef.current = appendHistoryItemsWithPersistence;
    return () => {
      appendHistoryItemsWithPersistenceRef.current = null;
    };
  }, [appendHistoryItemsWithPersistence]);

  const recordCompletedAgentRound = useCallback(async (result: KodaXResult) => {
    context.messages = result.messages;
    context.contextTokenSnapshot = result.contextTokenSnapshot;
    reconcileContextLineage(result.messages);

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
    const nextUiHistory = appendPersistedUiHistorySnapshot(
      persistedUiHistoryRef.current,
      persistedAdditions,
    );

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
    persistContextStateInBackground,
    reconcileContextLineage,
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
      const persistedHistoryBase = persistedUiHistoryRef.current;
      const persistedAdditions: CreatableHistoryItem[] = [];

      if (prepared.mode === "fork") {
        const lastAssistant = result.messages.slice().reverse().find((msg) => msg.role === "assistant");
        if (lastAssistant) {
          context.messages.push({
            role: "assistant",
            content: lastAssistant.content,
          });
          reconcileContextLineage(context.messages);
          for (const item of extractHistorySeedsFromMessage(lastAssistant)) {
            addHistoryItem(item);
            persistedAdditions.push(item);
          }
        }
      } else {
        context.messages = result.messages;
        context.contextTokenSnapshot = result.contextTokenSnapshot;
        reconcileContextLineage(result.messages);
        appendLastAssistantToHistory(result.messages);
        const lastAssistant = result.messages[result.messages.length - 1];
        if (lastAssistant?.role === "assistant") {
          for (const item of extractHistorySeedsFromMessage(lastAssistant)) {
            persistedAdditions.push(item);
          }
        }
      }

      await persistContextState(
        appendPersistedUiHistorySnapshot(persistedHistoryBase, persistedAdditions),
      );
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
    reconcileContextLineage,
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
        appendHistoryItemsToCurrentSnapshot([{
          type: "assistant",
          text: currentFullResponse + "\n\n[Interrupted]",
        }]);
      }

      // Add user message to UI history
      appendHistoryItemsToCurrentSnapshot([{
        type: "user",
        text: input,
      }]);
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
              const lineage = context.lineage ?? reconcileContextLineage(context.messages);
              context.lineage = lineage;
              await storage.save(context.sessionId, {
                messages: context.messages,
                title,
                gitRoot: context.gitRoot ?? "",
                uiHistory: persistedUiHistoryRef.current,
                lineage,
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
            persistedUiHistoryRef.current = [];
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
              context.uiHistory = normalizePersistedUiHistory(loaded.uiHistory);
              context.lineage = loaded.lineage;
              context.artifactLedger = loaded.artifactLedger;
              context.title = loaded.title;
              context.sessionId = id;
              context.contextTokenSnapshot = undefined;
              persistedUiHistoryRef.current = context.uiHistory ?? [];
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
            context.uiHistory = normalizePersistedUiHistory(loaded.uiHistory);
            context.title = loaded.title;
            context.contextTokenSnapshot = undefined;
            persistedUiHistoryRef.current = context.uiHistory ?? [];
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
            context.uiHistory = normalizePersistedUiHistory(forked.data.uiHistory);
            context.title = forked.data.title;
            context.contextTokenSnapshot = undefined;
            persistedUiHistoryRef.current = context.uiHistory ?? [];
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
      appendHistoryItemsToCurrentSnapshot,
      appendLastAssistantToHistory,
      persistContextState,
      reconcileContextLineage,
      runQueueableAgentSequence,
      startCompacting,
      stopCompacting,
      resetLiveToolCalls,
      clearWorkStripTimers,
    ]
  );

  const promptFooterSurface = (
    <PromptFooter
      left={<PromptFooterLeftSide items={footerLeftItems} />}
      right={<PromptFooterRightSide items={footerRightItems} />}
      queued={<QueuedCommandsSurface pendingInputs={streamingState.pendingInputs} />}
      stashNotice={<StashNotice text={stashNoticeText} />}
      notifications={<NotificationsSurface notifications={footerNotifications} />}
      inlineNotices={promptFooterNotices.length > 0 ? (
        <StatusNoticesSurface notices={promptFooterNotices} />
      ) : undefined}
      composer={(
        <PromptComposer
          onSubmit={handleSubmit}
          prompt=">"
          placeholder={isLoading
            ? canQueueFollowUps
              ? "Queue a follow-up for the next round..."
              : "Agent is busy..."
            : "Type a message..."}
          focus={!confirmRequest && !uiRequest && !isHistorySearchActive}
          cwd={process.cwd()}
          gitRoot={options.context?.gitRoot || context.gitRoot}
          onInputChange={handleInputChange}
        />
      )}
      inlineSuggestions={useOverlaySurface ? undefined : suggestionsSurface}
      helpSurface={showHelp ? (
        <PromptHelpMenu sections={buildHelpMenuSections()} />
      ) : undefined}
      taskBar={transcriptDisplayState.supportsFullscreenLayout ? (
        <BackgroundTaskBar
          items={backgroundTaskViewModel.items}
          overflowLabel={backgroundTaskViewModel.overflowLabel}
          ctaHint={backgroundTaskViewModel.ctaHint}
          showSpinner={showTaskBarSpinner}
        />
      ) : (
        <AmaWorkStrip
          text={displayWorkStripText}
          showSpinner={showTaskBarSpinner}
        />
      )}
      statusLine={<Box><StatusBar {...statusBarProps} viewModel={statusBarViewModel} /></Box>}
      inlineDialogs={useOverlaySurface ? undefined : dialogSurface}
    />
  );
  const transcriptFooterSurface = (
    <PromptFooter
      left={<PromptFooterLeftSide items={footerLeftItems} />}
      right={<PromptFooterRightSide items={footerRightItems} />}
      stashNotice={<StashNotice text={stashNoticeText} />}
      notifications={<NotificationsSurface notifications={footerNotifications} />}
      composer={(
        <TranscriptModeFooter
          searchActive={isHistorySearchActive}
          searchQuery={historySearchQuery}
          searchCurrent={historySearchMatches.length > 0 ? clampedHistorySearchSelectedIndex + 1 : 0}
          searchCount={historySearchMatches.length}
          searchDetailText={historySearchDetailText}
          pendingLiveUpdates={pendingTranscriptUpdateCount}
          secondaryText={transcriptFooterSecondaryText}
          noticeText={selectionCopyNotice}
        />
      )}
      statusLine={<Box><StatusBar {...statusBarProps} viewModel={statusBarViewModel} /></Box>}
    />
  );
  const renderPromptSurfaceTranscript = useCallback((options?: {
    bannerVisible?: boolean;
    rendererWindow?: Pick<ScrollBoxWindow, "start" | "end" | "scrollHeight" | "viewportHeight" | "scrollTop" | "viewportTop" | "pendingDelta" | "sticky">;
    visibleRowsOverride?: TranscriptRow[];
  }) => (
    <PromptTranscriptSurface
      banner={options?.bannerVisible ? <Banner {...bannerProps} /> : undefined}
      items={displayItems}
      isLoading={displayIsLoading}
      isThinking={transcriptStreamingState.isThinking}
      thinkingCharCount={transcriptStreamingState.thinkingCharCount}
      thinkingContent={transcriptStreamingState.thinkingContent}
      streamingResponse={transcriptStreamingState.currentResponse}
      currentTool={transcriptStreamingState.currentTool}
      activeToolCalls={transcriptStreamingState.activeToolCalls}
      toolInputCharCount={transcriptStreamingState.toolInputCharCount}
      toolInputContent={transcriptStreamingState.toolInputContent}
      iterationHistory={transcriptStreamingState.iterationHistory}
      currentIteration={transcriptStreamingState.currentIteration}
      isCompacting={transcriptStreamingState.isCompacting}
      agentMode={currentConfig.agentMode}
      managedPhase={displayIsLoading ? managedTaskStatus?.phase : undefined}
      managedHarnessProfile={displayIsLoading ? managedTaskStatus?.harnessProfile : undefined}
      managedWorkerTitle={displayIsLoading ? managedTaskStatus?.activeWorkerTitle : undefined}
      managedRound={displayIsLoading ? managedTaskStatus?.currentRound : undefined}
      managedMaxRounds={displayIsLoading ? managedTaskStatus?.maxRounds : undefined}
      managedGlobalWorkBudget={displayIsLoading ? managedTaskStatus?.globalWorkBudget : undefined}
      managedBudgetUsage={displayIsLoading ? managedTaskStatus?.budgetUsage : undefined}
      managedBudgetApprovalRequired={displayIsLoading ? managedTaskStatus?.budgetApprovalRequired : undefined}
      lastLiveActivityLabel={transcriptStreamingState.lastLiveActivityLabel}
      viewportRows={viewportBudget.messageRows}
      viewportWidth={terminalWidth}
      scrollOffset={historyScrollOffset}
      animateSpinners={options?.rendererWindow ? transcriptAnimateSpinners : (!isLivePaused && fullscreenPolicy.transcriptSpinnerAnimation)}
      windowed={Boolean(options?.rendererWindow)}
      rendererWindow={options?.rendererWindow}
      transcriptModel={ownedTranscriptRenderModel}
      visibleRowsOverride={options?.visibleRowsOverride}
      maxLines={transcriptMaxLines}
      showFullThinking={false}
      showDetailedTools={false}
      selectedTextRanges={transcriptTextSelection?.rowRanges}
      expandedItemKeys={expandedTranscriptItemIds}
      onMetricsChange={handleTranscriptMetricsChange}
      onVisibleRowsChange={handleVisibleTranscriptRowsChange}
    />
  ), [
    bannerProps,
    currentConfig.agentMode,
    displayIsLoading,
    expandedTranscriptItemIds,
    fullscreenPolicy.transcriptSpinnerAnimation,
    handleTranscriptMetricsChange,
    handleVisibleTranscriptRowsChange,
    historyScrollOffset,
    isLivePaused,
    managedTaskStatus?.activeWorkerTitle,
    managedTaskStatus?.budgetApprovalRequired,
    managedTaskStatus?.budgetUsage,
    managedTaskStatus?.currentRound,
    managedTaskStatus?.globalWorkBudget,
    managedTaskStatus?.harnessProfile,
    managedTaskStatus?.maxRounds,
    managedTaskStatus?.phase,
    ownedTranscriptRenderModel,
    terminalWidth,
    transcriptAnimateSpinners,
    transcriptMaxLines,
    transcriptStreamingState.activeToolCalls,
    transcriptStreamingState.currentIteration,
    transcriptStreamingState.currentResponse,
    transcriptStreamingState.currentTool,
    transcriptStreamingState.isCompacting,
    transcriptStreamingState.isThinking,
    transcriptStreamingState.iterationHistory,
    transcriptStreamingState.lastLiveActivityLabel,
    transcriptStreamingState.thinkingCharCount,
    transcriptStreamingState.thinkingContent,
    transcriptStreamingState.toolInputCharCount,
    transcriptStreamingState.toolInputContent,
    transcriptTextSelection?.rowRanges,
    viewportBudget.messageRows,
  ]);
  const renderTranscriptModeSurface = useCallback((options?: {
    bannerVisible?: boolean;
    rendererWindow?: Pick<ScrollBoxWindow, "start" | "end" | "scrollHeight" | "viewportHeight" | "scrollTop" | "viewportTop" | "pendingDelta" | "sticky">;
    visibleRowsOverride?: TranscriptRow[];
  }) => (
    <TranscriptModeSurface
      banner={options?.bannerVisible ? <Banner {...bannerProps} /> : undefined}
      items={displayItems}
      isLoading={displayIsLoading}
      isThinking={transcriptStreamingState.isThinking}
      thinkingCharCount={transcriptStreamingState.thinkingCharCount}
      thinkingContent={transcriptStreamingState.thinkingContent}
      streamingResponse={transcriptStreamingState.currentResponse}
      currentTool={transcriptStreamingState.currentTool}
      activeToolCalls={transcriptStreamingState.activeToolCalls}
      toolInputCharCount={transcriptStreamingState.toolInputCharCount}
      toolInputContent={transcriptStreamingState.toolInputContent}
      iterationHistory={transcriptStreamingState.iterationHistory}
      currentIteration={transcriptStreamingState.currentIteration}
      isCompacting={transcriptStreamingState.isCompacting}
      agentMode={currentConfig.agentMode}
      managedPhase={displayIsLoading ? managedTaskStatus?.phase : undefined}
      managedHarnessProfile={displayIsLoading ? managedTaskStatus?.harnessProfile : undefined}
      managedWorkerTitle={displayIsLoading ? managedTaskStatus?.activeWorkerTitle : undefined}
      managedRound={displayIsLoading ? managedTaskStatus?.currentRound : undefined}
      managedMaxRounds={displayIsLoading ? managedTaskStatus?.maxRounds : undefined}
      managedGlobalWorkBudget={displayIsLoading ? managedTaskStatus?.globalWorkBudget : undefined}
      managedBudgetUsage={displayIsLoading ? managedTaskStatus?.budgetUsage : undefined}
      managedBudgetApprovalRequired={displayIsLoading ? managedTaskStatus?.budgetApprovalRequired : undefined}
      lastLiveActivityLabel={transcriptStreamingState.lastLiveActivityLabel}
      viewportRows={viewportBudget.messageRows}
      viewportWidth={terminalWidth}
      scrollOffset={historyScrollOffset}
      animateSpinners={options?.rendererWindow ? transcriptAnimateSpinners : (!isLivePaused && fullscreenPolicy.transcriptSpinnerAnimation)}
      windowed={Boolean(options?.rendererWindow)}
      rendererWindow={options?.rendererWindow}
      transcriptModel={ownedTranscriptRenderModel}
      visibleRowsOverride={options?.visibleRowsOverride}
      maxLines={transcriptMaxLines}
      showFullThinking
      showDetailedTools
      selectedItemId={selectedTranscriptItemId}
      selectedTextRanges={transcriptTextSelection?.rowRanges}
      expandedItemKeys={expandedTranscriptItemIds}
      onMetricsChange={handleTranscriptMetricsChange}
      onVisibleRowsChange={handleVisibleTranscriptRowsChange}
    />
  ), [
    bannerProps,
    currentConfig.agentMode,
    displayIsLoading,
    expandedTranscriptItemIds,
    fullscreenPolicy.transcriptSpinnerAnimation,
    handleTranscriptMetricsChange,
    handleVisibleTranscriptRowsChange,
    historyScrollOffset,
    isLivePaused,
    managedTaskStatus?.activeWorkerTitle,
    managedTaskStatus?.budgetApprovalRequired,
    managedTaskStatus?.budgetUsage,
    managedTaskStatus?.currentRound,
    managedTaskStatus?.globalWorkBudget,
    managedTaskStatus?.harnessProfile,
    managedTaskStatus?.maxRounds,
    managedTaskStatus?.phase,
    ownedTranscriptRenderModel,
    selectedTranscriptItemId,
    terminalWidth,
    transcriptAnimateSpinners,
    transcriptMaxLines,
    transcriptStreamingState.activeToolCalls,
    transcriptStreamingState.currentIteration,
    transcriptStreamingState.currentResponse,
    transcriptStreamingState.currentTool,
    transcriptStreamingState.isCompacting,
    transcriptStreamingState.isThinking,
    transcriptStreamingState.iterationHistory,
    transcriptStreamingState.lastLiveActivityLabel,
    transcriptStreamingState.thinkingCharCount,
    transcriptStreamingState.thinkingContent,
    transcriptStreamingState.toolInputCharCount,
    transcriptStreamingState.toolInputContent,
    transcriptTextSelection?.rowRanges,
    viewportBudget.messageRows,
  ]);
  const shellBody = (
    <Box
      flexDirection="column"
      width={terminalWidth}
      flexShrink={0}
      flexGrow={fullscreenPolicy.enabled ? 1 : 0}
    >
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
        onToggleTranscriptMode={toggleTranscriptMode}
        onOpenTranscriptSearch={openHistorySearchSurface}
        canOpenTranscriptSearch={isTranscriptMode && !confirmRequest && !uiRequest}
        isInteractiveDialogActive={Boolean(confirmRequest || uiRequest)}
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

      {/* Banner - in non-fullscreen mode this remains part of scrollback history */}
      {showBanner && (!fullscreenPolicy.enabled ? (
        <Static items={[1]}>
          {() => (
            <Banner
              key="banner"
              {...bannerProps}
            />
          )}
        </Static>
      ) : null)}


      <FullscreenTranscriptLayout
        width={terminalWidth}
        stickyHeader={transcriptChrome.stickyHeader}
        jumpToLatest={transcriptChrome.jumpToLatest}
        transcript={!fullscreenPolicy.enabled || !transcriptOwnsViewport ? (
          (isTranscriptMode
            ? renderTranscriptModeSurface({ bannerVisible: fullscreenPolicy.enabled && showBanner })
            : renderPromptSurfaceTranscript({ bannerVisible: fullscreenPolicy.enabled && showBanner }))
        ) : undefined}
        renderTranscriptWindow={fullscreenPolicy.enabled && transcriptOwnsViewport
          ? (window) => (
            (() => {
              const adjustedWindow = {
                ...window,
                start: Math.max(0, window.start - fullscreenBannerRows),
                end: Math.max(0, window.end - fullscreenBannerRows),
                viewportTop: Math.max(0, window.viewportTop - fullscreenBannerRows),
                viewportHeight: Math.max(
                  0,
                  window.viewportHeight - (showBanner && window.start < fullscreenBannerRows
                    ? fullscreenBannerRows
                    : 0),
                ),
              };
              const visibleRows = resolveVisibleTranscriptRows(
                ownedTranscriptRenderModel?.rows ?? [],
                {
                  start: adjustedWindow.start,
                  end: adjustedWindow.end,
                },
              );

              return isTranscriptMode
                ? renderTranscriptModeSurface({
                  bannerVisible: showBanner && window.start < fullscreenBannerRows,
                  rendererWindow: adjustedWindow,
                  visibleRowsOverride: visibleRows,
                })
                : renderPromptSurfaceTranscript({
                  bannerVisible: showBanner && window.start < fullscreenBannerRows,
                  rendererWindow: adjustedWindow,
                  visibleRowsOverride: visibleRows,
                });
            })()
          )
          : undefined}
        overlay={overlaySurface}
        scrollTop={historyScrollOffset}
        scrollHeight={effectiveTranscriptScrollHeight}
        viewportHeight={viewportBudget.messageRows}
        stickyScroll={!isTranscriptMode && !isAwaitingUserInteraction && historyScrollOffset === 0}
        scrollRef={transcriptScrollRef}
        onWindowChange={handleTranscriptWindowChange}
        onScrollTopChange={setHistoryScrollOffset}
        footer={isTranscriptMode ? transcriptFooterSurface : promptFooterSurface}
      />
    </Box>
  );

  if (fullscreenPolicy.enabled) {
    return (
      <AlternateScreen
        mouseTracking={fullscreenPolicy.mouseWheel || fullscreenPolicy.mouseClicks}
      >
        {shellBody}
      </AlternateScreen>
    );
  }

  return shellBody;
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
  const terminalHostProfile = detectTerminalHostProfile();
  const rendererMode = resolveEffectiveTuiRendererMode();
  const fullscreenPolicy = resolveFullscreenPolicy(terminalHostProfile, rendererMode);

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
      existingUiHistory = normalizePersistedUiHistory(loaded.uiHistory);
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
          existingUiHistory = normalizePersistedUiHistory(loaded.uiHistory);
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
        rendererMode={rendererMode}
        fullscreenPolicy={fullscreenPolicy}
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
