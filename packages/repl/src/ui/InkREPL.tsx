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
import { render, Box, useApp, Text, Static, useStdout, useStdin, useTerminalWrite } from "./tui.js";
import { AlternateScreen, type ScrollBoxWindow } from "../tui/index.js";
import { StatusBar } from "./components/StatusBar.js";
import { FullscreenTranscriptLayout } from "./components/FullscreenTranscriptLayout.js";
import { TranscriptModeFooter } from "./components/TranscriptModeFooter.js";
import { PromptTranscriptSurface } from "./components/PromptTranscriptSurface.js";
import { TranscriptModeSurface } from "./components/TranscriptModeSurface.js";
import { PromptComposer } from "./components/PromptComposer.js";
import {
  PromptFooter,
  PromptFooterLeftSide,
  PromptFooterRightSide,
} from "./components/PromptFooter.js";
import { PromptHelpMenu } from "./components/PromptHelpMenu.js";
import { PromptSuggestionsSurface } from "./components/PromptSuggestionsSurface.js";
import { DialogSurface } from "./components/DialogSurface.js";
import { ClipboardToastSurface } from "./components/ClipboardToastSurface.js";
import { QueuedCommandsSurface } from "./components/QueuedCommandsSurface.js";
import { NotificationsSurface } from "./components/NotificationsSurface.js";
import { StatusNoticesSurface } from "./components/StatusNoticesSurface.js";
import { StashNotice } from "./components/StashNotice.js";
import { Spinner } from "./components/LoadingIndicator.js";
import { BackgroundTaskBar } from "./components/BackgroundTaskBar.js";
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
  extractArtifactLedger,
  KodaXInputArtifact,
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
  CANCELLED_TOOL_RESULT_MESSAGE,
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
import { t } from "../common/i18n.js";
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
import { preparePromptInputArtifacts } from "../common/input-artifacts.js";

// Extracted modules
import { MemorySessionStorage, type SessionStorage } from "./utils/session-storage.js";
import { processSpecialSyntax, isShellCommandHandled } from "./utils/shell-executor.js";
import {
  extractHistorySeedsFromMessage,
  seedToHistoryItem,
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
  hasTranscriptInputActivity,
  resolveStreamingInterruptAction,
  resolveTranscriptPointerAction,
} from "./utils/transcript-input-policy.js";
import { resolveTranscriptKeyboardAction } from "./utils/transcript-key-actions.js";
import { executeTranscriptKeyboardAction } from "./utils/transcript-interaction-controller.js";
import {
  buildTranscriptRenderModel,
  materializeTranscriptRenderModel,
  sliceHistoryToRecentRounds,
  type TranscriptRenderModel,
  type TranscriptRow,
  type TranscriptSection,
} from "./utils/transcript-layout.js";
import {
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
  clampTranscriptScrollOffset,
  isTranscriptItemVisible,
  resolveTranscriptPageSize,
  resolveTranscriptSearchAnchorItemId,
  resolveTranscriptSelectionOffset,
  resolveTranscriptWheelStep,
  useTranscriptViewportScrollController,
} from "./utils/transcript-scroll-controller.js";
import {
  resolveTranscriptOwnedWindowGeometry,
  type TranscriptOwnedWindowGeometry,
} from "./utils/transcript-window-geometry.js";
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
  type TranscriptTextSelection,
} from "../tui/core/selection.js";
import { resolveTranscriptDragEdgeScrollDirection } from "../tui/core/scroll.js";
import { getRendererInstance } from "../tui/core/root.js";
import {
  getAskUserDialogTitle,
  shouldSwitchToAcceptEdits,
  toSelectOptions,
  type SelectOption,
} from "./utils/ask-user.js";
import { buildHelpMenuSections } from "./constants/layout.js";
import { buildStatusBarViewModel } from "./view-models/status-bar.js";
import {
  buildPromptActivityViewModel,
  buildPromptPlaceholderText,
} from "./view-models/surface-liveness.js";
import { buildSurfaceStatusBarProps } from "./view-models/surface-status.js";
import { buildTranscriptSearchChrome } from "./view-models/transcript-search.js";
import {
  buildBaseFooterNotices,
  buildFooterNotifications,
  buildPromptFooterNotices,
  buildStashNoticeText,
  buildTranscriptFooterViewModel,
} from "./view-models/surface-chrome.js";
import {
  buildAmaSummaryViewModel,
  buildAmaWorkStripFromStatus as buildAmaWorkStripTextFromStatus,
} from "./view-models/ama-summary.js";
import {
  buildTranscriptSelectionRuntimeState,
  buildTranscriptSelectionViewModel,
} from "./view-models/transcript-viewport.js";
import {
  buildPromptSurfaceItems,
  captureTranscriptSnapshot,
  countPendingTranscriptUpdates,
  resolveTranscriptInteractionPolicy,
  resolveTranscriptSurfaceItems,
  shouldOwnTranscriptViewport,
  type TranscriptSnapshot,
} from "./utils/transcript-surface.js";
import {
  extendTranscriptSelectionSpan,
  resolveTranscriptMultiClickState,
  resolveTranscriptSelectionSpanAt,
  type TranscriptMultiClickTrackerState,
  type TranscriptSelectionGestureMode,
  type TranscriptSelectionSpan,
} from "./utils/transcript-selection-gestures.js";

// REPL options
export interface InkREPLOptions extends KodaXOptions {
  storage?: SessionStorage;
  hardExitOnClose?: boolean;
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

type StreamingEvents = import("@kodax/coding").KodaXEvents & {
  onCompactedMessages?: (messages: KodaXMessage[], update?: CompactionUpdate) => void;
};

interface TranscriptMouseSelectionState {
  anchor: TranscriptScreenPoint;
  focus: TranscriptScreenPoint;
  didDrag: boolean;
  mode: TranscriptSelectionGestureMode;
  anchorSpan?: TranscriptSelectionSpan;
}

interface ClipboardNoticeState {
  text: string;
  tone: "success" | "warning";
}

type ManagedForegroundLedgerBlockKind = "thinking" | "assistant" | "tool_group";

interface ManagedForegroundLedgerState {
  workerId?: string;
  workerTitle?: string;
  activeKind?: ManagedForegroundLedgerBlockKind;
  activeThinkingItemId?: string;
  activeAssistantItemId?: string;
  activeToolGroupItemId?: string;
  activeToolGroupTools: ToolCall[];
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

function buildManagedTranscriptCompactText(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  if (lines.length === 1) {
    return lines[0];
  }

  const [first, second] = lines;
  const combined = first.startsWith("[")
    ? `${first} ${second}`
    : `${first} / ${second}`;
  return combined.length > 220 ? `${combined.slice(0, 217)}...` : combined;
}

function toManagedTranscriptEventItem(text: string): CreatableHistoryItem {
  const compactText = buildManagedTranscriptCompactText(text);
  return {
    type: "event",
    icon: ">",
    text,
    ...(compactText && compactText !== text ? { compactText } : {}),
  };
}

function toCreatableHistoryItem(item: HistoryItem): CreatableHistoryItem {
  switch (item.type) {
    case "assistant":
      return {
        type: "assistant",
        text: item.text,
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "thinking":
      return {
        type: "thinking",
        text: item.text,
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "event":
      return {
        type: "event",
        text: item.text,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "info":
      return {
        type: "info",
        text: item.text,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "error":
      return { type: "error", text: item.text };
    case "system":
      return { type: "system", text: item.text };
    case "hint":
      return { type: "hint", text: item.text };
    case "tool_group":
      return { type: "tool_group", tools: item.tools };
    case "user":
      return { type: "user", text: item.text };
    default:
      {
        const exhaustiveCheck: never = item;
        return exhaustiveCheck;
      }
  }
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

type ManagedLiveItemDraft = {
  item: HistoryItem;
  persistToHistory: boolean;
};

function areManagedLiveItemsEquivalent(left: HistoryItem, right: HistoryItem): boolean {
  if (left.type !== right.type) {
    return false;
  }

  switch (left.type) {
    case "assistant": {
      const next = right as typeof left;
      return left.text === next.text && left.compactText === next.compactText;
    }
    case "thinking": {
      const next = right as typeof left;
      return left.text === next.text && left.compactText === next.compactText;
    }
    case "event": {
      const next = right as typeof left;
      return left.text === next.text
        && left.compactText === next.compactText
        && left.icon === next.icon;
    }
    case "info": {
      const next = right as typeof left;
      return left.text === next.text
        && left.compactText === next.compactText
        && left.icon === next.icon;
    }
    case "error":
    case "hint":
    case "system":
    case "user": {
      const next = right as typeof left;
      return left.text === next.text;
    }
    case "tool_group": {
      const next = right as typeof left;
      return JSON.stringify(left.tools) === JSON.stringify(next.tools);
    }
    default:
      return false;
  }
}

function buildManagedLiveEventDrafts(
  status: KodaXManagedTaskStatusEvent,
): ManagedLiveItemDraft[] {
  if (status.events && status.events.length > 0) {
    return status.events.reduce<ManagedLiveItemDraft[]>((acc, event) => {
        const compactText = event.summary.trim();
        const text = (event.detail ?? event.summary).trim();
        if (!compactText || !text) {
          return acc;
        }
        const itemId = `managed-live-${event.key}`;
        const timestamp = Date.now();
        const persistToHistory = event.persistToHistory ?? status.persistToHistory ?? false;
        if (event.presentation === "thinking") {
          acc.push({
            item: {
              id: itemId,
              type: "thinking",
              timestamp,
              text,
              ...(compactText !== text ? { compactText } : {}),
            },
            persistToHistory,
          });
          return acc;
        }
        if (event.presentation === "assistant") {
          acc.push({
            item: {
              id: itemId,
              type: "assistant",
              timestamp,
              text,
              ...(compactText !== text ? { compactText } : {}),
            },
            persistToHistory,
          });
          return acc;
        }
        acc.push({
          item: {
            id: itemId,
            type: "event",
            timestamp,
            text,
            icon: event.kind === "warning" ? "!" : ">",
            ...(compactText !== text ? { compactText } : {}),
          },
          persistToHistory,
        });
        return acc;
      }, []);
  }

  const compactText = formatManagedTaskBreadcrumb(status);
  const text = formatManagedTaskBreadcrumb(status, { expanded: true }) ?? compactText;
  if (!compactText || !text) {
    return [];
  }
  return [{
    item: {
      id: `managed-live-fallback-${status.phase ?? "worker"}-${compactText.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}`,
      type: "event",
      timestamp: Date.now(),
      text,
      icon: ">",
      ...(compactText !== text ? { compactText } : {}),
    },
    persistToHistory: status.persistToHistory ?? false,
  }];
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

function isForegroundManagedStreamingStatus(
  status: KodaXManagedTaskStatusEvent | null | undefined,
): status is KodaXManagedTaskStatusEvent & { activeWorkerId: string } {
  return Boolean(
    status?.activeWorkerId
      && !status.childFanoutClass
      && (status.phase === "preflight" || status.phase === "worker"),
  );
}

export function buildManagedForegroundTurnHistoryItems(
  workerTitle: string | undefined,
  options: {
    thinking?: string;
    response?: string;
    toolCalls?: readonly ToolCall[];
    toolNames?: readonly string[];
    createId: (kind: "thinking" | "assistant" | "tool_group" | "info") => string;
  },
): HistoryItem[] {
  const timestamp = Date.now();
  const prefix = workerTitle?.trim()
    ? `[${workerTitle.trim()}] `
    : "";
  const items: HistoryItem[] = [];
  const normalizedThinking = options.thinking?.trim() ?? "";
  const normalizedResponse = options.response?.trim() ?? "";

  if (normalizedThinking) {
    const text = `${prefix}${normalizedThinking}`.trim();
    const compactText = buildManagedTranscriptCompactText(text);
    items.push({
      id: options.createId("thinking"),
      type: "thinking",
      timestamp,
      text,
      ...(compactText && compactText !== text ? { compactText } : {}),
    });
  }

  const normalizedToolCalls = options.toolCalls && options.toolCalls.length > 0
    ? [...options.toolCalls]
    : [];
  const normalizedToolNames = options.toolNames && options.toolNames.length > 0
    ? [...options.toolNames]
    : [];

  if (normalizedToolCalls.length > 0) {
    items.push({
      id: options.createId("tool_group"),
      type: "tool_group",
      timestamp,
      tools: normalizedToolCalls,
    });
  } else if (!normalizedThinking && !normalizedResponse && normalizedToolNames.length > 0) {
    items.push({
      id: options.createId("info"),
      type: "info",
      timestamp,
      icon: "*",
      text: `${prefix}Tools: ${normalizedToolNames.join(", ")}`.trim(),
    });
  }

  if (normalizedResponse) {
    const text = `${prefix}${normalizedResponse}`.trim();
    const compactText = buildManagedTranscriptCompactText(text);
    items.push({
      id: options.createId("assistant"),
      type: "assistant",
      timestamp,
      text,
      ...(compactText && compactText !== text ? { compactText } : {}),
    });
  }

  return items;
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
  hasSpinnerLiveness: _hasSpinnerLiveness,
}: {
  isLivePaused: boolean;
  isLoading: boolean;
  hasSpinnerLiveness: boolean;
}): boolean {
  return isLoading && !isLivePaused;
}

export function buildAmaWorkStripFromStatus(
  status: Pick<KodaXManagedTaskStatusEvent, "agentMode" | "childFanoutClass" | "childFanoutCount"> | null | undefined,
  isLoading: boolean,
): string | undefined {
  return buildAmaWorkStripTextFromStatus(status, isLoading);
}

function toPersistedUiHistoryItem(
  item: { type: HistoryItem["type"]; text?: string; icon?: string; compactText?: string },
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
    ...(typeof item.icon === "string" && item.icon.length > 0 ? { icon: item.icon } : {}),
    ...(typeof item.compactText === "string" && item.compactText.length > 0
      ? { compactText: item.compactText.trimEnd() }
      : {}),
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

function buildBannerTranscriptSection(props: BannerProps): TranscriptSection {
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
  const versionLine = `  v${KODAX_VERSION} | ${props.config.provider}/${model} [${reasoningCapabilityShort}] | ${props.config.agentMode.toUpperCase()} | ${props.config.permissionMode}${props.config.reasoningMode !== "off" ? ` +reason:${props.config.reasoningMode}` : ""}`;
  const compactionLine = props.compactionInfo
    ? `  Context: ${ctxK}k | Compaction: ${props.compactionInfo.enabled ? "on" : "off"} @ ${props.compactionInfo.triggerPercent}% (${triggerK}k)`
    : undefined;
  const sessionLine = `  Session: ${props.sessionId} | Working: ${props.workingDir}`;
  const dividerLine = `  ${"-".repeat(dividerWidth)}`;
  const rows: TranscriptRow[] = [];
  const wrapBannerLine = (text: string): string[] => {
    const layout = calculateVisualLayout(
      text.length > 0 ? text.split("\n") : [""],
      Math.max(1, props.terminalWidth),
      0,
      0,
    );
    return layout.visualLines.length > 0 ? layout.visualLines : [""];
  };
  const pushLineRows = (
    keyPrefix: string,
    text: string,
    style: Pick<TranscriptRow, "color" | "bold" | "italic">,
  ) => {
    wrapBannerLine(text).forEach((line, index) => {
      rows.push({
        key: `${keyPrefix}-${index}`,
        text: line,
        ...style,
      });
    });
  };

  KODAX_BANNER_LOGO_LINES.forEach((line, index) => {
    pushLineRows(`banner-logo-${index}`, line, { color: "primary" });
  });
  pushLineRows("banner-version", versionLine, { color: "text", bold: true });
  if (compactionLine) {
    pushLineRows("banner-compaction", compactionLine, { color: "dim" });
  }
  pushLineRows("banner-divider-top", dividerLine, { color: "dim" });
  pushLineRows("banner-session", sessionLine, { color: "dim" });
  pushLineRows("banner-divider-bottom", dividerLine, { color: "dim" });
  rows.push({ key: "banner-blank", text: " " });

  return {
    key: "banner",
    rows,
  };
}

function prependTranscriptSection(
  model: TranscriptRenderModel,
  section: TranscriptSection | undefined,
): TranscriptRenderModel {
  if (!section) {
    return model;
  }

  return {
    ...model,
    sections: [section, ...model.sections],
    rows: [...section.rows, ...model.rows],
  };
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
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
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
  const gracefulExitRunnerRef = useRef<Promise<void> | null>(null);
  const [isInputEmpty, setIsInputEmpty] = useState(true); // Track if input is empty for ? shortcut
  const [inputText, setInputText] = useState("");
  const [transcriptDisplayState, setTranscriptDisplayState] = useState(() => (
    createTranscriptDisplayState(terminalHostProfile, {
      rendererMode,
    })
  ));
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  const [transcriptScrollHeight, setTranscriptScrollHeight] = useState(0);
  const {
    scrollRef: transcriptScrollRef,
    scrollOffset: historyScrollOffset,
    sticky: viewportSticky,
    setScrollOffset: setHistoryScrollOffset,
    handleScrollTopChange: handleTranscriptScrollTopChange,
    handleStickyChange: handleViewportStickyChange,
    scrollTo: scrollTranscriptTo,
    scrollBy: scrollTranscriptBy,
    scrollToBottom: scrollTranscriptToBottom,
  } = useTranscriptViewportScrollController();
  const transcriptRawWindowRef = useRef<ScrollBoxWindow | null>(null);
  const transcriptOwnedWindowGeometryRef = useRef<TranscriptOwnedWindowGeometry | null>(null);
  const transcriptVisibleRowsRef = useRef<TranscriptRow[]>([]);
  const transcriptAllRowsRef = useRef<TranscriptRow[]>([]);
  const transcriptScreenBufferRef = useRef<TranscriptScreenBuffer | null>(null);
  const mouseSelectionRef = useRef<TranscriptMouseSelectionState | null>(null);
  const transcriptMultiClickRef = useRef<TranscriptMultiClickTrackerState>({
    time: 0,
    row: -1,
    column: -1,
    count: 0,
  });
  const [promptTextSelection, setPromptTextSelection] = useState<TranscriptTextSelection | undefined>(undefined);
  const [transcriptModeTextSelection, setTranscriptModeTextSelection] = useState<TranscriptTextSelection | undefined>(undefined);
  const [selectionCopyNotice, setSelectionCopyNotice] = useState<ClipboardNoticeState | undefined>(undefined);
  const [expandedTranscriptItemIds, setExpandedTranscriptItemIds] = useState<Set<string>>(() => new Set());
  const [transcriptSnapshot, setTranscriptSnapshot] = useState<TranscriptSnapshot | null>(null);
  const [promptSurfaceSnapshot, setPromptSurfaceSnapshot] = useState<TranscriptSnapshot | null>(null);
  const [managedTaskStatus, setManagedTaskStatus] = useState<KodaXManagedTaskStatusEvent | null>(null);
  const [managedLiveEvents, setManagedLiveEvents] = useState<HistoryItem[]>([]);
  const [managedForegroundTurnItems, setManagedForegroundTurnItems] = useState<HistoryItem[]>([]);
  const [lastLiveActivityLabel, setLastLiveActivityLabel] = useState<string | undefined>(undefined);
  const [visibleWorkStripText, setVisibleWorkStripText] = useState<string | undefined>(undefined);
  const managedTaskStatusRef = useRef<KodaXManagedTaskStatusEvent | null>(null);
  const managedTaskBreadcrumbRef = useRef<string | null>(null);
  const managedLiveEventsRef = useRef<HistoryItem[]>([]);
  const managedRoundEventHistoryRef = useRef<HistoryItem[]>([]);
  const managedForegroundTurnItemsRef = useRef<HistoryItem[]>([]);
  const managedForegroundOwnerRef = useRef<{ workerId?: string; workerTitle?: string }>({});
  const managedForegroundLedgerRef = useRef<ManagedForegroundLedgerState>({
    activeToolGroupTools: [],
  });
  const managedForegroundItemSeqRef = useRef(0);
  // Issue 079: Limit visible history to last 20 conversation rounds
  // A "round" = one user input + AI response(s)
  // Full history remains in state, only rendering is limited
  const MAX_VISIBLE_ROUNDS = 20;
  const displayHistory = useMemo(
    () => [...history, ...managedForegroundTurnItems],
    [history, managedForegroundTurnItems],
  );
  const renderHistory = useMemo(() => {
    return sliceHistoryToRecentRounds(displayHistory, MAX_VISIBLE_ROUNDS);
  }, [displayHistory]);
  const transcriptHistory = displayHistory;
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

  const setManagedLiveEventItems = useCallback((nextEvents: HistoryItem[]) => {
    managedLiveEventsRef.current = nextEvents;
    setManagedLiveEvents(nextEvents);
  }, []);

  const setManagedForegroundTurnHistory = useCallback((nextItems: HistoryItem[]) => {
    managedForegroundTurnItemsRef.current = nextItems;
    setManagedForegroundTurnItems(nextItems);
  }, []);

  const mutateManagedForegroundTurnHistory = useCallback((mutator: (items: HistoryItem[]) => HistoryItem[]) => {
    const nextItems = mutator([...managedForegroundTurnItemsRef.current]);
    setManagedForegroundTurnHistory(nextItems);
  }, [setManagedForegroundTurnHistory]);

  const appendManagedForegroundTurnHistory = useCallback((nextItems: readonly HistoryItem[]) => {
    if (nextItems.length === 0) {
      return;
    }
    setManagedForegroundTurnHistory([
      ...managedForegroundTurnItemsRef.current,
      ...nextItems,
    ]);
  }, [setManagedForegroundTurnHistory]);

  const resetManagedForegroundLedgerState = useCallback((options?: { clearOwner?: boolean }) => {
    const current = managedForegroundLedgerRef.current;
    managedForegroundLedgerRef.current = {
      ...(options?.clearOwner
        ? {}
        : {
            workerId: current.workerId,
            workerTitle: current.workerTitle,
          }),
      activeToolGroupTools: [],
    };
    if (options?.clearOwner) {
      managedForegroundOwnerRef.current = {};
    }
  }, []);

  const clearManagedForegroundTurnHistory = useCallback(() => {
    resetManagedForegroundLedgerState({ clearOwner: true });
    setManagedForegroundTurnHistory([]);
  }, [resetManagedForegroundLedgerState, setManagedForegroundTurnHistory]);

  const nextManagedForegroundItemId = useCallback((kind: "thinking" | "assistant" | "tool_group" | "info") => {
    managedForegroundItemSeqRef.current += 1;
    return `managed-foreground-${kind}-${managedForegroundItemSeqRef.current}`;
  }, []);

  const appendManagedForegroundLedgerItem = useCallback((item: HistoryItem) => {
    appendManagedForegroundTurnHistory([item]);
    return item.id;
  }, [appendManagedForegroundTurnHistory]);

  const updateManagedForegroundLedgerItem = useCallback((
    itemId: string | undefined,
    updater: (item: HistoryItem) => HistoryItem,
  ): HistoryItem | undefined => {
    if (!itemId) {
      return undefined;
    }
    let updatedItem: HistoryItem | undefined;
    mutateManagedForegroundTurnHistory((items) => items.map((item) => {
      if (item.id !== itemId) {
        return item;
      }
      updatedItem = updater(item);
      return updatedItem;
    }));
    return updatedItem;
  }, [mutateManagedForegroundTurnHistory]);

  const startManagedForegroundLedgerBlock = useCallback((
    kind: ManagedForegroundLedgerBlockKind,
    workerTitle: string | undefined,
  ): string => {
    const currentLedger = managedForegroundLedgerRef.current;
    if (currentLedger.activeKind === kind) {
      if (kind === "thinking" && currentLedger.activeThinkingItemId) {
        return currentLedger.activeThinkingItemId;
      }
      if (kind === "assistant" && currentLedger.activeAssistantItemId) {
        return currentLedger.activeAssistantItemId;
      }
      if (kind === "tool_group" && currentLedger.activeToolGroupItemId) {
        return currentLedger.activeToolGroupItemId;
      }
    }

    const timestamp = Date.now();
    const prefix = workerTitle?.trim()
      ? `[${workerTitle.trim()}] `
      : "";

    if (kind === "thinking") {
      const itemId = appendManagedForegroundLedgerItem({
        id: nextManagedForegroundItemId("thinking"),
        type: "thinking",
        timestamp,
        text: prefix,
      });
      managedForegroundLedgerRef.current = {
        ...managedForegroundLedgerRef.current,
        activeKind: "thinking",
        activeThinkingItemId: itemId,
        activeAssistantItemId: undefined,
        activeToolGroupItemId: undefined,
        activeToolGroupTools: [],
      };
      return itemId;
    }

    if (kind === "assistant") {
      const itemId = appendManagedForegroundLedgerItem({
        id: nextManagedForegroundItemId("assistant"),
        type: "assistant",
        timestamp,
        text: prefix,
      });
      managedForegroundLedgerRef.current = {
        ...managedForegroundLedgerRef.current,
        activeKind: "assistant",
        activeThinkingItemId: undefined,
        activeAssistantItemId: itemId,
        activeToolGroupItemId: undefined,
        activeToolGroupTools: [],
      };
      return itemId;
    }

    const itemId = appendManagedForegroundLedgerItem({
      id: nextManagedForegroundItemId("tool_group"),
      type: "tool_group",
      timestamp,
      tools: [],
    });
    managedForegroundLedgerRef.current = {
      ...managedForegroundLedgerRef.current,
      activeKind: "tool_group",
      activeThinkingItemId: undefined,
      activeAssistantItemId: undefined,
      activeToolGroupItemId: itemId,
      activeToolGroupTools: [],
    };
    return itemId;
  }, [appendManagedForegroundLedgerItem, nextManagedForegroundItemId]);

  const appendManagedForegroundTextBlock = useCallback((
    kind: "thinking" | "assistant",
    text: string,
  ) => {
    if (!text) {
      return;
    }
    const workerTitle = managedForegroundLedgerRef.current.workerTitle;
    const itemId = startManagedForegroundLedgerBlock(kind, workerTitle);
    updateManagedForegroundLedgerItem(itemId, (item) => {
      if (item.type !== kind) {
        return item;
      }
      return {
        ...item,
        text: `${item.text}${text}`,
      };
    });
  }, [startManagedForegroundLedgerBlock, updateManagedForegroundLedgerItem]);

  const syncManagedForegroundThinkingBlock = useCallback((thinking: string) => {
    const normalizedThinking = thinking.trim();
    if (!normalizedThinking) {
      return;
    }
    const workerTitle = managedForegroundLedgerRef.current.workerTitle?.trim();
    const nextText = workerTitle
      ? `[${workerTitle}] ${normalizedThinking}`
      : normalizedThinking;
    const itemId = startManagedForegroundLedgerBlock("thinking", managedForegroundLedgerRef.current.workerTitle);
    updateManagedForegroundLedgerItem(itemId, (item) => (
      item.type === "thinking"
        ? {
            ...item,
            text: nextText,
          }
        : item
    ));
  }, [startManagedForegroundLedgerBlock, updateManagedForegroundLedgerItem]);

  const syncManagedForegroundToolGroup = useCallback((toolCall: ToolCall) => {
    const currentLedger = managedForegroundLedgerRef.current;
    const itemId = startManagedForegroundLedgerBlock("tool_group", currentLedger.workerTitle);
    const nextTools = currentLedger.activeToolGroupTools.some((existing) => existing.id === toolCall.id)
      ? currentLedger.activeToolGroupTools.map((existing) => (
          existing.id === toolCall.id ? toolCall : existing
        ))
      : [...currentLedger.activeToolGroupTools, toolCall];
    managedForegroundLedgerRef.current = {
      ...managedForegroundLedgerRef.current,
      activeKind: "tool_group",
      activeToolGroupItemId: itemId,
      activeToolGroupTools: nextTools,
    };
    updateManagedForegroundLedgerItem(itemId, (item) => (
      item.type === "tool_group"
        ? {
            ...item,
            tools: nextTools,
          }
        : item
    ));
  }, [startManagedForegroundLedgerBlock, updateManagedForegroundLedgerItem]);

  const transitionManagedForegroundPhase = useCallback((nextWorker?: {
    workerId?: string;
    workerTitle?: string;
  }) => {
    managedForegroundLedgerRef.current = {
      workerId: nextWorker?.workerId,
      workerTitle: nextWorker?.workerTitle,
      activeToolGroupTools: [],
    };
    managedForegroundOwnerRef.current = {
      workerId: nextWorker?.workerId,
      workerTitle: nextWorker?.workerTitle,
    };
    iterationToolsRef.current = [];
    iterationToolCallsRef.current = [];
    setLiveToolCalls([]);
    clearToolInputContent();
    setCurrentTool(undefined);
    stopThinking();
    clearThinkingContent();
    clearResponse();
    setLastLiveActivityLabel(undefined);
  }, [
    clearToolInputContent,
    clearResponse,
    clearThinkingContent,
    setCurrentTool,
    setLiveToolCalls,
    setLastLiveActivityLabel,
    stopThinking,
  ]);

  const appendManagedLiveEventDrafts = useCallback((drafts: Array<{
    item: HistoryItem;
    persistToHistory: boolean;
  }>) => {
    if (drafts.length === 0) {
      return [] as HistoryItem[];
    }

    const created: HistoryItem[] = [];
    let nextEvents = [...managedLiveEventsRef.current];
    let nextRoundHistory = [...managedRoundEventHistoryRef.current];

    for (const draft of drafts) {
      const eventItem = draft.item;
      const existingLiveIndex = nextEvents.findIndex((item) => item.id === eventItem.id);
      if (existingLiveIndex >= 0) {
        const previous = nextEvents[existingLiveIndex];
        if (!areManagedLiveItemsEquivalent(previous, eventItem)) {
          nextEvents = nextEvents.map((item, index) => (
            index === existingLiveIndex
              ? {
                  ...eventItem,
                  timestamp: previous.timestamp,
                }
              : item
          ));
        }
      } else {
        nextEvents = [...nextEvents, eventItem].slice(-12);
        created.push(eventItem);
      }

      if (draft.persistToHistory) {
        const existingHistoryIndex = nextRoundHistory.findIndex((item) => item.id === eventItem.id);
        if (existingHistoryIndex >= 0) {
          const previous = nextRoundHistory[existingHistoryIndex];
          if (!areManagedLiveItemsEquivalent(previous, eventItem)) {
            nextRoundHistory = nextRoundHistory.map((item, index) => (
              index === existingHistoryIndex
                ? {
                    ...eventItem,
                    timestamp: previous.timestamp,
                  }
                : item
            ));
          }
        } else {
          nextRoundHistory = [...nextRoundHistory, eventItem].slice(-48);
        }
      }
    }

    managedRoundEventHistoryRef.current = nextRoundHistory;
    if (created.length > 0 || nextEvents.some((item, index) => !areManagedLiveItemsEquivalent(item, managedLiveEventsRef.current[index] ?? item) || item.id !== managedLiveEventsRef.current[index]?.id)) {
      setManagedLiveEventItems(nextEvents);
    }

    return created;
  }, [setManagedLiveEventItems]);

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
      focusedIndex: number;
      selectedIndices: number[];
      multiSelect?: boolean;
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
      return t("confirm.instruction.protected");
    }
    if (canAlways) {
      return t("confirm.instruction.always");
    }
    return t("confirm.instruction.basic");
  }, [confirmRequest, currentConfig.permissionMode]);

  const isHistorySearchActive = transcriptDisplayState.searchMode === "history";
  const isTranscriptMode = transcriptDisplayState.surface === "transcript";
  const isAwaitingUserInteraction = !!confirmRequest || !!uiRequest || isHistorySearchActive;
  const transcriptMaxLines = isTranscriptMode
    ? (showAllInTranscript ? Number.POSITIVE_INFINITY : 1000)
    : 12;
  const surfaceInteractionPolicy = resolveTranscriptInteractionPolicy(
    fullscreenPolicy,
    transcriptDisplayState.surface,
  );
  const fullscreenShellMode = surfaceInteractionPolicy.shellMode;
  const useAlternateScreenShell = surfaceInteractionPolicy.usesAlternateScreenShell;
  const useRendererViewportShell = surfaceInteractionPolicy.usesRendererViewportShell;
  const useRendererOwnedMouseTracking = surfaceInteractionPolicy.usesRendererMouseTracking;
  const useManagedMouseClicks = surfaceInteractionPolicy.usesManagedMouseClicks;
  const useManagedMouseWheel = surfaceInteractionPolicy.usesManagedMouseWheel;
  const useManagedSelection = surfaceInteractionPolicy.usesManagedSelection;
  const transcriptOwnsViewport = shouldOwnTranscriptViewport(
    fullscreenPolicy,
    transcriptDisplayState.surface,
    shouldWindowTranscript(transcriptDisplayState),
  );
  const isLivePaused = shouldPauseLiveTranscript(transcriptDisplayState);
  const suggestionsReservedForLayout = shouldReserveSuggestionsSpace && !isTranscriptMode;

  const createTranscriptSnapshot = useCallback((): TranscriptSnapshot => captureTranscriptSnapshot({
    items: transcriptHistory,
    managedLiveEvents: [],
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
    transcriptHistory,
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

  const pendingTranscriptUpdateCount = useMemo(() => countPendingTranscriptUpdates({
    isTranscriptMode,
    snapshot: transcriptSnapshot,
    currentItemsLength: transcriptHistory.length,
    currentManagedLiveEventsLength: 0,
    isLoading,
    currentResponse: streamingState.currentResponse,
    thinkingContent: streamingState.thinkingContent,
    activeToolCallsLength: activeToolCalls.length,
  }), [
    activeToolCalls.length,
    isLoading,
    isTranscriptMode,
    transcriptHistory.length,
    streamingState.currentResponse,
    streamingState.thinkingContent,
    transcriptSnapshot,
  ]);

  const displaySnapshot = isTranscriptMode ? transcriptSnapshot : null;
  const promptDisplayItems = useMemo(
    () => buildPromptSurfaceItems(renderHistory),
    [renderHistory],
  );
  const foregroundManagedLedgerVisible = useMemo(
    () => Boolean(managedForegroundTurnItems.length > 0 || isForegroundManagedStreamingStatus(managedTaskStatus)),
    [managedForegroundTurnItems.length, managedTaskStatus],
  );
  const foregroundManagedLedgerHasContent = managedForegroundTurnItems.length > 0;
  const foregroundManagedOwnsLivePreview = fullscreenPolicy.streamingPreview && foregroundManagedLedgerVisible;
  const transcriptDisplayItems = resolveTranscriptSurfaceItems({
    surface: "transcript",
    snapshot: displaySnapshot,
    promptItems: renderHistory,
    transcriptItems: transcriptHistory,
  });
  const transcriptDisplayIsLoading = displaySnapshot?.isLoading ?? isLoading;
  const promptStreamingState = fullscreenPolicy.streamingPreview
    ? {
      isThinking: foregroundManagedOwnsLivePreview ? false : streamingState.isThinking,
      thinkingCharCount: foregroundManagedOwnsLivePreview ? 0 : streamingState.thinkingCharCount,
      thinkingContent: foregroundManagedOwnsLivePreview ? "" : streamingState.thinkingContent,
      currentResponse: foregroundManagedOwnsLivePreview ? "" : streamingState.currentResponse,
      currentTool: foregroundManagedOwnsLivePreview ? undefined : streamingState.currentTool,
      activeToolCalls: foregroundManagedOwnsLivePreview ? [] as ToolCall[] : activeToolCalls,
      toolInputCharCount: 0,
      toolInputContent: "",
      managedLiveEvents: [] as HistoryItem[],
      lastLiveActivityLabel: foregroundManagedOwnsLivePreview ? lastLiveActivityLabel : undefined,
      iterationHistory: [] as typeof streamingState.iterationHistory,
      currentIteration: streamingState.currentIteration,
      isCompacting: false,
    }
    : {
      isThinking: false,
      thinkingCharCount: 0,
      thinkingContent: "",
      currentResponse: "",
      currentTool: undefined,
      activeToolCalls: [] as ToolCall[],
      toolInputCharCount: 0,
      toolInputContent: "",
      managedLiveEvents: [] as HistoryItem[],
      lastLiveActivityLabel: undefined,
      iterationHistory: [] as typeof streamingState.iterationHistory,
      currentIteration: streamingState.currentIteration,
      isCompacting: false,
    };
  const transcriptStreamingState = fullscreenPolicy.streamingPreview
    ? {
      isThinking: foregroundManagedOwnsLivePreview ? false : (displaySnapshot?.isThinking ?? streamingState.isThinking),
      thinkingCharCount: foregroundManagedOwnsLivePreview ? 0 : (displaySnapshot?.thinkingCharCount ?? streamingState.thinkingCharCount),
      thinkingContent: foregroundManagedOwnsLivePreview ? "" : (displaySnapshot?.thinkingContent ?? streamingState.thinkingContent),
      currentResponse: foregroundManagedOwnsLivePreview ? "" : (displaySnapshot?.currentResponse ?? streamingState.currentResponse),
      currentTool: foregroundManagedOwnsLivePreview ? undefined : (displaySnapshot?.currentTool ?? streamingState.currentTool),
      activeToolCalls: foregroundManagedOwnsLivePreview ? [] as ToolCall[] : (displaySnapshot?.activeToolCalls ?? activeToolCalls),
      toolInputCharCount: foregroundManagedOwnsLivePreview ? 0 : (displaySnapshot?.toolInputCharCount ?? streamingState.toolInputCharCount),
      toolInputContent: foregroundManagedOwnsLivePreview ? "" : (displaySnapshot?.toolInputContent ?? streamingState.toolInputContent),
      managedLiveEvents: [] as HistoryItem[],
      lastLiveActivityLabel: displaySnapshot?.lastLiveActivityLabel ?? lastLiveActivityLabel,
      iterationHistory: foregroundManagedOwnsLivePreview ? [] as typeof streamingState.iterationHistory : (displaySnapshot?.iterationHistory ?? streamingState.iterationHistory),
      currentIteration: displaySnapshot?.currentIteration ?? streamingState.currentIteration,
      isCompacting: displaySnapshot?.isCompacting ?? streamingState.isCompacting,
    }
    : {
      isThinking: false,
      thinkingCharCount: 0,
      thinkingContent: "",
      currentResponse: "",
      currentTool: undefined,
      activeToolCalls: [] as ToolCall[],
      toolInputCharCount: 0,
      toolInputContent: "",
      managedLiveEvents: [] as HistoryItem[],
      lastLiveActivityLabel: undefined,
      iterationHistory: [] as typeof streamingState.iterationHistory,
      currentIteration: displaySnapshot?.currentIteration ?? streamingState.currentIteration,
      isCompacting: false,
    };
  const activeTextSelection = isTranscriptMode
    ? transcriptModeTextSelection
    : promptTextSelection;
  const promptSelectionFreezeActive = !!promptTextSelection;
  const createPromptSurfaceSnapshot = useCallback((): TranscriptSnapshot => captureTranscriptSnapshot({
    items: promptDisplayItems,
    managedLiveEvents: [],
    isLoading,
    isThinking: promptStreamingState.isThinking,
    thinkingCharCount: promptStreamingState.thinkingCharCount,
    thinkingContent: promptStreamingState.thinkingContent,
    currentResponse: promptStreamingState.currentResponse,
    currentTool: promptStreamingState.currentTool,
    activeToolCalls: promptStreamingState.activeToolCalls,
    toolInputCharCount: promptStreamingState.toolInputCharCount,
    toolInputContent: promptStreamingState.toolInputContent,
    lastLiveActivityLabel: promptStreamingState.lastLiveActivityLabel,
    iterationHistory: promptStreamingState.iterationHistory,
    currentIteration: promptStreamingState.currentIteration,
    isCompacting: promptStreamingState.isCompacting,
  }), [
    isLoading,
    promptDisplayItems,
    promptStreamingState.activeToolCalls,
    promptStreamingState.currentIteration,
    promptStreamingState.currentResponse,
    promptStreamingState.currentTool,
    promptStreamingState.isCompacting,
    promptStreamingState.isThinking,
    promptStreamingState.iterationHistory,
    promptStreamingState.lastLiveActivityLabel,
    promptStreamingState.thinkingCharCount,
    promptStreamingState.thinkingContent,
    promptStreamingState.toolInputCharCount,
    promptStreamingState.toolInputContent,
  ]);

  useEffect(() => {
    if (!promptSelectionFreezeActive) {
      setPromptSurfaceSnapshot(null);
      return;
    }

    setPromptSurfaceSnapshot((prev) => prev ?? createPromptSurfaceSnapshot());
  }, [createPromptSurfaceSnapshot, promptSelectionFreezeActive]);

  const effectivePromptDisplayItems = promptSurfaceSnapshot?.items ?? promptDisplayItems;
  const effectivePromptIsLoading = promptSurfaceSnapshot?.isLoading ?? isLoading;
  const effectivePromptStreamingState = promptSurfaceSnapshot
    ? {
      isThinking: promptSurfaceSnapshot.isThinking,
      thinkingCharCount: promptSurfaceSnapshot.thinkingCharCount,
      thinkingContent: promptSurfaceSnapshot.thinkingContent,
      currentResponse: promptSurfaceSnapshot.currentResponse,
      currentTool: promptSurfaceSnapshot.currentTool,
      activeToolCalls: promptSurfaceSnapshot.activeToolCalls,
      toolInputCharCount: promptSurfaceSnapshot.toolInputCharCount,
      toolInputContent: promptSurfaceSnapshot.toolInputContent,
      managedLiveEvents: promptSurfaceSnapshot.managedLiveEvents,
      lastLiveActivityLabel: promptSurfaceSnapshot.lastLiveActivityLabel,
      iterationHistory: promptSurfaceSnapshot.iterationHistory,
      currentIteration: promptSurfaceSnapshot.currentIteration,
      isCompacting: promptSurfaceSnapshot.isCompacting,
    }
    : promptStreamingState;
  const currentSurfaceItems = isTranscriptMode
    ? transcriptDisplayItems
    : effectivePromptDisplayItems;
  const currentSurfaceIsLoading = isTranscriptMode
    ? transcriptDisplayIsLoading
    : effectivePromptIsLoading;
  const currentSurfaceStreamingState = isTranscriptMode
    ? transcriptStreamingState
    : effectivePromptStreamingState;
  const promptNeedsFallbackLiveStatus = effectivePromptIsLoading
    && !streamingState.currentResponse
    && !streamingState.thinkingContent
    && activeToolCalls.length === 0;
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
  const fullscreenBannerSection = useMemo(
    () => (fullscreenPolicy.enabled && showBanner
      ? buildBannerTranscriptSection(bannerProps)
      : undefined),
    [bannerProps, fullscreenPolicy.enabled, showBanner],
  );
  const promptMainScreenRenderModel = useMemo(
    () => prependTranscriptSection(
      materializeTranscriptRenderModel(buildTranscriptRenderModel({
        items: effectivePromptDisplayItems,
        viewportWidth: terminalWidth,
        isLoading: effectivePromptIsLoading,
        maxLines: transcriptMaxLines,
        isThinking: effectivePromptStreamingState.isThinking,
        thinkingCharCount: effectivePromptStreamingState.thinkingCharCount,
        thinkingContent: effectivePromptStreamingState.thinkingContent,
        streamingResponse: effectivePromptStreamingState.currentResponse,
        currentTool: effectivePromptStreamingState.currentTool,
        activeToolCalls: effectivePromptStreamingState.activeToolCalls,
        toolInputCharCount: effectivePromptStreamingState.toolInputCharCount,
        toolInputContent: effectivePromptStreamingState.toolInputContent,
        iterationHistory: effectivePromptStreamingState.iterationHistory,
        currentIteration: effectivePromptStreamingState.currentIteration,
        isCompacting: effectivePromptStreamingState.isCompacting,
        managedAgentMode: currentConfig.agentMode,
        managedPhase: effectivePromptIsLoading ? managedTaskStatus?.phase : undefined,
        managedHarnessProfile: effectivePromptIsLoading ? managedTaskStatus?.harnessProfile : undefined,
        managedWorkerTitle: effectivePromptIsLoading ? managedTaskStatus?.activeWorkerTitle : undefined,
        managedRound: effectivePromptIsLoading ? managedTaskStatus?.currentRound : undefined,
        managedMaxRounds: effectivePromptIsLoading ? managedTaskStatus?.maxRounds : undefined,
        managedGlobalWorkBudget: effectivePromptIsLoading ? managedTaskStatus?.globalWorkBudget : undefined,
        managedBudgetUsage: effectivePromptIsLoading ? managedTaskStatus?.budgetUsage : undefined,
        managedBudgetApprovalRequired: effectivePromptIsLoading ? managedTaskStatus?.budgetApprovalRequired : undefined,
        lastLiveActivityLabel: effectivePromptStreamingState.lastLiveActivityLabel,
        windowed: false,
        showFullThinking: false,
        showDetailedTools: false,
        showAllContent: false,
        showLiveProgressRows: promptNeedsFallbackLiveStatus,
      })),
      fullscreenBannerSection,
    ),
    [
      currentConfig.agentMode,
      effectivePromptDisplayItems,
      effectivePromptIsLoading,
      effectivePromptStreamingState.activeToolCalls,
      effectivePromptStreamingState.currentIteration,
      effectivePromptStreamingState.currentTool,
      effectivePromptStreamingState.isCompacting,
      effectivePromptStreamingState.currentResponse,
      effectivePromptStreamingState.isThinking,
      effectivePromptStreamingState.iterationHistory,
      effectivePromptStreamingState.lastLiveActivityLabel,
      effectivePromptStreamingState.thinkingCharCount,
      effectivePromptStreamingState.thinkingContent,
      effectivePromptStreamingState.toolInputCharCount,
      effectivePromptStreamingState.toolInputContent,
      managedTaskStatus?.activeWorkerTitle,
      managedTaskStatus?.budgetApprovalRequired,
      managedTaskStatus?.budgetUsage,
      managedTaskStatus?.currentRound,
      managedTaskStatus?.globalWorkBudget,
      managedTaskStatus?.harnessProfile,
      managedTaskStatus?.maxRounds,
      managedTaskStatus?.phase,
      promptNeedsFallbackLiveStatus,
      fullscreenBannerSection,
      terminalWidth,
      transcriptMaxLines,
    ],
  );
  const transcriptMainScreenRenderModel = useMemo(
    () => {
      if (!isTranscriptMode || useRendererViewportShell) {
        return undefined;
      }

      return prependTranscriptSection(
        materializeTranscriptRenderModel(buildTranscriptRenderModel({
          items: transcriptDisplayItems,
          viewportWidth: terminalWidth,
          isLoading: transcriptDisplayIsLoading,
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
          managedPhase: transcriptDisplayIsLoading ? managedTaskStatus?.phase : undefined,
          managedHarnessProfile: transcriptDisplayIsLoading ? managedTaskStatus?.harnessProfile : undefined,
          managedWorkerTitle: transcriptDisplayIsLoading ? managedTaskStatus?.activeWorkerTitle : undefined,
          managedRound: transcriptDisplayIsLoading ? managedTaskStatus?.currentRound : undefined,
          managedMaxRounds: transcriptDisplayIsLoading ? managedTaskStatus?.maxRounds : undefined,
          managedGlobalWorkBudget: transcriptDisplayIsLoading ? managedTaskStatus?.globalWorkBudget : undefined,
          managedBudgetUsage: transcriptDisplayIsLoading ? managedTaskStatus?.budgetUsage : undefined,
          managedBudgetApprovalRequired: transcriptDisplayIsLoading ? managedTaskStatus?.budgetApprovalRequired : undefined,
          lastLiveActivityLabel: transcriptStreamingState.lastLiveActivityLabel,
          windowed: false,
          showFullThinking: true,
          showDetailedTools: showAllInTranscript,
          showAllContent: showAllInTranscript,
          showLiveProgressRows: !foregroundManagedLedgerHasContent,
          expandedItemKeys: expandedTranscriptItemIds,
        })),
        fullscreenBannerSection,
      );
    },
    [
      currentConfig.agentMode,
      expandedTranscriptItemIds,
      foregroundManagedLedgerHasContent,
      fullscreenBannerSection,
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
      transcriptDisplayIsLoading,
      transcriptDisplayItems,
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
      showAllInTranscript,
      useRendererViewportShell,
    ],
  );
  const ownedTranscriptRenderModel = useMemo(
    () => {
      if (!transcriptOwnsViewport) {
        return undefined;
      }

      if (!isTranscriptMode) {
        return promptMainScreenRenderModel;
      }

      return prependTranscriptSection(
        buildTranscriptRenderModel({
          items: currentSurfaceItems,
          viewportWidth: terminalWidth,
          isLoading: currentSurfaceIsLoading,
          maxLines: transcriptMaxLines,
          isThinking: currentSurfaceStreamingState.isThinking,
          thinkingCharCount: currentSurfaceStreamingState.thinkingCharCount,
          thinkingContent: currentSurfaceStreamingState.thinkingContent,
          streamingResponse: currentSurfaceStreamingState.currentResponse,
          currentTool: currentSurfaceStreamingState.currentTool,
          activeToolCalls: currentSurfaceStreamingState.activeToolCalls,
          toolInputCharCount: currentSurfaceStreamingState.toolInputCharCount,
          toolInputContent: currentSurfaceStreamingState.toolInputContent,
          iterationHistory: currentSurfaceStreamingState.iterationHistory,
          currentIteration: currentSurfaceStreamingState.currentIteration,
          isCompacting: currentSurfaceStreamingState.isCompacting,
          managedAgentMode: currentConfig.agentMode,
          managedPhase: currentSurfaceIsLoading ? managedTaskStatus?.phase : undefined,
          managedHarnessProfile: currentSurfaceIsLoading ? managedTaskStatus?.harnessProfile : undefined,
          managedWorkerTitle: currentSurfaceIsLoading ? managedTaskStatus?.activeWorkerTitle : undefined,
          managedRound: currentSurfaceIsLoading ? managedTaskStatus?.currentRound : undefined,
          managedMaxRounds: currentSurfaceIsLoading ? managedTaskStatus?.maxRounds : undefined,
          managedGlobalWorkBudget: currentSurfaceIsLoading ? managedTaskStatus?.globalWorkBudget : undefined,
          managedBudgetUsage: currentSurfaceIsLoading ? managedTaskStatus?.budgetUsage : undefined,
          managedBudgetApprovalRequired: currentSurfaceIsLoading ? managedTaskStatus?.budgetApprovalRequired : undefined,
          lastLiveActivityLabel: currentSurfaceStreamingState.lastLiveActivityLabel,
          windowed: true,
          showFullThinking: isTranscriptMode,
          showDetailedTools: showAllInTranscript,
          showAllContent: showAllInTranscript,
          showLiveProgressRows: isTranscriptMode && !foregroundManagedLedgerHasContent,
          expandedItemKeys: isTranscriptMode ? expandedTranscriptItemIds : undefined,
        }),
        fullscreenBannerSection,
      );
    },
    [
      currentConfig.agentMode,
      currentSurfaceIsLoading,
      currentSurfaceItems,
      foregroundManagedLedgerHasContent,
      fullscreenBannerSection,
      currentSurfaceStreamingState.activeToolCalls,
      currentSurfaceStreamingState.currentIteration,
      currentSurfaceStreamingState.currentResponse,
      currentSurfaceStreamingState.currentTool,
      currentSurfaceStreamingState.isCompacting,
      currentSurfaceStreamingState.isThinking,
      currentSurfaceStreamingState.iterationHistory,
      currentSurfaceStreamingState.lastLiveActivityLabel,
      currentSurfaceStreamingState.thinkingCharCount,
      currentSurfaceStreamingState.thinkingContent,
      currentSurfaceStreamingState.toolInputCharCount,
      currentSurfaceStreamingState.toolInputContent,
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
      promptMainScreenRenderModel,
      isLoading,
      isTranscriptMode,
      terminalWidth,
      transcriptMaxLines,
      transcriptOwnsViewport,
      showAllInTranscript,
    ],
  );
  const activeTranscriptRenderModel = useMemo(
    () => ownedTranscriptRenderModel ?? transcriptMainScreenRenderModel,
    [ownedTranscriptRenderModel, transcriptMainScreenRenderModel],
  );
  const rawAmaSummaryViewModel = useMemo(
    () => buildAmaSummaryViewModel({
      status: managedTaskStatus,
      isLoading,
      agentMode: currentConfig.agentMode,
    }),
    [currentConfig.agentMode, isLoading, managedTaskStatus],
  );
  const rawWorkStripText = rawAmaSummaryViewModel.workStripText;
  const displayWorkStripText = displaySnapshot?.workStripText ?? visibleWorkStripText;
  const displayedAmaSummaryViewModel = useMemo(
    () => buildAmaSummaryViewModel({
      status: managedTaskStatus,
      isLoading,
      agentMode: currentConfig.agentMode,
      parallelTextOverride: displayWorkStripText,
    }),
    [currentConfig.agentMode, displayWorkStripText, isLoading, managedTaskStatus],
  );
  const selectableTranscriptItemIds = useMemo(
    () => getSelectableTranscriptItemIds(currentSurfaceItems),
    [currentSurfaceItems],
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
    () => currentSurfaceItems.find((item) => item.id === selectedTranscriptItemId),
    [currentSurfaceItems, selectedTranscriptItemId],
  );
  const transcriptSelectionCapabilities = useMemo(
    () => ({
      ...transcriptDisplayState,
      supportsSelection: transcriptDisplayState.supportsSelection && transcriptOwnsViewport,
      supportsCopyOnSelect: transcriptDisplayState.supportsCopyOnSelect && transcriptOwnsViewport,
    }),
    [transcriptDisplayState, transcriptOwnsViewport],
  );
  const transcriptSelectionRuntime = useMemo(
    () => buildTranscriptSelectionRuntimeState({
      state: transcriptSelectionCapabilities,
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
      transcriptSelectionCapabilities,
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
    () => createTranscriptSearchIndex(currentSurfaceItems),
    [currentSurfaceItems],
  );
  const historySearchMatches = useMemo(
    () => searchTranscriptIndex(transcriptSearchIndex, historySearchQuery),
    [transcriptSearchIndex, historySearchQuery],
  );
  const transcriptSearchChrome = useMemo(
    () => buildTranscriptSearchChrome({
      isHistorySearchActive,
      historySearchQuery,
      matches: historySearchMatches,
      selectedIndex: historySearchSelectedIndex,
      anchorItemId: transcriptDisplayState.searchAnchorItemId,
      useOverlaySurface:
        transcriptDisplayState.supportsOverlaySurface
        && transcriptDisplayState.supportsSearchViewport
        && transcriptOwnsViewport,
    }),
    [
      historySearchMatches,
      historySearchQuery,
      historySearchSelectedIndex,
      isHistorySearchActive,
      transcriptDisplayState.searchAnchorItemId,
      transcriptDisplayState.supportsOverlaySurface,
      transcriptDisplayState.supportsSearchViewport,
      transcriptOwnsViewport,
    ],
  );
  const clampedHistorySearchSelectedIndex = transcriptSearchChrome.clampedSelectedIndex;
  const historySearchStatusText = transcriptSearchChrome.statusText;
  const effectiveHistorySearchDetailText = transcriptSearchChrome.detailText;
  const effectiveTranscriptSearchState = transcriptSearchChrome.searchState;
  const isSelectedTranscriptItemExpanded = transcriptSelectionRuntime.detailState === "expanded";
  const canCycleTranscriptSelection =
    transcriptSelectionRuntime.selectionEnabled
    && selectableTranscriptItemIds.length > 0
    && !activeTextSelection;
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
        fullscreenPolicy.enabled && transcriptOwnsViewport
          ? (!viewportSticky || isHistorySearchActive || isAwaitingUserInteraction)
          : (isTranscriptMode || isHistorySearchActive || isAwaitingUserInteraction),
      );
      next = setTranscriptSearchMatchIndex(next, clampedHistorySearchSelectedIndex);
      return next;
    });
  }, [
    clampedHistorySearchSelectedIndex,
    fullscreenPolicy.enabled,
    historyScrollOffset,
    isAwaitingUserInteraction,
    isHistorySearchActive,
    isTranscriptMode,
    pendingTranscriptUpdateCount,
    transcriptOwnsViewport,
    viewportSticky,
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
  const statusBarStreamingState = isTranscriptMode
    ? transcriptStreamingState
    : {
      isThinking: effectivePromptStreamingState.isThinking,
      thinkingCharCount: effectivePromptStreamingState.thinkingCharCount,
      currentTool: effectivePromptStreamingState.currentTool,
      activeToolCalls: effectivePromptStreamingState.activeToolCalls,
      toolInputCharCount: effectivePromptStreamingState.toolInputCharCount,
      toolInputContent: effectivePromptStreamingState.toolInputContent,
      currentIteration: effectivePromptStreamingState.currentIteration,
      isCompacting: effectivePromptStreamingState.isCompacting,
    };
  const statusBarIsLoading = isTranscriptMode ? transcriptDisplayIsLoading : effectivePromptIsLoading;
  const statusBarProps = useMemo(
    () =>
      buildSurfaceStatusBarProps({
        sessionId: context.sessionId,
        permissionMode: currentConfig.permissionMode,
        agentMode: currentConfig.agentMode,
        provider: currentConfig.provider,
        model: currentConfig.model ?? getProviderModel(currentConfig.provider) ?? currentConfig.provider,
        thinking: currentConfig.thinking,
        reasoningMode: currentConfig.reasoningMode,
        reasoningCapability: formatReasoningCapabilityShort(
          getProviderReasoningCapability(currentConfig.provider, currentConfig.model),
        ),
        isTranscriptMode,
        streamingState: statusBarStreamingState,
        maxIter: streamingState.maxIter,
        contextUsage,
        isLoading: statusBarIsLoading,
        managedState: {
          phase: managedTaskStatus?.phase,
          harnessProfile: managedTaskStatus?.harnessProfile,
          workerTitle: managedTaskStatus?.activeWorkerTitle,
          round: managedTaskStatus?.currentRound,
          maxRounds: managedTaskStatus?.maxRounds,
          globalWorkBudget: managedTaskStatus?.globalWorkBudget,
          budgetUsage: managedTaskStatus?.budgetUsage,
          budgetApprovalRequired: managedTaskStatus?.budgetApprovalRequired,
        },
      }),
    [
      context.sessionId,
      currentConfig.permissionMode,
      currentConfig.agentMode,
      currentConfig.provider,
      currentConfig.model,
      currentConfig.thinking,
      currentConfig.reasoningMode,
      isTranscriptMode,
      statusBarStreamingState,
      streamingState.maxIter,
      contextUsage,
      statusBarIsLoading,
      managedTaskStatus?.phase,
      managedTaskStatus?.harnessProfile,
      managedTaskStatus?.activeWorkerTitle,
      managedTaskStatus?.currentRound,
      managedTaskStatus?.maxRounds,
      managedTaskStatus?.globalWorkBudget,
      managedTaskStatus?.budgetUsage,
      managedTaskStatus?.budgetApprovalRequired,
    ],
  );

  const promptWaitingReason = confirmRequest
    ? "confirm"
    : uiRequest?.kind;
  const promptActivityViewModel = useMemo(
    () => buildPromptActivityViewModel({
      isTranscriptMode,
      isLoading: statusBarIsLoading,
      streamingState: effectivePromptStreamingState,
      managedState: statusBarIsLoading
        ? {
          phase: managedTaskStatus?.phase,
          harnessProfile: managedTaskStatus?.harnessProfile,
          workerTitle: managedTaskStatus?.activeWorkerTitle,
        }
        : undefined,
      waitingReason: promptWaitingReason,
    }),
    [
      effectivePromptStreamingState.activeToolCalls,
      effectivePromptStreamingState.currentTool,
      effectivePromptStreamingState.isCompacting,
      effectivePromptStreamingState.isThinking,
      effectivePromptStreamingState.thinkingCharCount,
      effectivePromptStreamingState.toolInputCharCount,
      effectivePromptStreamingState.toolInputContent,
      isTranscriptMode,
      managedTaskStatus?.activeWorkerTitle,
      managedTaskStatus?.harnessProfile,
      managedTaskStatus?.phase,
      promptWaitingReason,
      statusBarIsLoading,
    ],
  );
  const promptBusyText = promptActivityViewModel?.text;

  const statusBarViewModel = useMemo(
    () => buildStatusBarViewModel(statusBarProps),
    [statusBarProps],
  );
  const visibleStatusBarViewModel = useMemo(
    () => statusBarViewModel,
    [statusBarViewModel],
  );
  const statusBarText = visibleStatusBarViewModel.text;
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
    return buildBaseFooterNotices({
      historySearchQuery,
      pendingInputCount: streamingState.pendingInputs.length,
    });
  }, [historySearchQuery, streamingState.pendingInputs.length]);
  const footerNotifications = useMemo(() => {
    return buildFooterNotifications({
      historySearchQuery,
      isHistorySearchActive,
      historySearchMatchCount: historySearchMatches.length,
      pendingInputCount: streamingState.pendingInputs.length,
      maxPendingInputs: MAX_PENDING_INPUTS,
    });
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
    return buildStashNoticeText({
      inputText,
      isTranscriptMode,
      isHistorySearchActive,
    });
  }, [inputText, isHistorySearchActive, isTranscriptMode]);
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
  const promptFooterNotices = useMemo(() => {
    return buildPromptFooterNotices(baseFooterNotices);
  }, [baseFooterNotices]);
  const transcriptFooterViewModel = useMemo(
    () =>
      buildTranscriptFooterViewModel({
        textSelection: activeTextSelection,
        selectionState: transcriptSelectionState,
        isHistorySearchActive,
        historySearchDetailText: effectiveHistorySearchDetailText,
        historySearchHasMatches: Boolean(historySearchStatusText) && historySearchMatches.length > 0,
        showAllActive: showAllInTranscript,
        baseFooterNotices,
      }),
    [
      activeTextSelection,
      baseFooterNotices,
      effectiveHistorySearchDetailText,
      historySearchMatches.length,
      historySearchStatusText,
      isHistorySearchActive,
      showAllInTranscript,
      transcriptSelectionState,
    ],
  );
  const transcriptFooterSecondaryText = transcriptFooterViewModel.secondaryText;
  const transcriptFooterBudgetNotices = transcriptFooterViewModel.budgetNotices;
  const activeFooterNotices = isTranscriptMode
    ? transcriptFooterBudgetNotices
    : promptFooterNotices;
  const terminalRows = stdout.rows ?? 24;
  const budgetedTerminalRows = terminalRows;
  const footerBudgetInputText = isTranscriptMode ? "" : inputText;
  const footerBudgetPendingInputSummary = isTranscriptMode ? undefined : pendingInputSummary;
  const footerBudgetWorkStripText = displayWorkStripText;
  const footerBudgetShowHelp = isTranscriptMode ? false : showHelp;
  const viewportBudget = useMemo(
    // Budget transcript, footer, overlay, status, and task slots together so
    // the viewport always receives a stable number of visible rows.
    () => calculateViewportBudget({
      terminalRows: budgetedTerminalRows,
      terminalWidth,
      windowedTranscript: useRendererViewportShell,
      inputText: footerBudgetInputText,
      footerHeaderText: footerHeaderSummary,
      activitySummary: isTranscriptMode ? undefined : promptBusyText,
      pendingInputSummary: footerBudgetPendingInputSummary,
      stashNoticeSummary: stashNoticeText,
      notificationSummary: footerNotificationSummary,
      statusNoticeSummary: activeFooterNotices.join(" | "),
      workStripText: footerBudgetWorkStripText,
      suggestionsReserved: suggestionsReservedForLayout,
      suggestionsMode: "inline",
      showHelp: footerBudgetShowHelp,
      statusBarText,
      confirmPrompt: confirmRequest?.prompt,
      confirmInstruction,
      dialogMode: "inline",
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
      promptBusyText,
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
        mode="inline"
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
  const effectiveTranscriptBaseScrollHeight = activeTranscriptRenderModel
    ? activeTranscriptRenderModel.rows.length + activeTranscriptRenderModel.previewRows.length
    : transcriptScrollHeight;
  const effectiveTranscriptScrollHeight = effectiveTranscriptBaseScrollHeight;
  const handleTranscriptMetricsChange = useCallback((metrics: {
    scrollHeight: number;
    viewportHeight: number;
  }) => {
    if (!activeTranscriptRenderModel) {
      setTranscriptScrollHeight(metrics.scrollHeight);
    }
  }, [activeTranscriptRenderModel]);
  const resolveOwnedTranscriptWindow = useCallback((window: ScrollBoxWindow) => (
    resolveTranscriptOwnedWindowGeometry({
      window,
      stickyHeader: transcriptChrome.stickyHeader,
      width: terminalWidth,
      topChromeRows: 0,
    })
  ), [
    terminalWidth,
    transcriptChrome.stickyHeader,
  ]);
  const rebuildTranscriptScreenBuffer = useCallback((
    rows = transcriptVisibleRowsRef.current,
    allRows = transcriptAllRowsRef.current,
    geometry = transcriptRawWindowRef.current
      ? resolveOwnedTranscriptWindow(transcriptRawWindowRef.current)
      : transcriptOwnedWindowGeometryRef.current,
  ) => {
    if (!geometry || rows.length === 0) {
      transcriptScreenBufferRef.current = null;
      return;
    }

    transcriptOwnedWindowGeometryRef.current = geometry;
    transcriptScreenBufferRef.current = buildTranscriptScreenBuffer(rows, {
      allRows,
      rowIndexByKey: buildTranscriptRowIndexByKey(allRows),
      topOffsetRows: geometry.topOffsetRows,
      viewportHeight: geometry.contentWindow.viewportHeight,
      animateSpinners: transcriptAnimateSpinners,
    });
  }, [
    resolveOwnedTranscriptWindow,
    transcriptAnimateSpinners,
  ]);
  const resolveTranscriptContentViewportRows = useCallback(() => {
    const geometry = transcriptOwnedWindowGeometryRef.current;
    if (geometry?.contentWindow.viewportHeight && geometry.contentWindow.viewportHeight > 0) {
      return geometry.contentWindow.viewportHeight;
    }
    return viewportBudget.messageRows;
  }, [viewportBudget.messageRows]);
  const handleTranscriptWindowChange = useCallback((window: ScrollBoxWindow) => {
    transcriptRawWindowRef.current = window;
    const geometry = resolveOwnedTranscriptWindow(window);
    transcriptOwnedWindowGeometryRef.current = geometry;
    rebuildTranscriptScreenBuffer(
      transcriptVisibleRowsRef.current,
      transcriptAllRowsRef.current,
      geometry,
    );
  }, [rebuildTranscriptScreenBuffer, resolveOwnedTranscriptWindow]);
  const handleVisibleTranscriptRowsChange = useCallback((snapshot: {
    rows: TranscriptRow[];
    allRows: TranscriptRow[];
  }) => {
    transcriptVisibleRowsRef.current = snapshot.rows;
    transcriptAllRowsRef.current = snapshot.allRows;
    rebuildTranscriptScreenBuffer(snapshot.rows, snapshot.allRows);
  }, [rebuildTranscriptScreenBuffer]);
  const clearTranscriptMouseSelection = useCallback(() => {
    mouseSelectionRef.current = null;
    setPromptTextSelection(undefined);
    setTranscriptModeTextSelection(undefined);
  }, []);

  const clearTranscriptSelectionFocus = useCallback(() => {
    clearTranscriptMouseSelection();
    setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, undefined));
  }, [clearTranscriptMouseSelection]);

  useEffect(() => {
    rebuildTranscriptScreenBuffer();
  }, [rebuildTranscriptScreenBuffer]);

  useEffect(() => {
    setHistoryScrollOffset((prev) => (
      clampTranscriptScrollOffset(prev, effectiveTranscriptScrollHeight, viewportBudget.messageRows)
    ));
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

  const showClipboardNotice = useCallback((
    message: string | undefined,
    tone: ClipboardNoticeState["tone"] = "success",
  ) => {
    const trimmedMessage = message?.trim();
    if (!trimmedMessage) {
      return;
    }
    setSelectionCopyNotice({
      text: trimmedMessage,
      tone,
    });
  }, []);
  const buildClipboardFailureNotice = useCallback((prefix: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return `${prefix}: ${message}`;
  }, []);
  const copySelectedTranscriptText = useCallback(async (selectionOverride?: TranscriptTextSelection) => {
    const selection = selectionOverride ?? activeTextSelection;
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
        "success",
      );
      return true;
    } catch (error) {
      showClipboardNotice(
        buildClipboardFailureNotice("Failed to copy transcript selection", error),
        "warning",
      );
      return false;
    }
  }, [activeTextSelection, buildClipboardFailureNotice, showClipboardNotice, writeTerminal]);

  const alignTranscriptSelection = useCallback((itemId: string | undefined) => {
    if (!itemId) {
      return;
    }
    if (isTranscriptItemVisible({
      items: currentSurfaceItems,
      renderModel: activeTranscriptRenderModel,
      terminalWidth,
      transcriptMaxLines,
      viewportRows: resolveTranscriptContentViewportRows(),
      itemId,
      visibleRows: transcriptVisibleRowsRef.current,
      expandedItemKeys: expandedTranscriptItemIds,
      showDetailedTools: false,
    })) {
      return;
    }
    const nextOffset = resolveTranscriptSelectionOffset({
      items: currentSurfaceItems,
      renderModel: activeTranscriptRenderModel,
      terminalWidth,
      transcriptMaxLines,
      viewportRows: resolveTranscriptContentViewportRows(),
      itemId,
      expandedItemKeys: expandedTranscriptItemIds,
      showDetailedTools: false,
    });
    scrollTranscriptTo(nextOffset);
  }, [
    currentSurfaceItems,
    terminalWidth,
    transcriptMaxLines,
    activeTranscriptRenderModel,
    expandedTranscriptItemIds,
    resolveTranscriptContentViewportRows,
    scrollTranscriptTo,
    transcriptVisibleRowsRef,
  ]);

  const selectTranscriptItem = useCallback((itemId: string | undefined) => {
    setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, itemId));
    if (itemId) {
      alignTranscriptSelection(itemId);
    }
  }, [alignTranscriptSelection]);

  const revealTranscriptItem = useCallback((itemId: string | undefined) => {
    if (!itemId) {
      return;
    }
    alignTranscriptSelection(itemId);
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
    alignTranscriptSelection(selectedTranscriptItemId);
  }, [alignTranscriptSelection, canToggleSelectedTranscriptDetail, selectedTranscriptItemId]);

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
      showClipboardNotice("Copied selected transcript entry to clipboard.", "success");
    } catch (error) {
      showClipboardNotice(
        buildClipboardFailureNotice("Failed to copy transcript entry", error),
        "warning",
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
      showClipboardNotice("Copied selected tool args to clipboard.", "success");
    } catch (error) {
      showClipboardNotice(
        buildClipboardFailureNotice("Failed to copy tool args", error),
        "warning",
      );
    }
  }, [
    buildClipboardFailureNotice,
    canCopySelectedToolInput,
    selectedTranscriptItem,
    showClipboardNotice,
    writeTerminal,
  ]);
  const resolveTranscriptSelectionRows = useCallback(() => (
    transcriptAllRowsRef.current
  ), []);
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
    const selectionRows = resolveTranscriptSelectionRows();
    const nextSelection = buildTranscriptScreenSelection(
      selectionRows,
      anchorPoint,
      focusPoint,
      {
        animateSpinners: transcriptAnimateSpinners,
        selectFullRowOnCollapsed: options?.selectFullRowOnCollapsed,
      },
    );
    if (isTranscriptMode) {
      setTranscriptModeTextSelection(nextSelection);
    } else {
      setPromptTextSelection(nextSelection);
    }

    const focusedRow = selectionRows[
      Math.max(0, Math.min(focusPoint.modelRowIndex, selectionRows.length - 1))
    ];
    if (options?.updateSelectedItem && focusedRow?.itemId) {
      setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, focusedRow.itemId));
    }
    return nextSelection;
  }, [isTranscriptMode, resolveTranscriptSelectionRows, transcriptAnimateSpinners]);
  const finalizeTranscriptMouseSelection = useCallback((
    selectionState: TranscriptMouseSelectionState | null,
    options?: {
      focusPoint?: TranscriptScreenPoint;
      copySelection?: boolean;
    },
  ) => {
    if (!selectionState) {
      return undefined;
    }

    mouseSelectionRef.current = null;
    const nextSelectionState = {
      ...selectionState,
      focus: options?.focusPoint ?? selectionState.focus,
    };
    const shouldKeepSelection = nextSelectionState.mode !== "char"
      || nextSelectionState.didDrag;

    if (!shouldKeepSelection) {
      clearTranscriptMouseSelection();
      return undefined;
    }

    const nextTextSelection = updateTranscriptMouseSelection(
      nextSelectionState.anchor,
      nextSelectionState.focus,
      {
        selectFullRowOnCollapsed: false,
        updateSelectedItem: false,
      },
    );

    if (!nextTextSelection) {
      clearTranscriptMouseSelection();
      return undefined;
    }

    if (options?.copySelection !== false) {
      void copySelectedTranscriptText(nextTextSelection);
    }
    return nextTextSelection;
  }, [
    clearTranscriptMouseSelection,
    copySelectedTranscriptText,
    updateTranscriptMouseSelection,
  ]);

  const openHistorySearchSurface = useCallback(() => {
    if (!isTranscriptMode || !currentSurfaceItems.length || confirmRequest || uiRequest) {
      return;
    }
    clearTranscriptMouseSelection();
    const anchorItemId = resolveTranscriptSearchAnchorItemId(
      {
        items: currentSurfaceItems,
        selectedItemId: selectedTranscriptItemId,
        renderModel: activeTranscriptRenderModel,
        terminalWidth,
        transcriptMaxLines,
        viewportRows: resolveTranscriptContentViewportRows(),
        scrollOffset: historyScrollOffset,
        expandedItemKeys: expandedTranscriptItemIds,
        showDetailedTools: false,
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
    currentSurfaceItems,
    expandedTranscriptItemIds,
    historyScrollOffset,
    isTranscriptMode,
    selectedTranscriptItemId,
    activeTranscriptRenderModel,
    terminalWidth,
    transcriptMaxLines,
    uiRequest,
    resolveTranscriptContentViewportRows,
    clearTranscriptMouseSelection,
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
        focusedIndex: uiRequest.focusedIndex,
        selectedIndices: uiRequest.selectedIndices,
        multiSelect: uiRequest.multiSelect,
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
  const selectionCopyNoticeSurface = useMemo(() => {
    if (!selectionCopyNotice) {
      return undefined;
    }

    return (
      <ClipboardToastSurface
        text={selectionCopyNotice.text}
        tone={selectionCopyNotice.tone}
      />
    );
  }, [selectionCopyNotice]);
  // Overlay surface: only used for transient toasts (ClipboardToast) that have
  // their own backgroundColor fill. Dialogs and suggestions are ALWAYS inline
  // to avoid terminal transparency bleed-through (Issue 112).
  const contentOverlaySurface = useMemo(() => {
    if (!selectionCopyNoticeSurface) {
      return undefined;
    }
    return (
      <Box flexDirection="column" width="100%">
        {selectionCopyNoticeSurface}
      </Box>
    );
  }, [selectionCopyNoticeSurface]);
  const exitTranscriptModeSurface = useCallback(() => {
    setTranscriptDisplayState((prev) => jumpTranscriptToLatest(exitTranscriptMode(prev)));
    setShowAllInTranscript(false);
    scrollTranscriptToBottom();
    setHistorySearchQuery("");
    setHistorySearchSelectedIndex(0);
    clearTranscriptMouseSelection();
  }, [clearTranscriptMouseSelection, scrollTranscriptToBottom]);

  const toggleTranscriptShowAll = useCallback(() => {
    if (!isTranscriptMode) {
      return;
    }

    setShowAllInTranscript((prev) => !prev);
  }, [isTranscriptMode]);

  const toggleTranscriptMode = useCallback(() => {
    if (isTranscriptMode) {
      exitTranscriptModeSurface();
      return;
    }

    setShowAllInTranscript(false);
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
    if (!isTranscriptMode || !canCopySelectedTranscriptItem || !supportsTranscriptCopyOnSelect) {
      lastAutoCopiedTranscriptItemIdRef.current = undefined;
      return;
    }

    if (transcriptModeTextSelection) {
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
    transcriptModeTextSelection,
    writeTerminal,
  ]);

  useEffect(() => {
    if (stdout?.isTTY !== true) {
      return;
    }

    const rendererInstance = getRendererInstance(stdout);
    rendererInstance?.setShellMode?.(
      fullscreenShellMode,
      useRendererOwnedMouseTracking,
    );
    if (!useAlternateScreenShell) {
      rendererInstance?.setAltScreenActive?.(false);
    }
  }, [
    fullscreenShellMode,
    stdout,
    useAlternateScreenShell,
    useRendererOwnedMouseTracking,
  ]);

  // Refs for callbacks
  // Note: permissionMode and alwaysAllowTools are stored separately for permission checks
  const currentOptionsRef = useRef<InkREPLOptions>({
    ...options,
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
    const hasManagedForegroundLedger = managedForegroundTurnItemsRef.current.length > 0;
    const interruptedItems = hasManagedForegroundLedger
      ? [
          ...managedForegroundTurnItemsRef.current.map((item) => toCreatableHistoryItem(item)),
          ...(latestBreadcrumb && latestBreadcrumb !== lastHistoryText
            ? [{ type: "info" as const, text: latestBreadcrumb }]
            : []),
        ]
      : [
          ...managedForegroundTurnItemsRef.current.map((item) => toCreatableHistoryItem(item)),
          ...buildInterruptedPersistenceItems(
            getThinkingContent(),
            getFullResponse(),
            {
              toolCalls: iterationToolCallsRef.current,
              toolNames: iterationToolsRef.current,
              infoItems: latestBreadcrumb && latestBreadcrumb !== lastHistoryText
                ? [latestBreadcrumb]
                : [],
            },
          ),
        ];

    if (interruptedItems.length === 0) {
      return;
    }

    interruptPersistenceQueuedRef.current = true;
    appendHistoryItemsWithPersistenceRef.current?.(interruptedItems);
  }, [getFullResponse, getThinkingContent]);

  useEffect(() => {
    pendingInputsRef.current = streamingState.pendingInputs;
  }, [streamingState.pendingInputs]);

  const resetInterruptedPromptState = useCallback(() => {
    userInterruptedRef.current = true;
    abort();
    stopStreaming();
    stopThinking();
    clearThinkingContent();
    clearToolInputContent();
    clearResponse();
    setCurrentTool(undefined);
    resetLiveToolCalls();
    setLastLiveActivityLabel(undefined);
    clearManagedForegroundTurnHistory();
    managedLiveEventsRef.current = [];
    managedRoundEventHistoryRef.current = [];
    setManagedLiveEvents([]);
    setIsLoading(false);
  }, [
    abort,
    clearResponse,
    clearThinkingContent,
    clearToolInputContent,
    resetLiveToolCalls,
    clearManagedForegroundTurnHistory,
    setCurrentTool,
    setManagedLiveEvents,
    setIsLoading,
    setLastLiveActivityLabel,
    stopStreaming,
    stopThinking,
  ]);

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

      const interruptAction = resolveStreamingInterruptAction({
        keyName: key.name,
        ctrl: Boolean(key.ctrl),
        isTranscriptMode,
        isAwaitingUserInteraction,
        isInputEmpty,
        pendingInputCount: streamingState.pendingInputs.length,
        hasTranscriptTextSelection: Boolean(transcriptModeTextSelection),
        timeSinceLastEscapeMs: Date.now() - lastEscPressRef.current,
        doubleEscapeIntervalMs: DOUBLE_ESC_INTERVAL,
      });

      switch (interruptAction.kind) {
        case "interrupt":
          lastEscPressRef.current = 0;
          queueInterruptedPersistence();
          resetInterruptedPromptState();
          return true;
        case "pop-pending-input":
          removeLastPendingInput();
          lastEscPressRef.current = 0;
          return true;
        case "arm-double-escape":
          lastEscPressRef.current = Date.now();
          return true;
        case "none":
        default:
          break;
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
      resetInterruptedPromptState,
    ]
  );

  useKeypress(
    KeypressHandlerPriority.Critical,
    (key) => {
      const hasTranscript = hasTranscriptInputActivity({
        itemsLength: currentSurfaceItems.length,
        currentResponse: currentSurfaceStreamingState.currentResponse,
        thinkingContent: currentSurfaceStreamingState.thinkingContent,
        activeToolCallsLength: currentSurfaceStreamingState.activeToolCalls.length,
      });

      const pointerAction = resolveTranscriptPointerAction({
        keyName: key.name,
        hasTranscript,
        historyScrollOffset,
        reviewPageSize,
        reviewWheelStep,
        hasMouse: Boolean(key.mouse),
        mouseButton: key.mouse?.button,
        mouseAction: key.mouse?.action,
        usesManagedMouseClicks: useManagedMouseClicks,
        supportsMouseTracking: transcriptDisplayState.supportsMouseTracking,
        usesRendererMouseTracking: useRendererOwnedMouseTracking,
        usesManagedMouseWheel: useManagedMouseWheel,
        supportsWheelHistory: transcriptDisplayState.supportsWheelHistory,
      });

      if (pointerAction.kind === "mouse-phase") {
        const mouseEvent = key.mouse;
        if (!mouseEvent) {
          return false;
        }

        if (pointerAction.phase === "press" && mouseSelectionRef.current) {
          finalizeTranscriptMouseSelection(mouseSelectionRef.current);
        }

        const target = resolveTranscriptMouseTarget(mouseEvent.row, mouseEvent.column);
        if (pointerAction.phase === "press") {
          if (!target || !hasTranscript) {
            if (activeTextSelection || selectedTranscriptItemId) {
              clearTranscriptSelectionFocus();
              return true;
            }
            clearTranscriptMouseSelection();
            return false;
          }

          const multiClick = resolveTranscriptMultiClickState({
            previous: transcriptMultiClickRef.current,
            time: Date.now(),
            row: mouseEvent.row,
            column: mouseEvent.column,
          });
          transcriptMultiClickRef.current = multiClick;
          const selectionMode: TranscriptSelectionGestureMode = multiClick.count >= 3
            ? "line"
            : multiClick.count === 2
              ? "word"
              : "char";

          disarmHistorySearchSelection();
          setTranscriptDisplayState((prev) => setTranscriptSelectedItem(prev, undefined));
          if (isTranscriptMode) {
            setTranscriptModeTextSelection(undefined);
          } else {
            setPromptTextSelection(undefined);
          }

          if (selectionMode !== "char") {
            const selectionSpan = resolveTranscriptSelectionSpanAt(
              resolveTranscriptSelectionRows(),
              target.point,
              selectionMode,
            );
            if (selectionSpan) {
              mouseSelectionRef.current = {
                anchor: selectionSpan.start,
                focus: selectionSpan.end,
                didDrag: false,
                mode: selectionMode,
                anchorSpan: selectionSpan,
              };
              updateTranscriptMouseSelection(
                selectionSpan.start,
                selectionSpan.end,
                { updateSelectedItem: false },
              );
              return true;
            }
          }

          mouseSelectionRef.current = {
            anchor: target.point,
            focus: target.point,
            didDrag: false,
            mode: "char",
          };
          return true;
        }

        if (!mouseSelectionRef.current) {
          return false;
        }

        if (pointerAction.phase === "drag") {
          const buffer = transcriptScreenBufferRef.current;
          const edgeScrollDirection = buffer
            ? resolveTranscriptDragEdgeScrollDirection(buffer, mouseEvent.row)
            : 0;
          if (edgeScrollDirection !== 0) {
            scrollTranscriptBy(edgeScrollDirection);
          }
          const dragTarget = target ?? (buffer
            ? clampTranscriptScreenHit(buffer, mouseEvent.row, mouseEvent.column)
            : undefined);
          if (!dragTarget) {
            return false;
          }

          const currentSelection = mouseSelectionRef.current;
          if (currentSelection.mode !== "char" && currentSelection.anchorSpan) {
            const targetSpan = resolveTranscriptSelectionSpanAt(
              resolveTranscriptSelectionRows(),
              dragTarget.point,
              currentSelection.mode,
            );
            if (!targetSpan) {
              return false;
            }

            const nextRange = extendTranscriptSelectionSpan(
              currentSelection.anchorSpan,
              targetSpan,
            );
            mouseSelectionRef.current = {
              ...currentSelection,
              anchor: nextRange.anchor,
              focus: nextRange.focus,
              didDrag: true,
            };
            updateTranscriptMouseSelection(
              nextRange.anchor,
              nextRange.focus,
              { updateSelectedItem: false },
            );
            return true;
          }

          mouseSelectionRef.current = {
            ...currentSelection,
            focus: dragTarget.point,
            didDrag: true,
          };
          updateTranscriptMouseSelection(
            currentSelection.anchor,
            dragTarget.point,
            { updateSelectedItem: false },
          );
          return true;
        }

        if (pointerAction.phase === "release") {
          const selectionState = mouseSelectionRef.current;
          const fallbackPoint = selectionState.focus;
          const releaseTarget = target ?? (transcriptScreenBufferRef.current
            ? clampTranscriptScreenHit(
              transcriptScreenBufferRef.current,
              mouseEvent.row,
              mouseEvent.column,
            )
            : undefined);
          let focusPoint = releaseTarget?.point ?? fallbackPoint;

          if (selectionState.mode !== "char" && selectionState.anchorSpan) {
            const releaseSpan = resolveTranscriptSelectionSpanAt(
              resolveTranscriptSelectionRows(),
              focusPoint,
              selectionState.mode,
            );
            if (releaseSpan) {
              const nextRange = extendTranscriptSelectionSpan(
                selectionState.anchorSpan,
                releaseSpan,
              );
              selectionState.anchor = nextRange.anchor;
              focusPoint = nextRange.focus;
            }
          }

          finalizeTranscriptMouseSelection(selectionState, { focusPoint });
          return true;
        }
      }

      if (pointerAction.kind === "scroll-by") {
        disarmHistorySearchSelection();
        scrollTranscriptBy(pointerAction.delta);
        return true;
      }

      if (pointerAction.kind === "consume") {
        return true;
      }

        const keyboardAction = resolveTranscriptKeyboardAction({
          key,
          isTranscriptMode,
          isHistorySearchActive,
          historySearchMatchCount: historySearchMatches.length,
          hasTextSelection: Boolean(activeTextSelection),
          hasFocusedItem: Boolean(selectedTranscriptItemId),
          canCopySelectedItem: canCopySelectedTranscriptItem,
          canCopySelectedToolInput,
          canToggleSelectedDetail: canToggleSelectedTranscriptDetail,
        canCycleTranscriptSelection,
      });

      return executeTranscriptKeyboardAction({
        action: keyboardAction,
        hasTranscript,
        isTranscriptMode,
        pageScrollDelta: reviewPageSize,
        disarmHistorySearchSelection,
        scrollTranscriptBy,
        closeHistorySearchSurface,
        backspaceHistorySearchQuery: () => {
          setHistorySearchQuery((prev) => prev.slice(0, -1));
          setHistorySearchSelectedIndex(0);
        },
        stepHistorySearchSelection: (direction) => {
          setHistorySearchSelectedIndex((prev) =>
            stepTranscriptSearchMatch(historySearchMatches.length, prev, direction),
          );
        },
        submitHistorySearchSelection: () => {
          const match = historySearchMatches[clampedHistorySearchSelectedIndex];
          if (match) {
            revealTranscriptItem(match.itemId);
            closeHistorySearchSurface();
          }
        },
          appendHistorySearchQuery: (text) => {
            setHistorySearchQuery((prev) => prev + text);
            setHistorySearchSelectedIndex(0);
          },
          openHistorySearchSurface,
          clearTranscriptSelectionFocus,
          exitTranscriptModeSurface,
          toggleTranscriptShowAll,
          scrollTranscriptHome: () => {
            scrollTranscriptTo(Math.max(0, effectiveTranscriptScrollHeight - viewportBudget.messageRows));
          },
        scrollTranscriptToBottom: () => {
          scrollTranscriptToBottom();
          clearTranscriptMouseSelection();
        },
        cycleTranscriptSelection,
        copySelectedTranscriptText: () => {
          void copySelectedTranscriptText();
        },
        copySelectedTranscriptItem: () => {
          void copySelectedTranscriptItem();
        },
        copySelectedTranscriptToolInput: () => {
          void copySelectedTranscriptToolInput();
        },
        toggleSelectedTranscriptDetail,
        navigateSearchMatch: (direction) => {
          setHistorySearchSelectedIndex((prev) => {
            const nextIndex = stepTranscriptSearchMatch(
              historySearchMatches.length,
              prev,
              direction,
            );
            const match = historySearchMatches[nextIndex];
            if (match) {
              revealTranscriptItem(match.itemId);
            }
            return nextIndex;
          });
        },
      });
    },
    [
      isTranscriptMode,
      currentSurfaceItems,
      currentSurfaceStreamingState.currentResponse,
      currentSurfaceStreamingState.thinkingContent,
      currentSurfaceStreamingState.activeToolCalls,
      historyScrollOffset,
      effectiveTranscriptScrollHeight,
      reviewPageSize,
      reviewWheelStep,
      selectedTranscriptItemId,
      clearTranscriptSelectionFocus,
      exitTranscriptModeSurface,
      toggleTranscriptShowAll,
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
      revealTranscriptItem,
      activeTextSelection,
      resolveTranscriptMouseTarget,
      transcriptDisplayState.supportsMouseTracking,
      transcriptModeTextSelection,
      useManagedMouseClicks,
      useManagedMouseWheel,
      useManagedSelection,
      useRendererViewportShell,
      useRendererOwnedMouseTracking,
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
        addHistoryItem({
          type: "info",
          text: `${t("dialog.confirm")} ${confirmRequest.prompt}\n  → ${t("confirm.result.approved")}`,
        });
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: true });
        confirmResolveRef.current = null;
        return true;
      }

      if (canAlways && (answer === "a" || answer === "always")) {
        addHistoryItem({
          type: "info",
          text: `${t("dialog.confirm")} ${confirmRequest.prompt}\n  → ${t("confirm.result.approved_always")}`,
        });
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: true, always: true });
        confirmResolveRef.current = null;
        return true;
      }

      if (answer === "n" || answer === "no" || key.name === "escape") {
        addHistoryItem({
          type: "info",
          text: `${t("dialog.confirm")} ${confirmRequest.prompt}\n  → ${t("confirm.result.denied")}`,
        });
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

  const showSelectDialogWithOptions = useCallback((
    title: string,
    options: SelectOption[],
    multiSelect?: boolean,
  ): Promise<string | undefined> => {
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
        focusedIndex: 0,
        selectedIndices: [],
        multiSelect,
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
        const optionCount = uiRequest.options.length;

        // Arrow-key / vim-style navigation
        if (key.name === "up" || key.sequence === "k") {
          setUiRequest((prev) =>
            prev && prev.kind === "select"
              ? { ...prev, focusedIndex: (prev.focusedIndex - 1 + optionCount) % optionCount, error: undefined }
              : prev,
          );
          return true;
        }

        if (key.name === "down" || key.sequence === "j") {
          setUiRequest((prev) =>
            prev && prev.kind === "select"
              ? { ...prev, focusedIndex: (prev.focusedIndex + 1) % optionCount, error: undefined }
              : prev,
          );
          return true;
        }

        // Space: toggle selection in multiSelect mode
        if (key.sequence === " " && uiRequest.multiSelect) {
          setUiRequest((prev) => {
            if (!prev || prev.kind !== "select") return prev;
            const idx = prev.focusedIndex;
            const selected = prev.selectedIndices.includes(idx)
              ? prev.selectedIndices.filter((i) => i !== idx)
              : [...prev.selectedIndices, idx];
            return { ...prev, selectedIndices: selected, error: undefined };
          });
          return true;
        }

        // Enter: confirm selection
        if (key.name === "return") {
          if (uiRequest.multiSelect) {
            // MultiSelect: return comma-separated values of selected items
            if (uiRequest.selectedIndices.length === 0) {
              setUiRequest((prev) =>
                prev && prev.kind === "select"
                  ? { ...prev, error: t("select.multiselect_empty") }
                  : prev,
              );
              return true;
            }
            const values = uiRequest.selectedIndices
              .sort((a, b) => a - b)
              .map((i) => uiRequest.options[i]?.value)
              .filter(Boolean)
              .join(", ");
            resolveUIRequest(values);
          } else {
            // Single select: return focused item's value
            resolveUIRequest(uiRequest.options[uiRequest.focusedIndex]?.value);
          }
          return true;
        }

        // Number keys: jump focus to that index (no direct confirm — user must press Enter).
        // In multiSelect mode, pressing a number key ALSO toggles the selection state for
        // that index — this mirrors checkbox UX where clicking both focuses and toggles.
        // Pressing the same number twice will toggle on → off → on.
        if (/^[1-9]$/.test(key.sequence)) {
          const idx = Number.parseInt(key.sequence, 10) - 1;
          if (idx >= 0 && idx < optionCount) {
            if (uiRequest.multiSelect) {
              // multiSelect: jump focus + toggle selection (intentional dual action)
              setUiRequest((prev) => {
                if (!prev || prev.kind !== "select") return prev;
                const selected = prev.selectedIndices.includes(idx)
                  ? prev.selectedIndices.filter((i) => i !== idx)
                  : [...prev.selectedIndices, idx];
                return { ...prev, focusedIndex: idx, selectedIndices: selected, error: undefined };
              });
            } else {
              // In single-select: only jump focus, require Enter to confirm
              setUiRequest((prev) =>
                prev && prev.kind === "select"
                  ? { ...prev, focusedIndex: idx, error: undefined }
                  : prev,
              );
            }
            return true;
          }
        }

        // Consume unhandled keys in select mode (no text buffer)
        return false;
      }

      // Input mode handling
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
            ...(item.icon ? { icon: item.icon } : {}),
            ...(item.compactText ? { compactText: item.compactText } : {}),
          });
        }
        return;
      }

      for (const msg of context.messages) {
        const historySeeds = extractHistorySeedsFromMessage(msg);
        for (const item of historySeeds) {
          addHistoryItem(seedToHistoryItem(item));
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
      if (userInterruptedRef.current) {
        return;
      }
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
      if (managedForegroundOwnerRef.current.workerId) {
        appendManagedForegroundTextBlock("thinking", text);
      }
    },
    onThinkingEnd: (thinking: string) => {
      if (userInterruptedRef.current) {
        return;
      }
      const currentThinking = getThinkingContent();
      const mergedThinking = mergeLiveThinkingContent(currentThinking, thinking);
      if (mergedThinking && mergedThinking !== currentThinking) {
        clearThinkingContent();
        startThinking();
        appendThinkingChars(mergedThinking.length);
        appendThinkingContent(mergedThinking);
      }
      if (managedForegroundOwnerRef.current.workerId) {
        syncManagedForegroundThinkingBlock(mergedThinking);
      }
      stopThinking();
    },
    onTextDelta: (text: string) => {
      if (userInterruptedRef.current) {
        return;
      }
      if (streamingState.currentTool) {
        setCurrentTool(undefined);
        clearToolInputContent();
      }
      stopThinking();
      setLastLiveActivityLabel(undefined);
      appendResponse(text);
      if (managedForegroundOwnerRef.current.workerId) {
        appendManagedForegroundTextBlock("assistant", text);
      }
    },
    onToolUseStart: (tool: { name: string; id: string; input?: Record<string, unknown> }) => {
      if (userInterruptedRef.current) {
        return;
      }
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
      if (managedForegroundOwnerRef.current.workerId) {
        syncManagedForegroundToolGroup(toolCall);
      }
      setLastLiveActivityLabel(
        formatManagedLiveToolLabel(toolCall, managedTaskStatusRef.current?.activeWorkerTitle),
      );
    },
    onToolInputDelta: (
      toolName: string,
      partialJson: string,
      meta?: { toolId?: string },
    ) => {
      if (userInterruptedRef.current) {
        return;
      }
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
        if (managedForegroundOwnerRef.current.workerId) {
          syncManagedForegroundToolGroup(updatedTool);
        }
        setLastLiveActivityLabel(
          formatManagedLiveToolLabel(updatedTool, managedTaskStatusRef.current?.activeWorkerTitle),
        );
      }
    },
    onToolResult: (result) => {
      if (userInterruptedRef.current) {
        return;
      }
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
          if (managedForegroundOwnerRef.current.workerId) {
            syncManagedForegroundToolGroup(finalizedTool);
          }
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
          if (managedForegroundOwnerRef.current.workerId) {
            syncManagedForegroundToolGroup(finalizedTool);
          }
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
        if (managedForegroundOwnerRef.current.workerId) {
          syncManagedForegroundToolGroup(finalizedTool);
        }
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
      if (managedForegroundOwnerRef.current.workerId) {
        finalizedTools.forEach((tool) => syncManagedForegroundToolGroup(tool));
      }
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
      if (managedForegroundOwnerRef.current.workerId) {
        finalizedTools.forEach((tool) => syncManagedForegroundToolGroup(tool));
      }
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
        console.log(chalk.yellow('   \u23F3 Retries exhausted. Press Enter to continue the conversation'));
      } else if (classification.category === ErrorCategory.TOOL_CALL_ID) {
        console.log(chalk.green('   \u2705 Session cleaned, ready to continue'));
      }

      console.log(''); // Empty line for readability
    },
    onRetry: (reason: string, attempt: number, maxAttempts: number) => {
      if (userInterruptedRef.current) {
        return;
      }
      emitRetryHistoryItem(addHistoryItem, reason, attempt, maxAttempts);
    },
    onProviderRecovery: (event) => {
      if (userInterruptedRef.current) {
        return;
      }
      emitRecoveryHistoryItem(addHistoryItem, event);
    },
    onManagedTaskStatus: (status) => {
      if (userInterruptedRef.current) {
        return;
      }
      const previousForegroundWorker = managedForegroundOwnerRef.current;
      if (isForegroundManagedStreamingStatus(status)) {
        if (
          previousForegroundWorker.workerId
          && previousForegroundWorker.workerId !== status.activeWorkerId
        ) {
          transitionManagedForegroundPhase({
            workerId: status.activeWorkerId,
            workerTitle: status.activeWorkerTitle,
          });
        } else if (previousForegroundWorker.workerId !== status.activeWorkerId) {
          managedForegroundLedgerRef.current = {
            workerId: status.activeWorkerId,
            workerTitle: status.activeWorkerTitle,
            activeToolGroupTools: [],
          };
          managedForegroundOwnerRef.current = {
            workerId: status.activeWorkerId,
            workerTitle: status.activeWorkerTitle,
          };
        }
      }
      managedTaskStatusRef.current = status;
      setManagedTaskStatus(status);
      const liveEventDrafts = buildManagedLiveEventDrafts(status);
      appendManagedLiveEventDrafts(liveEventDrafts);
      const breadcrumbCompact = formatManagedTaskBreadcrumb(status);
      const breadcrumbExpanded = formatManagedTaskBreadcrumb(status, { expanded: true });
      const breadcrumbText = breadcrumbExpanded ?? breadcrumbCompact;
      if (breadcrumbText) {
        managedTaskBreadcrumbRef.current = breadcrumbText;
      }
    },
    onProviderRateLimit: (attempt: number, maxAttempts: number, delayMs: number) => {
      if (userInterruptedRef.current) {
        return;
      }
      addHistoryItem({
        type: "info",
        icon: "\u23F3",
        text: `[Rate Limit] Retrying in ${delayMs / 1000}s (${attempt}/${maxAttempts})...`
      });
    },
    // Iteration start - called at the beginning of each agent iteration
    // Iteration start: called at the beginning of each agent iteration.
    onIterationStart: (iter: number, maxIter: number) => {
      if (userInterruptedRef.current) {
        return;
      }
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
      const ownsForegroundLedger = Boolean(managedForegroundOwnerRef.current.workerId);

      // Always update iteration counter BEFORE adding to history 
      // This implicitly clears the text buffer so we don't double-render the old streaming 
      // content simultaneously with the new static HistoryItem!
      startNewIteration(iter);
      if (ownsForegroundLedger) {
        resetManagedForegroundLedgerState({ clearOwner: false });
      }
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
        if (!ownsForegroundLedger) {
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
          // Issue 051: show cancellation feedback (now via i18n).
          console.log(chalk.yellow(t("cancelled")));
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
    // Issue 114: ESC returns undefined → must signal cancellation, not silently fallback.
    askUser: async (options: import("@kodax/coding").AskUserQuestionOptions): Promise<string> => {
      const selectOptions = options.options ? toSelectOptions(options.options) : [];
      const selectedValue = await showSelectDialogWithOptions(
        getAskUserDialogTitle(options),
        selectOptions,
        options.multiSelect,
      );

      // Issue 114: User pressed ESC → signal cancellation so the agent loop stops.
      if (selectedValue === undefined) {
        return CANCELLED_TOOL_RESULT_MESSAGE;
      }

      if (shouldSwitchToAcceptEdits(permissionModeRef.current, options, selectedValue)) {
        setSessionPermissionMode("accept-edits");
        return JSON.stringify({
          choice: selectedValue,
          mode_switched: true,
          new_mode: "accept-edits",
          note: "Permission mode switched to accept-edits. You can now write files, run bash commands, and make edits. Proceed with the implementation.",
        });
      }

      return selectedValue;
    },
    askUserInput: async (options: { question: string; default?: string }): Promise<string | undefined> => {
      return showInputDialog(options.question, options.default);
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
    resetManagedForegroundLedgerState,
    setLastLiveActivityLabel,
    appendManagedForegroundTextBlock,
    syncManagedForegroundThinkingBlock,
    syncManagedForegroundToolGroup,
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
    initialMessages: KodaXMessage[] = context.messages,
    inputArtifacts?: readonly KodaXInputArtifact[],
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
    if (inputArtifacts && inputArtifacts.length > 0) {
      managedRunContext.inputArtifacts = [...inputArtifacts];
    }

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

  const requestGracefulExit = useCallback(async () => {
    if (gracefulExitRunnerRef.current) {
      return gracefulExitRunnerRef.current;
    }

    const run = (async () => {
      userInterruptedRef.current = true;
      abort();
      stopStreaming();
      stopThinking();
      clearThinkingContent();
      clearToolInputContent();
      clearResponse();
      setCurrentTool(undefined);
      setIsLoading(false);

      // Flush any pending persistence, then force a final save with the latest uiHistory.
      await persistContextStateQueueRef.current.catch(() => {});
      await persistContextStateRef.current?.().catch(() => {});
      setIsRunning(false);
      if (isRawModeSupported && stdin?.isRaw) {
        setRawMode(false);
      }
      stdin?.pause?.();
      stdin?.unref?.();
      exit();
      onExit();
    })();

    gracefulExitRunnerRef.current = run.finally(() => {
      gracefulExitRunnerRef.current = null;
    });
    return gracefulExitRunnerRef.current;
  }, [
    abort,
    clearResponse,
    clearThinkingContent,
    clearToolInputContent,
    exit,
    isRawModeSupported,
    onExit,
    setCurrentTool,
    setIsLoading,
    setRawMode,
    stdin,
    stopStreaming,
    stopThinking,
  ]);

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
    const managedForegroundRoundItems = [...managedForegroundTurnItemsRef.current];
    const hasManagedForegroundLedger = managedForegroundRoundItems.length > 0;
    // The foreground ledger may contain only tool_group/thinking items without a
    // substantive assistant text block.  When that happens we must still append
    // the resolved finalResponse so the user sees the answer.
    const foregroundCoversAssistantText = hasManagedForegroundLedger
      && managedForegroundRoundItems.some(
        (item) => item.type === "assistant"
          && "text" in item
          && sanitizeUserFacingAssistantText(String(item.text ?? "")).length > 0,
      );
    const needsFinalResponseItem = finalResponse && !foregroundCoversAssistantText;
    const managedRoundEvents = [...managedRoundEventHistoryRef.current];
    const managedTranscriptItems = managedRoundEvents.length === 0
      ? buildManagedTaskTranscriptItems(result)
      : [];
    const roundHistoryItems = hasManagedForegroundLedger
      ? []
      : buildRoundHistoryItems({
          thinking: finalThinking,
          response: undefined,
          toolCalls: iterationToolCallsRef.current,
          toolNames: iterationToolsRef.current,
        });
    const persistedAdditions: CreatableHistoryItem[] = [
      ...managedForegroundRoundItems.map((item) => toCreatableHistoryItem(item)),
      ...roundHistoryItems,
      ...managedRoundEvents.map((item) => toCreatableHistoryItem(item)),
      ...managedTranscriptItems.map((text) => toManagedTranscriptEventItem(text)),
      ...(needsFinalResponseItem
        ? [{
            type: "assistant" as const,
            text: result.interrupted ? `${finalResponse}\n\n[Interrupted]` : finalResponse,
          }]
        : !finalResponse && !foregroundCoversAssistantText && !result.interrupted
          ? [{ type: "info" as const, text: "[No response text was produced for this round]" }]
          : []),
    ];
    const nextUiHistory = appendPersistedUiHistorySnapshot(
      persistedUiHistoryRef.current,
      persistedAdditions,
    );

    clearThinkingContent();
    clearResponse();

    for (const item of managedForegroundRoundItems) {
      addHistoryItem(toCreatableHistoryItem(item));
    }
    for (const item of roundHistoryItems) {
      addHistoryItem(item);
    }

    for (const transcript of managedTranscriptItems) {
      addHistoryItem(toManagedTranscriptEventItem(transcript));
    }
    for (const eventItem of managedRoundEvents) {
      addHistoryItem(toCreatableHistoryItem(eventItem));
    }

    if (needsFinalResponseItem) {
      addHistoryItem({
        type: "assistant",
        text: result.interrupted ? `${finalResponse}\n\n[Interrupted]` : finalResponse,
      });
    } else if (!finalResponse && !foregroundCoversAssistantText && !result.interrupted) {
      // No assistant text was produced — neither from the foreground ledger nor
      // from the resolved result.  Surface a visible notice so the user is aware
      // the response was empty rather than silently showing nothing.
      addHistoryItem({ type: "info", text: "[No response text was produced for this round]" });
    }

    iterationToolsRef.current = [];
    iterationToolCallsRef.current = [];
    resetLiveToolCalls();
    clearToolInputContent();
    setCurrentTool(undefined);
    setLastLiveActivityLabel(undefined);
    clearManagedForegroundTurnHistory();
    managedLiveEventsRef.current = [];
    managedRoundEventHistoryRef.current = [];
    setManagedLiveEvents([]);
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
    clearManagedForegroundTurnHistory,
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
      addHistoryItem(seedToHistoryItem(item));
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
            const mapped = seedToHistoryItem(item);
            addHistoryItem(mapped);
            persistedAdditions.push(mapped);
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
            persistedAdditions.push(seedToHistoryItem(item));
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
      const currentManagedForegroundItems = managedForegroundTurnItemsRef.current.map((item) => toCreatableHistoryItem(item));
      const hasManagedForegroundLedger = currentManagedForegroundItems.length > 0;
      if (currentManagedForegroundItems.length > 0) {
        appendHistoryItemsToCurrentSnapshot(currentManagedForegroundItems);
      }
      if (!hasManagedForegroundLedger && currentFullResponse) {
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
      clearManagedForegroundTurnHistory();
      managedLiveEventsRef.current = [];
      managedRoundEventHistoryRef.current = [];
      setManagedLiveEvents([]);
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
          exit: requestGracefulExit,
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

      const inputArtifactCwd =
        currentOptionsRef.current.context?.executionCwd ?? process.cwd();
      const emitArtifactWarnings = (warnings: readonly string[]) => {
        if (warnings.length === 0) {
          return;
        }
        appendHistoryItemsWithPersistence(
          warnings.map((text) => ({
            type: "info" as const,
            text,
          })),
        );
      };

      // Run with plan mode if enabled
      if (planMode) {
        const preparedArtifacts = preparePromptInputArtifacts(
          processed,
          inputArtifactCwd,
        );
        emitArtifactWarnings(preparedArtifacts.warnings);
        try {
          await runWithPlanMode(preparedArtifacts.promptText, {
            ...currentOptionsRef.current,
            provider: currentConfig.provider,
            thinking: currentConfig.thinking,
            reasoningMode: currentConfig.reasoningMode,
            agentMode: currentConfig.agentMode,
            context: {
              ...currentOptionsRef.current.context,
              ...(preparedArtifacts.inputArtifacts.length > 0
                ? { inputArtifacts: preparedArtifacts.inputArtifacts }
                : {}),
            },
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
          async (prompt) => {
            const preparedArtifacts = preparePromptInputArtifacts(
              prompt,
              currentOptionsRef.current.context?.executionCwd ?? process.cwd(),
            );
            emitArtifactWarnings(preparedArtifacts.warnings);
            return runAgentRound(
              currentOptionsRef.current,
              preparedArtifacts.promptText,
              context.messages,
              preparedArtifacts.inputArtifacts,
            );
          },
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
        // Update live token count with final estimate so the status bar stays current.
        // (Setting null would rely on context.messages — a mutable ref that React can't detect.)
        setLiveTokenCount(
          context.contextTokenSnapshot?.currentTokens
            ?? estimateTokens(context.messages),
        );
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
      activityBar={promptActivityViewModel ? (
        <Box paddingX={1}>
          {promptActivityViewModel.showSpinner ? (
            <Spinner color={getTheme("dark").colors.accent} />
          ) : null}
          <Text
            color={
              promptActivityViewModel.kind === "waiting"
                ? getTheme("dark").colors.warning
                : getTheme("dark").colors.accent
            }
          >
            {promptActivityViewModel.showSpinner ? " " : ""}
            {promptActivityViewModel.text}
          </Text>
        </Box>
      ) : undefined}
      composer={(
        <PromptComposer
          onSubmit={handleSubmit}
          prompt=">"
          placeholder={buildPromptPlaceholderText({
            isLoading,
            canQueueFollowUps,
            waitingReason: promptWaitingReason,
          })}
          focus={!confirmRequest && !uiRequest && !isHistorySearchActive}
          cwd={process.cwd()}
          gitRoot={options.context?.gitRoot || context.gitRoot}
          onInputChange={handleInputChange}
        />
      )}
      inlineSuggestions={suggestionsSurface}
      helpSurface={showHelp ? (
        <PromptHelpMenu sections={buildHelpMenuSections()} />
      ) : undefined}
      taskBar={displayWorkStripText ? (
        <BackgroundTaskBar
          items={displayedAmaSummaryViewModel.backgroundTask.items}
          overflowLabel={displayedAmaSummaryViewModel.backgroundTask.overflowLabel}
          ctaHint={displayedAmaSummaryViewModel.backgroundTask.ctaHint}
          showSpinner={isLoading}
        />
      ) : undefined}
      statusLine={<Box><StatusBar {...statusBarProps} viewModel={visibleStatusBarViewModel} /></Box>}
      inlineDialogs={dialogSurface}
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
          selectionActive={Boolean(activeTextSelection || selectedTranscriptItemId)}
          showAllActive={showAllInTranscript}
          searchQuery={historySearchQuery}
          searchCurrent={historySearchMatches.length > 0 ? clampedHistorySearchSelectedIndex + 1 : 0}
          searchCount={historySearchMatches.length}
          searchDetailText={effectiveHistorySearchDetailText}
          pendingLiveUpdates={pendingTranscriptUpdateCount}
          secondaryText={transcriptFooterSecondaryText}
        />
      )}
      taskBar={displayWorkStripText ? (
        <BackgroundTaskBar
          items={displayedAmaSummaryViewModel.backgroundTask.items}
          overflowLabel={displayedAmaSummaryViewModel.backgroundTask.overflowLabel}
          ctaHint={displayedAmaSummaryViewModel.backgroundTask.ctaHint}
          showSpinner={transcriptDisplayIsLoading}
        />
      ) : undefined}
      statusLine={<Box><StatusBar {...statusBarProps} viewModel={statusBarViewModel} /></Box>}
    />
  );
  const renderPromptSurfaceTranscript = useCallback((options?: {
    bannerVisible?: boolean;
    rendererWindow?: Pick<ScrollBoxWindow, "start" | "end" | "scrollHeight" | "viewportHeight" | "scrollTop" | "viewportTop" | "pendingDelta" | "sticky">;
  }) => (
    <PromptTranscriptSurface
      banner={options?.bannerVisible ? <Banner {...bannerProps} /> : undefined}
      items={effectivePromptDisplayItems}
      isLoading={effectivePromptIsLoading}
      viewportRows={viewportBudget.messageRows}
      viewportWidth={terminalWidth}
      scrollOffset={historyScrollOffset}
      windowed={Boolean(options?.rendererWindow)}
      rendererWindow={options?.rendererWindow}
      transcriptModel={options?.rendererWindow ? ownedTranscriptRenderModel : promptMainScreenRenderModel}
      maxLines={transcriptMaxLines}
      selectedTextRanges={useManagedSelection ? promptTextSelection?.rowRanges : undefined}
      onMetricsChange={handleTranscriptMetricsChange}
      onVisibleRowsChange={handleVisibleTranscriptRowsChange}
    />
  ), [
    bannerProps,
    effectivePromptDisplayItems,
    effectivePromptIsLoading,
    handleTranscriptMetricsChange,
    handleVisibleTranscriptRowsChange,
    historyScrollOffset,
    promptMainScreenRenderModel,
    terminalWidth,
    transcriptMaxLines,
    promptTextSelection?.rowRanges,
    viewportBudget.messageRows,
    useManagedSelection,
  ]);
  const renderTranscriptModeSurface = useCallback((options?: {
    bannerVisible?: boolean;
    windowed?: boolean;
    rendererWindow?: Pick<ScrollBoxWindow, "start" | "end" | "scrollHeight" | "viewportHeight" | "scrollTop" | "viewportTop" | "pendingDelta" | "sticky">;
  }) => (
    <TranscriptModeSurface
      banner={options?.bannerVisible ? <Banner {...bannerProps} /> : undefined}
      items={transcriptDisplayItems}
      browse={{ hintText: transcriptChrome.browseHintText }}
      selection={transcriptSelectionState}
      search={effectiveTranscriptSearchState}
      isLoading={transcriptDisplayIsLoading}
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
      managedPhase={transcriptDisplayIsLoading ? managedTaskStatus?.phase : undefined}
      managedHarnessProfile={transcriptDisplayIsLoading ? managedTaskStatus?.harnessProfile : undefined}
      managedWorkerTitle={transcriptDisplayIsLoading ? managedTaskStatus?.activeWorkerTitle : undefined}
      managedRound={transcriptDisplayIsLoading ? managedTaskStatus?.currentRound : undefined}
      managedMaxRounds={transcriptDisplayIsLoading ? managedTaskStatus?.maxRounds : undefined}
      managedGlobalWorkBudget={transcriptDisplayIsLoading ? managedTaskStatus?.globalWorkBudget : undefined}
      managedBudgetUsage={transcriptDisplayIsLoading ? managedTaskStatus?.budgetUsage : undefined}
      managedBudgetApprovalRequired={transcriptDisplayIsLoading ? managedTaskStatus?.budgetApprovalRequired : undefined}
      lastLiveActivityLabel={transcriptStreamingState.lastLiveActivityLabel}
      viewportRows={viewportBudget.messageRows}
      viewportWidth={terminalWidth}
      scrollOffset={historyScrollOffset}
      windowed={Boolean(options?.windowed)}
      animateSpinners={Boolean(options?.rendererWindow) && transcriptAnimateSpinners}
      rendererWindow={options?.rendererWindow}
      transcriptModel={options?.rendererWindow ? ownedTranscriptRenderModel : transcriptMainScreenRenderModel}
      maxLines={transcriptMaxLines}
      showDetailedTools={showAllInTranscript}
      showAllContent={showAllInTranscript}
      selectedItemId={transcriptSelectionRuntime.selectionEnabled ? selectedTranscriptItemId : undefined}
      selectedTextRanges={transcriptModeTextSelection?.rowRanges}
      expandedItemKeys={transcriptSelectionRuntime.selectionEnabled ? expandedTranscriptItemIds : undefined}
      onMetricsChange={handleTranscriptMetricsChange}
      onVisibleRowsChange={handleVisibleTranscriptRowsChange}
    />
  ), [
    bannerProps,
    currentConfig.agentMode,
    transcriptDisplayIsLoading,
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
    transcriptMainScreenRenderModel,
    transcriptChrome.browseHintText,
    selectedTranscriptItemId,
    transcriptSelectionState,
    terminalWidth,
    transcriptAnimateSpinners,
    transcriptDisplayItems,
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
    transcriptModeTextSelection?.rowRanges,
    effectiveTranscriptSearchState,
    showAllInTranscript,
    viewportBudget.messageRows,
  ]);
  const currentTranscriptSurface = isTranscriptMode
    ? renderTranscriptModeSurface({
      bannerVisible: false,
      windowed: transcriptOwnsViewport,
    })
    : renderPromptSurfaceTranscript({
      bannerVisible: false,
    });
  const currentFooterSurface = isTranscriptMode
    ? transcriptFooterSurface
    : promptFooterSurface;
  const shouldFillShellHeight = fullscreenPolicy.enabled && useRendererViewportShell;
  const shellBody = (
    <Box
      flexDirection="column"
      width={terminalWidth}
      flexShrink={0}
      flexGrow={shouldFillShellHeight ? 1 : 0}
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

      {useRendererViewportShell ? (
        <FullscreenTranscriptLayout
          width={terminalWidth}
          stickyHeader={transcriptChrome.stickyHeader}
          jumpToLatest={transcriptChrome.jumpToLatest}
          transcript={!fullscreenPolicy.enabled || !transcriptOwnsViewport ? (
            (isTranscriptMode
              ? renderTranscriptModeSurface({ bannerVisible: false })
              : renderPromptSurfaceTranscript({ bannerVisible: false }))
          ) : undefined}
          renderTranscriptWindow={fullscreenPolicy.enabled && transcriptOwnsViewport
            ? (window) => (
              (() => {
                const geometry = resolveOwnedTranscriptWindow(window);
                const adjustedWindow = geometry.contentWindow;

                return isTranscriptMode
                  ? renderTranscriptModeSurface({
                    bannerVisible: false,
                    windowed: true,
                    rendererWindow: adjustedWindow,
                  })
                  : renderPromptSurfaceTranscript({
                    bannerVisible: false,
                    rendererWindow: adjustedWindow,
                  });
              })()
            )
            : undefined}
          overlay={contentOverlaySurface}
          scrollTop={historyScrollOffset}
          scrollHeight={effectiveTranscriptScrollHeight}
          viewportHeight={viewportBudget.messageRows}
          stickyScroll={!isTranscriptMode && !isAwaitingUserInteraction && viewportSticky}
          scrollRef={transcriptScrollRef}
          onWindowChange={handleTranscriptWindowChange}
          onScrollTopChange={handleTranscriptScrollTopChange}
          onStickyChange={handleViewportStickyChange}
          footer={currentFooterSurface}
        />
      ) : (
        <>
          <Box flexDirection="column" flexGrow={1}>
            {currentTranscriptSurface}
            {contentOverlaySurface ? (
              <Box position="absolute" bottom={0} left={0} right={0} flexDirection="column">
                {contentOverlaySurface}
              </Box>
            ) : null}
          </Box>
          {currentFooterSurface}
        </>
      )}
    </Box>
  );
  if (useAlternateScreenShell) {
      return (
        <AlternateScreen
          mouseTracking={surfaceInteractionPolicy.usesRendererMouseTracking}
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
    const stdout = process.stdout;
    const stdin = process.stdin;
    // Render Ink app
    // Issue 058/060: Ink 6.x options to reduce flickering
    let exitMessageRequested = false;
    const { waitUntilExit, cleanup } = render(
      <InkREPL
        options={options}
        config={currentConfig}
        context={context}
        storage={storage}
        compactionInfo={compactionInfo}
        rendererMode={rendererMode}
        fullscreenPolicy={fullscreenPolicy}
        onExit={() => {
          exitMessageRequested = true;
        }}
      />,
      {
        stdout,
        stdin,
        exitOnCtrlC: false,
        patchConsole: false,
        // Note: incrementalRendering disabled - causes cursor positioning issues with custom TextInput
        // Ink 6.x still has synchronized updates (auto-enabled) which helps reduce flickering
        maxFps: 30,          // Ink 6.3.0+: Limit frame rate to reduce flickering
        shellMode: fullscreenPolicy.enabled ? fullscreenPolicy.promptShell : "main-screen",
      }
    );

    // Wait for exit
    await waitUntilExit();
    cleanup();
    if (stdin.isTTY === true && typeof stdin.setRawMode === "function" && stdin.isRaw) {
      stdin.setRawMode(false);
    }
    stdin.pause?.();
    stdin.unref?.();
    if (exitMessageRequested) {
      console.log(chalk.dim("\n[Exiting KodaX...]"));
    }
    const shouldHardExitOnClose = options.hardExitOnClose ?? (process.env.VITEST !== "true");
    if (exitMessageRequested && shouldHardExitOnClose) {
      const exitCode = process.exitCode ?? 0;
      let exitScheduled = false;
      const requestProcessExit = () => {
        if (exitScheduled) {
          return;
        }
        exitScheduled = true;
        process.exit(exitCode);
      };

      const exitTimer = setTimeout(requestProcessExit, 0);
      exitTimer.unref?.();
      stdout.write("", requestProcessExit);
      return;
    }
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
