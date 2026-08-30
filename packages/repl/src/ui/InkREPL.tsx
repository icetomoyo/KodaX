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
import { Spinner, SpinnerStatsTail, useSharedSpinnerTick } from "./components/LoadingIndicator.js";
import { BackgroundTaskBar } from "./components/BackgroundTaskBar.js";
import { TodoListSurface } from "./components/TodoListSurface.js";
import {
  ChildActivitySurface,
  measureChildActivitySurfaceRows,
} from "./components/ChildActivitySurface.js";
import {
  measureWorkflowRunSurfaceRows,
  WorkflowRunSurface,
} from "./components/WorkflowRunSurface.js";
import {
  buildTodoPlanViewModel,
  formatTodoPlanProgressText,
  formatTodoPlanViewModelForTranscript,
} from "./view-models/todo-plan.js";
import {
  buildChildActivityViewModel,
  childActivityId,
  childActivityLabel,
  childActivitySource,
  MAX_CHILD_ACTIVITY_ROWS,
  shouldShowChildActivitySurface,
  shouldRouteToChildActivity,
  shouldRouteWorkflowLiveOnlyNotice,
  suppressesChurnOverToolAction,
  toolActivityDetail,
  truncateChildActivityDetail,
  type ChildActivityKind,
  type ChildActivityRecord,
} from "./view-models/child-activity.js";
import {
  buildWorkflowLiveViewModel,
  formatWorkflowLiveViewModelForTranscript,
  workflowLiveSnapshotFromProcess,
  type WorkflowLiveSnapshot,
} from "./view-models/workflow-live.js";
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
  selectUncommittedLedgerUserItems,
} from "./contexts/index.js";
import { AutocompleteContextProvider, useAutocompleteContext } from "./hooks/index.js";
import {
  StreamingState,
  ToolCallStatus,
  type CreatableHistoryItem,
  type HistoryItem,
  type ToolCall,
  type PromptSubmitPayload,
  type LearningBinding,
  type LearningSurfaceSnapshot,
  KeypressHandlerPriority,
} from "./types.js";
import { getActivePasteStore, type PastedContent } from "./utils/paste-store.js";
import { hashPastedText, storePastedText, retrievePastedText, cleanupOldPastes } from "./utils/paste-cache.js";
import {
  prepareRootCompactionLineage,
  withSessionHistoryReadBarrier,
} from "./utils/compaction-commit.js";
import { stripAnsi } from "./utils/strip-ansi.js";
import { createConfirmationDialogQueue } from "./utils/confirmation-dialog-queue.js";
import {
  appendMemoryClientNotice,
  appendMemoryOutcomeDigest,
  appendMemoryReviewReceipt,
} from "@kodax-ai/agent";
import {
  buildSessionTree,
  createSessionLineage,
  extractArtifactLedger,
  getSessionMessagesFromLineage,
  KodaXInputArtifact,
  KodaXOptions,
  KodaXMessage,
  KodaXManagedTaskStatusEvent,
  KodaXReasoningMode,
  KodaXResult,
  KodaXSessionUiHistoryItem,
  KodaXSessionUiToolCall,
  KodaXSessionUiToolCallStatus,
  mergeArtifactLedger,
  runManagedTask,
  drainPendingSwaps,
  KODAX_DEFAULT_PROVIDER,
  KodaXTerminalError,
  classifyError,
  ErrorCategory,
  loadAgentsFiles,
  resolveRepoIntelligenceRuntimeConfig,
  CANCELLED_TOOL_RESULT_MESSAGE,
  classifyBashCommand,
  createOutputSegmentProjection,
  createDenialTracker,
  recordDenial,
  isDeniedRecently,
  getDenialContext,
  getRegisteredToolDefinition,
  effectiveOutputSegmentText,
  reduceOutputSegmentProjection,
  createBashPrefixExtractor,
  decideWorkflowInvocation,
  workflowStartOutcomeConsumesTurn,
  getDefaultWorkflowRunManager,
  resolveProvider,
  prewarmRepoIntelligenceCaches,
  actorQueueId,
} from "@kodax-ai/coding";
import type {
  AgentsFile,
  BashPrefixExtractor,
  CompactionUpdate,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLineage,
  KodaXActivityEventMeta,
  KodaXOutputSegmentProjection,
  KodaXOutputSegmentStarted,
  KodaXSidecarMessageEvent,
  KodaXToolEventMeta,
  KodaXUserInputPromptContext,
  KodaXWorkflowAgentDigestEvent,
  TodoItem,
  TodoList,
} from "@kodax-ai/coding";
import {
  emitKodaXDiagnostic,
  evictOldIslandMessageContent,
  estimateTokens,
  bootstrapTeamMode,
  setActiveUserInteraction,
  ASK_USER_BACK_SIGNAL,
  ASK_USER_CUSTOM_INPUT_SIGNAL,
  getAgentConfigPath,
  type AskUserAnswer,
  type AskUserSelectionAnswer,
  type TeamModeHandle,
  type WorkflowProcessEvent,
  type LearnedCapabilityRecord,
  type LearningEvent,
} from "@kodax-ai/agent";
import { deriveProjectKeyFromRoot } from "../interactive/project-key.js";
import {
  PermissionMode,
  ConfirmResult,
  createPermissionContext,
  computeConfirmTools,
  canonicalizePermissionMode,
  normalizePermissionMode,
  isAutoMode,
  isToolCallAllowed,
  isAlwaysConfirmPath,
  isCommandOnProtectedPath,
  FILE_MODIFICATION_TOOLS,
  isBashWriteCommand,
  isBashReadCommand,
  isBashReadCommandAutoAllowed,
  getPlanModeBlockReason,
  replBashPathSignalCollector,
} from "../permission/index.js";
import type { PermissionContext } from "../permission/types.js";
import {
  createStandaloneShellPermissionBoundary,
  type StandaloneExecPolicyOptions,
} from "../permission/standalone-shell-boundary.js";
import {
  RUNTIME_PERMISSION_PENDING_NOTICE,
  resolveReplRuntimePermissionDecision,
  toReplRuntimeAutoModeSettings,
  type ReplRuntimeAutoModeControl,
  type ReplRuntimeAutoModeSettings,
  type ReplRuntimePermissionGrantSuggestion,
  type ReplRuntimePermissionPrompt,
} from "../runtime-permission.js";
import {
  InteractiveContext,
  createInteractiveContext,
  generateSessionId,
  touchContext,
} from "../interactive/context.js";
import {
  parseCommand,
  executeCommand,
  isRegisteredUserCommand,
  CommandCallbacks,
  CurrentConfig,
} from "../interactive/commands.js";
import {
  findQueueableUserSkillReference,
  MultipleUserSkillReferencesError,
  preserveQueuedSkillContextSnapshot,
  resolveUserSkillInvocation,
} from "../interactive/user-skill-invocation.js";
import {
  enforceSessionTransitionGuard,
} from "../interactive/session-guardrails.js";
import { formatSessionTree } from "../interactive/session-tree.js";
import {
  inspectWorkspaceRuntime,
  resolveSessionRuntimeInfo,
  workspaceExists,
} from "../interactive/workspace-runtime.js";
import type {
  CommandInvocationRequest,
  CommandWorkflowInvocationRequest,
  RuntimeSurfaceStatus,
  SessionRecoverStatus,
} from "../commands/types.js";
import {
  startGeneratedWorkflowFromRequest,
} from "../commands/workflow-command.js";
import { formatWorkflowAgentDigest, inferWorkflowLocaleFromParts } from "../commands/workflow-command-results.js";
import { isDuplicateLegacyRateLimit, type RateLimitDedupKey } from "./rate-limit-dedup.js";
import {
  formatReasoningEffortStatusLabel,
  getProviderModel,
  resolveRuntimeEffortSelection,
  resolveRuntimeModelSelection,
  resolveRuntimeProviderSelection,
  resolveInitialEffortOverride,
  resolveProviderReasoningRuntimeEffort,
  saveConfig,
} from "../common/utils.js";
import { recordRejectedEffort } from "@kodax-ai/agent";
import { buildToolConfirmationPrompt } from "../common/tool-confirmation.js";
import { t } from "../common/i18n.js";
// FEATURE_200 Phase B.1 (v0.7.45) — leaf string/predicate helpers extracted.
import {
  truncateToolPreview,
  truncateToolOutputPreview,
  stripToolRolePrefix,
  normalizeToolNameForMatch,
  isCompletionTranscriptItem,
} from "./InkREPL-misc-helpers.js";
// FEATURE_200 Phase B.2 (v0.7.45) — managed-task live renderers extracted.
import {
  formatManagedLiveActivityLabel,
  formatManagedLiveToolLabel,
  areManagedLiveItemsEquivalent,
} from "./InkREPL-managed-task-renderers.js";
// FEATURE_200 Phase B.3 (v0.7.45) — managed-task live event drafts extracted.
import { buildManagedLiveEventDrafts } from "./InkREPL-live-event-drafts.js";
// FEATURE_200 Phase B.4 (v0.7.45) — managed-task transcript builders extracted.
// Re-exported so existing `from "./InkREPL.js"` importers (tests) keep working.
import { buildManagedTaskTranscriptItems } from "./InkREPL-transcript-builders.js";
export { buildManagedTaskTranscriptItems };
// FEATURE_202 (v0.7.45) — live reasoning topic header from the thinking stream.
import { extractBoldHeader } from "../tui/streaming/bold-header-extractor.js";
import { KODAX_VERSION } from "../common/utils.js";
import { saveAlwaysAllowToolPattern, loadAlwaysAllowTools, savePermissionModeUser, loadAutoModeSettings } from "../common/permission-config.js";
import {
  bootstrapAutoMode,
  type AutoModeBootstrapResult,
} from "../interactive/auto-mode-bootstrap.js";
import { copyTextToClipboard } from "../common/clipboard.js";
import { formatCompactionPolicy } from "../common/compaction-display.js";
import { initializeSkillRegistry, getSkillRegistry } from "@kodax-ai/agent";
import { getTheme } from "./themes/index.js";
import { KODAX_BANNER_LOGO_LINES } from "./constants/banner-logo.js";
import chalk from "chalk";
import {
  ShortcutsProvider,
  useShortcutsContext,
  GlobalShortcuts,
} from "./shortcuts/index.js";
import { prepareInvocationExecution } from "../interactive/invocation-runtime.js";
import { memDiagEnabled, memDiagSnapshot, memDiagReset, buildMemDiagBreakdown } from "../interactive/memory-diagnostics.js";
import { preparePromptInputArtifacts } from "../common/input-artifacts.js";
import {
  buildRecoverySeed,
  normalizeRecoveryPrompt,
  SESSION_RECOVERY_CONFIRM_MESSAGE,
  SESSION_RECOVERY_HINT_MESSAGE,
  shouldOfferSessionRecovery,
} from "../session/recovery.js";

// Extracted modules
import { MemorySessionStorage, type SessionData, type SessionStorage } from "./utils/session-storage.js";
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
import {
  sanitizeToolInput,
  stringifyToolReplayValue,
  TOOL_REPLAY_PREVIEW_MAX_LENGTH,
  truncateToolReplayText,
} from "./utils/tool-sanitizer.js";
import {
  normalizePersistedUiHistory,
  restoreHistoryItemsFromSession,
  trimPersistedUiHistorySnapshot,
} from "./utils/restore-history.js";
import { findMostRecentResumableSession } from "../session/resumable-session.js";
export { restoreHistoryItemsFromSession, trimPersistedUiHistorySnapshot };
import { withCapture, ConsoleCapturer } from "./utils/console-capturer.js";
import { createRecoveryHistoryItem, createRetryHistoryItem } from "./utils/retry-history.js";
import { createRepoIntelTraceHistoryItem, emitRepoIntelTraceHistoryItem } from "./utils/repo-intel-history.js";
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
import { formatPendingInputsBudgetText, MAX_PENDING_INPUTS } from "./utils/pending-inputs.js";
import {
  SLASH_MID_TASK_GUARD_DEDUPE_KEY,
  SLASH_MID_TASK_GUARD_MESSAGE,
  isSlashCommandText,
} from "./utils/slash-mid-task-guard.js";
import { runQueuedPromptSequence } from "./utils/queued-prompt-sequence.js";
import {
  hasTranscriptInputActivity,
  resolveStreamingInterruptAction,
  resolveTranscriptPointerAction,
  shouldStopWorkflowFromInterruptKey,
} from "./utils/transcript-input-policy.js";
import { resolveTranscriptKeyboardAction } from "./utils/transcript-key-actions.js";
import { executeTranscriptKeyboardAction } from "./utils/transcript-interaction-controller.js";
// FEATURE_058: transcript native scrollback dump.
import { dumpTranscriptToNativeScrollback } from "./utils/transcript-scrollback-dump.js";
import {
  buildAlternateScreenEnterSequence,
  buildAlternateScreenExitSequence,
} from "../tui/core/termio.js";
import {
  buildInlinePromptRenderModel,
  splitInlineLedgerModel,
  identifyInlineCommitSection,
  buildTranscriptDynamicPortion,
  buildTranscriptHiddenDivider,
  buildTranscriptRenderModel,
  buildTranscriptStaticPortion,
  composeTranscriptRenderModel,
  computeTranscriptCapStart,
  isTranscriptHiddenDivider,
  materializeTranscriptRenderModel,
  sliceHistoryToRecentCanonicalItems,
  sliceHistoryToRecentRounds,
  transcriptRenderCapForHistory,
  TRANSCRIPT_HARD_LINE_CAP,
  TRANSCRIPT_HIDDEN_DIVIDER_ID,
  TRANSCRIPT_MODE_VISIBLE_MESSAGES,
  type TranscriptCapAnchor,
  type TranscriptRenderModel,
  type TranscriptRow,
  type TranscriptSection,
} from "./utils/transcript-layout.js";
import { EMPTY_INLINE_SCROLLBACK_STATE } from "../tui/substrate/ink/inline-scrollback-ledger.js";
import { renderFinalizedSectionsToScrollbackText } from "./utils/render-finalized-sections.js";
import {
  computeInlineLedgerStep,
  gateInlinePromptModel,
  isInlineLedgerActive,
  resolveInlineLedgerState,
} from "./utils/inline-ledger-controller.js";
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
import { OVERSCAN_ROWS } from "./utils/overscan-window.js";
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
  appendCustomInputOption,
  getAskUserDialogTitle,
  toSelectOptions,
  type SelectOption,
} from "./utils/ask-user.js";
import { buildHelpMenuSections } from "./constants/layout.js";
import { buildStatusBarViewModel } from "./view-models/status-bar.js";
import {
  dismissLearningRecoveryAfterQuerySubmit,
  formatLearningRecoverySummary,
} from "./view-models/learning-summary.js";
import {
  buildPromptActivityViewModel,
  buildPromptPlaceholderText,
  shouldRenderPromptActivityInFooter,
} from "./view-models/surface-liveness.js";
import { resolveEffectiveCompactionInfo } from "./view-models/compaction-info.js";
import {
  buildSurfaceStatusBarProps,
} from "./view-models/surface-status.js";
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
import { buildHostSessionPayload } from "./utils/session-payload.js";
import { SessionReadError } from "../interactive/storage.js";
import type {
  PreparedSessionAppendBaseline,
  PreparedSessionTailDelta,
} from "../interactive/storage.js";

const DOUBLE_INTERRUPT_ESCAPE_INTERVAL_MS = 500;

function reportBackgroundSessionPersistenceError(error: unknown): void {
  emitKodaXDiagnostic({
    source: 'repl:session-persistence',
    level: 'error',
    message: 'Failed to persist interactive Session state in the background.',
    detail: error,
  });
}

function learningCenterActions(record: LearnedCapabilityRecord): SelectOption[] {
  const actions: SelectOption[] = [{ label: "Acknowledge notification", value: "acknowledge" }];
  if (record.lifecycle === "ready") {
    actions.push(
      { label: "Review", value: "review" },
      { label: "Review & Trust", value: "trust" },
      { label: "Snooze for 24 hours", value: "snooze" },
      { label: "Reject", value: "reject" },
    );
  } else if (record.lifecycle === "active_learned") {
    actions.push(
      { label: "Disable", value: "disable" },
      { label: "Promote to user catalog", value: "promote" },
    );
  } else if (record.lifecycle === "quarantined") {
    actions.push(
      { label: "Rollback", value: "rollback" },
      { label: "Disable", value: "disable" },
    );
  }
  return actions;
}

export function buildLearningCenterOptions(
  records: readonly LearnedCapabilityRecord[],
): SelectOption[] {
  const slugCounts = new Map<string, number>();
  for (const record of records) {
    slugCounts.set(record.slug, (slugCounts.get(record.slug) ?? 0) + 1);
  }
  return records.map((record) => {
    const duplicateId = (slugCounts.get(record.slug) ?? 0) > 1
      ? ` · ${record.capabilityId}`
      : "";
    return {
      label: `${record.displayName} · ${record.carrier} · ${record.lifecycle}${duplicateId}`,
      value: record.capabilityId,
    };
  });
}

async function applyLearningCenterAction(
  binding: LearningBinding,
  slug: string,
  action: string,
): Promise<void> {
  if (action === "acknowledge") await binding.acknowledge(slug);
  else if (action === "snooze") {
    await binding.snooze(slug, new Date(Date.now() + 24 * 60 * 60_000).toISOString());
  } else if (action === "reject") await binding.reject(slug);
  else if (action === "disable") await binding.disable(slug);
  else if (action === "rollback") await binding.rollback(slug);
  else if (action === "promote") await binding.promote(slug, "user");
  else if (action === "review") await binding.review(slug);
  else if (action === "trust") await binding.trust(slug);
}

export interface HostSessionPersistenceStorage {
  save(id: string, data: SessionData): Promise<void>;
  appendSessionDelta?(id: string, data: SessionData): Promise<void>;
  prepareSessionAppend?(id: string): Promise<PreparedSessionAppendBaseline | null>;
  appendPreparedSessionTail?(
    id: string,
    delta: PreparedSessionTailDelta,
  ): Promise<PreparedSessionAppendBaseline | null>;
}

type AppendSessionDeltaStorage = HostSessionPersistenceStorage & {
  appendSessionDelta(id: string, data: SessionData): Promise<void>;
};

type PreparedAppendStorage = AppendSessionDeltaStorage & {
  prepareSessionAppend(id: string): Promise<PreparedSessionAppendBaseline | null>;
  appendPreparedSessionTail(
    id: string,
    delta: PreparedSessionTailDelta,
  ): Promise<PreparedSessionAppendBaseline | null>;
};

function hasAppendSessionDelta(
  storage: HostSessionPersistenceStorage,
): storage is AppendSessionDeltaStorage {
  const candidate: Partial<AppendSessionDeltaStorage> = storage;
  return typeof candidate.appendSessionDelta === "function";
}

function applyRuntimeSessionSnapshot(context: InteractiveContext, result: KodaXResult): void {
  const snapshot = result.runtimeSessionSnapshot;
  if (!snapshot) {
    return;
  }

  if ('extensionState' in snapshot) {
    context.extensionState = snapshot.extensionState
      ? structuredClone(snapshot.extensionState)
      : {};
    context.extensionStateDirty = true;
  }
  if ('extensionRecords' in snapshot) {
    context.extensionRecords = snapshot.extensionRecords?.map((record) => ({ ...record })) ?? [];
    context.extensionRecordsDirty = true;
  }
}

// REPL options
export interface InkRuntimeRunnerInput {
  readonly options: KodaXOptions;
  readonly prompt: string;
  readonly sessionId: string;
  readonly permissionMode: PermissionMode;
  readonly autoModeSettings?: ReplRuntimeAutoModeSettings;
  readonly requestPermission?: ReplRuntimePermissionPrompt;
  /** Marks the callback installed by the REPL's legacy permission UI. */
  readonly legacyPermissionHook?: true;
}

export type InkRuntimeRunner = (input: InkRuntimeRunnerInput) => Promise<KodaXResult>;
export type InkRuntimeStatusProvider = () => Promise<RuntimeSurfaceStatus | undefined>;

export interface InkTransientNotice {
  readonly text: string;
  readonly tone: "success" | "warning";
}

function hasPreparedSessionAppend(
  storage: HostSessionPersistenceStorage,
): storage is PreparedAppendStorage {
  const candidate: Partial<PreparedAppendStorage> = storage;
  return typeof candidate.prepareSessionAppend === "function"
    && typeof candidate.appendPreparedSessionTail === "function"
    && typeof candidate.appendSessionDelta === "function";
}

export function createPreparedSessionTail(
  data: SessionData,
  baseline: PreparedSessionAppendBaseline,
  sessionSnapshotDirty: boolean,
): PreparedSessionTailDelta | undefined {
  if (
    sessionSnapshotDirty
    || data.lineage === undefined
    || data.lineage.entries.length < baseline.lineageCount
    || (data.artifactLedger !== undefined
      && data.artifactLedger.length < baseline.artifactCount)
    || (data.artifactLedger === undefined && baseline.artifactCount > 0)
    || (data.extensionRecords !== undefined && baseline.extensionCount > 0)
    || data.tag !== baseline.tag
    || data.extensionState !== undefined
    || data.actorSnapshot !== undefined
    || Object.prototype.hasOwnProperty.call(data, "errorMetadata")
  ) return undefined;
  const lineageEntries = data.lineage.entries.slice(baseline.lineageCount);
  let parentId = baseline.activeEntryId;
  for (const entry of lineageEntries) {
    if (entry.type !== "message" || entry.parentId !== parentId) return undefined;
    parentId = entry.id;
  }
  if (data.lineage.activeEntryId !== parentId) return undefined;
  return {
    baseline,
    title: data.title,
    activeEntryId: data.lineage.activeEntryId,
    lineageEntries,
    artifactEntries: data.artifactLedger?.slice(baseline.artifactCount),
    extensionRecords: data.extensionRecords?.slice(baseline.extensionCount),
    ...(data.uiHistory !== undefined ? { uiHistory: data.uiHistory } : {}),
    ...(data.scope !== undefined ? { scope: data.scope } : {}),
  };
}

export async function persistHostSessionPayload(
  storage: HostSessionPersistenceStorage,
  sessionId: string,
  sessionPayload: SessionData,
  sessionSnapshotDirty: boolean,
): Promise<void> {
  const baseline = hasPreparedSessionAppend(storage)
    ? await storage.prepareSessionAppend(sessionId)
    : null;
  const preparedTail = baseline === null
    ? undefined
    : createPreparedSessionTail(
        sessionPayload,
        baseline,
        sessionSnapshotDirty,
      );
  if (hasPreparedSessionAppend(storage) && preparedTail !== undefined) {
    try {
      await storage.appendPreparedSessionTail(sessionId, preparedTail);
      return;
    } catch (error: unknown) {
      if (!(error instanceof SessionReadError) || error.code !== 'data_changed') {
        throw error;
      }
      await storage.appendSessionDelta(sessionId, sessionPayload);
      return;
    }
  }
  if (hasAppendSessionDelta(storage)) {
    await storage.appendSessionDelta(sessionId, sessionPayload);
    return;
  }
  await storage.save(sessionId, sessionPayload);
}

export interface InkREPLOptions extends KodaXOptions {
  storage?: SessionStorage;
  execPolicy?: StandaloneExecPolicyOptions;
  hardExitOnClose?: boolean;
  runtimeRunner?: InkRuntimeRunner;
  runtimeAutoModeControl?: ReplRuntimeAutoModeControl;
  getRuntimeStatus?: InkRuntimeStatusProvider;
  validateSetupA2AConfig?: (value: unknown) => unknown;
  prepareSetupSandbox?: CommandCallbacks['prepareSetupSandbox'];
  inspectSandbox?: CommandCallbacks['inspectSandbox'];
  learning?: LearningBinding;
  subscribeTransientNotices?: (
    listener: (notice: InkTransientNotice) => void,
  ) => () => void;
}

// Ink REPL Props
interface InkREPLProps {
  options: InkREPLOptions;
  config: CurrentConfig;
  context: InteractiveContext;
  startupRuntimeInfo: NonNullable<InteractiveContext["runtimeInfo"]>;
  storage: SessionStorage;
  autoModeSettings: ReplRuntimeAutoModeSettings;
  compactionInfo?: {
    contextWindow: number;
    triggerPercent: number;
    triggerTokens?: number;
    enabled: boolean;
    reservedResponseTokens?: number;
    /**
     * Raw user-config override (`compaction.contextWindow`) if set.
     * When defined, wins unconditionally over provider per-model values —
     * mirrors the `/compact` / runtime cascade documented in CAP-056. The
     * cascade lives in the React layer so `/model` swaps re-resolve
     * against the active model's contextWindow.
     */
    userOverrideContextWindow?: number;
  };
  rendererMode: EffectiveTuiRendererMode;
  fullscreenPolicy: FullscreenPolicy;
  onExit: () => void;
  /**
   * Auto-mode guardrail factory.
   * Built once per session in `runInkInteractiveMode` (async, requires
   * filesystem reads) and threaded into the component so:
   *   - `createKodaXOptions` can inject `guardrails` when in auto mode
   *   - `/auto-denials` can read reviewer diagnostics
   * Without this prop, the Ink REPL silently ignored auto-mode (regression
   * fixed pre-v0.7.33 release after the readline REPL had already wired it).
   */
  autoModeBootstrap: AutoModeBootstrapResult;
  /**
   * FEATURE_092 v0.7.34 hotfix-3: setter the component invokes inside a
   * `useEffect` on every `currentConfig` state change. Writes the latest
   * config into a ref read by the auto-mode bootstrap's
   * `getCurrentProviderName` / `getCurrentModel` / `getCurrentPermissionMode`
   * closures, so mid-session `/model` and `/provider` swaps retarget the
   * classifier without restart.
   */
  setCurrentConfigRef: (cfg: CurrentConfig) => void;
  /**
   * v0.7.43 (FEATURE_173 Part B follow-up): the Team Mode handle bootstrapped
   * in `runInkInteractiveMode`. Threaded into the component so `/new`,
   * `/resume`, and `/fork` slash command handlers can republish the resolved
   * sessionId onto the FEATURE_125 heartbeat. `null` when team mode is
   * disabled (`KODAX_DISABLE_MULTI_INSTANCE=1`).
   */
  teamModeHandle: TeamModeHandle | null;
}

// Banner Props
interface BannerProps {
  config: CurrentConfig;
  sessionId: string;
  workingDir: string;
  terminalWidth: number;
  compactionInfo?: {
    contextWindow: number;
    triggerPercent: number;
    triggerTokens?: number;
    enabled: boolean;
    reservedResponseTokens?: number;
    /**
     * Raw user-config override (`compaction.contextWindow`) if set.
     * When defined, wins unconditionally over provider per-model values —
     * mirrors the `/compact` / runtime cascade documented in CAP-056. The
     * cascade lives in the React layer so `/model` swaps re-resolve
     * against the active model's contextWindow.
     */
    userOverrideContextWindow?: number;
  };
}

type StreamingEvents = import("@kodax-ai/coding").KodaXEvents & {
  onCompactedMessages?: (
    messages: KodaXMessage[],
    update?: CompactionUpdate,
    meta?: KodaXActivityEventMeta,
  ) => void | Promise<void>;
};

const CHILD_ACTIVITY_MAX_RECORDS = 12;

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
  /**
   * FEATURE_184 v0.7.42 follow-up — id of the thinking item this turn
   * has accumulated streaming `reasoning_content` into. Survives
   * `activeKind` flips to "assistant" / "tool_group" (unlike
   * `activeThinkingItemId`, which is cleared the moment the model
   * switches off thinking). `syncManagedForegroundThinkingBlock`
   * (`onThinkingEnd` finalize) targets this id so the full thinking
   * content replaces the existing item, instead of `startManagedForeg-
   * roundLedgerBlock` creating a duplicate thinking item AFTER the
   * assistant text has already been rendered (surfaced as a stale
   * "Thinking" block below the answer in `deepseek-v4-pro`-style
   * reasoning streams where the entire thinking phase precedes the
   * text phase). Overwritten with the new id on each new thinking-
   * item creation (so multi-turn workers correctly re-target);
   * reset to undefined on phase transition.
   */
  currentTurnThinkingItemId?: string;
}

const PLAN_MODE_BLOCK_GUIDANCE =
  "Do not try to modify files while planning. Finish the plan first, then call exit_plan_mode with the finalized plan — the user will review and approve or reject.";

/**
 * FEATURE_092 phase 2b.7b: single source of truth for "should this session
 * carry the auto-mode guardrail in `KodaXOptions.guardrails`?" Centralized
 * here so any code path that builds options consults the same predicate
 * (initial useRef seed, `setSessionPermissionMode`, slash-command-driven
 * `createKodaXOptions`). Returns `undefined` (not `[]`) outside auto mode
 * so the runner sees the same shape as before this feature shipped.
 */
function buildAutoModeGuardrails(
  mode: PermissionMode,
  bootstrap: AutoModeBootstrapResult,
): readonly import("@kodax-ai/agent").ToolGuardrail[] | undefined {
  if (!isAutoMode(mode)) return undefined;
  return [bootstrap.getGuardrail()];
}

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

function formatCapturedConsoleOutput(args: readonly unknown[]): string {
  return stripAnsi(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
}

function joinCapturedConsoleOutput(lines: readonly string[]): string | undefined {
  const text = lines.map(stripAnsi).join("\n").trimEnd();
  return text.trim().length > 0 ? text : undefined;
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
    icon: isCompletionTranscriptItem(text) ? "\u2713" : ">",
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
        timestamp: item.timestamp,
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "thinking":
      return {
        type: "thinking",
        text: item.text,
        timestamp: item.timestamp,
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "event":
      return {
        type: "event",
        text: item.text,
        timestamp: item.timestamp,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "info":
      return {
        type: "info",
        text: item.text,
        timestamp: item.timestamp,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "error":
      return { type: "error", text: item.text, timestamp: item.timestamp };
    case "system":
      return { type: "system", text: item.text, timestamp: item.timestamp };
    case "hint":
      return { type: "hint", text: item.text, timestamp: item.timestamp };
    case "sidecar":
      return {
        type: "sidecar",
        text: item.text,
        timestamp: item.timestamp,
        ...(item.verdict ? { verdict: item.verdict } : {}),
        ...(item.delivery ? { delivery: item.delivery } : {}),
      };
    case "tool_group":
      return { type: "tool_group", tools: item.tools, timestamp: item.timestamp };
    case "user":
      return { type: "user", text: item.text, timestamp: item.timestamp };
    default:
      {
        const exhaustiveCheck: never = item;
        return exhaustiveCheck;
      }
  }
}

function sanitizeInterruptedAssistantText(text: string): string {
  if (isControlPlaneOnlyAssistantText(text)) {
    return "";
  }
  return sanitizeUserFacingAssistantText(text).trim();
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripManagedWorkerPrefix(text: string, workerTitle: string | undefined): string {
  const title = workerTitle?.trim();
  if (!title) {
    return text;
  }
  return text.replace(new RegExp(`^\\[${escapeRegExpLiteral(title)}\\]\\s*`), "");
}

export function hasSubstantiveManagedAssistantText(
  text: string,
  workerTitle: string | undefined,
): boolean {
  const sanitized = sanitizeUserFacingAssistantText(text);
  return stripManagedWorkerPrefix(sanitized, workerTitle).trim().length > 0;
}

export function shouldAppendManagedAssistantTextDelta(
  text: string,
  hasActiveAssistantBlock: boolean,
): boolean {
  if (!text) {
    return false;
  }
  return hasActiveAssistantBlock || text.trim().length > 0;
}

export function discardReplacedOutputSegmentItems(
  items: readonly HistoryItem[],
  itemIds: readonly (string | undefined)[],
  mode: "replace" | "append",
): HistoryItem[] {
  if (mode === "append") return [...items];
  const discardedIds = new Set(
    itemIds.filter((id): id is string => id !== undefined),
  );
  return discardedIds.size === 0
    ? [...items]
    : items.filter((item) => !discardedIds.has(item.id));
}

export function applyDistinctOutputSegmentStart(
  projection: KodaXOutputSegmentProjection,
  segment: KodaXOutputSegmentStarted,
  onStarted: (next: KodaXOutputSegmentProjection) => void,
): KodaXOutputSegmentProjection {
  const next = reduceOutputSegmentProjection(
    projection,
    { type: "segment.started", ...segment },
  ).state;
  if (next !== projection) onStarted(next);
  return next;
}

export function applyProviderRecoveryTransientReset(actions: {
  readonly clearResponse: () => void;
  readonly clearThinkingContent: () => void;
  readonly stopThinking: () => void;
  readonly clearToolInputContent: () => void;
  readonly clearCurrentTool: () => void;
  readonly resetLiveToolCalls: () => void;
  readonly clearLiveActivityLabel: () => void;
}): void {
  // Provider-owned buffers stay visible until the next distinct segment start.
  actions.stopThinking();
  actions.clearToolInputContent();
  actions.clearCurrentTool();
  actions.resetLiveToolCalls();
  actions.clearLiveActivityLabel();
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

const MAX_PERSISTED_TOOL_GROUP_TOOLS = 20;
const INCOMPLETE_PERSISTED_TOOL_ERROR = "Session ended before the tool completed.";

function toPersistedToolStatus(tool: ToolCall): {
  status: KodaXSessionUiToolCallStatus;
  error?: string;
} {
  switch (tool.status) {
    case ToolCallStatus.Success:
      return { status: "success" };
    case ToolCallStatus.Error:
      return { status: "error" };
    case ToolCallStatus.Cancelled:
      return { status: "cancelled" };
    case ToolCallStatus.AwaitingApproval:
    case ToolCallStatus.Scheduled:
    case ToolCallStatus.Validating:
    case ToolCallStatus.Executing:
      // Persisted replay is terminal-only; unfinished tools, including pending
      // approvals, are rendered as cancelled instead of being revived on resume.
      return { status: "cancelled", error: INCOMPLETE_PERSISTED_TOOL_ERROR };
    default: {
      const exhaustiveCheck: never = tool.status;
      return exhaustiveCheck;
    }
  }
}

function toPersistedToolCall(tool: ToolCall): KodaXSessionUiToolCall | undefined {
  if (!tool.id || !tool.name) {
    return undefined;
  }

  const status = toPersistedToolStatus(tool);
  const output = status.status === "success"
    ? stringifyToolReplayValue(tool.output)
    : undefined;
  const error = status.status === "error" || status.status === "cancelled"
    ? truncateToolReplayText(tool.error ?? stringifyToolReplayValue(tool.output) ?? status.error ?? "")
    : undefined;

  const input = sanitizeToolInput(tool.input);

  return {
    id: tool.id,
    name: tool.name,
    status: status.status,
    ...(input ? { input } : {}),
    ...(typeof tool.preview === "string" && tool.preview.trim().length > 0
      ? { preview: truncateToolReplayText(tool.preview.trim(), TOOL_REPLAY_PREVIEW_MAX_LENGTH) }
      : {}),
    ...(output && output.trim().length > 0 ? { output } : {}),
    ...(error && error.trim().length > 0 ? { error } : {}),
    ...(typeof tool.startTime === "number" ? { startTime: tool.startTime } : {}),
    ...(typeof tool.endTime === "number" ? { endTime: tool.endTime } : {}),
  };
}

function toPersistedToolGroup(
  item: Extract<HistoryItem | CreatableHistoryItem, { type: "tool_group" }>,
): KodaXSessionUiHistoryItem | undefined {
  const tools = item.tools
    .slice(0, MAX_PERSISTED_TOOL_GROUP_TOOLS)
    .map(toPersistedToolCall)
    .filter((tool): tool is KodaXSessionUiToolCall => Boolean(tool));
  const timestamp = persistedHistoryTimestamp(item);
  return tools.length > 0
    ? { type: "tool_group", tools, ...(timestamp === undefined ? {} : { timestamp }) }
    : undefined;
}

function persistedHistoryTimestamp(
  item: HistoryItem | CreatableHistoryItem,
): number | undefined {
  return item.timestamp !== undefined && Number.isFinite(item.timestamp) && item.timestamp >= 0
    ? item.timestamp
    : undefined;
}

function toPersistedUiHistoryItem(
  item: HistoryItem | CreatableHistoryItem,
): KodaXSessionUiHistoryItem | undefined {
  if (item.type === "tool_group") {
    return toPersistedToolGroup(item);
  }

  const text = "text" in item && typeof item.text === "string" ? item.text.trimEnd() : "";
  if (!text) {
    return undefined;
  }

  // Sidecar items encode verdict/delivery into the icon slot so the existing
  // KodaXSessionUiTextHistoryItem shape requires no extra fields.
  if (item.type === "sidecar") {
    const verdictIcon = item.delivery === "budget-exhausted"
      ? "budget-exhausted"
      : item.verdict ?? "revise";
    const timestamp = persistedHistoryTimestamp(item);
    return {
      type: "sidecar",
      text,
      icon: verdictIcon,
      ...(timestamp === undefined ? {} : { timestamp }),
    };
  }

  const icon = "icon" in item && typeof item.icon === "string" && item.icon.length > 0
    ? item.icon
    : undefined;
  const compactText = "compactText" in item && typeof item.compactText === "string" && item.compactText.length > 0
    ? item.compactText.trimEnd()
    : undefined;
  const timestamp = persistedHistoryTimestamp(item);

  return {
    type: item.type,
    text,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(icon ? { icon } : {}),
    ...(compactText ? { compactText } : {}),
  };
}

// v0.7.38 (2026-05-11) — opt-in flag for the legacy harness-lifecycle
// markers that used to appear in the transcript ("AMA H0 - Task
// completed", "[Scout] Completion marked uncertain — signals: ...").
// Default OFF: the markers are suppressed so the transcript reads like
// a continuous chat (parity with Claude Code, which has no equivalent
// markers). The underlying harness — Scout/Worker/Evaluator routing,
// idle-yield, mutation guard, capability sections, message queue,
// child registry — is unchanged; only the visualization layer in the
// transcript is affected. Set `KODAX_TRANSCRIPT_HARNESS_MARKERS=1` to
// restore the legacy persistence (useful when debugging session
// replays where you want explicit turn-boundary anchors).
const TRANSCRIPT_HARNESS_MARKERS_ENABLED =
  process.env.KODAX_TRANSCRIPT_HARNESS_MARKERS === '1';

// FEATURE_214 (v0.7.46) — React-bypass fullscreen scroll. Opt-in via
// `KODAX_SCROLL_OVERSCAN=1`. The bypass kills the per-wheel-tick React re-window
// (the 1-3fps stall) by translating within an overscan block, but it leans on the
// DECSTBM hardware scroll — which Windows ConPTY mis-renders, leaving ghost cells
// (错行). NOT default-on until that's resolved: validate `OVERSCAN=1` together
// with `KODAX_SCROLL_DECSTBM=0` (bypass repaints the window directly instead of
// hardware-scrolling — still no React re-render, but no ConPTY ghosting) before
// flipping this default.
const FULLSCREEN_SCROLL_OVERSCAN_ROWS =
  process.env.KODAX_SCROLL_OVERSCAN === '1' ? OVERSCAN_ROWS : undefined;

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
  compactionInfo,
}) => {
  const theme = getTheme("dark");
  const model = config.model ?? getProviderModel(config.provider) ?? config.provider;
  const reasoningEffortLabel = formatReasoningEffortStatusLabel({
    provider: config.provider,
    model: config.model,
    effort: config.effort,
    effortOverride: config.effortOverride,
    thinking: config.thinking,
    reasoningMode: config.reasoningMode,
  });

  // Compute compaction display values
  const ctxK = compactionInfo ? Math.round(compactionInfo.contextWindow / 1000) : 0;
  const compactionPolicy = compactionInfo
    ? formatCompactionPolicy(
        compactionInfo.contextWindow,
        compactionInfo.triggerPercent,
        compactionInfo.triggerTokens,
      )
    : undefined;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Logo */}
      {KODAX_BANNER_LOGO_LINES.map((line, i) => (
        <Text key={i} color={theme.colors.primary}>
          {line}
        </Text>
      ))}

      {/* Tagline — cyan gutter, ties to the logo */}
      <Box>
        <Text color={theme.colors.primary}>{"  ▎ "}</Text>
        <Text color={theme.colors.primary}>{"AI Coding Agent · Minimalist & Intelligent"}</Text>
      </Box>

      {/* Version · Provider · Mode — green gutter */}
      <Box>
        <Text color={theme.colors.success}>{"  ▎ "}</Text>
        <Text bold color={theme.colors.text}>{"v"}{KODAX_VERSION}</Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text color={theme.colors.success}>{config.provider}/{model}</Text>
        <Text dimColor>{`  ·  effort:${reasoningEffortLabel}`}</Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text color={theme.colors.primary}>{config.agentMode.toUpperCase()}</Text>
        <Text dimColor>{" / "}</Text>
        <Text color={theme.colors.accent}>{config.permissionMode}</Text>
      </Box>

      {/* Compaction — amber gutter */}
      {compactionInfo && (
        <Box>
          <Text color={theme.colors.accent}>{"  ▎ "}</Text>
          <Text color={theme.colors.text}>{`ctx ${ctxK}k  ·  compaction `}</Text>
          <Text color={compactionInfo.enabled ? theme.colors.success : theme.colors.text}>
            {compactionInfo.enabled ? "on" : "off"}
          </Text>
          <Text color={theme.colors.text}>{` · ${compactionPolicy}`}</Text>
        </Box>
      )}

      {/* Session — violet gutter */}
      <Box>
        <Text color={theme.colors.secondary}>{"  ▎ "}</Text>
        <Text color={theme.colors.text}>{"session "}</Text>
        <Text color={theme.colors.primary}>{sessionId}</Text>
        <Text color={theme.colors.text}>{"  ·  "}</Text>
        <Text color={theme.colors.text}>{workingDir}</Text>
      </Box>
    </Box>
  );
};

function buildBannerTranscriptSection(props: BannerProps): TranscriptSection {
  const model = props.config.model ?? getProviderModel(props.config.provider) ?? props.config.provider;
  const reasoningEffortLabel = formatReasoningEffortStatusLabel({
    provider: props.config.provider,
    model: props.config.model,
    effort: props.config.effort,
    effortOverride: props.config.effortOverride,
    thinking: props.config.thinking,
    reasoningMode: props.config.reasoningMode,
  });
  const ctxK = props.compactionInfo ? Math.round(props.compactionInfo.contextWindow / 1000) : 0;
  const compactionPolicy = props.compactionInfo
    ? formatCompactionPolicy(
        props.compactionInfo.contextWindow,
        props.compactionInfo.triggerPercent,
        props.compactionInfo.triggerTokens,
      )
    : undefined;
  const taglineLine = "  ▎ AI Coding Agent · Minimalist & Intelligent";
  const versionLine = `  ▎ v${KODAX_VERSION}  ·  ${props.config.provider}/${model}  ·  effort:${reasoningEffortLabel}  ·  ${props.config.agentMode.toUpperCase()} / ${props.config.permissionMode}`;
  const compactionLine = props.compactionInfo
    ? `  ▎ ctx ${ctxK}k  ·  compaction ${props.compactionInfo.enabled ? "on" : "off"} · ${compactionPolicy}`
    : undefined;
  const sessionLine = `  ▎ session ${props.sessionId}  ·  ${props.workingDir}`;
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
  pushLineRows("banner-tagline", taglineLine, { color: "primary" });
  pushLineRows("banner-version", versionLine, { color: "text", bold: true });
  if (compactionLine) {
    pushLineRows("banner-compaction", compactionLine, { color: "text" });
  }
  pushLineRows("banner-session", sessionLine, { color: "text" });
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

// FEATURE_214 — inline scrollback ledger. Default ON: the inline prompt commits finalized
// history (banner + completed rounds + stable streaming lines) through the explicit ledger
// + engine commitInlineScrollback, with a bounded live frame. Set KODAX_INLINE_LEDGER=0 to
// fall back to the legacy <Static> path (append-only, no resize/clear/rollback rebuild).
// Only affects INLINE main-screen (KODAX_FULLSCREEN=0 / SSH); fullscreen is unaffected.
const INLINE_LEDGER_ENABLED = process.env.KODAX_INLINE_LEDGER !== "0";

// FEATURE_214 — diagnostic for the rare inline-ledger commit failure (empty render text
// or a thrown commit). Gated on KODAX_INLINE_LEDGER_DEBUG=1 and written to stderr (the
// project's non-console diagnostic path), NOT console.log. The ledger always rebuilds on
// the next change after a failure, so this is a heads-up, not a crash.
function reportInlineLedgerFailure(reason: string, error?: unknown): void {
  if (process.env.KODAX_INLINE_LEDGER_DEBUG !== "1") {
    return;
  }
  emitKodaXDiagnostic({
    source: "repl:inline-ledger",
    level: "debug",
    message: `${reason}; rebuilding on next change.`,
    ...(error !== undefined ? { detail: error } : {}),
  });
}

/**
 * Inner REPL component that uses contexts
 */
const InkREPLInner: React.FC<InkREPLProps> = ({
  options,
  config,
  context,
  startupRuntimeInfo,
  storage,
  autoModeSettings,
  rendererMode,
  fullscreenPolicy,
  onExit,
  compactionInfo,
  autoModeBootstrap,
  setCurrentConfigRef,
  teamModeHandle,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalRows = stdout.rows ?? 24;
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const writeTerminal = useTerminalWrite();
  const { history } = useUIState();

  // Cost tracking — agent sets .current via events.getCostReport, /cost command reads it
  const inkCostReportRef: { current: (() => string) | null } = React.useRef<(() => string) | null>(null);

  // FEATURE_066: Session-scoped denial tracker for permission hardening
  const denialTrackerRef = React.useRef(createDenialTracker());
  // MED-6: `addHistoryItem` bypasses the managed-foreground layering
  // logic. For info-style items (type: 'info') that can fire while a
  // managed worker owns the foreground turn, route through
  // `emitInfoItemToCorrectLayer` instead — see its JSDoc (~L1510) for
  // the hard rule. Plain assistant / tool_group / thinking items are
  // fine to `addHistoryItem` directly.
  const { addHistoryItem, addHistoryItems, clearHistory: clearUIHistory, setSessionId } = useUIActions();
  const historyRef = useRef(history);
  const persistedUiHistoryRef = useRef<KodaXSessionUiHistoryItem[]>(
    serializeUiHistorySnapshot(history),
  );

  useEffect(() => {
    historyRef.current = history;
    persistedUiHistoryRef.current = serializeUiHistorySnapshot(history);
  }, [history]);

  // Reset the memory-diagnostics log once per session so each run starts
  // with a clean file; no-op when KODAX_MEMORY_DIAG is not set.
  useEffect(() => {
    memDiagReset();
  }, []);

  // Issue 121: opportunistically GC the on-disk paste-cache on startup so
  // old `[Pasted text #N]` blobs don't accumulate across restarts. Best-
  // effort — failures log internally and do not block REPL start.
  useEffect(() => {
    void cleanupOldPastes();
  }, []);

  // Get terminal dimensions for fixed layout.
  const terminalWidth = stdout.columns || 80;

  const streamingState = useStreamingState();

  // Mirror live streaming state into a ref so memDiagSnapshot can read it
  // without pulling `streamingState` into callback deps (that would rebuild
  // `persistContextState` / submit handlers on every streaming delta).
  const streamingStateRef = useRef(streamingState);
  useEffect(() => {
    streamingStateRef.current = streamingState;
  }, [streamingState]);
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
    peekPendingInputDelivery,
    shiftPendingInput,
    consumePendingInputs,
  } = useStreamingActions();

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [currentConfig, setCurrentConfig] = useState<CurrentConfig>(config);
  const runtimeEffortResolution = useMemo(
    () => resolveProviderReasoningRuntimeEffort({
      provider: currentConfig.provider,
      model: currentConfig.model,
      effort: currentConfig.effort,
      effortOverride: currentConfig.effortOverride,
      permissionMode: currentConfig.permissionMode,
      planModeEffort: currentConfig.planModeEffort,
      thinking: currentConfig.thinking,
      reasoningMode: currentConfig.reasoningMode,
    }),
    [
      currentConfig.provider,
      currentConfig.model,
      currentConfig.effort,
      currentConfig.effortOverride,
      currentConfig.permissionMode,
      currentConfig.planModeEffort,
      currentConfig.thinking,
      currentConfig.reasoningMode,
    ],
  );
  const configuredEffort = runtimeEffortResolution.configuredEffort;
  const runtimeEffort = runtimeEffortResolution.runtimeEffort;
  const displayedConfig = useMemo<CurrentConfig>(
    () => ({
      ...currentConfig,
      effort: configuredEffort,
    }),
    [currentConfig, configuredEffort],
  );

  // Reactive contextWindow resolution. See
  // `view-models/compaction-info.ts` for the documented cascade — the
  // tests there pin the contract (user override → per-model → startup
  // fallback). Status bar + live banners consume this; the Static top
  // banner is render-once by Ink design and stays at session start.
  const effectiveCompactionInfo = useMemo(
    () => resolveEffectiveCompactionInfo(
      compactionInfo,
      { provider: currentConfig.provider, model: currentConfig.model },
      resolveProvider,
    ),
    [compactionInfo, currentConfig.provider, currentConfig.model],
  );
  const [isRunning, setIsRunning] = useState(true);
  const [showBanner, setShowBanner] = useState(true); // Show banner in Ink UI
  const [submitCounter, setSubmitCounter] = useState(0); // Counter to trigger clear on submit
  const [canQueueFollowUps, setCanQueueFollowUps] = useState(false);
  const [learningSnapshot, setLearningSnapshot] = useState<LearningSurfaceSnapshot | undefined>(undefined);
  const [learningNotices, setLearningNotices] = useState<readonly {
    readonly id: string;
    readonly text: string;
    readonly tone: "warning" | "accent";
  }[]>([]);
  const hasSubmittedQueryRef = useRef(false);
  const dismissLearningRecovery = useCallback(() => {
    hasSubmittedQueryRef.current = true;
    setLearningNotices(dismissLearningRecoveryAfterQuerySubmit);
  }, []);
  const [liveTokenCount, setLiveTokenCount] = useState<number | null>(null); // Live token count for real-time display
  const workflowIntentBoundaryQueueLockedRef = useRef(false);
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
  useEffect(() => {
    const binding = options.learning;
    if (!binding) return undefined;
    let active = true;
    let subscription: ReturnType<LearningBinding['subscribe']> | undefined;
    const refresh = async (): Promise<LearningSurfaceSnapshot> => {
      const snapshot = await binding.getSnapshot();
      if (!active) return snapshot;
      setLearningSnapshot((current) => (
        current !== undefined && current.revision > snapshot.revision ? current : snapshot
      ));
      return snapshot;
    };
    const reportRefreshFailure = (error: unknown): void => {
      emitKodaXDiagnostic({
        source: "repl:learning",
        level: "warn",
        message: "Failed to refresh the Learning Center snapshot.",
        detail: error instanceof Error ? error.message : String(error),
      });
    };
    const onEvent = (event: LearningEvent): void => {
      if (!active) return;
      if (event.kind === "ready" || event.kind === "activated" || event.kind === "attention") {
        const action = event.kind === "ready"
          ? "is ready for review"
          : event.kind === "activated" ? "became active" : "requires attention";
        setLearningNotices((current) => [{
          id: event.eventId,
          text: `A learned ${event.carrier} ${action}: ${event.displayName}  [/learn]`,
          tone: event.kind === "activated" ? "accent" as const : "warning" as const,
        }, ...current.filter((notice) => notice.id !== event.eventId)].slice(0, 2));
      }
      void refresh().catch(reportRefreshFailure);
    };
    void refresh().then((snapshot) => {
      if (!active) return;
      const recovery = formatLearningRecoverySummary(snapshot);
      if (recovery && !hasSubmittedQueryRef.current) {
        const tone: 'warning' | 'accent' = snapshot.attention > 0 || snapshot.ready > 0
          ? 'warning'
          : 'accent';
        setLearningNotices((current) => [{
          id: 'learning-recovery',
          text: recovery,
          tone,
        }, ...current.filter((notice) => notice.id !== 'learning-recovery')].slice(0, 2));
      }
      subscription = binding.subscribe(onEvent, { afterRevision: snapshot.revision });
    }).catch(reportRefreshFailure);
    return () => {
      active = false;
      subscription?.close();
    };
  }, [options.learning]);
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
  const [workflowBuilderMessage, setWorkflowBuilderMessage] = useState<string | null>(null);
  const [workflowLiveStatus, setWorkflowLiveStatus] = useState<WorkflowLiveSnapshot | null>(null);
  const workflowLiveStatusRef = useRef<WorkflowLiveSnapshot | null>(null);
  const replaceWorkflowLiveStatus = useCallback((next: WorkflowLiveSnapshot | null): void => {
    workflowLiveStatusRef.current = next;
    setWorkflowLiveStatus(next);
  }, []);
  const updateWorkflowLiveStatus = useCallback((
    updater: (current: WorkflowLiveSnapshot | null) => WorkflowLiveSnapshot | null,
  ): void => {
    const next = updater(workflowLiveStatusRef.current);
    workflowLiveStatusRef.current = next;
    setWorkflowLiveStatus(next);
  }, []);
  const routeWorkflowLiveOnlyNotice = useCallback((
    meta: KodaXActivityEventMeta | undefined,
    message: string,
  ): boolean => {
    const current = workflowLiveStatusRef.current;
    if (
      current?.status !== "running"
      || !shouldRouteWorkflowLiveOnlyNotice(meta, current.runId)
    ) {
      return false;
    }
    replaceWorkflowLiveStatus({ ...current, message });
    return true;
  }, [replaceWorkflowLiveStatus]);
  // FEATURE_246 (P1 review): single source of truth for applying a workflow run
  // UI event to the live status. Shared by the slash /workflow path AND the
  // model-launched run_workflow path (which arrives via options.events
  // .onWorkflowProcessEvent — see handleInlineWorkflowProcessEvent below).
  const applyWorkflowRunUiEvent = useCallback((
    event: Parameters<NonNullable<CommandCallbacks['onWorkflowRunUpdate']>>[0],
  ): void => {
    if (event.status === "running") {
      replaceWorkflowLiveStatus({
        runId: event.runId,
        workflow: event.workflow,
        status: event.status,
        ...(event.phase !== undefined ? { phase: event.phase } : {}),
        ...(event.phaseIndex !== undefined ? { phaseIndex: event.phaseIndex } : {}),
        ...(event.phaseTotal !== undefined ? { phaseTotal: event.phaseTotal } : {}),
        ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
        ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
        activeAgents: event.activeAgents,
        totalSpawned: event.totalSpawned,
        ...(event.plannedAgents !== undefined ? { plannedAgents: event.plannedAgents } : {}),
        ...(event.agentCap !== undefined ? { agentCap: event.agentCap } : {}),
        ...(event.tokenBudgetSpent !== undefined ? { tokenBudgetSpent: event.tokenBudgetSpent } : {}),
        ...(event.tokenBudgetTotal !== undefined ? { tokenBudgetTotal: event.tokenBudgetTotal } : {}),
        completedAgents: event.completedAgents,
        failedAgents: event.failedAgents,
        stoppedAgents: event.stoppedAgents,
        ...(event.message !== undefined ? { message: event.message } : {}),
        ...(event.locale !== undefined ? { locale: event.locale } : {}),
      });
      return;
    }
    updateWorkflowLiveStatus((current) => (
      current?.runId === event.runId ? null : current
    ));
  }, [replaceWorkflowLiveStatus, updateWorkflowLiveStatus]);
  // FEATURE_246 (P1 review): render live progress for the inline run_workflow
  // path the same way the slash path does. The coding host forwards this run's
  // process events here; convert each to the run-update UI shape and apply it.
  const handleInlineWorkflowProcessEvent = useCallback((event: WorkflowProcessEvent): void => {
    const message = event.type === "workflow_updated" ? event.message : undefined;
    // FEATURE_246 (review B5): detect locale from the run's own text (goal / name /
    // latest message) so a model-launched workflow gets the same zh/en labels the
    // slash path does — instead of a hardcoded 'en' that mislabels CJK workflows.
    const locale = inferWorkflowLocaleFromParts(
      event.snapshot.goal,
      event.snapshot.workflowName,
      event.snapshot.displayName,
      event.snapshot.latestMessage,
      message,
    );
    applyWorkflowRunUiEvent(workflowLiveSnapshotFromProcess(
      event.snapshot,
      message === undefined ? { locale } : { locale, message },
    ));
  }, [applyWorkflowRunUiEvent]);
  // FEATURE_097 (v0.7.34) — todo plan surface state. Single source of
  // truth for the rendered list; the runner-side `onTodoUpdate` handler
  // does `setTodoItems(items)` directly (no managedForegroundLedger
  // round-trip — the list is task-global, not per-worker).
  const [todoItems, setTodoItems] = useState<readonly TodoItem[]>([]);
  // FEATURE_149 (v0.7.38) — derive the spinner's "currentTodoActiveForm"
  // from the first `in_progress` item's `activeForm` field. Mirrors CC's
  // `Spinner.tsx:169` `currentTodo?.activeForm` lookup. The transcript
  // layout uses this string as the spinner's leader verb when present
  // ("Running failing tests..." instead of generic "Thinking..."). The
  // first-match rule matches CC's "one in_progress at a time" convention
  // (the LLM is instructed to keep at most one task active per owner).
  // Memoized BEFORE the transcript render-model memos so `currentTodoActiveForm`
  // is in scope when those memos reference it (no TDZ).
  // FEATURE_151 (v0.7.38) Slice F + v0.7.42 schema split — fallback chain
  // matches CC's `Spinner.tsx:169` behavior: `currentTodo?.activeForm ??
  // currentTodo?.subject ?? randomVerb`. v0.7.42 renamed KodaX's
  // `TodoItem.content` → `subject` for direct CC parity. When the LLM
  // forgets to supply `activeForm` for an `in_progress` item — possible
  // despite role-prompt enforcement — show the imperative subject instead
  // of falling back to a generic random spinner verb. The user gets at
  // least item-level signal ("Run failing tests") rather than a
  // context-free "Working...".
  const currentTodoActiveForm = useMemo<string | undefined>(() => {
    for (const item of todoItems) {
      if (item.status !== "in_progress") continue;
      if (item.activeForm && item.activeForm.length > 0) {
        return item.activeForm;
      }
      if (item.subject && item.subject.length > 0) {
        return item.subject;
      }
    }
    return undefined;
  }, [todoItems]);
  // FEATURE_151 (v0.7.38): the post-completion 5-second linger gate that
  // previously hid the surface after `lastAllCompletedAt + 5s` was removed.
  // The matching React state (`todoLastAllCompletedAt` + setter) was deleted
  // because nothing reads it anymore. The view-model still accepts a
  // `lastAllCompletedAt` field on `BuildTodoPlanOptions` for one release of
  // back-compat with any external embedder that may hand-build the options
  // shape — we just pass `null`.
  const [managedLiveEvents, setManagedLiveEvents] = useState<HistoryItem[]>([]);
  const [managedForegroundTurnItems, setManagedForegroundTurnItems] = useState<HistoryItem[]>([]);
  const [lastLiveActivityLabel, setLastLiveActivityLabel] = useState<string | undefined>(undefined);
  const [visibleWorkStripText, setVisibleWorkStripText] = useState<string | undefined>(undefined);
  const managedTaskStatusRef = useRef<KodaXManagedTaskStatusEvent | null>(null);
  const managedTaskBreadcrumbRef = useRef<string | null>(null);
  const managedLiveEventsRef = useRef<HistoryItem[]>([]);
  const managedRoundEventHistoryRef = useRef<HistoryItem[]>([]);
  const managedForegroundTurnItemsRef = useRef<HistoryItem[]>([]);
  const sidecarMessageDeliveredRef = useRef(false);
  // FEATURE_213 (v0.7.45) — ids of mid-turn user messages already committed to
  // history (by a round-end / fresh-submit / interrupt commit). The ledger-wipe
  // rescue pass uses this to commit any UNcommitted mid-turn user message before
  // a premature clear loses it, without double-adding ones already committed.
  const committedMidTurnUserIdsRef = useRef<Set<string>>(new Set());
  const managedForegroundOwnerRef = useRef<{ workerId?: string; workerTitle?: string }>({});
  const managedForegroundLedgerRef = useRef<ManagedForegroundLedgerState>({
    activeToolGroupTools: [],
  });
  const outputSegmentProjectionRef = useRef<KodaXOutputSegmentProjection>(
    createOutputSegmentProjection(),
  );
  const managedOutputSegmentItemsRef = useRef<{
    providerRequestId?: string;
    assistantItemId?: string;
    thinkingItemId?: string;
  }>({});
  const managedForegroundItemSeqRef = useRef(0);

  // === Foreground text buffer (O(n²) → O(n) fix) ===
  // Instead of calling updateManagedForegroundLedgerItem on every streaming delta
  // (which copies the full items array each time), accumulate text in a mutable ref
  // and flush to React state at 80ms intervals — matching StreamingContext's flush cycle.
  // Reference: Claude Code uses ref-based accumulation + lazy serialization;
  // pi-mono uses rAF batching; opencode uses 16ms frame + 100ms render throttle.
  const foregroundTextBufferRef = useRef<{
    itemId: string | undefined;
    kind: "thinking" | "assistant";
    pendingText: string;
  }>({ itemId: undefined, kind: "thinking", pendingText: "" });
  const foregroundFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // FEATURE_201 (v0.7.45) Phase A set this to 16ms (60fps); FEATURE_212
  // (v0.7.45) reverted it to 80ms. The 16ms cadence multiplied a per-frame
  // cost that scales with history length (each re-render re-resolved the full
  // transcript surface), so on long sessions it dropped the whole UI's frame
  // rate. 80ms was the proven-good value; smoothness at 60fps is only safe once
  // per-frame work is O(1) — see the memoization fixes in this feature.
  const FOREGROUND_FLUSH_INTERVAL = 80;
  // Issue 079: Limit visible history to last 20 conversation rounds
  // A "round" = one user input + AI response(s)
  // Full history remains in state, only rendering is limited
  const MAX_VISIBLE_ROUNDS = 20;
  // FEATURE_060 Tier 2 (v0.7.30): UUID-anchored 200-item hard cap on the
  // historical transcript items consumed by the prompt + transcript
  // surfaces. Round-based capping (`MAX_VISIBLE_ROUNDS = 20`) is a UX
  // choice; this is a perf safety net that prevents `kodax -c` resume of
  // a long session from blasting all N items into Ink's `<Static>` block
  // on first paint. Anchor survives id churn from collapse/regrouping
  // (`computeTranscriptCapStart` falls back to stored idx when id is
  // gone, mirroring CC-1174).
  const transcriptCapAnchorRef = useRef<TranscriptCapAnchor>(null);
  const fullDisplayHistory = useMemo(
    () => [...history, ...managedForegroundTurnItems],
    [history, managedForegroundTurnItems],
  );
  const displayHistory = useMemo(() => {
    const start = computeTranscriptCapStart(
      fullDisplayHistory,
      transcriptCapAnchorRef,
      transcriptRenderCapForHistory(fullDisplayHistory),
    );
    return start === 0 ? fullDisplayHistory : fullDisplayHistory.slice(start);
  }, [fullDisplayHistory]);
  // FEATURE_060 Tier 2 v0.7.40 follow-up — `useDeferredValue(displayHistory)`
  // disabled (replaced with direct passthrough). Root-cause hypothesis: on
  // Windows/ConPTY under Node.js + Ink (react-reconciler without DOM idle
  // scheduling), the low-priority React track NEVER gets to flush during
  // heavy agent execution. Each spinner tick + streaming-state update is
  // a high-priority React update, perpetually starving the deferred work.
  // User-visible symptom: during agent run, transcript items (user query,
  // thinking blocks, assistant text, tool calls) stay invisible while
  // spinner + status bar + TodoListSurface render normally; all items
  // "pop in" at task end when setIsLoading(false) forces a re-render.
  //
  // The other two FEATURE_060 Tier 2 optimizations remain intact:
  //   1. UUID-anchored 200-item cap in `displayHistory`        (line 1626)
  //   3. Transcript-mode 30-message visible cap                (line 2565)
  // These already bound the per-render cost to O(min(N, 200)) for the
  // 200-cap path and O(min(N, 30)) for transcript-mode — so removing the
  // useDeferredValue indirection (mid-frame interruptibility) should NOT
  // bring back the original SSH-resume lag that FEATURE_060 Tier 2 fixed.
  //
  // Trade-off accepted: long-session `kodax -c` resume on Windows-SSH may
  // see a one-time first-paint lag of ~10-50ms. Single-event, recoverable.
  // Compared to "transcript invisible during every agent run" (user-
  // reported P0), this is strictly better.
  //
  // If a future repro shows the resume regression returns, switch to a
  // length-thresholded variant:
  //   const lazyDeferred = useDeferredValue(displayHistory);
  //   const deferredDisplayHistory = displayHistory.length > 100
  //     ? lazyDeferred : displayHistory;
  const deferredDisplayHistory = displayHistory;
  const renderHistory = useMemo(() => {
    return sliceHistoryToRecentRounds(deferredDisplayHistory, MAX_VISIBLE_ROUNDS);
  }, [deferredDisplayHistory]);
  const transcriptHistory = deferredDisplayHistory;
  const showWorkStripTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hideWorkStripTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const iterationToolsRef = useRef<string[]>([]);
  const iterationToolCallsRef = useRef<ToolCall[]>([]);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCall[]>([]);
  const activeToolCallsRef = useRef<ToolCall[]>([]);
  const [childActivityRecords, setChildActivityRecords] = useState<ChildActivityRecord[]>([]);
  const childActivityRecordsRef = useRef<ChildActivityRecord[]>([]);

  const setLiveToolCalls = useCallback((nextToolCalls: ToolCall[]) => {
    activeToolCallsRef.current = nextToolCalls;
    setActiveToolCalls(nextToolCalls);
  }, []);

  const setChildActivityRecordState = useCallback((nextRecords: ChildActivityRecord[]) => {
    childActivityRecordsRef.current = nextRecords;
    setChildActivityRecords(nextRecords);
  }, []);

  const clearChildActivityRecords = useCallback(() => {
    setChildActivityRecordState([]);
  }, [setChildActivityRecordState]);

  const completeChildActivityRecord = useCallback((
    meta: KodaXActivityEventMeta | undefined,
  ): boolean => {
    if (!shouldRouteToChildActivity(meta)) {
      return false;
    }
    const id = childActivityId(meta);
    const nextRecords = childActivityRecordsRef.current.filter((record) => record.id !== id);
    if (nextRecords.length === childActivityRecordsRef.current.length) {
      return true;
    }
    setChildActivityRecordState(nextRecords);
    return true;
  }, [setChildActivityRecordState]);

  const upsertChildActivityRecord = useCallback((
    meta: KodaXActivityEventMeta | undefined,
    kind: ChildActivityKind,
    detail: string,
    options?: {
      readonly append?: boolean;
      readonly skipIfExisting?: boolean;
    },
  ): boolean => {
    if (!shouldRouteToChildActivity(meta)) {
      return false;
    }
    const id = childActivityId(meta);
    const existing = childActivityRecordsRef.current.find((record) => record.id === id);
    if (options?.skipIfExisting && existing?.kind === kind) {
      return true;
    }
    // Tool-action priority: once a child shows a concrete tool action, keep that
    // stable "Grep …/Read …" line until the next tool call rather than letting the
    // churny thinking/assistant/stream token flow overwrite it. Zero extra cost —
    // the tool detail already flowed through `toolActivityDetail`.
    if (suppressesChurnOverToolAction(existing?.kind, kind)) {
      return true;
    }
    const nextDetail = options?.append && existing?.kind === kind
      ? `${existing.detail}${detail}`
      : detail || existing?.detail || "running";
    const nextRecord: ChildActivityRecord = {
      id,
      label: childActivityLabel(meta),
      source: childActivitySource(meta),
      status: "running",
      kind,
      detail: truncateChildActivityDetail(nextDetail),
      // Preserve the first-seen time so each row shows its own elapsed.
      startedAt: existing?.startedAt ?? Date.now(),
    };
    const currentRecords = childActivityRecordsRef.current;
    const existingIndex = currentRecords.findIndex((record) => record.id === id);
    const nextRecords = existingIndex >= 0
      ? currentRecords.map((record, index) => (index === existingIndex ? nextRecord : record))
      : [...currentRecords, nextRecord].slice(0, CHILD_ACTIVITY_MAX_RECORDS);
    setChildActivityRecordState(nextRecords);
    return true;
  }, [setChildActivityRecordState]);

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
    // Issue 130: preserve the tool_group reference + FULL tools list (not
    // just Executing) when any entry is still in flight. See the matching
    // comment in `transitionManagedForegroundPhase` for why filtering
    // `activeToolGroupTools` to Executing would corrupt the history item
    // on the next in-place update. The iteration-boundary call site (L5615)
    // pairs with this for the liveToolCalls / iterationToolCallsRef layers.
    const hasExecutingInGroup = current.activeToolGroupTools.some(
      (t) => t.status === ToolCallStatus.Executing,
    );
    managedForegroundLedgerRef.current = {
      ...(options?.clearOwner
        ? {}
        : {
            workerId: current.workerId,
            workerTitle: current.workerTitle,
          }),
      ...(hasExecutingInGroup
        ? {
            activeToolGroupItemId: current.activeToolGroupItemId,
            activeToolGroupTools: current.activeToolGroupTools,
          }
        : { activeToolGroupTools: [] }),
    };
    if (options?.clearOwner) {
      managedForegroundOwnerRef.current = {};
    }
  }, []);

  // FEATURE_213 (v0.7.45) — mark a batch of just-committed ledger items so the
  // ledger-wipe rescue pass does not re-add their (mid-turn user) entries.
  const markLedgerUserItemsCommitted = useCallback((items: readonly HistoryItem[]) => {
    for (const item of items) {
      if (item.type === "user" && typeof item.id === "string") {
        committedMidTurnUserIdsRef.current.add(item.id);
      }
    }
  }, []);

  const clearManagedForegroundTurnHistory = useCallback(() => {
    // Clear text buffer to prevent stale flushes after clear
    foregroundTextBufferRef.current = { itemId: undefined, kind: "thinking", pendingText: "" };
    if (foregroundFlushTimerRef.current) {
      clearTimeout(foregroundFlushTimerRef.current);
      foregroundFlushTimerRef.current = null;
    }
    // FEATURE_213 (v0.7.45) — rescue any mid-turn user message that has NOT yet
    // been committed to history before wiping the ledger. Without this, a clear
    // that fires before the round-end commit (the bug: a queued query typed
    // while waiting for a sub-agent) silently drops the user's message. Deduped
    // by id via `committedMidTurnUserIdsRef`, so the post-commit clear (which
    // follows a real round-end commit that already marked these ids) is a no-op
    // here and never double-adds.
    const pendingUserItems = selectUncommittedLedgerUserItems(
      managedForegroundTurnItemsRef.current,
      committedMidTurnUserIdsRef.current,
    );
    if (pendingUserItems.length > 0) {
      for (const item of pendingUserItems) {
        committedMidTurnUserIdsRef.current.add(item.id as string);
      }
      appendHistoryItemsWithPersistenceRef.current?.(
        pendingUserItems.map((item) => toCreatableHistoryItem(item)),
      );
    }
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

  /**
   * Route an info history item to the correct layer. When a managed
   * worker is active the main history renders ABOVE the managed
   * foreground turn, so any `addHistoryItem` during that window pins
   * the info near the user prompt instead of appearing inline with
   * the current worker output. This helper mirrors the fix applied to
   * `recordConfirmResult` (63330bc), `onProviderRecovery` (09cd7ae),
   * and `onRetry` — and extends it to the remaining info callbacks
   * (`onCompact`, `onProviderRateLimit`, `onScoutSuspiciousCompletion`).
   *
   * Callers: anything that can fire while a managed worker owns the
   * foreground turn AND produces an info-line history entry. Items
   * that land at round boundaries (e.g. "No response text produced")
   * are NOT candidates — by that point the managed foreground is
   * already cleared.
   *
   * --------------------------------------------------------------
   * HARD RULE (MED-6):
   *
   * Any info-style history item emitted while
   * `managedForegroundOwnerRef.current.workerId != null` MUST go
   * through this helper. Do NOT add new
   * `addHistoryItem({ type: 'info', ... })` call sites that can
   * fire during managed foreground without first reading this rule.
   *
   * Confirmed routed sources (keep in sync when adding new ones):
   *   - onCompact / onProviderRateLimit /
   *     onScoutSuspiciousCompletion (107bcb2)
   *   - queue-limit info (a829d0b)
   *   - retry / provider-recovery / confirm-result
   *     (63330bc / 09cd7ae / pre-existing)
   *
   * Violating this rule resurfaces the "info squeezed under user
   * prompt instead of inline with worker output" bug; grep reviewers
   * should flag any new `addHistoryItem({ type: 'info' })` sites
   * that could fire mid-worker-turn.
   * --------------------------------------------------------------
   */
  const emitInfoItemToCorrectLayer = useCallback((
    item: { type: "info"; text: string; icon?: string; tightSpacing?: boolean },
    tag: string,
  ): void => {
    if (managedForegroundOwnerRef.current.workerId) {
      appendManagedForegroundLedgerItem({
        id: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: item.type,
        text: item.text,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.tightSpacing ? { tightSpacing: true } : {}),
        timestamp: Date.now(),
      } as HistoryItem);
    } else {
      addHistoryItem(item);
    }
  }, [addHistoryItem, appendManagedForegroundLedgerItem]);

  /**
   * Emit a sidecar verifier history item to the correct transcript layer.
   * Follows the same foreground-layering rule as emitInfoItemToCorrectLayer:
   * if a managed worker currently owns the foreground, append to that ledger
   * so the sidecar message renders inline with the worker output.
   */
  const emitSidecarItemToCorrectLayer = useCallback((
    item: { type: "sidecar"; text: string; verdict?: "revise" | "blocked"; delivery?: "budget-exhausted" },
    tag: string,
  ): void => {
    const ts = Date.now();
    if (managedForegroundOwnerRef.current.workerId) {
      appendManagedForegroundLedgerItem({
        id: `${tag}-${ts}-${Math.random().toString(36).slice(2, 7)}`,
        type: "sidecar",
        text: item.text,
        ...(item.verdict ? { verdict: item.verdict } : {}),
        ...(item.delivery ? { delivery: item.delivery } : {}),
        timestamp: ts,
      } as HistoryItem);
    } else {
      addHistoryItem(item);
    }
  }, [addHistoryItem, appendManagedForegroundLedgerItem]);

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

    // Issue: When switching away from tool_group to thinking/assistant,
    // preserve the tool_group references if tools are still executing.
    // Otherwise the tool_group item becomes orphaned and a duplicate is
    // created when the tool result arrives.
    const hasExecutingTools = currentLedger.activeToolGroupTools.some(
      (t) => t.status === ToolCallStatus.Executing,
    );

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
        // FEATURE_184 v0.7.42 follow-up — record this id as the
        // turn-scoped thinking target. We only get here when creating
        // a NEW thinking item (the same-kind reuse path returned
        // early above), so this naturally tracks the first thinking
        // item of each new thinking phase. The id survives the
        // `activeThinkingItemId: undefined` reset that happens when
        // text streaming starts, so `onThinkingEnd` can find it.
        currentTurnThinkingItemId: itemId,
        activeAssistantItemId: undefined,
        ...(hasExecutingTools ? {} : {
          activeToolGroupItemId: undefined,
          activeToolGroupTools: [],
        }),
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
        ...(hasExecutingTools ? {} : {
          activeToolGroupItemId: undefined,
          activeToolGroupTools: [],
        }),
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

  // Flush buffered text to a single foreground item update.
  // Collapses N delta appends into 1 array copy + setState.
  const flushForegroundTextBuffer = useCallback(() => {
    if (foregroundFlushTimerRef.current) {
      clearTimeout(foregroundFlushTimerRef.current);
      foregroundFlushTimerRef.current = null;
    }
    const buf = foregroundTextBufferRef.current;
    if (!buf.pendingText || !buf.itemId) {
      return;
    }
    const text = buf.pendingText;
    const itemId = buf.itemId;
    const kind = buf.kind;
    buf.pendingText = "";
    updateManagedForegroundLedgerItem(itemId, (item) => {
      if (item.type !== kind) return item;
      return { ...item, text: `${item.text}${text}` };
    });
  }, [updateManagedForegroundLedgerItem]);

  const scheduleForegroundFlush = useCallback(() => {
    if (!foregroundFlushTimerRef.current) {
      foregroundFlushTimerRef.current = setTimeout(flushForegroundTextBuffer, FOREGROUND_FLUSH_INTERVAL);
    }
  }, [flushForegroundTextBuffer]);

  const appendManagedForegroundTextBlock = useCallback((
    kind: "thinking" | "assistant",
    text: string,
  ) => {
    if (!text) {
      return;
    }
    const currentLedger = managedForegroundLedgerRef.current;
    if (
      kind === "assistant"
      && !shouldAppendManagedAssistantTextDelta(
        text,
        currentLedger.activeKind === "assistant" && Boolean(currentLedger.activeAssistantItemId),
      )
    ) {
      return;
    }
    const workerTitle = currentLedger.workerTitle;
    const itemId = startManagedForegroundLedgerBlock(kind, workerTitle);

    const buf = foregroundTextBufferRef.current;
    if (buf.itemId === itemId && buf.kind === kind) {
      // Same item — accumulate in buffer (O(1), no array copy)
      buf.pendingText += text;
    } else {
      // Different item — flush old buffer, start new accumulation
      flushForegroundTextBuffer();
      buf.itemId = itemId;
      buf.kind = kind;
      buf.pendingText = text;
    }
    scheduleForegroundFlush();
  }, [startManagedForegroundLedgerBlock, flushForegroundTextBuffer, scheduleForegroundFlush]);

  const beginOutputSegment = useCallback((
    segment: KodaXOutputSegmentStarted,
  ): void => {
    outputSegmentProjectionRef.current = applyDistinctOutputSegmentStart(
      outputSegmentProjectionRef.current,
      segment,
      (nextProjection) => {
        if (managedForegroundOwnerRef.current.workerId) {
          flushForegroundTextBuffer();
          const previousItems = managedOutputSegmentItemsRef.current;
          if (segment.mode === "replace") {
            mutateManagedForegroundTurnHistory((items) =>
              discardReplacedOutputSegmentItems(
                items,
                [previousItems.assistantItemId, previousItems.thinkingItemId],
                segment.mode,
              ),
            );
          }
          const ledger = managedForegroundLedgerRef.current;
          managedForegroundLedgerRef.current = {
            ...ledger,
            activeKind: ledger.activeKind === "tool_group" ? "tool_group" : undefined,
            activeAssistantItemId: undefined,
            activeThinkingItemId: undefined,
            currentTurnThinkingItemId: undefined,
          };
          foregroundTextBufferRef.current = {
            itemId: undefined,
            kind: "thinking",
            pendingText: "",
          };
          managedOutputSegmentItemsRef.current = {
            providerRequestId: segment.providerRequestId,
          };
          return;
        }

        clearResponse();
        clearThinkingContent();
        const assistantText = effectiveOutputSegmentText(nextProjection, "assistant");
        const thinkingText = effectiveOutputSegmentText(nextProjection, "thinking");
        if (assistantText) appendResponse(assistantText);
        if (thinkingText) {
          startThinking();
          appendThinkingChars(thinkingText.length);
          appendThinkingContent(thinkingText);
        }
      },
    );
  }, [
    appendResponse,
    appendThinkingChars,
    appendThinkingContent,
    clearResponse,
    clearThinkingContent,
    flushForegroundTextBuffer,
    mutateManagedForegroundTurnHistory,
    startThinking,
  ]);

  const syncManagedForegroundThinkingBlock = useCallback((thinking: string) => {
    const normalizedThinking = thinking.trim();
    if (!normalizedThinking) {
      return;
    }
    // This is a full replacement (onThinkingEnd) — discard any pending buffer
    // for thinking blocks to prevent stale text from being flushed after replacement.
    const buf = foregroundTextBufferRef.current;
    if (buf.kind === "thinking" && buf.pendingText) {
      buf.pendingText = "";
      if (foregroundFlushTimerRef.current) {
        clearTimeout(foregroundFlushTimerRef.current);
        foregroundFlushTimerRef.current = null;
      }
    }
    const workerTitle = managedForegroundLedgerRef.current.workerTitle?.trim();
    const nextText = workerTitle
      ? `[${workerTitle}] ${normalizedThinking}`
      : normalizedThinking;
    // FEATURE_184 v0.7.42 follow-up — `onThinkingEnd` fires AFTER the
    // text-streaming phase (provider streams `reasoning_content` first,
    // then `content`, then finalizes). By that point `activeKind` has
    // flipped to "assistant" and `activeThinkingItemId` has been
    // cleared — so the old code called `startManagedForegroundLedger-
    // Block("thinking", ...)`, which would CREATE A NEW thinking item
    // and append it AFTER the assistant text. The user-visible bug
    // was a duplicate "Thinking" block surfaced below the answer.
    //
    // Fix: target `currentTurnThinkingItemId` (the turn-scoped id
    // recorded when the first thinking item was created earlier in
    // this turn) and update it in place. Fallback to the standard
    // ledger-block path only when no thinking item exists this turn
    // — vanishingly rare (`onThinkingEnd` without a prior
    // `onThinkingDelta`), but covered for completeness.
    const existingTurnThinkingId = managedForegroundLedgerRef.current.currentTurnThinkingItemId;
    if (existingTurnThinkingId) {
      updateManagedForegroundLedgerItem(existingTurnThinkingId, (item) => (
        item.type === "thinking"
          ? { ...item, text: nextText }
          : item
      ));
      return;
    }
    const itemId = startManagedForegroundLedgerBlock("thinking", managedForegroundLedgerRef.current.workerTitle);
    updateManagedForegroundLedgerItem(itemId, (item) => (
      item.type === "thinking"
        ? { ...item, text: nextText }
        : item
    ));
  }, [startManagedForegroundLedgerBlock, updateManagedForegroundLedgerItem]);

  const syncManagedForegroundToolGroup = useCallback((toolCall: ToolCall) => {
    // Flush any pending text buffer before tool group updates, so the array
    // copy includes the latest accumulated thinking/assistant text.
    flushForegroundTextBuffer();

    const currentLedger = managedForegroundLedgerRef.current;

    // === Tier 1 — Fast path (ref-based): tool already lives in the
    // currently-tracked active tool_group's refs. Covers:
    //   - same-group delta/result update (most common case)
    //   - Issue 115: kind transition (tool_group → thinking) with
    //     preserved refs — toolCall.id still in activeToolGroupTools
    //   - Issue 130: phase/iteration transition with preserved refs
    //     (when no new worker has yet stomped on the active slot)
    // The original L1962 guard was guarded by `activeKind !== "tool_group"`
    // to avoid colliding with the same-group fallthrough; the unified
    // fast path drops that condition because matching by ID is enough.
    if (
      currentLedger.activeToolGroupItemId
      && currentLedger.activeToolGroupTools.some((t) => t.id === toolCall.id)
    ) {
      const nextTools = currentLedger.activeToolGroupTools.map((t) => (
        t.id === toolCall.id ? toolCall : t
      ));
      const allResolved = nextTools.every((t) => (
        t.status === ToolCallStatus.Success
        || t.status === ToolCallStatus.Error
        || t.status === ToolCallStatus.Cancelled
      ));
      managedForegroundLedgerRef.current = {
        ...currentLedger,
        ...(allResolved
          ? { activeToolGroupItemId: undefined, activeToolGroupTools: [] }
          : { activeToolGroupTools: nextTools }
        ),
      };
      updateManagedForegroundLedgerItem(currentLedger.activeToolGroupItemId, (item) => (
        item.type === "tool_group" ? { ...item, tools: nextTools } : item
      ));
      return;
    }

    // === Tier 2 — Orphan history-search (Issue 130 EC1): tool is NOT in
    // the active group's refs (a new worker has stomped on the active
    // slot, OR ref preservation was bypassed). Search foreground turn
    // history backwards for the tool_group that originally owned this
    // tool ID and update it in place. Decouples orphan recovery from
    // the single-slot ref tracker so multi-slot tracking isn't needed.
    // O(m) on managedForegroundTurnItemsRef.current; bounded per-turn
    // (<100 items in practice). The reverse iteration biases the
    // search toward the most recent groups, which is where orphans
    // most often live in normal sequencing.
    const historyItems = managedForegroundTurnItemsRef.current;
    for (let i = historyItems.length - 1; i >= 0; i -= 1) {
      const item = historyItems[i];
      if (item.type !== "tool_group") continue;
      if (!item.tools.some((t) => t.id === toolCall.id)) continue;
      const nextTools = item.tools.map((t) => (
        t.id === toolCall.id ? toolCall : t
      ));
      updateManagedForegroundLedgerItem(item.id, (existing) => (
        existing.type === "tool_group" ? { ...existing, tools: nextTools } : existing
      ));
      return;
    }

    // === Tier 3 — Create / extend: tool is brand new. Get the active
    // tool_group (creating one if needed) and add the tool.
    //
    // Issue 130 bugfix: when `startManagedForegroundLedgerBlock` returns
    // a NEWLY-created itemId (e.g. activeKind was undefined after a
    // phase transition), nextTools must be `[toolCall]` only. The
    // pre-fix code unconditionally did `[...currentLedger.activeToolGroupTools,
    // toolCall]`, which leaks preserved orphan tools (e.g. V1 from
    // the previous worker) into the new group's history. The reuse
    // gate below ensures the carry-over only happens when we're truly
    // extending the same active group (typical parallel tool case).
    const itemId = startManagedForegroundLedgerBlock("tool_group", currentLedger.workerTitle);
    const isReuseOfActiveGroup = currentLedger.activeKind === "tool_group"
      && currentLedger.activeToolGroupItemId === itemId;
    const nextTools = isReuseOfActiveGroup
      ? (currentLedger.activeToolGroupTools.some((existing) => existing.id === toolCall.id)
          ? currentLedger.activeToolGroupTools.map((existing) => (
              existing.id === toolCall.id ? toolCall : existing
            ))
          : [...currentLedger.activeToolGroupTools, toolCall])
      : [toolCall];
    managedForegroundLedgerRef.current = {
      ...managedForegroundLedgerRef.current,
      activeKind: "tool_group",
      activeToolGroupItemId: itemId,
      activeToolGroupTools: nextTools,
    };
    updateManagedForegroundLedgerItem(itemId, (item) => (
      item.type === "tool_group" ? { ...item, tools: nextTools } : item
    ));
  }, [startManagedForegroundLedgerBlock, updateManagedForegroundLedgerItem, flushForegroundTextBuffer]);

  const transitionManagedForegroundPhase = useCallback((nextWorker?: {
    workerId?: string;
    workerTitle?: string;
  }) => {
    // Flush any pending text before phase transition to avoid losing content
    flushForegroundTextBuffer();
    // Issue 130: when a phase transition fires while a previous worker's tool
    // is still Executing (e.g. emit_verdict between observer.onRoleEmit and
    // events.onToolResult), preserve the tool_group reference + tools across
    // the reset so the late-arriving tool_result event can be routed back
    // to its original tool_group history item via the L1962 in-place-update
    // guard. Clearing them outright (pre-fix) leaves the entry stuck at
    // `running` forever — see Issue 115 for the kind-transition variant.
    //
    // Critical: `activeToolGroupTools` is the FULL snapshot of the group
    // (including already-terminal entries), not just Executing. The L1991
    // `.map()` in-place update reuses this list verbatim — if we filtered
    // to Executing only, a later result event would overwrite history with
    // ONLY the executing entries, dropping ✓ tools from the displayed group.
    // So we preserve the whole list when ANY entry is still Executing.
    const prevLedger = managedForegroundLedgerRef.current;
    const hasExecutingInGroup = prevLedger.activeToolGroupTools.some(
      (t) => t.status === ToolCallStatus.Executing,
    );
    const executingLiveTools = activeToolCallsRef.current.filter(
      (t) => t.status === ToolCallStatus.Executing,
    );
    const executingLiveIds = new Set(executingLiveTools.map((t) => t.id));
    managedForegroundLedgerRef.current = {
      workerId: nextWorker?.workerId,
      workerTitle: nextWorker?.workerTitle,
      ...(hasExecutingInGroup
        ? {
            activeToolGroupItemId: prevLedger.activeToolGroupItemId,
            activeToolGroupTools: prevLedger.activeToolGroupTools,
          }
        : { activeToolGroupTools: [] }),
    };
    managedForegroundOwnerRef.current = {
      workerId: nextWorker?.workerId,
      workerTitle: nextWorker?.workerTitle,
    };
    iterationToolsRef.current = [];
    iterationToolCallsRef.current = iterationToolCallsRef.current.filter(
      (t) => executingLiveIds.has(t.id),
    );
    setLiveToolCalls(executingLiveTools);
    clearToolInputContent();
    setCurrentTool(undefined);
    stopThinking();
    clearThinkingContent();
    clearResponse();
    setLastLiveActivityLabel(undefined);
  }, [
    flushForegroundTextBuffer,
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
    runtimeGrantSuggestions?: readonly ReplRuntimePermissionGrantSuggestion[];
  } | null>(null);
  const confirmResolveRef = useRef<((result: ConfirmResult) => void) | null>(null);
  const confirmationDialogQueueRef = useRef(createConfirmationDialogQueue());
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
      // FEATURE_222 — multi-select count bounds (host-enforced on confirm).
      minSelections?: number;
      maxSelections?: number;
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
  const uiResolveRef = useRef<((value: string | string[] | undefined) => void) | null>(null);
  // Fix: keep a synchronously-updated ref so the useKeypress handler always
  // reads the latest uiRequest (the registered handler captures a stale closure).
  const uiRequestRef = useRef(uiRequest);
  uiRequestRef.current = uiRequest;
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historySearchSelectedIndex, setHistorySearchSelectedIndex] = useState(0);
  const lastHistorySearchQueryRef = useRef("");
  const lastAutoCopiedTranscriptItemIdRef = useRef<string | undefined>(undefined);

  // Issue 070: Calculate context token usage for status bar display
  // Issue 070: Calculate context token usage for status bar display
  // Issue 070: calculate context token usage for the status bar.
  const contextUsage = useMemo(() => {
    if (!effectiveCompactionInfo) return undefined;

    const {
      contextWindow,
      triggerPercent,
      triggerTokens,
      reservedResponseTokens,
    } = effectiveCompactionInfo;
    const currentTokens =
      liveTokenCount ??
      context.contextTokenSnapshot?.currentTokens ??
      estimateTokens(context.messages);

    return {
      currentTokens,
      contextWindow,
      triggerPercent,
      triggerTokens,
      reservedResponseTokens,
    };
  }, [context.messages, context.contextTokenSnapshot, effectiveCompactionInfo, liveTokenCount]);

  const confirmInstruction = useMemo(() => {
    if (!confirmRequest) return undefined;
    const runtimeKinds = new Set(
      confirmRequest.runtimeGrantSuggestions?.map((suggestion) => suggestion.kind) ?? [],
    );
    if (runtimeKinds.has('persistent')) return t("confirm.instruction.runtime_persistent");
    if (runtimeKinds.has('session')) return t("confirm.instruction.runtime_session");
    if (confirmRequest.runtimeGrantSuggestions !== undefined) {
      return t("confirm.instruction.basic");
    }
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
  // FEATURE_060 Track 3 (v0.7.30): replaced `Number.POSITIVE_INFINITY` with
  // `TRANSCRIPT_HARD_LINE_CAP` (100K lines, ~10MB of materialized rows) so
  // pathological show-all sessions can't reintroduce unbounded retained
  // render models. Normal show-all usage stays unaffected — a 100K-line
  // budget is orders of magnitude beyond any realistic interactive session.
  // Proper viewport-virtualization (only materializing visible rows) is
  // tracked as a separate refactor; this cap is the Tier 1 boundedness
  // guarantee.
  const transcriptMaxLines = isTranscriptMode
    ? (showAllInTranscript ? TRANSCRIPT_HARD_LINE_CAP : 1000)
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
  // FEATURE_212 (v0.7.45) perf — memoize the transcript surface resolve. It
  // does an O(history) shallow copy and previously re-ran on EVERY InkREPLInner
  // re-render (i.e. on every streaming notify / forceUpdate), so per-frame cost
  // scaled with history length. Now it recomputes only when the underlying
  // items actually change.
  const rawTranscriptDisplayItems = useMemo(
    () => resolveTranscriptSurfaceItems({
      surface: "transcript",
      snapshot: displaySnapshot,
      promptItems: renderHistory,
      transcriptItems: transcriptHistory,
    }),
    [displaySnapshot, renderHistory, transcriptHistory],
  );
  // FEATURE_060 Tier 2 (v0.7.30): when transcript-mode is active and the
  // user has NOT toggled show-all, slice to the last 30 messages and
  // prepend a synthetic `buildTranscriptHiddenDivider` info-row so the
  // user sees `↑ N earlier messages hidden — press Ctrl+E to show all`
  // (mirrors CC's `MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE = 30` at
  // Messages.tsx:276). The 200-item cap (anchor above) is the perf
  // safety net for `<Static>` first-paint on `kodax -c`; this 30-cap is
  // the transcript-mode UX (so the surface lands close to the active
  // turn, not buried under hundreds of historical rounds).
  // `showAllInTranscript` toggles back to the full (200-capped) view and
  // drops the divider.
  const transcriptDisplayItems = useMemo(() => {
    if (!isTranscriptMode || showAllInTranscript) {
      return rawTranscriptDisplayItems;
    }
    const visibleSlice = sliceHistoryToRecentCanonicalItems(
      rawTranscriptDisplayItems,
      TRANSCRIPT_MODE_VISIBLE_MESSAGES,
    );
    if (visibleSlice.length === rawTranscriptDisplayItems.length) return rawTranscriptDisplayItems;
    const hiddenCount = rawTranscriptDisplayItems.length - visibleSlice.length;
    const divider = buildTranscriptHiddenDivider(
      hiddenCount,
      visibleSlice[0]?.timestamp,
    );
    return [divider, ...visibleSlice];
  }, [rawTranscriptDisplayItems, isTranscriptMode, showAllInTranscript]);
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
  const workflowLiveTick = useSharedSpinnerTick(workflowLiveStatus?.status === "running");
  const workflowLiveViewModel = useMemo(
    () => buildWorkflowLiveViewModel(workflowLiveStatus, Date.now()),
    [workflowLiveStatus, workflowLiveTick],
  );
  const workflowActivityText = workflowLiveViewModel.shouldRender
    ? `Workflow ${workflowLiveViewModel.workflow}${workflowLiveViewModel.phase ? ` - ${workflowLiveViewModel.phase}` : ""}`
    : undefined;
  const todoPlanViewModel = useMemo(
    () => buildTodoPlanViewModel(todoItems, {
      now: Date.now(),
      lastAllCompletedAt: null,
    }),
    [todoItems],
  );
  const childActivityMaxRows = terminalRows <= 20 ? 1 : MAX_CHILD_ACTIVITY_ROWS;
  // Re-render on the shared spinner cadence while children are active so each
  // row's elapsed advances (same pattern as the workflow-live surface).
  const childActivityTick = useSharedSpinnerTick(childActivityRecords.length > 0);
  const childActivityViewModel = useMemo(
    () => buildChildActivityViewModel(childActivityRecords, childActivityMaxRows, Date.now()),
    [childActivityMaxRows, childActivityRecords, childActivityTick],
  );
  const shouldRenderChildActivitySurface = shouldShowChildActivitySurface({
    isTranscriptMode,
    isLoading,
    hasWorkflowLiveSurface: workflowLiveViewModel.shouldRender,
    childActivityVisible: childActivityViewModel.shouldRender,
  });
  const transcriptLiveStatusLines = useMemo(() => {
    if (!isTranscriptMode) {
      return [] as readonly string[];
    }

    const lines: string[] = [];
    lines.push(...formatWorkflowLiveViewModelForTranscript(workflowLiveViewModel));
    if (isLoading && todoPlanViewModel.shouldRender) {
      lines.push(...formatTodoPlanViewModelForTranscript(todoPlanViewModel));
    }
    return lines;
  }, [isTranscriptMode, isLoading, todoPlanViewModel, workflowLiveViewModel]);
  const bannerProps = useMemo<BannerProps>(() => ({
    config: displayedConfig,
    sessionId: context.sessionId,
    workingDir:
      options.context?.executionCwd
      || options.context?.gitRoot
      || context.runtimeInfo?.executionCwd
      || context.gitRoot
      || process.cwd(),
    terminalWidth,
    // Live banners (non-Static) get the per-model resolved value so
    // `/model` swaps update the displayed context window. The Static
    // top banner captures whatever was current at first render and
    // stays at that snapshot by Ink design — that is acceptable as a
    // session-start record.
    compactionInfo: effectiveCompactionInfo ?? undefined,
  }), [
    effectiveCompactionInfo,
    context.sessionId,
    displayedConfig,
    context.runtimeInfo?.executionCwd,
    options.context?.gitRoot,
    options.context?.executionCwd,
    terminalWidth,
  ]);
  const fullscreenBannerSection = useMemo(
    () => (fullscreenPolicy.enabled && showBanner
      ? buildBannerTranscriptSection(bannerProps)
      : undefined),
    [bannerProps, fullscreenPolicy.enabled, showBanner],
  );
  // FEATURE_214 — inline scrollback ledger. Active ONLY on the inline main-screen path
  // AND only when the live renderer handle actually exposes commitInlineScrollback;
  // otherwise the prompt model keeps its staticSections and falls back to <Static> so
  // history is never dropped (req 1/2/3/6).
  const inlineLedgerStateRef = useRef(EMPTY_INLINE_SCROLLBACK_STATE);
  const inlineLedgerWasActiveRef = useRef(false);
  // Whether the native scrollback is owned/dirtied by the ledger — forces a rebuild on the
  // next active entry even with an empty source (cleared by a successful rebuild-empty), so
  // a stale owned scrollback is purged on re-entry but a fresh start never clears it (req 2).
  const inlineLedgerOwnsScrollbackRef = useRef(false);
  const inlineLedgerActive = isInlineLedgerActive({
    enabled: INLINE_LEDGER_ENABLED,
    useRendererViewportShell,
    isTranscriptMode,
    hasCommitHandle:
      typeof getRendererInstance(stdout)?.commitInlineScrollback === "function",
  });
  // FEATURE_172 P1.1 (v0.7.41) — split static / dynamic cache keys.
  // The static portion (committed rounds) recomputes only when items / viewport /
  // max change. The dynamic portion (current round + streaming) recomputes per
  // 80ms StreamingContext flush. Before this split, every flush invalidated the
  // whole model, so 200 items @ 28ms × 12.5Hz saturated the render loop.
  const promptStaticPortion = useMemo(
    () => buildTranscriptStaticPortion({
      items: effectivePromptDisplayItems,
      viewportWidth: terminalWidth,
      maxLines: transcriptMaxLines,
      showDetailedTools: false,
      showAllContent: false,
      windowed: false,
    }),
    [effectivePromptDisplayItems, terminalWidth, transcriptMaxLines],
  );
  const promptMainScreenRenderModel = useMemo(
    () => {
      const dynamicPortion = buildTranscriptDynamicPortion({
        activeItems: promptStaticPortion.activeItems,
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
        currentTodoActiveForm,
        showFullThinking: false,
        showDetailedTools: false,
        showAllContent: false,
        showLiveProgressRows: promptNeedsFallbackLiveStatus,
      });
      // FEATURE_214 Phase 2b: the inline prompt does NOT materialize. materialize
      // merges staticSections(finalized)+sections(dynamic) into one rows array, so the
      // live cell-frame would render the WHOLE transcript and the growing path
      // duplicates finalized history into scrollback. Keeping finalized in
      // staticSections routes it through <Static> → the engine hasStaticOutput branch
      // (scrollback ONCE), out of the live frame. The transcript surface (below) keeps
      // materialize for its windowed complete-frame paint.
      const inlinePromptModel = buildInlinePromptRenderModel(
        promptStaticPortion,
        dynamicPortion,
        fullscreenBannerSection,
      );
      // FEATURE_214 — when the inline ledger is active it OWNS finalized history (commits
      // it to native scrollback via the engine), so the live model drops staticSections
      // and MessageList stops rendering <Static> for them (req 1). The ledger reads the
      // RAW promptStaticPortion (in the effect below), NOT this emptied model (req 3).
      return gateInlinePromptModel(inlinePromptModel, inlineLedgerActive);
    },
    [
      currentConfig.agentMode,
      inlineLedgerActive,
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
      promptStaticPortion,
      fullscreenBannerSection,
      terminalWidth,
      transcriptMaxLines,
      currentTodoActiveForm,
    ],
  );
  // FEATURE_214 — the inline scrollback ledger effect is defined BELOW, right after
  // `inlineLedgerBounded` (which computes the bounded commit source from
  // viewportBudget.messageRows). It depends directly on that source — no render-phase
  // ref bridge — so it commits exactly what was bounded.
  // FEATURE_172 P1.2 (v0.7.41) — same static/dynamic split for transcript view.
  // Static cache key includes `showAllInTranscript` because toggling it changes
  // `showDetailedTools` / `showAllContent`, which affect the committed (static)
  // sections' formatting. Streaming-state changes still skip the static rebuild.
  const transcriptStaticPortion = useMemo(
    () => buildTranscriptStaticPortion({
      items: transcriptDisplayItems,
      viewportWidth: terminalWidth,
      maxLines: transcriptMaxLines,
      showDetailedTools: showAllInTranscript,
      showAllContent: showAllInTranscript,
      // FEATURE_220: transcript mode (Ctrl+O) always expands finalized thinking
      // — matches the dynamic portion's showFullThinking and honours the
      // collapsed-thinking "Ctrl+O to expand" affordance.
      showFullThinking: true,
      windowed: false,
    }),
    [transcriptDisplayItems, terminalWidth, transcriptMaxLines, showAllInTranscript],
  );
  const transcriptMainScreenRenderModel = useMemo(
    () => {
      if (!isTranscriptMode || useRendererViewportShell) {
        return undefined;
      }

      const dynamicPortion = buildTranscriptDynamicPortion({
        activeItems: transcriptStaticPortion.activeItems,
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
        liveStatusLines: transcriptLiveStatusLines,
        currentTodoActiveForm,
        showFullThinking: true,
        showDetailedTools: showAllInTranscript,
        showAllContent: showAllInTranscript,
        showLiveProgressRows: !foregroundManagedLedgerHasContent,
        expandedItemKeys: expandedTranscriptItemIds,
      });
      return prependTranscriptSection(
        materializeTranscriptRenderModel(
          composeTranscriptRenderModel(transcriptStaticPortion, dynamicPortion),
        ),
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
      transcriptMaxLines,
      transcriptStaticPortion,
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
      transcriptLiveStatusLines,
      useRendererViewportShell,
      currentTodoActiveForm,
    ],
  );
  const ownedTranscriptRenderModel = useMemo(
    () => {
      if (!transcriptOwnsViewport) {
        return undefined;
      }

      if (!isTranscriptMode) {
        // FEATURE_214 Phase 2b: promptMainScreenRenderModel is un-materialized for the
        // INLINE path (finalized → staticSections → <Static>). The windowed/fullscreen
        // viewport does NOT render <Static> (MessageList gates it on !windowed) and is
        // already bounded (no growing-path duplication), so re-materialize here to keep
        // the complete frame intact for the owned viewport — no fullscreen regression.
        return materializeTranscriptRenderModel(promptMainScreenRenderModel);
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
          liveStatusLines: transcriptLiveStatusLines,
          // FEATURE_149 (v0.7.38) — spinner reads currentTodo.activeForm
          currentTodoActiveForm,
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
      transcriptLiveStatusLines,
      showAllInTranscript,
      currentTodoActiveForm,
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
    () => getSelectableTranscriptItemIds(currentSurfaceItems)
      .filter((id) => id !== TRANSCRIPT_HIDDEN_DIVIDER_ID),
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
    () => createTranscriptSearchIndex(
      currentSurfaceItems.filter((item) => !isTranscriptHiddenDivider(item)),
    ),
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
  useEffect(() => {
    void options.runtimeAutoModeControl?.syncSettings?.(
      context.sessionId,
      currentConfig.permissionMode,
      autoModeSettings,
    );
  }, [autoModeSettings, context.sessionId, currentConfig.permissionMode, options.runtimeAutoModeControl]);
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
        effort: configuredEffort,
        reasoningEffortLabel: formatReasoningEffortStatusLabel({
          provider: currentConfig.provider,
          model: currentConfig.model,
          effort: configuredEffort,
          effortOverride: currentConfig.effortOverride,
          thinking: currentConfig.thinking,
          reasoningMode: currentConfig.reasoningMode,
        }),
        isTranscriptMode,
        streamingState: statusBarStreamingState,
        maxIter: streamingState.maxIter,
        contextUsage,
        learning: learningSnapshot,
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
          idleWaiting: managedTaskStatus?.idleWaiting,
          idleWaitingPendingCount: managedTaskStatus?.idleWaitingPendingCount,
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
      currentConfig.effortOverride,
      configuredEffort,
      isTranscriptMode,
      statusBarStreamingState,
      streamingState.maxIter,
      contextUsage,
      learningSnapshot,
      statusBarIsLoading,
      managedTaskStatus?.phase,
      managedTaskStatus?.harnessProfile,
      managedTaskStatus?.activeWorkerTitle,
      managedTaskStatus?.currentRound,
      managedTaskStatus?.maxRounds,
      managedTaskStatus?.globalWorkBudget,
      managedTaskStatus?.budgetUsage,
      managedTaskStatus?.budgetApprovalRequired,
      managedTaskStatus?.idleWaiting,
      managedTaskStatus?.idleWaitingPendingCount,
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
      workflowBuilderMessage: workflowBuilderMessage ?? undefined,
      backgroundWorkflowMessage: workflowActivityText,
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
      workflowBuilderMessage,
      workflowActivityText,
    ],
  );
  const promptActivityShouldRenderInFooter = shouldRenderPromptActivityInFooter({
    activity: promptActivityViewModel,
  });
  const footerActivityViewModel = promptActivityShouldRenderInFooter
    ? promptActivityViewModel
    : undefined;
  const footerActivityText = footerActivityViewModel?.text;
  const promptActivityBarVisible = Boolean(footerActivityViewModel);

  // v0.7.38 hotfix (2026-05-11) — FEATURE_151 Slice C correction.
  // Clear `todoItems` when the loading lifecycle transitions
  // true → false (i.e. the AMA run terminated). Without this, the
  // next prompt re-enters `isLoading=true` and the gated mount
  // surfaces the PREVIOUS run's completed list until the new run's
  // Scout `init()` / LLM `op:'init'` replaces it — a stale-list
  // flash that defeats the whole point of the on-end clear.
  //
  // Scoped strictly to the true→false edge by checking `wasLoadingRef`
  // — a transient mid-render `isLoading=false` snapshot during initial
  // mount (before the first prompt) MUST NOT clear (there's nothing
  // to clear, and we don't want to schedule a stray setState on
  // every render).
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading) {
      setTodoItems((items) => (items.length > 0 ? [] : items));
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading]);

  const statusBarViewModel = useMemo(
    () => buildStatusBarViewModel(statusBarProps),
    [statusBarProps],
  );
  const visibleStatusBarViewModel = useMemo(
    () => statusBarViewModel,
    [statusBarViewModel],
  );
  const statusBarText = visibleStatusBarViewModel.text;
  // v0.7.42 layout bugfix — budget must see the same row count as the
  // `QueuedCommandsSurface` renders (N items + 1 hint row). Passing the
  // single-line summary (the old `formatPendingInputsSummary`) under-reserved
  // by N rows for queue depth ≥ 2, pushing composer + status bar off screen
  // instead of compressing the transcript above.
  const pendingInputSummary = useMemo(
    () => formatPendingInputsBudgetText(streamingState.pendingInputs),
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
    const base = buildFooterNotifications({
      historySearchQuery,
      isHistorySearchActive,
      historySearchMatchCount: historySearchMatches.length,
      pendingInputCount: streamingState.pendingInputs.length,
      maxPendingInputs: MAX_PENDING_INPUTS,
    });
    return [...base, ...learningNotices];
  }, [
    historySearchMatches.length,
    historySearchQuery,
    isHistorySearchActive,
    learningNotices,
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
  const budgetedTerminalRows = terminalRows;
  const footerBudgetInputText = isTranscriptMode ? "" : inputText;
  const footerBudgetPendingInputSummary = isTranscriptMode ? undefined : pendingInputSummary;
  const footerBudgetWorkStripText = displayWorkStripText;
  const footerBudgetShowHelp = isTranscriptMode ? false : showHelp;
  const workflowFooterRows = workflowLiveViewModel.shouldRender
    ? measureWorkflowRunSurfaceRows(workflowLiveViewModel)
    : 0;
  const todoFooterRows = isLoading && todoPlanViewModel.shouldRender
    ? todoPlanViewModel.rows.length
    : 0;
  const childActivityFooterRows = shouldRenderChildActivitySurface
    ? measureChildActivitySurfaceRows(childActivityViewModel)
    : 0;
  const viewportBudget = useMemo(
    // Budget transcript, footer, overlay, status, and task slots together so
    // the viewport always receives a stable number of visible rows.
    () => calculateViewportBudget({
      terminalRows: budgetedTerminalRows,
      terminalWidth,
      windowedTranscript: useRendererViewportShell,
      inputText: footerBudgetInputText,
      footerHeaderText: footerHeaderSummary,
      activitySummary: isTranscriptMode ? undefined : footerActivityText,
      // Mirrors the activityBar prop below: the spinner row is the stable
      // liveness heartbeat and should stay visible alongside progress
      // surfaces such as workflow, todo, or child activity panels.
      activityBarVisible: isTranscriptMode
        ? false
        : promptActivityBarVisible,
      workflowSurfaceRows: isTranscriptMode ? 0 : workflowFooterRows,
      childActivitySurfaceRows: isTranscriptMode ? 0 : childActivityFooterRows,
      // FEATURE_114 v0.7.36 Slice 4 (UX bugfix v0.7.38) — TodoListSurface
      // is rendered between activityBar and composer in PromptFooter.
      // Each viewModel row is a single Ink Box (1 line). Without this
      // budget reservation the composer + status-bar fall off-screen
      // as soon as the plan list shows.
      //
      // v0.7.38 hotfix (2026-05-11) — `isLoading` gate must mirror the
      // mount gate at the todoSurface= prop site (see line ~7590); the
      // mount conditional uses `(isLoading && shouldRender)`, so the
      // budget reservation has to follow suit or the layout reserves
      // empty rows when the run terminates.
      todoSurfaceRows: isTranscriptMode
        ? 0
        : todoFooterRows,
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
      footerActivityText,
      promptActivityBarVisible,
      isTranscriptMode,
      workflowFooterRows,
      childActivityFooterRows,
      todoFooterRows,
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
  // FEATURE_214 — ledger=1 bounded inline live frame + unified line-level commit source.
  // Runs AFTER viewportBudget so it can cap the live frame to `messageRows`. Splits the
  // active round (completed-item rows + streaming preview rows) into a HARD-CAPPED live
  // tail (always the last `messageRows` rows) + an overflow that joins finalized history
  // in a positional line-level commit source — so a long streaming answer's stable lines
  // also overflow + commit (only mutable spinner rows in the overflow are dropped). The
  // ledger effect just below consumes `committedSections` directly (no render-phase ref).
  // Inactive (ledger off / fullscreen / transcript): pass the model through untouched.
  const inlineLedgerBounded = useMemo<{
    model: typeof promptMainScreenRenderModel;
    committedSections: TranscriptSection[];
  }>(() => {
    if (!inlineLedgerActive) {
      return { model: promptMainScreenRenderModel, committedSections: [] };
    }
    const { committedSections, liveRows } = splitInlineLedgerModel(
      promptStaticPortion.staticSections,
      promptMainScreenRenderModel.rows, // completed-item rows (same renderer as finalized)
      promptMainScreenRenderModel.previewRows, // streaming preview (stable lines overflow + commit)
      viewportBudget.messageRows,
    );
    return {
      model: { ...promptMainScreenRenderModel, staticSections: [], rows: liveRows, previewRows: [] },
      committedSections,
    };
  }, [
    inlineLedgerActive,
    promptMainScreenRenderModel,
    promptStaticPortion.staticSections,
    viewportBudget.messageRows,
  ]);
  const inlineLedgerBoundedModel = inlineLedgerBounded.model;
  // FEATURE_214 — drive the inline scrollback ledger. Active ONLY on inline main-screen
  // with a live commitInlineScrollback handle. Commits the bounded unified source (banner
  // + finalized history + active-round overflow [completed + stable streaming], positional
  // 1-row line sections) via the engine; advances ledger state ONLY after a successful
  // commit. Re-runs when `committedSections` changes (every streaming flush that overflows
  // new stable rows, and on round finalization) — no ref bridge, reads the source directly.
  useEffect(() => {
    const handle = getRendererInstance(stdout);
    const hasCommitHandle = typeof handle?.commitInlineScrollback === "function";
    const step = computeInlineLedgerStep({
      active: inlineLedgerActive,
      hasCommitHandle,
      wasActive: inlineLedgerWasActiveRef.current,
      forceRebuild: inlineLedgerOwnsScrollbackRef.current,
      prior: inlineLedgerStateRef.current,
      finalizedSections: inlineLedgerBounded.committedSections,
      // Under inline mixed policy (KODAX_FULLSCREEN=0) the separate <Banner> is NOT
      // rendered and the ledger gate clears the banner from the live model — so the LEDGER
      // must commit it. planInlineScrollback folds it in as the first scrollback section;
      // the committed source above excludes the banner, so it is committed exactly once.
      bannerSection: fullscreenBannerSection,
      width: terminalWidth,
      // Timestamp-insensitive identity so a streamed `Assistant` line aligns with its
      // finalized `Assistant [HH:MM]` render (append, not rebuild) at round finalize.
      identify: identifyInlineCommitSection,
    });
    let committed = false;
    let hadContent = false;
    if (step.kind === "commit") {
      // step.sections are positional 1-row sections; flatten the delta into ONE section
      // so the rendered scrollback text is contiguous (no per-line spacing).
      const deltaRows = step.sections.flatMap((section) => section.rows);
      const text = renderFinalizedSectionsToScrollbackText(
        deltaRows.length > 0 ? [{ key: "il-delta", rows: deltaRows }] : [],
        { width: terminalWidth, theme: getTheme("dark") },
      );
      hadContent = text.length > 0;
      if (step.mode === "append" && !text) {
        reportInlineLedgerFailure("empty-append-text");
      } else {
        try {
          handle?.commitInlineScrollback?.({ mode: step.mode, text });
          committed = true;
        } catch (err) {
          reportInlineLedgerFailure("commit-threw", err);
        }
      }
    }
    const resolved = resolveInlineLedgerState(
      step,
      { committed, hadContent },
      inlineLedgerOwnsScrollbackRef.current,
    );
    inlineLedgerStateRef.current = resolved.state;
    inlineLedgerWasActiveRef.current = resolved.wasActive;
    inlineLedgerOwnsScrollbackRef.current = resolved.owns;
  }, [
    inlineLedgerActive,
    inlineLedgerBounded.committedSections,
    fullscreenBannerSection,
    terminalWidth,
    stdout,
  ]);
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
  useEffect(() => options.subscribeTransientNotices?.((notice) => {
    showClipboardNotice(notice.text, notice.tone);
  }), [options.subscribeTransientNotices, showClipboardNotice]);
  const showPasteFallbackNotice = useCallback((message: string): void => {
    showClipboardNotice(message, "warning");
  }, [showClipboardNotice]);
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
    () => {
      if (!confirmRequest) return null;
      // FEATURE_075: for exit_plan_mode, route the plan content into the
      // scrollable DialogSurface panel and strip the plan lines out of the
      // single-line prompt to avoid double-rendering. For other tools the
      // full prompt (title + details) stays inline as before.
      if (confirmRequest.tool === "exit_plan_mode") {
        const planContent = typeof confirmRequest.input.plan === "string"
          ? (confirmRequest.input.plan as string)
          : undefined;
        // confirmRequest.prompt = title + "\n" + details; keep only the title
        // for exit_plan_mode so planContent owns the plan rendering.
        const titleOnlyPrompt = confirmRequest.prompt.split("\n", 1)[0] ?? confirmRequest.prompt;
        return {
          prompt: titleOnlyPrompt,
          instruction: confirmInstruction,
          planContent,
        };
      }
      return {
        prompt: confirmRequest.prompt,
        instruction: confirmInstruction,
      };
    },
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
  const modelSessionStorage = useMemo(
    () => withSessionHistoryReadBarrier(
      storage,
      () => persistContextStateQueueRef.current,
    ),
    [storage],
  );
  const currentOptionsRef = useRef<InkREPLOptions>({
    ...options,
    thinking: currentConfig.thinking,
    reasoningMode: currentConfig.reasoningMode,
    effort: runtimeEffort,
    agentMode: currentConfig.agentMode,
    // FEATURE_246 A5 (ADR-047): carry the workflow runs dir on the live session
    // options that flow to runAgentRound so the Worker's run_workflow tool is
    // active on NL turns (not just the /workflow command path). The mid-session
    // update at the auto-mode switch spreads `...currentOptionsRef.current`, so
    // this value persists; the slash-command closure inherits it the same way.
    workflowRunsBaseDir: getAgentConfigPath(
      "workflow-runs",
      deriveProjectKeyFromRoot(process.cwd()).key,
    ),
    context: {
      ...options.context,
      gitRoot: context.gitRoot ?? undefined,
      executionCwd: context.runtimeInfo?.executionCwd ?? context.gitRoot ?? process.cwd(),
      repoIntelligenceMode: currentConfig.repoIntelligenceMode,
      repoIntelligenceTrace: currentConfig.repoIntelligenceTrace,
      // FEATURE_087/088 (v0.7.28): the Ink REPL is the authorized self-
      // construction surface. The 5 staircase tools (scaffold_tool / ... /
      // activate_tool) are exposed to the LLM here; child agents and ACP /
      // single-shot CLI surfaces stay false (their context is built fresh
      // and does NOT inherit this flag).
      toolConstructionMode: true,
    },
    session: {
      ...options.session,
      id: context.sessionId,
      storage: modelSessionStorage,
      // FEATURE_173 dual-writer fix: the Ink REPL owns session persistence
      // (full lineage + uiHistory + artifactLedger via persistContextState).
      // Suppress the runner's redundant flat snapshot so it can't clobber
      // the active-entry pointer on resume.
      persistedByHost: true,
    },
    // An external Runtime owns shared-session Auto classification and receipts.
    // Keep the local guardrail only for the standalone REPL runner.
    guardrails: options.runtimeRunner
      ? undefined
      : buildAutoModeGuardrails(currentConfig.permissionMode, autoModeBootstrap),
  });
  useEffect(() => {
    currentOptionsRef.current.effort = runtimeEffort;
  }, [runtimeEffort]);
  const applyInteractiveRuntimeInfo = useCallback((
    runtimeInfo: NonNullable<InteractiveContext["runtimeInfo"]>,
  ) => {
    const gitRoot = runtimeInfo.workspaceRoot ?? undefined;
    context.runtimeInfo = runtimeInfo;
    context.gitRoot = gitRoot;
    currentOptionsRef.current.context = {
      ...currentOptionsRef.current.context,
      gitRoot,
      executionCwd: runtimeInfo.executionCwd ?? gitRoot ?? process.cwd(),
    };
  }, [context]);
  // Permission-related refs (not part of KodaXOptions anymore)
  const permissionModeRef = useRef<PermissionMode>(currentConfig.permissionMode);
  const permissionModeUpdateRef = useRef(0);
  useEffect(() => {
    permissionModeRef.current = currentConfig.permissionMode;
  }, [currentConfig.permissionMode]);
  // FEATURE_214 (v0.7.46) perf — `loadAlwaysAllowTools()` reads a config file off
  // disk. As a bare `useRef(loadAlwaysAllowTools())` argument it was evaluated on
  // EVERY InkREPLInner render (useRef ignores the arg after the first, but still
  // computes it) — a synchronous file read per streaming flush / scroll tick.
  // Hoist it into a `useMemo(…, [])` so the read happens once; explicit reloads
  // still go through `alwaysAllowToolsRef.current = loadAlwaysAllowTools()`.
  const initialAlwaysAllowTools = useMemo(() => loadAlwaysAllowTools(), []);
  const alwaysAllowToolsRef = useRef<string[]>(initialAlwaysAllowTools);

  // FEATURE_153 (v0.7.38): live currentConfig ref + LLM-backed bash prefix
  // extractor for `isToolCallAllowed`. The ref-based getter pattern mirrors
  // permissionModeRef above so /provider and /model swaps mid-session
  // redirect the extractor without recreation.
  const currentConfigRef = useRef(currentConfig);
  useEffect(() => {
    currentConfigRef.current = currentConfig;
  }, [currentConfig]);
  const bashPrefixExtractorRef = useRef<BashPrefixExtractor | null>(null);
  if (bashPrefixExtractorRef.current === null) {
    bashPrefixExtractorRef.current = createBashPrefixExtractor({
      getProvider: () => resolveProvider(currentConfigRef.current.provider),
      getModel: () => currentConfigRef.current.model ?? '',
    });
  }

  const setSessionPermissionMode = useCallback(async (mode: PermissionMode): Promise<void> => {
    const canonicalMode = canonicalizePermissionMode(mode);
    const updateId = ++permissionModeUpdateRef.current;
    setCurrentConfig((prev) => ({ ...prev, permissionMode: canonicalMode }));
    permissionModeRef.current = canonicalMode;
    await options.runtimeAutoModeControl?.syncSettings?.(
      context.sessionId,
      canonicalMode,
      autoModeSettings,
    );
    if (updateId !== permissionModeUpdateRef.current) return;
    const modeEffortResolution = resolveProviderReasoningRuntimeEffort({
      provider: currentConfigRef.current.provider,
      model: currentConfigRef.current.model,
      effort: currentConfigRef.current.effort,
      effortOverride: currentConfigRef.current.effortOverride,
      permissionMode: canonicalMode,
      planModeEffort: currentConfigRef.current.planModeEffort,
      thinking: currentConfigRef.current.thinking,
      reasoningMode: currentConfigRef.current.reasoningMode,
    });
    // FEATURE_092 phase 2b.7b: keep the live KodaXOptions in sync so a
    // mid-session /auto switch lights up the guardrail on the very next
    // tool call, and stepping out of auto removes it.
    currentOptionsRef.current = {
      ...currentOptionsRef.current,
      effort: modeEffortResolution.runtimeEffort,
      guardrails: options.runtimeRunner
        ? undefined
        : buildAutoModeGuardrails(canonicalMode, autoModeBootstrap),
    };
  }, [autoModeBootstrap, autoModeSettings, context.sessionId, options.runtimeAutoModeControl, options.runtimeRunner]);
  const pendingInputsRef = useRef<string[]>(streamingState.pendingInputs);
  const userInterruptedRef = useRef(false);
  const lastInterruptEscapeAtRef = useRef(0);
  // Rate-limit double-render dedup: base.ts fires the structured onRetryAfter
  // immediately before the legacy onRateLimit for the SAME retry. We record the
  // structured line's key here so the legacy onProviderRateLimit handler can
  // suppress its duplicate line. See ./rate-limit-dedup.ts.
  const rateLimitDedupRef = useRef<RateLimitDedupKey | null>(null);

  // Issue 116: generation counter to discard results from stale (interrupted) rounds.
  // Incremented on each prompt submission; checked after await to detect supersession.
  const promptGenerationRef = useRef(0);

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
    // FEATURE_213 — this commit includes the foreground ledger (incl any
    // mid-turn user message); mark them so the ensuing clear's rescue skips them.
    markLedgerUserItemsCommitted(managedForegroundTurnItemsRef.current);
    appendHistoryItemsWithPersistenceRef.current?.(interruptedItems);
  }, [getFullResponse, getThinkingContent, markLedgerUserItemsCommitted]);

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
    managedTaskStatusRef.current = null;
    managedTaskBreadcrumbRef.current = null;
    setManagedLiveEvents([]);
    setManagedTaskStatus(null);
    setWorkflowBuilderMessage(null);
    clearWorkStripTimers();
    setVisibleWorkStripText(undefined);
    setIsLoading(false);
    if (stdout?.isTTY === true) {
      getRendererInstance(stdout)?.clear?.();
    }
  }, [
    abort,
    clearResponse,
    clearThinkingContent,
    clearToolInputContent,
    clearWorkStripTimers,
    resetLiveToolCalls,
    clearManagedForegroundTurnHistory,
    setCurrentTool,
    setManagedLiveEvents,
    setIsLoading,
    setLastLiveActivityLabel,
    stopStreaming,
    stopThinking,
    stdout,
  ]);

  const stopActiveWorkflowRuns = useCallback((reason: string): boolean => {
    const manager = getDefaultWorkflowRunManager();
    const activeRuns = manager
      .list()
      .filter((run) => run.status === "running" || run.status === "paused");

    if (activeRuns.length === 0) {
      return false;
    }

    for (const run of activeRuns) {
      manager.stop(run.runId, reason);
    }

    updateWorkflowLiveStatus((current) => {
      if (!current || current.status !== "running") {
        return current;
      }
      if (!activeRuns.some((run) => run.runId === current.runId)) {
        return current;
      }
      return {
        ...current,
        status: "stopped",
        activeAgents: [],
        message: "Workflow stopped by user.",
      };
    });

    const firstRun = activeRuns[0];
    if (activeRuns.length === 1 && firstRun) {
      emitInfoItemToCorrectLayer({
        type: "info",
        text: `Stopped workflow ${firstRun.workflow} (${firstRun.runId}).`,
      }, "workflow-stop");
    } else {
      emitInfoItemToCorrectLayer({
        type: "info",
        text: `Stopped ${activeRuns.length} active workflows.`,
      }, "workflow-stop");
    }

    return true;
  }, [emitInfoItemToCorrectLayer, updateWorkflowLiveStatus]);

  useEffect(() => {
    if (!workflowLiveViewModel.shouldRender) {
      return;
    }

    const handleSigint = (): void => {
      stopActiveWorkflowRuns("stopped by Ctrl+C");
    };

    process.on("SIGINT", handleSigint);
    return () => {
      process.off("SIGINT", handleSigint);
    };
  }, [stopActiveWorkflowRuns, workflowLiveViewModel.shouldRender]);

  // Global interrupt handler using the Gemini CLI style isActive pattern.
  // Foreground streaming and background workflow runs both own interrupt keys.
  // Reference: Gemini CLI useGeminiStream.ts useKeypress usage.
  useKeypress(
    KeypressHandlerPriority.Critical,
    (key) => {
      const isEscapeKey = key.name === "escape";
      const now = Date.now();
      const canEscapeInterrupt = isEscapeKey
        && !isTranscriptMode
        && !isAwaitingUserInteraction
        && isInputEmpty
        && streamingState.pendingInputs.length === 0
        && (isLoading || workflowLiveViewModel.shouldRender);
      const isDoubleEscape = canEscapeInterrupt && (
        key.meta === true ||
        now - lastInterruptEscapeAtRef.current < DOUBLE_INTERRUPT_ESCAPE_INTERVAL_MS
      );

      lastInterruptEscapeAtRef.current = canEscapeInterrupt ? now : 0;

      if (shouldStopWorkflowFromInterruptKey({
        keyName: key.name,
        ctrl: Boolean(key.ctrl),
        isTranscriptMode,
        isAwaitingUserInteraction,
        isInputEmpty,
        isDoubleEscape,
        pendingInputCount: streamingState.pendingInputs.length,
        hasTranscriptTextSelection: Boolean(transcriptModeTextSelection),
        hasActiveWorkflow: workflowLiveViewModel.shouldRender,
      })) {
        return stopActiveWorkflowRuns(
          key.ctrl ? "stopped by Ctrl+C" : "stopped by Escape",
        );
      }

      if (!isLoading) {
        return false;
      }

      const interruptAction = resolveStreamingInterruptAction({
        keyName: key.name,
        ctrl: Boolean(key.ctrl),
        isTranscriptMode,
        isAwaitingUserInteraction,
        isInputEmpty,
        isDoubleEscape,
        pendingInputCount: streamingState.pendingInputs.length,
        hasTranscriptTextSelection: Boolean(transcriptModeTextSelection),
      });

      switch (interruptAction.kind) {
        case "interrupt":
          queueInterruptedPersistence();
          resetInterruptedPromptState();
          return true;
        case "pop-pending-input":
          removeLastPendingInput();
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
      stopActiveWorkflowRuns,
      transcriptModeTextSelection,
      workflowLiveViewModel.shouldRender,
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
        // FEATURE_058: transcript native scrollback dump.
        // Exit the alt-screen, write plain-text transcript content to the
        // terminal's native scrollback buffer, then re-enter the fullscreen
        // surface. The renderer repaints from current React state on
        // re-entry so no content restoration is needed.
        dumpTranscriptToScrollback: () => {
          dumpTranscriptToNativeScrollback({
            items: currentSurfaceItems.filter((item) => !isTranscriptHiddenDivider(item)),
            exitAltScreen: () => {
              writeTerminal(buildAlternateScreenExitSequence({ mouseTracking: true }));
            },
            writeToScrollback: (text) => {
              writeTerminal(text);
            },
            enterAltScreen: () => {
              writeTerminal(buildAlternateScreenEnterSequence({
                mouseTracking: true,
                clearOnEnter: false,
              }));
            },
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
      const runtimeSessionGrant = confirmRequest.runtimeGrantSuggestions
        ?.find((suggestion) => suggestion.kind === 'session');
      const runtimePersistentGrant = confirmRequest.runtimeGrantSuggestions
        ?.find((suggestion) => suggestion.kind === 'persistent');
      const isProtectedPath = !!confirmRequest.input._alwaysConfirm;
      const isRuntimePermission = confirmRequest.runtimeGrantSuggestions !== undefined;
      // Runtime prompts can only select a Runtime-issued persistent candidate.
      const canAlways = runtimePersistentGrant !== undefined
        || (!isRuntimePermission
          && currentConfig.permissionMode === "accept-edits"
          && !isProtectedPath);

      // v0.7.26 parity: confirm-result history items must route through
      // the managed-foreground ledger when an AMA worker is active —
      // otherwise the "[Confirm] … → Approved" line renders below the
      // user prompt instead of inline with the worker output. Mirrors
      // the fix for onError (63330bc) and onRetry / onProviderRecovery
      // (09cd7ae). Without this gating, bash tool confirmations appear
      // "somewhere wrong on screen" while a managed task is running.
      const recordConfirmResult = (
        suffixKey: 'approved' | 'approved_session' | 'approved_always' | 'denied',
      ) => {
        const text = `${t("dialog.confirm")} ${confirmRequest.prompt}\n  → ${t(`confirm.result.${suffixKey}`)}`;
        const inManagedForeground = !!managedForegroundOwnerRef.current.workerId;
        if (inManagedForeground) {
          appendManagedForegroundLedgerItem({
            id: `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: "info",
            text,
            timestamp: Date.now(),
          } as HistoryItem);
        } else {
          addHistoryItem({ type: "info", text });
        }
      };

      if (answer === "y" || answer === "yes") {
        recordConfirmResult('approved');
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: true });
        confirmResolveRef.current = null;
        return true;
      }

      if (runtimeSessionGrant && (answer === "s" || answer === "session")) {
        recordConfirmResult('approved_session');
        setConfirmRequest(null);
        confirmResolveRef.current?.({ confirmed: true, runtimeGrantKind: 'session' });
        confirmResolveRef.current = null;
        return true;
      }

      if (canAlways && (answer === "a" || answer === "always")) {
        recordConfirmResult('approved_always');
        setConfirmRequest(null);
        confirmResolveRef.current?.(
          runtimePersistentGrant
            ? { confirmed: true, runtimeGrantKind: 'persistent' }
            : { confirmed: true, always: true },
        );
        confirmResolveRef.current = null;
        return true;
      }

      if (answer === "n" || answer === "no" || key.name === "escape") {
        recordConfirmResult('denied');
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

  const resolveUIRequest = useCallback((value: string | string[] | undefined) => {
    setUiRequest(null);
    uiResolveRef.current?.(value);
    uiResolveRef.current = null;
  }, []);

  const showSelectDialogWithOptions = useCallback((
    title: string,
    options: SelectOption[],
    multiSelect?: boolean,
    // FEATURE_222 — optional multi-select count bounds. Only meaningful when
    // multiSelect is true; a caller that omits them gets the prior behaviour.
    constraints?: {
      minSelections?: number;
      maxSelections?: number;
      defaultValue?: string;
    },
    signal?: AbortSignal,
  ): Promise<string | string[] | undefined> => {
    if (options.length === 0) {
      return Promise.resolve(undefined);
    }

    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const settle = (value: string | string[] | undefined): void => {
        signal?.removeEventListener('abort', onAbort);
        if (uiResolveRef.current === settle) uiResolveRef.current = null;
        resolve(value);
      };
      const onAbort = (): void => {
        if (uiResolveRef.current !== settle) return;
        setUiRequest(null);
        settle(undefined);
      };
      uiResolveRef.current = settle;
      signal?.addEventListener('abort', onAbort, { once: true });
      const defaultIndex = constraints?.defaultValue === undefined
        ? -1
        : options.findIndex((option) => option.value === constraints.defaultValue);
      setUiRequest({
        kind: "select",
        title,
        options,
        buffer: "",
        focusedIndex: Math.max(0, defaultIndex),
        selectedIndices:
          multiSelect === true && defaultIndex >= 0 ? [defaultIndex] : [],
        multiSelect,
        minSelections: constraints?.minSelections,
        maxSelections: constraints?.maxSelections,
      });
    });
  }, []);

  const showSelectDialog = useCallback((title: string, options: string[]): Promise<string | undefined> => {
    // Single-select wrapper — never passes multiSelect, so the widened
    // (FEATURE_222) union result is always a string|undefined here; collapse
    // an array defensively to keep the string-only return contract.
    return showSelectDialogWithOptions(
      title,
      options.map((option) => ({ label: option, value: option })),
    ).then((value) => (Array.isArray(value) ? value[0] : value));
  }, [showSelectDialogWithOptions]);

  const openLearningCenter = useCallback(async (requested?: string): Promise<void> => {
    const binding = options.learning;
    if (!binding) return;
    let capabilityKey = requested;
    if (!capabilityKey) {
      const page = await binding.list({ limit: 200 });
      if (page.items.length === 0) {
        setLearningNotices([{
          id: "learning-center-empty",
          text: "Learning Center has no learned capabilities.",
          tone: "accent",
        }]);
        return;
      }
      const selected = await showSelectDialogWithOptions(
        "Learning Center — type to search",
        buildLearningCenterOptions(page.items),
      );
      capabilityKey = Array.isArray(selected) ? selected[0] : selected;
    }
    if (!capabilityKey) return;
    const detail = await binding.get(capabilityKey);
    const selectedAction = await showSelectDialogWithOptions(
      `${detail.displayName} · ${detail.carrier} · ${detail.lifecycle}`,
      learningCenterActions(detail),
    );
    const action = Array.isArray(selectedAction) ? selectedAction[0] : selectedAction;
    if (!action) return;
    await applyLearningCenterAction(binding, detail.capabilityId, action);
    setLearningSnapshot(await binding.getSnapshot());
  }, [options.learning, showSelectDialogWithOptions]);

  // FEATURE_087/088 (v0.7.28): bind a stable askUser implementation to the
  // ConstructionRuntime policy module. The policy needs an interactive
  // approval dialog to honour 'ask-user' verdicts on activate_tool. The
  // implementation reuses showSelectDialogWithOptions (component-local
  // useCallback, stable across renders), so the binding is mount-once and
  // tear-down on unmount.
  const askUserForConstructionPolicy = useCallback(
    async (options: import("@kodax-ai/coding").AskUserQuestionOptions): Promise<string> => {
      const selectOptions = options.options ? toSelectOptions(options.options) : [];
      // The construction / self-modify policy is inherently single-select
      // (approve vs reject) and its contract returns a single string, so force
      // single-select rather than forwarding options.multiSelect. A multi-select
      // here would let a `join(", ")` corrupt an option value containing ", "
      // (the exact hazard FEATURE_222 R2 removed everywhere else).
      const selected = await showSelectDialogWithOptions(
        getAskUserDialogTitle(options),
        selectOptions,
        false,
      );
      // ESC → undefined → return the shared CANCELLED_TOOL_RESULT_MESSAGE
      // sentinel. The policy maps any non-'approve' answer to 'reject', so a
      // cancelled dialog rejects. `selected` is a string with single-select; the
      // array guard is defensive only — take the first value, never join.
      if (selected === undefined) return CANCELLED_TOOL_RESULT_MESSAGE;
      return Array.isArray(selected) ? (selected[0] ?? CANCELLED_TOOL_RESULT_MESSAGE) : selected;
    },
    [showSelectDialogWithOptions],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { bindAskUserForConstruction } = await import('../common/construction-bootstrap.js');
      if (cancelled) return;
      bindAskUserForConstruction(askUserForConstructionPolicy);
    })();
    return () => {
      cancelled = true;
      void (async () => {
        const { bindAskUserForConstruction } = await import('../common/construction-bootstrap.js');
        bindAskUserForConstruction(null);
      })();
    };
  }, [askUserForConstructionPolicy]);

  const showInputDialog = useCallback((
    prompt: string,
    defaultValue?: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolve) => {
      // uiResolveRef is shared with the (now array-capable, FEATURE_222) select
      // dialog, so it accepts string[]. Input mode never resolves an array;
      // narrow defensively so the string-only Promise contract holds.
      const settle = (value: string | string[] | undefined): void => {
        signal?.removeEventListener('abort', onAbort);
        if (uiResolveRef.current === settle) uiResolveRef.current = null;
        resolve(Array.isArray(value) ? value[0] : value);
      };
      const onAbort = (): void => {
        if (uiResolveRef.current !== settle) return;
        setUiRequest(null);
        settle(undefined);
      };
      uiResolveRef.current = settle;
      signal?.addEventListener('abort', onAbort, { once: true });
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
      // Read from ref to avoid stale closure — the registered handler is NOT
      // re-created when uiRequest state changes (useKeypress deps don't include it).
      const req = uiRequestRef.current;
      if (!req) return false;

      if (key.name === "escape") {
        resolveUIRequest(undefined);
        return true;
      }

      if (req.kind === "select") {
        const optionCount = req.options.length;

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
        if (key.sequence === " " && req.multiSelect) {
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

        // Enter: confirm selection — read latest state from ref, not stale closure.
        if (key.name === "return") {
          const latest = uiRequestRef.current;
          if (!latest || latest.kind !== "select") return false;

          if (latest.multiSelect) {
            // FEATURE_222 — validate the selection count against the optional
            // min/max bounds before resolving. Empty selection keeps its own
            // message; a below-min or above-max count re-prompts with a range
            // hint. All three reuse the existing inline `error` field.
            const count = latest.selectedIndices.length;
            const { minSelections, maxSelections } = latest;
            // An explicit `minSelections: 0` means the selection is optional, so
            // an empty confirm is valid — only reject empty when the min is unset
            // (default: at least one) or positive.
            const rangeError =
              count === 0 && minSelections !== 0
                ? t("select.multiselect_empty")
                : minSelections !== undefined && count < minSelections
                  ? t("select.multiselect_min", { min: String(minSelections) })
                  : maxSelections !== undefined && count > maxSelections
                    ? t("select.multiselect_max", { max: String(maxSelections) })
                    : undefined;
            if (rangeError !== undefined) {
              setUiRequest((prev) =>
                prev && prev.kind === "select" ? { ...prev, error: rangeError } : prev,
              );
              return true;
            }
            // Resolve the selected values as an ARRAY — no longer joined, so
            // values containing ", " survive intact (FEATURE_222 R2).
            const values = latest.selectedIndices
              .slice()
              .sort((a, b) => a - b)
              .map((i) => latest.options[i]?.value)
              .filter((v): v is string => typeof v === "string" && v.length > 0);
            resolveUIRequest(values);
          } else {
            // Single select: return focused item's value
            resolveUIRequest(latest.options[latest.focusedIndex]?.value);
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
            if (req.multiSelect) {
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

      // Input mode handling — read latest state from ref for buffer/defaultValue.
      if (key.name === "return") {
        const latest = uiRequestRef.current;
        if (!latest || latest.kind !== "input") return false;
        const trimmed = latest.buffer.trim();
        resolveUIRequest(trimmed === "" ? latest.defaultValue ?? undefined : trimmed);
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
    if (history.length !== 0) return;
    if (context.uiHistory?.length) {
      const persistedHistory = trimPersistedUiHistorySnapshot(context.uiHistory);
      if (persistedHistory.length !== context.uiHistory.length) {
        context.uiHistory = persistedHistory;
      }
      // FEATURE_212 (v0.7.45) — bulk-add in ONE dispatch. The per-item loop
      // here triggered N dispatches → N re-renders, each re-resolving the
      // growing transcript: O(n²) resume lag on long `kodax -c` sessions.
      addHistoryItems(restoreHistoryItemsFromSession({
        messages: context.messages,
        uiHistory: persistedHistory,
      }));
      return;
    }

    if (context.messages.length > 0) {
      addHistoryItems(restoreHistoryItemsFromSession({ messages: context.messages }));
    }
  }, [context.messages, context.uiHistory, history.length, addHistoryItems]);

  // Preload skills on mount to ensure they're available for first /skill:xxx call
  // Issue 059: Skills lazy loading caused first skill invocation to fail
  // Issue 064: Must pass projectRoot to discover .kodax/skills/ in project directory
  const skillRegistryReadyRef = useRef(false);
  useEffect(() => {
    let active = true;
    skillRegistryReadyRef.current = false;
    void initializeSkillRegistry(context.gitRoot).finally(() => {
      if (active) skillRegistryReadyRef.current = true;
    });
    return () => {
      active = false;
    };
  }, [context.gitRoot]);

  // v0.7.41 L2 — prewarm repo-intelligence session caches at REPL mount.
  // Uses `refresh:false`; see prewarmRepoIntelligenceCaches docs for budget/coalescing details.
  // Cache-coherent with L1 (middleware also uses refresh:false on first round),
  // so user-path can share in-flight worker work or hit the warmed P3+ cache.
  // Safe to opt out via
  // `KODAX_PREWARM_REPO_INTELLIGENCE=0`.
  useEffect(() => {
    if (process.env.KODAX_PREWARM_REPO_INTELLIGENCE === '0') return;
    prewarmRepoIntelligenceCaches(
      {
        executionCwd: context.runtimeInfo?.executionCwd ?? context.gitRoot ?? process.cwd(),
        gitRoot: context.gitRoot ?? undefined,
      },
      { mode: currentConfig.repoIntelligenceMode },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.gitRoot, context.runtimeInfo?.executionCwd, currentConfig.repoIntelligenceMode]);

  // Process special syntax (shell commands, file references)
  // Create KodaXEvents for streaming updates
  const createStreamingEvents = useCallback((): StreamingEvents => ({
    onOutputSegmentStart: (segment, meta) => {
      if (userInterruptedRef.current || shouldRouteToChildActivity(meta)) {
        return;
      }
      beginOutputSegment(segment);
    },
    onMemoryOutcomeDigest: (digest, metadata) => {
      if (digest.sessionId !== context.sessionId) {
        options.events?.onMemoryOutcomeDigest?.(digest, metadata);
        return;
      }
      context.lineage = appendMemoryOutcomeDigest(
        context.lineage ?? createSessionLineage(context.messages),
        digest,
        metadata?.jobId,
      );
    },
    onMemoryReviewReceipt: (receipt) => {
      if (receipt.sessionId !== undefined && receipt.sessionId !== context.sessionId) {
        options.events?.onMemoryReviewReceipt?.(receipt);
        return;
      }
      context.lineage = appendMemoryReviewReceipt(
        context.lineage ?? createSessionLineage(context.messages),
        receipt,
      );
    },
    onMemoryNotice: (notice) => {
      if (notice.sessionId !== undefined && notice.sessionId !== context.sessionId) {
        options.events?.onMemoryNotice?.(notice);
        return;
      }
      const lineage = context.lineage ?? createSessionLineage(context.messages);
      const nextLineage = appendMemoryClientNotice(
        lineage,
        { ...notice, createdAt: new Date().toISOString() },
      );
      context.lineage = nextLineage;
      if (nextLineage !== lineage) {
        addHistoryItem({
          type: "info",
          text: `[memory] ${notice.summaries.slice(0, 3).join("; ")}`,
        });
      }
      options.events?.onMemoryNotice?.(notice);
    },
    onThinkingDelta: (text: string, meta?: KodaXActivityEventMeta) => {
      if (userInterruptedRef.current) {
        return;
      }
      if (upsertChildActivityRecord(meta, "thinking", text, { append: true })) {
        return;
      }
      if (meta?.providerRequestId !== undefined) {
        const reduced = reduceOutputSegmentProjection(
          outputSegmentProjectionRef.current,
          {
            type: "thinking.delta",
            providerRequestId: meta.providerRequestId,
            text,
          },
        );
        outputSegmentProjectionRef.current = reduced.state;
        if (!reduced.accepted) return;
      }
      if (streamingState.currentTool) {
        setCurrentTool(undefined);
        clearToolInputContent();
      }
      // FEATURE_202 (v0.7.45): surface the model's first **bold** reasoning
      // topic as "Thinking: <topic>" instead of a static "[Thinking]".
      const { header: reasoningHeader } = extractBoldHeader(getThinkingContent() + text);
      const thinkingLabel = reasoningHeader ? `[Thinking: ${reasoningHeader}]` : "[Thinking]";
      setLastLiveActivityLabel(
        formatManagedLiveActivityLabel(
          managedTaskStatusRef.current?.activeWorkerTitle
            ? `[${managedTaskStatusRef.current.activeWorkerTitle}] ${thinkingLabel}`
            : thinkingLabel,
          managedTaskStatusRef.current?.activeWorkerTitle,
        ),
      );
      // The UI layer stores thinking content for display.
      appendThinkingChars(text.length);
      appendThinkingContent(text);
      if (managedForegroundOwnerRef.current.workerId) {
        appendManagedForegroundTextBlock("thinking", text);
        managedOutputSegmentItemsRef.current = {
          ...managedOutputSegmentItemsRef.current,
          thinkingItemId: managedForegroundLedgerRef.current.activeThinkingItemId,
        };
      }
    },
    onThinkingEnd: (thinking: string, meta?: KodaXActivityEventMeta) => {
      if (userInterruptedRef.current) {
        return;
      }
      if (upsertChildActivityRecord(meta, "thinking", thinking)) {
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
    onTextDelta: (text: string, meta?: KodaXActivityEventMeta) => {
      if (userInterruptedRef.current) {
        return;
      }
      if (upsertChildActivityRecord(meta, "assistant", text, { append: true })) {
        return;
      }
      if (meta?.providerRequestId !== undefined) {
        const reduced = reduceOutputSegmentProjection(
          outputSegmentProjectionRef.current,
          {
            type: "assistant.delta",
            providerRequestId: meta.providerRequestId,
            text,
          },
        );
        outputSegmentProjectionRef.current = reduced.state;
        if (!reduced.accepted) return;
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
        managedOutputSegmentItemsRef.current = {
          ...managedOutputSegmentItemsRef.current,
          assistantItemId: managedForegroundLedgerRef.current.activeAssistantItemId,
        };
      }
    },
    onToolUseStart: (
      tool: { name: string; id: string; input?: Record<string, unknown> },
      meta?: KodaXToolEventMeta,
    ) => {
      if (userInterruptedRef.current) {
        return;
      }
      if (upsertChildActivityRecord(meta, "tool", toolActivityDetail(tool.name, tool.input))) {
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
      meta?: KodaXToolEventMeta,
    ) => {
      if (userInterruptedRef.current) {
        return;
      }
      if (upsertChildActivityRecord(meta, "tool", toolName, { skipIfExisting: true })) {
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
    onToolResult: (result, meta?: KodaXToolEventMeta) => {
      if (userInterruptedRef.current) {
        return;
      }
      if (upsertChildActivityRecord(meta, "tool", `${result.name} completed`)) {
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
    onToolProgress: (update: { id: string; message: string }, meta?: KodaXToolEventMeta) => {
      if (userInterruptedRef.current) return;
      if (upsertChildActivityRecord(meta, "progress", update.message)) {
        return;
      }
      const truncated = update.message.length > 100
        ? update.message.slice(0, 97) + '...'
        : update.message;
      // 1. Update live tool state (progressLines rendered inside tool block)
      const updatedTool = updateLiveToolCallById(update.id, (tool) => ({
        ...tool,
        preview: truncated,
        progressLines: [...(tool.progressLines ?? []).slice(-4), truncated],
      }));
      // 2. Sync to foreground turn → displayHistory → transcript re-renders
      if (updatedTool && managedForegroundOwnerRef.current.workerId) {
        syncManagedForegroundToolGroup(updatedTool);
      }
      // 3. Update spinner label
      setLastLiveActivityLabel(truncated);
    },
    onStreamEnd: (meta?: KodaXActivityEventMeta) => {
      // Issue 116: guard against stale onStreamEnd from aborted round.
      // The agent AbortError path calls events.onStreamEnd() after the UI has
      // already reset via resetInterruptedPromptState(). Without this guard,
      // it would corrupt tool-call state of the new round.
      if (userInterruptedRef.current) {
        return;
      }
      if (shouldRouteToChildActivity(meta)) {
        return;
      }
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
    onChildActivityEnd: (meta?: KodaXActivityEventMeta) => {
      completeChildActivityRecord(meta);
    },
    hasPendingInputs: () => pendingInputsRef.current.length > 0,
    // FEATURE_164 (v0.7.41) — mid-turn user message injection visibility.
    // The Runner-driven path's `beforeNextTurn` hook fires this after it
    // drains user-typed prompts from MessageQueue mid-Q1-round and splices
    // them into the agent transcript. Render each as a user history item
    // so the user sees their typed query echoed inline with the ongoing
    // conversation, rather than waiting for the round to end.
    //
    // Plan-A fix (v0.7.41): when a managed worker owns the foreground
    // turn, route through the foreground ledger (not `addHistoryItem`).
    // Static history renders ABOVE the managed-foreground stack while
    // the worker is running, so an `addHistoryItem` call here would pin
    // Q2 above Worker turn-1's output instead of interleaving between
    // turn 1 and turn 2. Round-end finalization (`recordCompletedAgentRound`)
    // commits the foreground ledger in its natural temporal order, which
    // places the Q2 user item exactly between the two worker turns it
    // was injected between — same precedent as `emitInfoItemToCorrectLayer`
    // (MED-6 HARD RULE).
    onMidTurnUserMessages: (contents: readonly string[]) => {
      if (userInterruptedRef.current) {
        return;
      }
      for (const content of contents) {
        const normalized = content.trim();
        if (!normalized) continue;
        if (managedForegroundOwnerRef.current.workerId) {
          appendManagedForegroundLedgerItem({
            id: `mid-turn-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: "user",
            text: normalized,
            timestamp: Date.now(),
          });
        } else {
          addHistoryItem({ type: "user", text: normalized });
        }
      }
    },
    onSidecarMessage: (event: KodaXSidecarMessageEvent) => {
      if (userInterruptedRef.current) {
        return;
      }
      const bodyText = event.suggestedFix
        ? `${event.content}\nSuggested fix: ${event.suggestedFix}`
        : event.content;
      if (event.delivery === "budget-exhausted") {
        emitSidecarItemToCorrectLayer(
          { type: "sidecar", text: bodyText, delivery: "budget-exhausted" },
          "sidecar-message",
        );
      } else {
        const verdict = event.verdict === "blocked" ? "blocked" : "revise";
        emitSidecarItemToCorrectLayer(
          { type: "sidecar", text: bodyText, verdict },
          "sidecar-message",
        );
      }
      sidecarMessageDeliveredRef.current = true;
    },
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

      if (classification.category === ErrorCategory.USER_ABORT) {
        return;
      }

      // Build a multi-line error payload and route it to the correct
      // rendering layer. Earlier code emitted each line via
      // `console.log(chalk.*)`. Two evolutions made that wrong:
      //   1. When Ink's `patchConsole` was active it routed console output
      //      into the static area BELOW the user prompt — defeating the
      //      chronological position the 052c23b fix established.
      //   2. The renderer now runs with `patchConsole: false` (vendored
      //      substrate, FEATURE_057), so console.log bypasses Ink entirely
      //      and writes straight into the alt-screen buffer, colliding
      //      with the React render output.
      // Either way the history-item path below is the single source of
      // truth: when a managed worker is still owning the turn, append the
      // error into the foreground ledger so it renders inside the worker's
      // group, right where the failure happened. Otherwise fall back to a
      // normal history item.
      const categoryName = categoryNames[classification.category] || 'Unknown';
      const errorLines: string[] = [`\u274C API Error (${categoryName}): ${error.message}`];
      if (classification.shouldCleanup) {
        errorLines.push('   \u{1F9F9} Cleaned incomplete tool calls');
      }
      if (classification.category === ErrorCategory.PERMANENT) {
        errorLines.push('   \u{1F4A1} This error requires manual intervention. Please check:');
        if (error.message.includes('auth') || error.message.includes('401')) {
          errorLines.push('      - Your API key is valid');
          errorLines.push('      - Run /config to check provider settings');
        } else if (error.message.includes('400')) {
          errorLines.push('      - The request parameters are correct');
          errorLines.push('      - Try restarting the conversation');
        } else {
          errorLines.push('      - The error details above');
        }
      } else if (classification.category === ErrorCategory.TRANSIENT) {
        errorLines.push('   \u23F3 Retries exhausted. Press Enter to continue the conversation');
      } else if (classification.category === ErrorCategory.TOOL_CALL_ID) {
        errorLines.push('   \u2705 Session cleaned, ready to continue');
      }
      const errorText = errorLines.join('\n');

      const inManagedForegroundErr = !!managedForegroundOwnerRef.current.workerId;
      if (inManagedForegroundErr) {
        appendManagedForegroundLedgerItem({
          id: `error-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: "error",
          text: errorText,
          timestamp: Date.now(),
        } as HistoryItem);
      } else {
        addHistoryItem({
          type: "error",
          text: errorText,
        });
      }
    },
    onRetry: (
      reason: string,
      attempt: number,
      maxAttempts: number,
      meta?: KodaXActivityEventMeta,
    ) => {
      if (userInterruptedRef.current) {
        return;
      }
      const retryItem = createRetryHistoryItem(reason, attempt, maxAttempts);
      if (routeWorkflowLiveOnlyNotice(meta, retryItem.text)) {
        return;
      }
      if (upsertChildActivityRecord(meta, "progress", retryItem.text)) {
        return;
      }
      // In AMA managed-foreground mode the active rendering anchor is the
      // managed foreground turn layer; addHistoryItem would land in the
      // wrong position. Mirrors the 09cd7ae fix for onProviderRecovery —
      // onRetry was the missed sibling of that fix.
      const inManagedForeground = !!managedForegroundOwnerRef.current.workerId;
      if (inManagedForeground) {
        appendManagedForegroundLedgerItem({
          ...retryItem,
          id: `retry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
        } as HistoryItem);
      } else {
        addHistoryItem(retryItem);
      }
    },
    onProviderRecovery: (event, meta?: KodaXActivityEventMeta) => {
      if (userInterruptedRef.current) {
        return;
      }
      const recoveryItem = createRecoveryHistoryItem(event);
      if (routeWorkflowLiveOnlyNotice(meta, recoveryItem.text)) {
        return;
      }
      if (upsertChildActivityRecord(meta, "progress", recoveryItem.text)) {
        return;
      }
      const inManagedForeground = !!managedForegroundOwnerRef.current.workerId;

      // The failed provider request already owns its streamed text in the
      // output-segment projection. The next segment.started(replace) event
      // removes that request exactly once; never append the cumulative live
      // buffer here, or the managed ledger and persisted uiHistory get P1+P1.
      applyProviderRecoveryTransientReset({
        clearResponse,
        clearThinkingContent,
        stopThinking,
        clearToolInputContent,
        clearCurrentTool: () => setCurrentTool(undefined),
        resetLiveToolCalls,
        clearLiveActivityLabel: () => setLastLiveActivityLabel(undefined),
      });

      // Commit recovery info to the correct layer.
      if (inManagedForeground) {
        appendManagedForegroundLedgerItem({
          ...recoveryItem,
          id: `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
        } as HistoryItem);
      } else {
        addHistoryItem(recoveryItem);
      }
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
          // Issue 130: defensive guard. This branch fires when no previous
          // foreground owner existed (`previousForegroundWorker.workerId`
          // is falsy) — so in normal flow there should be no in-flight
          // tools to preserve. Apply the same has-Executing pattern for
          // consistency with `transitionManagedForegroundPhase`, in case a
          // stale ledger somehow carries an Executing entry across
          // foreground promotion. Preserve the FULL tools list (not just
          // Executing) — see the rationale in transitionManagedForegroundPhase.
          const prevLedger = managedForegroundLedgerRef.current;
          const hasExecutingInGroup = prevLedger.activeToolGroupTools.some(
            (t) => t.status === ToolCallStatus.Executing,
          );
          managedForegroundLedgerRef.current = {
            workerId: status.activeWorkerId,
            workerTitle: status.activeWorkerTitle,
            ...(hasExecutingInGroup
              ? {
                  activeToolGroupItemId: prevLedger.activeToolGroupItemId,
                  activeToolGroupTools: prevLedger.activeToolGroupTools,
                }
              : { activeToolGroupTools: [] }),
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
    onProviderRateLimit: (
      attempt: number,
      maxAttempts: number,
      delayMs: number,
      meta?: KodaXActivityEventMeta,
    ) => {
      if (userInterruptedRef.current) {
        return;
      }
      // The structured onRetryAfter callback fires immediately before this
      // legacy one for the same retry (base.ts) and renders a richer line; drop
      // this duplicate so the user sees one rate-limit notice, not two. The
      // legacy callback stays wired for SDK / extension rate-limit events.
      const pendingStructured = rateLimitDedupRef.current;
      rateLimitDedupRef.current = null;
      if (isDuplicateLegacyRateLimit(pendingStructured, { attempt, maxAttempts, delayMs })) {
        return;
      }
      const text = `[Rate Limit] Retrying in ${delayMs / 1000}s (${attempt}/${maxAttempts})...`;
      if (routeWorkflowLiveOnlyNotice(meta, text)) {
        return;
      }
      if (upsertChildActivityRecord(meta, "progress", text)) {
        return;
      }
      // Route through the layer-aware emitter so rate-limit notices
      // render inline with the managed worker output instead of
      // clustering above the user prompt when a managed task is active.
      emitInfoItemToCorrectLayer({
        type: "info",
        icon: "\u23F3",
        text,
      }, 'ratelimit');
    },
    // FEATURE_130 (v0.7.36): structured retry-after display. Coexists
    // with onProviderRateLimit (legacy flat shape stays wired for the
    // existing rate-limit extension events). The structured event
    // carries `provider` + `source`, letting the spinner show whether
    // we're honoring a server-supplied wait or guessing with backoff \u2014
    // the design's "user knows it's not a bug, it's quota" goal.
    onRetryAfter: (event, meta?: KodaXActivityEventMeta) => {
      if (userInterruptedRef.current) {
        return;
      }
      // Record this structured retry so the legacy onProviderRateLimit line
      // (which base.ts fires next for the same retry) can be suppressed as a
      // duplicate. Set before any early routing return so the legacy line is
      // suppressed regardless of which layer this structured line renders into.
      rateLimitDedupRef.current = {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        waitMs: event.waitMs,
      };
      const seconds = Math.round(event.waitMs / 1000);
      const sourceLabel =
        event.source === 'exponential-backoff'
          ? 'no-header \u2192 backoff'
          : event.source;
      const reasonLabel = event.reason === 'overloaded' ? 'Overloaded' : 'Rate limited';
      const text = `[${reasonLabel}] (${event.provider}) \u2014 retrying in ${seconds}s [${sourceLabel}] (${event.attempt}/${event.maxAttempts})`;
      if (routeWorkflowLiveOnlyNotice(meta, text)) {
        return;
      }
      if (upsertChildActivityRecord(meta, "progress", text)) {
        return;
      }
      emitInfoItemToCorrectLayer({
        type: "info",
        icon: "\u23F3",
        text,
      }, 'ratelimit');
    },
    onReasoningEffortRejected: (event) => {
      // Passive capability learning: a provider HARD-rejected this effort, so
      // record it (narrows the cycle / /effort / wire everywhere via the
      // capability cache) and re-resolve a model-safe effort for the active
      // config so the status bar follows and the next request won't resend it.
      recordRejectedEffort(
        event.provider,
        event.model,
        event.effort,
        'observed',
        new Date().toISOString(),
      );
      const resolution = resolveProviderReasoningRuntimeEffort({
        provider: event.provider,
        model: event.model,
        effort: currentConfigRef.current.effort,
        effortOverride: currentConfigRef.current.effortOverride,
        permissionMode: currentConfigRef.current.permissionMode,
        planModeEffort: currentConfigRef.current.planModeEffort,
        thinking: currentConfigRef.current.thinking,
        reasoningMode: currentConfigRef.current.reasoningMode,
      });
      const safeEffort = resolution.runtimeEffort;
      setCurrentConfig((prev) => ({
        ...prev,
        effort: safeEffort,
        effortOverride: safeEffort !== undefined,
      }));
      saveConfig({ effort: safeEffort });
      currentOptionsRef.current.effort = safeEffort;
      emitInfoItemToCorrectLayer({
        type: "info",
        icon: "\u26A0",
        text: `[${event.provider}/${event.model} \u4E0D\u652F\u6301 effort "${event.effort}",\u5DF2\u8BB0\u5F55;\u540E\u7EED\u4E0D\u518D\u63D0\u4F9B\u8BE5\u6863${safeEffort ? `,\u5DF2\u5207\u5230 ${safeEffort}` : ''}]`,
      }, 'ratelimit');
    },
    onRepoIntelligenceTrace: (event) => {
      // v0.7.27 FEATURE_086 — display repo-intelligence trace events
      // (routing / preturn / module / impact / task-snapshot) inline so
      // users can see when the agent pulls repo context. OFF by default
      // to match the v0.7.20-era transcript density; enable via
      // `/repo-intel trace on`. Gated upstream by
      // `shouldEmitRepoIntelligenceTrace` in agent.ts — when the toggle
      // is off, the emitter short-circuits and this handler never fires.
      if (userInterruptedRef.current) {
        return;
      }
      emitInfoItemToCorrectLayer(
        createRepoIntelTraceHistoryItem(event),
        'repointel-trace',
      );
    },
    onTodoUpdate: (items: TodoList) => {
      // FEATURE_097 (v0.7.34) — direct setState path. Per design
      // §"事件路由注意", todo state is task-global, not per-worker, so it
      // does NOT route through `emitInfoItemToCorrectLayer`. The store's
      // onChange callback already handed us a frozen snapshot — push it
      // straight into React state.
      //
      // FEATURE_151 (v0.7.38) — the wall-clock-anchor `todoLastAllCompletedAt`
      // arming and `isPlanFullyClosed` check were removed because the
      // 5-second post-completion linger gate they fed into is gone (the
      // surface now stays visible until the next Scout init() / LLM
      // op:'init' replace()). Keeping the arming would have caused
      // spurious re-renders without driving any UI behavior. The
      // `userInterruptedRef` guard remains so an in-flight Esc still
      // suppresses incoming store updates from a possibly-half-aborted
      // round.
      if (userInterruptedRef.current) {
        return;
      }
      setTodoItems(items);
    },
    onScoutSuspiciousCompletion: (payload) => {
      // X-layer: Scout's H0 completion was inferred (no explicit escalation)
      // but the harness saw signals that suggest Scout may not actually be
      // done. Surface as an info item with a warning icon so the user knows
      // to double-check the result instead of trusting a silent success.
      if (userInterruptedRef.current) {
        return;
      }
      // v0.7.38 (2026-05-11) — suppressed by default to match Claude
      // Code, which has no equivalent transcript marker. The
      // suspicious-completion signal still propagates through the
      // harness (recorder, lineage, eval) — only the transcript banner
      // is gated. Set KODAX_TRANSCRIPT_HARNESS_MARKERS=1 to restore.
      if (!TRANSCRIPT_HARNESS_MARKERS_ENABLED) {
        return;
      }
      // Scout-suspicious fires while Scout still owns the managed
      // foreground turn — route to that layer so it renders inline
      // with the Scout output, not stacked under the user prompt.
      emitInfoItemToCorrectLayer({
        type: "info",
        icon: "\u26A0",
        text: `[Scout] Completion marked uncertain — signals: ${payload.signals.join(", ")}. Verify the result before continuing.`,
      }, 'scout-uncertain');
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
      // Issue 130: pair with the ledger-layer preservation in
      // resetManagedForegroundLedgerState — if a tool result from the
      // previous iteration is still in flight (e.g. emit_verdict whose
      // onToolResult lands after the iteration boundary fires), keep
      // its entry in liveToolCalls / iterationToolCallsRef so
      // finalizeLiveToolCall can still find it by id. Drop only the
      // already-terminal entries (those have been reported in the
      // prior round and don't need to carry forward).
      const carriedExecutingTools = activeToolCallsRef.current.filter(
        (t) => t.status === ToolCallStatus.Executing,
      );
      const carriedExecutingIds = new Set(carriedExecutingTools.map((t) => t.id));
      iterationToolsRef.current = [];
      iterationToolCallsRef.current = iterationToolCallsRef.current.filter(
        (t) => carriedExecutingIds.has(t.id),
      );
      setLiveToolCalls(carriedExecutingTools);
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
            // FEATURE_212 — bulk even on the mount-race fallback (one dispatch).
            addHistoryItems([...previousRoundItems]);
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

      if (mode === 'full-access') {
        return true;
      }

      // The runner guardrail has already decided this exact Auto call.
      // Return before the cross-mode denial cache and all legacy checks so a
      // denial recorded under Edits cannot override a later reviewer allow.
      if (isAutoMode(mode)) {
        return true;
      }

      // === 0. Denial tracker: skip recently denied operations ===
      // FEATURE_066: If the user already denied this exact operation, don't ask again
      if (isDeniedRecently(denialTrackerRef.current, tool, input)) {
        const ctx = getDenialContext(denialTrackerRef.current);
        return `[Skipped] Previously denied operation. ${ctx}`;
      }

      // === 1. Plan mode: use the same fail-closed operation analysis as Runtime ===
      if (mode === 'plan') {
        const blockReason = getPlanModeBlockReason(
          tool,
          input,
          gitRoot ?? context.runtimeInfo?.executionCwd ?? process.cwd(),
          context.runtimeInfo?.executionCwd ?? gitRoot ?? process.cwd(),
        );
        if (blockReason !== null) {
          return `${blockReason} ${PLAN_MODE_BLOCK_GUIDANCE}`;
        }
      }

      // Standalone Bash always enters the Coding-owned sandbox/host boundary.
      // Mode review and Edits prompts happen only after a real boundary.
      if (!options.runtimeRunner && tool === 'bash') return true;

      // === 2. Safe read-only bash commands: auto-allowed BEFORE protected path check ===
      // Issue 085: All modes should allow safe read commands without confirmation
      // Safe read-only bash commands are auto-allowed before protected path checks.
      if (tool === 'bash') {
        const command = (input.command as string) ?? '';
        if (isBashReadCommandAutoAllowed(
          command,
          gitRoot ?? process.cwd(),
          context.runtimeInfo?.executionCwd ?? gitRoot ?? process.cwd(),
        )) {
          return true; // Auto-allowed for safe read-only commands in all modes
        }
      }

      // === 2.5. Dangerous bash commands: always require confirmation ===
      // FEATURE_066: Regardless of permission mode, dangerous commands always need confirmation
      if (tool === 'bash') {
        const command = (input.command as string) ?? '';
        const classification = classifyBashCommand(command);
        if (classification.level === 'dangerous') {
          const result = await showConfirmDialog(tool, { ...input, _dangerousCommand: true });
          if (!result.confirmed) {
            denialTrackerRef.current = recordDenial(
              denialTrackerRef.current, tool, input, classification.reason,
            );
            return `[Blocked] Dangerous command requires confirmation: ${classification.reason}`;
          }
          return result.confirmed;
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
        // In accept-edits mode, check alwaysAllowTools for bash.
        // FEATURE_153: extractor matches allowlist patterns against the LLM-
        // extracted safe prefix (e.g. `git commit`) instead of naive startsWith,
        // closing the `git commit -m "x" $(curl evil)` injection surface.
        if (mode === 'accept-edits' && tool === 'bash') {
          if (
            await isToolCallAllowed(
              tool,
              input,
              alwaysAllowTools,
              bashPrefixExtractorRef.current ?? undefined,
            )
          ) {
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
          // FEATURE_057 Track E: route through addHistoryItem rather than
          // direct console.log. With patchConsole=false (the renderer no
          // longer captures stdout), a raw console.log would bypass the
          // React tree and write straight into the alt-screen buffer,
          // colliding with Ink's render output. Routing through the
          // history-item channel keeps the cancellation message in the
          // chronological transcript slot where the user expects it.
          addHistoryItem({ type: "info", text: t("cancelled") });
          // FEATURE_066: Record denial to avoid re-prompting
          denialTrackerRef.current = recordDenial(
            denialTrackerRef.current, tool, input,
          );
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
    askUser: async (
      options: import("@kodax-ai/coding").AskUserQuestionOptions,
      _meta?: KodaXToolEventMeta,
      interaction?: KodaXUserInputPromptContext,
    ): Promise<AskUserAnswer> => {
      const selectOptions = appendCustomInputOption(
        options.options ? toSelectOptions(options.options) : [],
        options,
      );
      const selectedValue = await showSelectDialogWithOptions(
        getAskUserDialogTitle(options),
        selectOptions,
        options.multiSelect,
        // FEATURE_222 — forward multi-select count bounds for host enforcement.
        {
          minSelections: options.minSelections,
          maxSelections: options.maxSelections,
          defaultValue: options.default,
        },
        interaction?.signal,
      );

      // Issue 114: User pressed ESC → signal cancellation so the agent loop stops.
      if (selectedValue === undefined) {
        return CANCELLED_TOOL_RESULT_MESSAGE;
      }

      if (selectedValue === ASK_USER_CUSTOM_INPUT_SIGNAL) {
        const customValue = await showInputDialog(
          options.customInputPrompt ?? options.question,
          options.customInputDefault,
          interaction?.signal,
        );
        if (customValue === undefined) return CANCELLED_TOOL_RESULT_MESSAGE;
        return { kind: "customInput", value: customValue };
      }

      if (Array.isArray(selectedValue) && selectedValue.includes(ASK_USER_CUSTOM_INPUT_SIGNAL)) {
        const customValue = await showInputDialog(
          options.customInputPrompt ?? options.question,
          options.customInputDefault,
          interaction?.signal,
        );
        if (customValue === undefined) return CANCELLED_TOOL_RESULT_MESSAGE;
        return selectedValue.map((value): AskUserSelectionAnswer =>
          value === ASK_USER_CUSTOM_INPUT_SIGNAL
            ? { kind: "customInput", value: customValue }
            : value,
        );
      }

      // Multi-select resolves an array (FEATURE_222); single-select a string.
      return selectedValue;
    },
    // FEATURE_074: exit_plan_mode tool callback. Tri-state return:
    //   'not-in-plan-mode' if session isn't in plan mode (tool errors);
    //   true on user approval (mode flips to accept-edits);
    //   false on user rejection (mode stays plan).
    // buildToolConfirmationDisplay has a dedicated case for 'exit_plan_mode'
    // that renders input.plan line-by-line so the user actually sees the plan.
    exitPlanMode: async (plan: string): Promise<boolean | 'not-in-plan-mode'> => {
      if (permissionModeRef.current !== 'plan') return 'not-in-plan-mode';
      const result = await showConfirmDialog('exit_plan_mode', { plan });
      if (result.confirmed) {
        setSessionPermissionMode('accept-edits' as PermissionMode);
        return true;
      }
      return false;
    },
    // Multi-question mode: present each question sequentially with back navigation.
    askUserMulti: async (
      options: import("@kodax-ai/coding").AskUserMultiOptions,
      _meta?: KodaXToolEventMeta,
      interaction?: KodaXUserInputPromptContext,
    ): Promise<Record<string, AskUserAnswer> | undefined> => {
      const questions = options.questions;
      const answers: Record<string, AskUserAnswer> = {};
      let i = 0;

      while (i < questions.length) {
        const q = questions[i]!;
        const selectOptions = appendCustomInputOption(toSelectOptions(q.options), q);

        // Non-first question: append "← Back" option (FEATURE_222 shared sentinel)
        if (i > 0) {
          selectOptions.push({
            label: t("select.back_prev"),
            value: ASK_USER_BACK_SIGNAL,
          });
        }

        const title = `[${i + 1}/${questions.length}] ${q.question}`;
        const selected = await showSelectDialogWithOptions(
          title,
          selectOptions,
          q.multiSelect,
          // FEATURE_222 — per-question multi-select bounds inherited from the item.
          {
            minSelections: q.minSelections,
            maxSelections: q.maxSelections,
            defaultValue: q.default,
          },
          interaction?.signal,
        );

        if (selected === undefined) {
          return undefined; // ESC → cancel all
        }

        // Back navigation is only ever the string sentinel; an array (multi-select
        // result) is never a back request, so guard the string case first.
        if (!Array.isArray(selected) && selected === ASK_USER_BACK_SIGNAL) {
          i--;
          continue;
        }

        if (!Array.isArray(selected) && selected === ASK_USER_CUSTOM_INPUT_SIGNAL) {
          const customValue = await showInputDialog(
            q.customInputPrompt ?? q.question,
            q.customInputDefault,
            interaction?.signal,
          );
          if (customValue === undefined) return undefined;
          answers[q.question] = { kind: "customInput", value: customValue };
          i++;
          continue;
        }

        if (Array.isArray(selected) && selected.includes(ASK_USER_CUSTOM_INPUT_SIGNAL)) {
          const customValue = await showInputDialog(
            q.customInputPrompt ?? q.question,
            q.customInputDefault,
            interaction?.signal,
          );
          if (customValue === undefined) return undefined;
          answers[q.question] = selected.map((value): AskUserSelectionAnswer =>
            value === ASK_USER_CUSTOM_INPUT_SIGNAL
              ? { kind: "customInput", value: customValue }
              : value,
          );
          i++;
          continue;
        }

        answers[q.question] = selected;
        i++;
      }

      return answers;
    },
    askUserInput: async (
      options: { question: string; default?: string },
      _meta?: KodaXToolEventMeta,
      interaction?: KodaXUserInputPromptContext,
    ): Promise<string | undefined> => {
      return showInputDialog(options.question, options.default, interaction?.signal);
    },
    onCompactStart: () => {
      // Trigger the compacting UI indicator before actual compaction begins
      startCompacting();
    },
    onCompactStats: (info: { tokensBefore: number; tokensAfter: number }) => {
      lastCompactionTokensBeforeRef.current = info.tokensBefore;
      setLiveTokenCount(info.tokensAfter);
    },
    onCompactedMessages: async (
      messages: KodaXMessage[],
      update?: CompactionUpdate,
      meta?: KodaXActivityEventMeta,
    ) => {
      const durableLineage = prepareRootCompactionLineage(
        context.lineage,
        messages,
        update,
        meta,
      );
      if (!durableLineage) return;
      context.messages = messages;
      if (update?.artifactLedger && update.artifactLedger.length > 0) {
        context.artifactLedger = mergeArtifactLedger(
          context.artifactLedger ?? [],
          update.artifactLedger,
        );
        context.sessionSnapshotDirty = true;
      }
      // FEATURE_072: route post-compact attachments natively onto the
      // CompactionEntry instead of letting them be re-serialized as regular
      // `message` entries. `messages` may still contain inline `[Post-compact:`
      // entries from agent.ts's `injectPostCompactAttachments` call
      // (P4 belt-and-suspenders); `applySessionCompaction` defensively strips
      // them before building lineage entries.
      context.lineage = durableLineage;
      const currentTokens = estimateTokens(messages);
      context.contextTokenSnapshot = {
        currentTokens,
        baselineEstimatedTokens: currentTokens,
        source: 'estimate',
      };
      touchContext(context);
      setLiveTokenCount(currentTokens);
      if (options.runtimeRunner) {
        // The embedded/daemon Runtime has already acknowledged its canonical
        // durable commit before invoking this in-process projection. Avoid a
        // second writer while still releasing the UI's exact in-memory copy.
        if (context.lineage === durableLineage) {
          context.lineage = evictOldIslandMessageContent(durableLineage);
        }
        return;
      }
      const persist = persistContextStateRef.current;
      if (!persist) {
        throw new Error('Ink REPL compaction persistence is not initialized.');
      }
      try {
        await persist();
        if (context.lineage === durableLineage) {
          context.lineage = evictOldIslandMessageContent(durableLineage);
        }
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'repl:compaction',
          level: 'error',
          message: 'Failed to durably persist compacted session history.',
          detail: error,
        });
        throw error;
      }
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
      // Route through the layer-aware emitter so the compact notice
      // renders inline with the managed worker output instead of
      // stacking right below the user prompt when a managed task is
      // active (compaction fires at the top of an agent turn, before
      // any foreground output, so without routing it anchors to the
      // main history above the managed foreground ledger).
      emitInfoItemToCorrectLayer({
        type: "info",
        icon: "\u2728",
        text: `Context auto-compacted (was ~${prevK}k tokens)`,
      }, 'compact');
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
      contextTokenSnapshot?: import("@kodax-ai/coding").KodaXContextTokenSnapshot;
      scope?: 'parent' | 'worker';
    }) => {
      // FEATURE_072: only parent-scoped iteration events may mutate
      // context.contextTokenSnapshot. Worker events still update the live
      // token display so the AMA status bar reflects in-flight progress,
      // but they must not overwrite the parent's snapshot — doing so was the
      // root cause of the v0.7.18 regression where a worker's short context
      // masquerading as the parent's context showed a deflated number that
      // then refused to update back. The v0.7.19 P6 finally-block cleanup
      // papers over this; Phase D of FEATURE_072 retires P6 once this scope
      // gate is validated.
      if (info.scope !== 'worker') {
        context.contextTokenSnapshot = info.contextTokenSnapshot;
      }
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
    beginOutputSegment,
    addLiveToolCall,
    updateExecutingTool,
    finalizeLiveToolCall,
    finalizeAllExecutingToolCalls,
    findLatestExecutingTool,
    resetLiveToolCalls,
    setLiveToolCalls,
    completeChildActivityRecord,
    routeWorkflowLiveOnlyNotice,
    upsertChildActivityRecord,
    emitInfoItemToCorrectLayer,
    streamingState.currentTool,
  ]);

  // Helper function to show confirmation dialog

  const showConfirmDialog = (
    tool: string,
    input: Record<string, unknown>,
    runtimeGrantSuggestions?: readonly ReplRuntimePermissionGrantSuggestion[],
    signal?: AbortSignal,
  ): Promise<ConfirmResult> => {
    const basePrompt = buildToolConfirmationPrompt(tool, input);
    const scopeLabels = runtimeGrantSuggestions?.map((suggestion) => suggestion.label) ?? [];
    const runtimeLines = runtimeGrantSuggestions === undefined
      ? []
      : [
          RUNTIME_PERMISSION_PENDING_NOTICE,
          ...scopeLabels.map((label) => `Runtime scope: ${label}`),
        ];
    const promptText = runtimeLines.length > 0
      ? `${basePrompt}\n${runtimeLines.join('\n')}`
      : basePrompt;

    return confirmationDialogQueueRef.current(() => {
      if (signal?.aborted) return Promise.resolve({ confirmed: false });
      // FEATURE_203 (v0.7.45): commit any pending streamed text before raising
      // the approval popup, so the popup never appears mid-sentence.
      flushForegroundTextBuffer();

      return new Promise<ConfirmResult>((resolve) => {
        const settle = (result: ConfirmResult): void => {
          signal?.removeEventListener('abort', onAbort);
          if (confirmResolveRef.current === settle) {
            confirmResolveRef.current = null;
          }
          resolve(result);
        };
        const onAbort = (): void => {
          if (confirmResolveRef.current !== settle) return;
          setConfirmRequest(null);
          settle({ confirmed: false });
        };
        confirmResolveRef.current = settle;
        signal?.addEventListener('abort', onAbort, { once: true });
        setConfirmRequest({
          tool,
          input,
          prompt: promptText,
          ...(runtimeGrantSuggestions !== undefined ? { runtimeGrantSuggestions } : {}),
        });
      });
    });
  };

  const requestRuntimePermission: ReplRuntimePermissionPrompt = async (request, promptContext) => {
    const result = await showConfirmDialog(
      request.toolName,
      {
        ...request.input,
        ...(request.reason !== undefined ? { _reason: request.reason } : {}),
        ...(request.executionCwd !== undefined ? { _executionCwd: request.executionCwd } : {}),
        ...(request.risk !== undefined ? { _runtimeRisk: request.risk } : {}),
      },
      request.grantSuggestions ?? [],
      promptContext.signal,
    );
    return resolveReplRuntimePermissionDecision(request, result);
  };

  // FEATURE_092 v0.7.34 hotfix-3: keep the bootstrap's currentConfig ref in
  // sync with React state. The auto-mode bootstrap was created in
  // `runInkInteractiveMode` (before mount) and its
  // `getCurrentProviderName` / `getCurrentModel` / `getCurrentPermissionMode`
  // closures read from `inkCurrentConfigRef`. Without this effect, those
  // closures would forever return the startup-time provider/model and
  // mid-session `/model` and `/provider` swaps would not retarget the
  // classifier. The effect body only writes a ref (no setState), so it
  // does not schedule a re-render itself.
  useEffect(() => {
    setCurrentConfigRef(currentConfig);
  }, [currentConfig, setCurrentConfigRef]);

  // FEATURE_222 — register the live ask-user surface so MCP elicitation (which a
  // server can send at any later point, long after the MCP provider was built)
  // can prompt the user through the same Ink dialogs. Handlers resolve the
  // current streaming events at CALL time (no stale closures); cleared on
  // unmount so a torn-down / headless state declines.
  useEffect(() => {
    const resolve = (): ReturnType<typeof createStreamingEvents> => createStreamingEvents();
    setActiveUserInteraction({
      askUser: (options, context) => {
        const fn = resolve().askUser;
        if (!fn) throw new Error("askUser surface unavailable");
        return fn(options, undefined, context);
      },
      askUserMulti: async (options, context) => {
        const fn = resolve().askUserMulti;
        return fn ? fn(options, undefined, context) : undefined;
      },
      askUserInput: async (options, context) => {
        const fn = resolve().askUserInput;
        return fn ? fn(options, undefined, context) : undefined;
      },
    });
    return () => setActiveUserInteraction(undefined);
  }, [createStreamingEvents]);

  // Run agent round
  const runAgentRound = async (
    opts: KodaXOptions,
    prompt: string,
    // FEATURE_072: default falls back to the lineage-derived view when a
    // lineage exists (authoritative source). Callers that explicitly pass an
    // initialMessages argument (fork path, resume path) keep their behaviour.
    initialMessages: KodaXMessage[] = context.lineage
      ? getSessionMessagesFromLineage(context.lineage, context.lineage.activeEntryId)
      : context.messages,
    inputArtifacts?: readonly KodaXInputArtifact[],
  ): Promise<KodaXResult> => {
    if (!options.runtimeRunner) autoModeBootstrap.resetTurn();
    outputSegmentProjectionRef.current = createOutputSegmentProjection();
    managedOutputSegmentItemsRef.current = {};
    const events = {
      ...createStreamingEvents(),
      getCostReport: inkCostReportRef,
      // FEATURE_246 (P1 review): live progress for the model-launched run_workflow
      // path — the coding host forwards this turn's workflow process events here.
      onWorkflowProcessEvent: handleInlineWorkflowProcessEvent,
      // ADR-049: each workflow child agent's completion digest lands in the
      // transcript (parity with the slash /workflow path + dispatch children).
      // Infer locale from the child agent's OWN summary/name (its actual output
      // language) — mirroring the console path (repl.ts) — instead of the
      // live-status ref, which is cleared on the workflow's terminal event and is
      // often stale by the time a child (especially the last) digest fires,
      // silently defaulting the digest chrome to English. Fall back to the
      // live-status locale only when the event carries no text (e.g. a failure
      // event with only an error string).
      onWorkflowAgentDigest: ({ runId, event }: KodaXWorkflowAgentDigestEvent): void => {
        const data = event.data ?? {};
        const summary = typeof data.summary === "string" ? data.summary : undefined;
        const name = typeof data.name === "string" ? data.name : undefined;
        const live = workflowLiveStatusRef.current;
        const locale = summary !== undefined || name !== undefined
          ? inferWorkflowLocaleFromParts(summary, name)
          : (live?.runId === runId ? live.locale ?? "en" : "en");
        const digest = formatWorkflowAgentDigest(event, locale, runId);
        if (!digest) return;
        // MED-6 layering: while the managed worker that spawned this workflow
        // still owns the foreground turn, static history renders ABOVE the live
        // foreground stack and is only committed at round-end — so a raw
        // appendHistoryItemsWithPersistence here pins the digest ABOVE the whole
        // worker turn (right under the spawning query, before the worker's own
        // thinking/tools). Route through the foreground ledger so it commits
        // inline in temporal order (same precedent as onMidTurnUserMessages /
        // emitInfoItemToCorrectLayer). Fall back to the persisted append only for
        // a true background arrival after the round ended (no foreground owner),
        // where end-of-history is the correct position.
        if (managedForegroundOwnerRef.current.workerId) {
          appendManagedForegroundLedgerItem({
            id: `wf-digest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: "assistant",
            text: digest,
            timestamp: Date.now(),
          } as HistoryItem);
        } else {
          appendHistoryItemsWithPersistence([{ type: "assistant", text: digest }]);
        }
      },
    };

    // Get skills system prompt snippet for progressive disclosure (Issue 056)

    // Issue 064: Pass projectRoot to prevent singleton reset
    const skillRegistry = getSkillRegistry(context.gitRoot);
    const skillsPrompt = skillRegistry.getSystemPromptSnippet();
    const managedRunContext = buildManagedRunContext(
      opts.context,
      context.gitRoot,
      context.contextTokenSnapshot,
      skillsPrompt,
      context.runtimeInfo?.executionCwd,
    );
    if (inputArtifacts && inputArtifacts.length > 0) {
      managedRunContext.inputArtifacts = [...inputArtifacts];
    }
    // FEATURE_074: live plan-mode check for child-agent inheritance. The closure
    // reads permissionModeRef.current lazily, so mid-run parent-mode toggles
    // (plan ↔ accept-edits) propagate into in-flight children.
    managedRunContext.planModeBlockCheck = (tool, input) => {
      if (permissionModeRef.current !== 'plan') return null;
      return getPlanModeBlockReason(tool, input, context.gitRoot ?? context.runtimeInfo?.executionCwd ?? process.cwd());
    };

    const standaloneShellBoundary = options.runtimeRunner
      ? undefined
      : createStandaloneShellPermissionBoundary({
          getPermissionMode: () => permissionModeRef.current,
          getAutoGuardrail: autoModeBootstrap.getGuardrail,
          shellSandbox: managedRunContext.shellSandbox,
          trustedTextMutationHost: managedRunContext.trustedTextMutationHost,
          userConfigDir: managedRunContext.configHome,
          projectRoot: context.gitRoot ?? context.runtimeInfo?.executionCwd ?? process.cwd(),
          execPolicy: options.execPolicy,
          resolvePlanHostExecution: (request) => (
            isBashReadCommandAutoAllowed(
              request.command,
              context.gitRoot ?? process.cwd(),
              context.runtimeInfo?.executionCwd ?? context.gitRoot ?? process.cwd(),
            )
              ? true
              : '[Blocked] Plan mode cannot escalate this command to unsandboxed host execution.'
          ),
          requestUserPermission: async (request, reason) => {
            const input = { ...request.toolInput, command: request.command };
            const mode = permissionModeRef.current;
            if (
              reason === 'mode_boundary'
              && mode === 'accept-edits'
              && await isToolCallAllowed(
                'bash',
                input,
                alwaysAllowToolsRef.current,
                bashPrefixExtractorRef.current ?? undefined,
              )
            ) return true;
            const result = await showConfirmDialog('bash', input, undefined, getSignal());
            if (
              result.confirmed
              && result.always
              && reason === 'mode_boundary'
              && permissionModeRef.current === 'accept-edits'
            ) {
              saveAlwaysAllowToolPattern('bash', input, false);
              alwaysAllowToolsRef.current = loadAlwaysAllowTools();
            }
            return result.confirmed;
          },
        });

    const runOptions: KodaXOptions = {
      ...opts,
      guardrails: standaloneShellBoundary !== undefined
        && isAutoMode(permissionModeRef.current)
        ? [standaloneShellBoundary.autoGuardrail]
        : undefined,
      session: {
        ...opts.session,
        initialMessages,
        initialExtensionState: context.extensionState ?? {},
        initialExtensionRecords: context.extensionRecords ?? [],
      },
      context: standaloneShellBoundary === undefined
        ? managedRunContext
        : {
            ...managedRunContext,
            shellSandbox: standaloneShellBoundary.shellSandbox,
            authorizeShellHostExecution: standaloneShellBoundary.authorizeShellHostExecution,
            ...(standaloneShellBoundary.trustedTextMutationHost === undefined
              ? {}
              : { trustedTextMutationHost: standaloneShellBoundary.trustedTextMutationHost }),
          },
      events,
      abortSignal: getSignal(),
    };

    try {
      if (options.runtimeRunner) {
        return await options.runtimeRunner({
          options: runOptions,
          prompt,
          sessionId: context.sessionId,
          permissionMode: permissionModeRef.current,
          autoModeSettings,
          requestPermission: requestRuntimePermission,
          legacyPermissionHook: true,
        });
      }
      return await runManagedTask(runOptions, prompt);
    } finally {
      // FEATURE_090 (v0.7.32) — drain self-modify pending resolver swaps
      // at the conversation-turn boundary. The G1 deferred-swap guarantee
      // protects the in-flight Runner.run by holding new versions in a
      // pending queue; activating them here means the next runAgentRound
      // resolves the modified agent. `finally` so abort / error paths
      // also drain (operator-approved swaps stick regardless of run
      // outcome — staying with the prior version on error would silently
      // diverge from disk state).
      drainPendingSwaps();
    }
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
    const extensionSessionPayload = {
      ...(context.extensionStateDirty ? { extensionState: context.extensionState ?? {} } : {}),
      ...(context.extensionRecordsDirty ? { extensionRecords: context.extensionRecords ?? [] } : {}),
    };
    const sessionPayload = buildHostSessionPayload({
      messages: context.messages,
      title,
      gitRoot: context.gitRoot ?? "",
      runtimeInfo: context.runtimeInfo,
      tag: currentOptionsRef.current.session?.tag,
      uiHistory: persistedUiHistory,
      lineage,
      artifactLedger: context.artifactLedger,
      ...extensionSessionPayload,
    });
    await persistHostSessionPayload(
      storage,
      context.sessionId,
      sessionPayload,
      context.sessionSnapshotDirty === true,
    );
    context.extensionStateDirty = false;
    context.extensionRecordsDirty = false;
    context.sessionSnapshotDirty = false;
    if (memDiagEnabled()) {
      memDiagSnapshot('persist', buildMemDiagBreakdown(
        context.messages, lineage,
        {
          historyItems: historyRef.current,
          foregroundItems: managedForegroundTurnItemsRef.current,
          streamingResponse: streamingStateRef.current.currentResponse,
          streamingThinking: streamingStateRef.current.thinkingContent,
          persistedUiHistory: persistedUiHistoryRef.current,
        },
      ));
    }
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
          void flushPendingPersistContextState()
            .catch(reportBackgroundSessionPersistenceError);
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
      await persistContextStateQueueRef.current.catch(
        reportBackgroundSessionPersistenceError,
      );
      await persistContextStateRef.current?.().catch(
        reportBackgroundSessionPersistenceError,
      );
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
    void persistContextStateInBackground(nextUiHistory)
      .catch(reportBackgroundSessionPersistenceError);
  }, [persistContextStateInBackground]);

  const appendHistoryItemsWithPersistence = useCallback((items: readonly CreatableHistoryItem[]) => {
    if (items.length === 0) {
      return;
    }
    // FEATURE_212 (v0.7.45) — one dispatch for the batch (was a per-item loop).
    addHistoryItems([...items]);
    persistHistoryAdditionsInBackground(items);
  }, [addHistoryItems, persistHistoryAdditionsInBackground]);

  const appendHistoryItemsToCurrentSnapshot = useCallback((items: readonly CreatableHistoryItem[]) => {
    if (items.length === 0) {
      return;
    }
    // FEATURE_212 (v0.7.45) — one dispatch for the batch (was a per-item loop).
    addHistoryItems([...items]);
    persistedUiHistoryRef.current = appendPersistedUiHistorySnapshot(
      persistedUiHistoryRef.current,
      items,
    );
  }, [addHistoryItems]);

  useEffect(() => {
    appendHistoryItemsWithPersistenceRef.current = appendHistoryItemsWithPersistence;
    return () => {
      appendHistoryItemsWithPersistenceRef.current = null;
    };
  }, [appendHistoryItemsWithPersistence]);

  const recordCompletedAgentRound = useCallback(async (result: KodaXResult) => {
    flushForegroundTextBuffer();
    const sidecarMessageDelivered = sidecarMessageDeliveredRef.current;
    sidecarMessageDeliveredRef.current = false;
    context.messages = result.messages;
    context.contextTokenSnapshot = result.contextTokenSnapshot;
    applyRuntimeSessionSnapshot(context, result);
    reconcileContextLineage(result.messages);

    // Issue 117: When the round failed (API error, etc.), skip the full
    // finalization that emits routing diagnostics and treats partial text as
    // the final answer.  Only persist foreground items the user already saw
    // and add a visible incomplete indicator.
    const roundFailed = result.success === false && !result.interrupted;

    const finalThinking = getThinkingContent().trim();
    const finalResponse = resolveCompletedAssistantText(
      result.messages,
      getFullResponse(),
      result.managedTask?.verdict.summary,
      result.lastText,
    );
    const foregroundWorkerTitle = managedForegroundLedgerRef.current.workerTitle;
    const managedForegroundRoundItems = [...managedForegroundTurnItemsRef.current];
    const hasManagedForegroundLedger = managedForegroundRoundItems.length > 0;
    // FEATURE_213 (v0.7.45) — a mid-turn user message that this round commits
    // inline (below) is now durable; mark its id so the post-commit ledger
    // clear's rescue pass does not double-add it.
    markLedgerUserItemsCommitted(managedForegroundRoundItems);
    // The foreground ledger may contain only tool_group/thinking items without a
    // substantive assistant text block.  When that happens we must still append
    // the resolved finalResponse so the user sees the answer.
    const foregroundCoversAssistantText = hasManagedForegroundLedger
      && managedForegroundRoundItems.some(
        (item) => item.type === "assistant"
          && "text" in item
          && hasSubstantiveManagedAssistantText(
            String(item.text ?? ""),
            foregroundWorkerTitle,
          ),
      );
    const durableManagedForegroundRoundItems = managedForegroundRoundItems.filter((item) => (
      item.type !== "assistant"
      || !("text" in item)
      || hasSubstantiveManagedAssistantText(String(item.text ?? ""), foregroundWorkerTitle)
    ));
    const needsFinalResponseItem = !roundFailed && finalResponse && !foregroundCoversAssistantText;
    const managedRoundEvents = [...managedRoundEventHistoryRef.current];
    const managedTranscriptCandidates = buildManagedTaskTranscriptItems(result, {
      sidecarMessageDelivered,
    });
    // Skip routing diagnostics for failed rounds — they mislead users into
    // thinking the task completed successfully.
    const managedTranscriptItems = roundFailed
      ? []
      : managedRoundEvents.length === 0
        ? (TRANSCRIPT_HARNESS_MARKERS_ENABLED
            ? managedTranscriptCandidates
            : managedTranscriptCandidates.filter(
                (text) => !isCompletionTranscriptItem(text),
              ))
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
      ...durableManagedForegroundRoundItems.map((item) => toCreatableHistoryItem(item)),
      ...roundHistoryItems,
      ...(roundFailed ? [] : managedRoundEvents.map((item) => toCreatableHistoryItem(item))),
      ...managedTranscriptItems.map((text) => toManagedTranscriptEventItem(text)),
      ...(needsFinalResponseItem
        ? [{
            type: "assistant" as const,
            text: result.interrupted ? `${finalResponse}\n\n[Interrupted]` : finalResponse,
          }]
        : !finalResponse && !foregroundCoversAssistantText && !result.interrupted && !roundFailed
          ? [{ type: "info" as const, text: "[No response text was produced for this round]" }]
          : []),
    ];
    const nextUiHistory = appendPersistedUiHistorySnapshot(
      persistedUiHistoryRef.current,
      persistedAdditions,
    );

    clearThinkingContent();
    clearResponse();

    // FEATURE_212 (v0.7.45) — collapse the per-item addHistoryItem loops into a
    // single bulk dispatch. Previously every round-end added K items via K
    // dispatches → K re-renders, each re-rendering the growing transcript:
    // per-round O(K·history). This is the hot path (every agent turn), the
    // dominant "越用越卡 / second-query lag" cost. One dispatch = one re-render.
    // Order + conditions preserved exactly (foreground → round → [transcript →
    // events, unless failed] → final/empty-notice).
    const roundUiAdditions: CreatableHistoryItem[] = [
      ...durableManagedForegroundRoundItems.map((item) => toCreatableHistoryItem(item)),
      ...roundHistoryItems,
      ...(roundFailed
        ? []
        : [
            ...managedTranscriptItems.map((transcript) => toManagedTranscriptEventItem(transcript)),
            ...managedRoundEvents.map((eventItem) => toCreatableHistoryItem(eventItem)),
          ]),
      ...(needsFinalResponseItem
        ? [{
            type: "assistant" as const,
            text: result.interrupted ? `${finalResponse}\n\n[Interrupted]` : finalResponse,
          }]
        // No assistant text was produced — neither from the foreground ledger
        // nor from the resolved result. Surface a visible notice so the user is
        // aware the response was empty rather than silently showing nothing.
        : !finalResponse && !foregroundCoversAssistantText && !result.interrupted && !roundFailed
          ? [{ type: "info" as const, text: "[No response text was produced for this round]" }]
          : []),
    ];
    addHistoryItems(roundUiAdditions);

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
    void persistContextStateInBackground(nextUiHistory)
      .catch(reportBackgroundSessionPersistenceError);
  }, [
    addHistoryItems,
    clearIterationHistory,
    clearToolInputContent,
    clearResponse,
    clearThinkingContent,
    context,
    flushForegroundTextBuffer,
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

    // FEATURE_149 Phase 1.1: state writes happen synchronously; caller's
    // `await onBeforeQueuedRound(...)` yields a microtask which is enough
    // for React's reducer dispatch to settle before runRound reads context.
    // The previous `setTimeout(50)` floor was a cargo-culted wait that added
    // ~50ms to every queued-prompt injection without any guaranteed semantics.
    addHistoryItem({
      type: "user",
      text: normalizedPrompt,
    });
    setSubmitCounter((prev) => prev + 1);
    touchContext(context);
  }, [addHistoryItem, context]);

  const runQueuedUserSkillRound = useCallback(async (
    rawInput: string,
  ): Promise<KodaXResult | undefined> => {
    const mainContextTokenSnapshot = context.contextTokenSnapshot;
    let invocation;
    try {
      invocation = await resolveUserSkillInvocation(rawInput, {
        workingDirectory: currentOptionsRef.current.context?.executionCwd ?? process.cwd(),
        projectRoot: context.gitRoot ?? undefined,
        sessionId: context.sessionId,
        environment: {},
        executeDynamicContext: context.skillDynamicContext?.execute,
        disableDynamicContext: context.skillDynamicContext?.disable,
      });
    } catch (error) {
      if (!(error instanceof MultipleUserSkillReferencesError)) throw error;
      const message = `[${error.message}]`;
      addHistoryItem({ type: "info", text: message });
      return preserveQueuedSkillContextSnapshot({
        success: false,
        lastText: message,
        signal: "BLOCKED",
        signalReason: error.message,
        messages: [...context.messages],
        sessionId: context.sessionId,
      }, mainContextTokenSnapshot);
    }
    if (!invocation) {
      const parsed = isSlashCommandText(rawInput) ? parseCommand(rawInput.trim()) : null;
      if (!parsed) return undefined;
      const unknownName = parsed.skillInvocation?.name ?? parsed.command;
      const message = `[Unknown command: /${unknownName}. Type /help for available commands]`;
      return preserveQueuedSkillContextSnapshot({
        success: true,
        lastText: message,
        messages: [
          ...context.messages,
          { role: "user", content: rawInput },
          { role: "assistant", content: message },
        ],
        sessionId: context.sessionId,
      }, mainContextTokenSnapshot);
    }

    const prepared = await prepareInvocationExecution(
      {
        ...currentOptionsRef.current,
        provider: currentConfig.provider,
        thinking: currentConfig.thinking,
        reasoningMode: currentConfig.reasoningMode,
      },
      invocation,
      rawInput,
      (message) => addHistoryItem({ type: "info", text: message }),
    );
    if (prepared.mode === "manual" || !prepared.prompt || !prepared.options) {
      if (prepared.manualOutput) {
        addHistoryItem({ type: "info", text: prepared.manualOutput });
      }
      await prepared.finalize();
      return preserveQueuedSkillContextSnapshot({
        success: false,
        lastText: '',
        signal: 'BLOCKED',
        signalReason: prepared.manualOutput ?? 'Queued Skill invocation was blocked.',
        messages: [...context.messages],
        sessionId: context.sessionId,
      }, mainContextTokenSnapshot);
    }

    try {
      const initialMessages = prepared.mode === "fork"
        ? []
        : context.lineage
          ? getSessionMessagesFromLineage(context.lineage, context.lineage.activeEntryId)
          : context.messages;
      const result = await runAgentRound(prepared.options, prepared.prompt, initialMessages);
      await prepared.finalize();
      if (prepared.mode !== "fork") return result;

      const forkUser = result.messages.find((message) => message.role === "user");
      const forkAssistant = result.messages.slice().reverse().find((message) => message.role === "assistant");
      return preserveQueuedSkillContextSnapshot({
        ...result,
        messages: [
          ...context.messages,
          ...(forkUser ? [forkUser] : []),
          ...(forkAssistant ? [forkAssistant] : []),
        ],
      }, mainContextTokenSnapshot);
    } catch (error) {
      await prepared.finalize(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }, [
    addHistoryItem,
    context,
    currentConfig.provider,
    currentConfig.reasoningMode,
    currentConfig.thinking,
    runAgentRound,
  ]);

  const runQueueableAgentSequence = useCallback(async (
    initialPrompt: string,
    runRound: (prompt: string) => Promise<KodaXResult>,
  ) => {
    // Issue 116: capture generation at sequence start so we can detect
    // if the user submitted a new prompt (Ctrl+C then new input) while
    // this sequence was still completing.
    const sequenceGeneration = promptGenerationRef.current;
    userInterruptedRef.current = false;
    interruptPersistenceQueuedRef.current = false;
    sidecarMessageDeliveredRef.current = false;
    setCanQueueFollowUps(true);
    try {
      return await runQueuedPromptSequence({
        initialPrompt,
        runRound,
        shiftPendingPrompt: shiftPendingInput,
        peekPendingPromptDelivery: peekPendingInputDelivery,
        onRoundComplete: async (result) => {
          // Issue 116: discard results if a newer prompt has superseded this sequence
          if (promptGenerationRef.current !== sequenceGeneration) return;
          await recordCompletedAgentRound(result);
        },
        onBeforeQueuedRound: async (prompt) => {
          userInterruptedRef.current = false;
          interruptPersistenceQueuedRef.current = false;
          await stageQueuedPrompt(prompt);
        },
        shouldContinue: (result) => !userInterruptedRef.current && result.success !== false,
        shouldDrainQueuedPrompts: () => {
          if (!workflowIntentBoundaryQueueLockedRef.current) {
            return true;
          }
          if (streamingStateRef.current.pendingInputs.length === 0) {
            workflowIntentBoundaryQueueLockedRef.current = false;
            return true;
          }
          return false;
        },
      });
    } finally {
      setCanQueueFollowUps(false);
    }
  }, [peekPendingInputDelivery, recordCompletedAgentRound, shiftPendingInput, stageQueuedPrompt]);

  const recoverCurrentSession = useCallback(async (prompt?: string): Promise<SessionRecoverStatus> => {
    if (context.messages.length === 0) {
      return "empty";
    }
    const allowed = enforceSessionTransitionGuard(
      currentConfig,
      "Recovering into a new session",
      logSessionTransitionGuard,
    );
    if (!allowed) {
      return "blocked";
    }

    const sourceSessionId = context.sessionId;
    const sourceLineage = context.lineage ?? reconcileContextLineage(context.messages);
    context.lineage = sourceLineage;
    const sourceArtifactLedger = context.artifactLedger
      ? structuredClone(context.artifactLedger)
      : undefined;
    const seed = buildRecoverySeed({
      sourceSessionId,
      messages: context.messages,
      lineage: sourceLineage,
      artifactLedger: sourceArtifactLedger,
      reason: "provider session recovery",
    });
    const sourceTitle = context.title || extractTitle(context.messages);

    await storage.save(context.sessionId, buildHostSessionPayload({
      messages: context.messages,
      title: sourceTitle,
      gitRoot: context.gitRoot ?? "",
      runtimeInfo: context.runtimeInfo,
      tag: currentOptionsRef.current.session?.tag,
      uiHistory: persistedUiHistoryRef.current,
      lineage: sourceLineage,
      artifactLedger: sourceArtifactLedger,
      extensionState: context.extensionState,
      extensionRecords: context.extensionRecords,
    }));

    const nextSessionId = generateSessionId();
    const seedLineage = createSessionLineage(seed.messages);
    await storage.save(nextSessionId, buildHostSessionPayload({
      messages: seed.messages,
      title: seed.title,
      gitRoot: context.gitRoot ?? "",
      runtimeInfo: context.runtimeInfo,
      tag: currentOptionsRef.current.session?.tag,
      uiHistory: [],
      lineage: seedLineage,
      artifactLedger: sourceArtifactLedger,
    }));

    const now = new Date().toISOString();
    context.sessionId = nextSessionId;
    context.messages = seed.messages;
    context.uiHistory = [];
    context.title = seed.title;
    context.contextTokenSnapshot = undefined;
    context.lineage = seedLineage;
    context.artifactLedger = sourceArtifactLedger;
    context.extensionState = undefined;
    context.extensionRecords = undefined;
    context.extensionStateDirty = false;
    context.extensionRecordsDirty = false;
    context.sessionSnapshotDirty = false;
    context.createdAt = now;
    context.lastAccessed = now;
    persistedUiHistoryRef.current = [];
    currentOptionsRef.current.session = {
      ...currentOptionsRef.current.session,
      id: nextSessionId,
    };

    setLiveTokenCount(null);
    clearUIHistory();
    setTodoItems([]);
    getActivePasteStore()?.reset();
    setSessionId(nextSessionId);
    teamModeHandle?.writer.update({ sessionId: nextSessionId });

    appendHistoryItemsToCurrentSnapshot([{
      type: "info",
      text: `Recovered into new session ${nextSessionId}\nSource session saved: ${sourceSessionId}\nRaw provider history was not replayed.`,
    }]);

    await storage.save(nextSessionId, buildHostSessionPayload({
      messages: context.messages,
      title: context.title,
      gitRoot: context.gitRoot ?? "",
      runtimeInfo: context.runtimeInfo,
      tag: currentOptionsRef.current.session?.tag,
      uiHistory: persistedUiHistoryRef.current,
      lineage: context.lineage,
      artifactLedger: context.artifactLedger,
    }));

    const continuation = normalizeRecoveryPrompt(prompt);
    try {
      await stageQueuedPrompt(continuation);
      await runQueueableAgentSequence(
        continuation,
        async (nextPrompt) => {
          const skillResult = await runQueuedUserSkillRound(nextPrompt);
          if (skillResult) return skillResult;
          const preparedArtifacts = preparePromptInputArtifacts(
            nextPrompt,
            currentOptionsRef.current.context?.executionCwd ?? process.cwd(),
          );
          for (const warning of preparedArtifacts.warnings) {
            addHistoryItem({ type: "info", text: warning });
          }
          return runAgentRound(
            currentOptionsRef.current,
            preparedArtifacts.promptText,
            context.messages,
            preparedArtifacts.inputArtifacts,
          );
        },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      appendHistoryItemsWithPersistence([{
        type: "error",
        text: `[Recover failed] ${message}`,
      }]);
      return "failed";
    }
    return "recovered";
  }, [
    addHistoryItem,
    appendHistoryItemsWithPersistence,
    appendHistoryItemsToCurrentSnapshot,
    clearUIHistory,
    context,
    currentConfig,
    reconcileContextLineage,
    runQueueableAgentSequence,
    runQueuedUserSkillRound,
    stageQueuedPrompt,
    storage,
    teamModeHandle,
  ]);

  // Issue 120: drain pending inputs left over from skill / plan-mode rounds.
  // Hands the first queued prompt to `runQueueableAgentSequence`, which then
  // drains the remainder via its internal loop. Keeps behaviour identical to
  // the main conversation path once the skill / plan wrapper has returned.
  const drainPendingInputsAsFollowUps = useCallback(async () => {
    const first = shiftPendingInput();
    if (!first || !first.trim()) {
      return;
    }
    const normalized = first.trim();
    await stageQueuedPrompt(normalized);
    await runQueueableAgentSequence(
      normalized,
      async (prompt) => (
        await runQueuedUserSkillRound(prompt)
        ?? runAgentRound(currentOptionsRef.current, prompt)
      ),
    );
  }, [
    runAgentRound,
    runQueueableAgentSequence,
    runQueuedUserSkillRound,
    shiftPendingInput,
    stageQueuedPrompt,
  ]);

  const appendLastAssistantToHistory = useCallback((messages: KodaXMessage[]) => {
    const lastAssistant = messages[messages.length - 1];
    if (lastAssistant?.role !== "assistant") {
      return;
    }

    const historySeeds = extractHistorySeedsFromMessage(lastAssistant);
    // FEATURE_212 — one dispatch for the batch (was a per-item loop).
    addHistoryItems(historySeeds.map(seedToHistoryItem));
  }, [addHistoryItems]);

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

    // Issue 120: open the follow-up queue gate while the skill / prompt
    // invocation is running so inputs pressed during streaming are queued
    // instead of silently dropped.
    setCanQueueFollowUps(true);
    try {
      // FEATURE_072: prefer lineage-derived view for non-fork dispatches.
      const initialMessages = prepared.mode === "fork"
        ? []
        : context.lineage
          ? getSessionMessagesFromLineage(context.lineage, context.lineage.activeEntryId)
          : context.messages;
      // Issue 116: capture generation at call time to detect supersession after await
      const roundGeneration = promptGenerationRef.current;
      const result = await runAgentRound(prepared.options, prepared.prompt, initialMessages);

      // Issue 116: discard results from a superseded round.
      // If the user Ctrl+C'd and submitted a new prompt while this round was
      // still completing (processing AbortError), promptGenerationRef will
      // have been incremented. Applying stale results would overwrite the
      // new round's context and inject incomplete tool calls into history.
      if (promptGenerationRef.current !== roundGeneration) {
        await prepared.finalize();
      } else {
        const persistedHistoryBase = persistedUiHistoryRef.current;
        const persistedAdditions: CreatableHistoryItem[] = [];

        if (prepared.mode === "fork") {
          // FEATURE_076 Q3: after the round-boundary reshape,
          // result.messages is a clean {user, assistant} dialog. Push
          // the user fork prompt first so context.messages retains
          // conversation continuity (previously only the assistant
          // message landed, leaving the fork prompt missing from
          // saved history).
          const forkUserMsg = result.messages.find((msg) => msg.role === "user");
          if (forkUserMsg) {
            context.messages.push(forkUserMsg);
          }
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

        applyRuntimeSessionSnapshot(context, result);
        await persistContextState(
          appendPersistedUiHistorySnapshot(persistedHistoryBase, persistedAdditions),
        );
        if (memDiagEnabled()) {
          memDiagSnapshot('round-end', buildMemDiagBreakdown(
            context.messages, context.lineage,
            {
              historyItems: historyRef.current,
              foregroundItems: managedForegroundTurnItemsRef.current,
              streamingResponse: streamingStateRef.current.currentResponse,
              streamingThinking: streamingStateRef.current.thinkingContent,
              persistedUiHistory: persistedUiHistoryRef.current,
            },
          ));
        }
        await prepared.finalize();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await prepared.finalize(error);
      setCanQueueFollowUps(false);
      throw error;
    }
    // Issue 120: normal completion — close gate, then drain any prompts the
    // user queued during streaming as regular follow-up rounds. On error the
    // catch above rethrows before reaching this point, so pending inputs stay
    // queued and will be drained by the next successful submission (matches
    // runQueueableAgentSequence's own shouldContinue=false behaviour).
    setCanQueueFollowUps(false);
    await drainPendingInputsAsFollowUps();
  }, [
    addHistoryItem,
    appendLastAssistantToHistory,
    context,
    currentConfig.provider,
    currentConfig.thinking,
    drainPendingInputsAsFollowUps,
    persistContextState,
    reconcileContextLineage,
    runAgentRound,
  ]);

  // Issue 121: when ↑ arrow recalls a history entry whose pasted contents
  // were only kept by hash (e.g. synthesized from session.uiHistory or a
  // future disk-backed input history), hydrate the missing content from
  // the on-disk paste-cache. Best-effort: missing cache hits leave the
  // placeholder literal, which submit will then send as-is.
  const handleHistoryRecall = useCallback(
    async (entry: { text: string; pastedContents: PastedContent[] }) => {
      for (const content of entry.pastedContents) {
        if (content.type !== "text") continue;
        if (content.content) continue; // already hydrated
        if (!content.contentHash) continue;
        try {
          const body = await retrievePastedText(content.contentHash);
          if (body) {
            content.content = body;
          }
        } catch {
          // best-effort — missing cache entry is recoverable on submit
        }
      }
    },
    [],
  );

  // Handle user input submission
  //
  // Issue 121: receives PromptSubmitPayload split into displayText (what
  // went into UI history — may contain `[Pasted text #N]` placeholders) and
  // fullText (what goes to parseCommand / the agent — all placeholders
  // expanded). Keeping them separate is what prevents long pastes from
  // ballooning the transcript while still feeding the LLM the real content.
  const handleSubmit = useCallback(
    async (payload: PromptSubmitPayload) => {
      const { displayText, fullText, pastedContents } = payload;
      // Prevent concurrent execution: ignore input if agent is busy or waiting for tool confirmation
      // Prevent concurrent execution while the agent is busy or awaiting confirmation.
      if (!fullText.trim() || !isRunning || confirmRequest || uiRequest) return;

      // Issue 121: fire-and-forget write of large pasted text to the disk
      // paste-cache. Runs async — never blocks submit.
      //
      // CRITICAL: do NOT mutate `content` in place. These objects reference
      // the session PasteStore map, and stamping `contentHash` there would
      // leak into future Up-arrow recalls + undo snapshots. The hash is
      // only meaningful for entries LOADED from disk (the recall path
      // populates `contentHash` from the persisted JSONL when available).
      for (const content of pastedContents) {
        if (content.type !== "text") continue;
        if (content.content.length < 1024) continue;
        const hash = hashPastedText(content.content);
        void storePastedText(hash, content.content);
      }

      // Hide help panel when submitting.
      setShowHelp(false);

      if (isLoading) {
        if (!canQueueFollowUps) {
          return;
        }
        if (streamingState.pendingInputs.length >= MAX_PENDING_INPUTS) {
          // Queue-limit notice fires while the user is typing a
          // follow-up during an active managed task; route to the
          // correct layer so it does not anchor near the user prompt
          // above the managed foreground ledger.
          emitInfoItemToCorrectLayer({
            type: "info",
            icon: "\u23F3",
            text: `Queued follow-up limit reached (${MAX_PENDING_INPUTS}). Wait for the next round or press Esc to remove the latest item.`,
          }, 'queue-limit');
          return;
        }

        const slashAtHead = isSlashCommandText(fullText);
        const queuedSlash = slashAtHead ? parseCommand(fullText.trim()) : null;
        const targetsRegisteredCommand = queuedSlash !== null
          && queuedSlash.skillInvocation === undefined
          && isRegisteredUserCommand(queuedSlash.command, context.gitRoot ?? undefined);
        // Queue admission is synchronous against the preloaded registry.
        // Dynamic expansion still happens only after the active round yields,
        // avoiding both an async enqueue race and unknown-slash interception.
        const queuedSkillRegistry = getSkillRegistry(context.gitRoot);
        let queuedSkillReference;
        try {
          queuedSkillReference = targetsRegisteredCommand
            ? undefined
            : findQueueableUserSkillReference(
                fullText,
                (name) => queuedSkillRegistry.has(name),
                skillRegistryReadyRef.current,
              );
        } catch (error) {
          if (!(error instanceof MultipleUserSkillReferencesError)) throw error;
          emitInfoItemToCorrectLayer({
            type: "info",
            icon: "\u26A0",
            text: error.message,
          }, "multiple-user-skill-references");
          return;
        }

        // Builtin/extension slash commands still require the immediate command
        // pipeline. Known Skills are different: keep their raw user text in a
        // host-owned queue entry so the trusted Skill resolver can expand it
        // after the active round yields.
        if (slashAtHead && !queuedSkillReference) {
          emitInfoItemToCorrectLayer({
            type: "info",
            icon: "\u26A0",
            text: SLASH_MID_TASK_GUARD_MESSAGE,
          }, SLASH_MID_TASK_GUARD_DEDUPE_KEY);
          return;
        }
        const pendingInputOptions = queuedSkillReference
          ? { delivery: "host" as const }
          : undefined;

        dismissLearningRecovery();

        // FEATURE_149 Phase B1b (v0.7.38) — fast-abort path.
        //
        // When the in-flight tool is tagged `interruptBehavior: 'cancel'`
        // (e.g., bash, dispatch_child_task), waiting for it to finish is
        // antagonistic to the user's redirect. Sequence:
        //   1) queue the new prompt FIRST (so it survives the abort),
        //   2) `abort({ preservePendingInputs: true })` — Substrate's
        //      AbortError terminal resolves with `{ success: true,
        //      interrupted: true }` (run-substrate.ts:1447), so the active
        //      `runQueuedPromptSequence` loop continues into its next
        //      iteration and shifts our queued prompt without losing
        //      isLoading state.
        //
        // For 'wait'-class tools (or untracked tools), keep the legacy
        // queue-without-abort behavior — they finish quickly enough that
        // an abort would cost more than it saves.
        const activeToolName = streamingState.currentTool;
        if (activeToolName) {
          const def = getRegisteredToolDefinition(activeToolName);
          if (def?.interruptBehavior === 'cancel') {
            addPendingInput(fullText, pendingInputOptions);
            abort({ preservePendingInputs: true });
            setInputText("");
            setIsInputEmpty(true);
            setSubmitCounter(prev => prev + 1);
            touchContext(context);
            return;
          }
        }

        // Queue the EXPANDED text — downstream drain path feeds the agent.
        addPendingInput(fullText, pendingInputOptions);
        setInputText("");
        setIsInputEmpty(true);
        setSubmitCounter(prev => prev + 1);
        touchContext(context);
        return;
      }

      dismissLearningRecovery();

      // Banner remains visible - it will scroll up naturally as messages are added
      // (Removed showBanner toggle to keep layout stable)

      // Preserve interrupted streaming response before clearing
      // Use getFullResponse() to include buffered content not yet flushed to currentResponse
      // Issue: When user sends new message during streaming, partial content was lost
      const currentFullResponse = sanitizeInterruptedAssistantText(getFullResponse());
      const currentManagedForegroundItems = managedForegroundTurnItemsRef.current.map((item) => toCreatableHistoryItem(item));
      const hasManagedForegroundLedger = currentManagedForegroundItems.length > 0;
      if (currentManagedForegroundItems.length > 0) {
        // FEATURE_213 — committing the ledger here (incl any mid-turn user
        // message); mark them so the clear below does not re-add via its rescue.
        markLedgerUserItemsCommitted(managedForegroundTurnItemsRef.current);
        appendHistoryItemsToCurrentSnapshot(currentManagedForegroundItems);
      }
      if (!hasManagedForegroundLedger && currentFullResponse) {
        appendHistoryItemsToCurrentSnapshot([{
          type: "assistant",
          text: currentFullResponse + "\n\n[Interrupted]",
        }]);
      }

      // Add user message to UI history — store the DISPLAY form so the
      // transcript stays bounded. fullText already went to the agent below.
      appendHistoryItemsToCurrentSnapshot([{
        type: "user",
        text: displayText,
      }]);
      setInputText("");
      setIsInputEmpty(true);

      // Clear autocomplete suggestions space when message is sent
      // Clear reserved autocomplete space once a message is sent.
      setSubmitCounter(prev => prev + 1);

      if (memDiagEnabled()) {
        memDiagSnapshot('turn-start', buildMemDiagBreakdown(
          context.messages, context.lineage,
          {
            historyItems: historyRef.current,
            foregroundItems: managedForegroundTurnItemsRef.current,
            streamingResponse: streamingStateRef.current.currentResponse,
            streamingThinking: streamingStateRef.current.thinkingContent,
            persistedUiHistory: persistedUiHistoryRef.current,
          },
        ));
      }
      setIsLoading(true);
      userInterruptedRef.current = false;
      interruptPersistenceQueuedRef.current = false;
      // Issue 116: bump generation so stale round completions are discarded
      ++promptGenerationRef.current;
      setManagedTaskStatus(null);
      setWorkflowBuilderMessage(null);
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
      clearChildActivityRecords();
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

      // Process commands — use the EXPANDED text so `/command ...` args that
      // contain paste placeholders resolve to the real content (Issue 121).
      type WorkflowBuilderUiEvent = Parameters<NonNullable<CommandCallbacks['onWorkflowBuilderEvent']>>[0];
      type WorkflowRunMessageUiEvent = Parameters<NonNullable<CommandCallbacks['onWorkflowRunMessage']>>[0];
      const handleWorkflowBuilderEvent = (event: WorkflowBuilderUiEvent): void => {
        if (
          event.stage === "started"
          || event.stage === "generating"
          || event.stage === "validating"
          || event.stage === "ready"
        ) {
          setWorkflowBuilderMessage(event.message);
          return;
        }
        setWorkflowBuilderMessage(null);
      };
      // FEATURE_246 (P1 review): delegate to the component-scoped handler so the
      // slash path and the inline run_workflow path apply run updates identically.
      const handleWorkflowRunUpdate = applyWorkflowRunUiEvent;
      const handleWorkflowRunMessage = (event: WorkflowRunMessageUiEvent): void => {
        if (event.type === "event") {
          return;
        }
        const text = stripAnsi(event.text).trimEnd();
        if (!text.trim()) {
          return;
        }
        if (event.type === "error") {
          addHistoryItem({
            type: "error",
            text,
          });
          return;
        }
        if (event.type === "assistant") {
          appendHistoryItemsWithPersistence([{
            type: "assistant",
            text,
          }]);
          return;
        }
        emitInfoItemToCorrectLayer({
          type: "info",
          text,
        }, "workflow-message");
      };

      const runWorkflowInvocation = async (
        workflow: CommandWorkflowInvocationRequest,
        rawInput: string,
        callbacks: Pick<
          CommandCallbacks,
          | 'createKodaXOptions'
          | 'confirm'
          | 'readline'
          | 'onWorkflowBuilderEvent'
          | 'onWorkflowRunMessage'
          | 'onWorkflowRunUpdate'
        >,
      ): Promise<boolean> => {
        const decision = decideWorkflowInvocation({ source: workflow.source });

        // FEATURE_246 A5 (ADR-047): reached only from a parsed `/workflow`
        // command (the natural-language intercept was removed), so the policy
        // returns 'suggest'. 'none' stays as a defensive guard.
        if (decision.action === 'none') {
          return false;
        }

        const workflowOutput: string[] = [];
        const originalWorkflowLog = console.log;
        console.log = (...args: unknown[]) => {
          workflowOutput.push(formatCapturedConsoleOutput(args));
        };
        let workflowUserCommitted = false;
        const commitWorkflowUserMessage = (): void => {
          if (workflowUserCommitted) {
            return;
          }
          workflowUserCommitted = true;
          context.messages.push({
            role: "user",
            content: rawInput || workflow.request,
          });
        };
        const workflowCallbacks = {
          ...callbacks,
          onWorkflowRunMessage: (event: WorkflowRunMessageUiEvent): void => {
            callbacks.onWorkflowRunMessage?.(event);
            if (event.type !== "assistant") {
              return;
            }
            if (event.final !== true) {
              return;
            }
            const text = stripAnsi(event.text).trimEnd();
            if (!text.trim()) {
              return;
            }
            commitWorkflowUserMessage();
            context.messages.push({
              role: "assistant",
              content: text,
            });
            reconcileContextLineage(context.messages);
            void persistContextStateInBackground()
              .catch(reportBackgroundSessionPersistenceError);
            if (streamingStateRef.current.pendingInputs.length > 0) {
              workflowIntentBoundaryQueueLockedRef.current = true;
            }
          },
        } satisfies typeof callbacks;

        try {
          const outcome = await startGeneratedWorkflowFromRequest({
            request: workflow.request,
            callbacks: workflowCallbacks,
            approval: currentConfig.permissionMode === 'plan' ? 'required' : 'silent',
            presentation: 'agentic',
            sourceLabel: workflow.displayName,
            processSource: workflow.processSource ?? 'command',
            ...(workflow.builtin !== undefined ? { builtin: workflow.builtin } : {}),
            onBuilderEvent: workflowCallbacks.onWorkflowBuilderEvent,
          });
          if (outcome === 'started' && streamingStateRef.current.pendingInputs.length > 0) {
            workflowIntentBoundaryQueueLockedRef.current = true;
          }
          return workflowStartOutcomeConsumesTurn({ outcome });
        } finally {
          setWorkflowBuilderMessage(null);
          console.log = originalWorkflowLog;
          const workflowOutputText = joinCapturedConsoleOutput(
            workflowOutput.filter((item, pos, self) => self.indexOf(item) === pos),
          );
          if (workflowOutputText) {
            addHistoryItem({
              type: "info",
              text: workflowOutputText,
            });
          }
        }
      };

      const parsed = parseCommand(fullText.trim());
      let inlineSkillInvocation;
      try {
        inlineSkillInvocation = parsed || fullText.trim().startsWith('!')
          ? undefined
          : await resolveUserSkillInvocation(fullText.trim(), {
              workingDirectory: currentOptionsRef.current.context?.executionCwd ?? process.cwd(),
              projectRoot: context.gitRoot ?? undefined,
              sessionId: context.sessionId,
              environment: {},
              executeDynamicContext: context.skillDynamicContext?.execute,
              disableDynamicContext: context.skillDynamicContext?.disable,
            });
      } catch (error) {
        if (!(error instanceof MultipleUserSkillReferencesError)) throw error;
        addHistoryItem({ type: "info", text: `[${error.message}]` });
        return;
      }
      if (parsed || inlineSkillInvocation) {
        let slashWorkflowUserCommitted = false;
        const commitSlashWorkflowFinalMessage = (text: string): void => {
          if (parsed?.command !== "workflow") {
            return;
          }
          if (!slashWorkflowUserCommitted) {
            slashWorkflowUserCommitted = true;
            context.messages.push({
              role: "user",
              content: fullText.trim(),
            });
          }
          context.messages.push({
            role: "assistant",
            content: text,
          });
          reconcileContextLineage(context.messages);
          void persistContextStateInBackground()
            .catch(reportBackgroundSessionPersistenceError);
        };
        // Create command callbacks
        const callbacks: CommandCallbacks = {
          getRuntimeStatus: options.getRuntimeStatus,
          validateSetupA2AConfig: options.validateSetupA2AConfig,
          prepareSetupSandbox: options.prepareSetupSandbox,
          inspectSandbox: options.inspectSandbox,
          learning: options.learning,
          getLearningSummary: options.learning ? () => options.learning!.getSnapshot() : undefined,
          openLearningCenter,
          exit: requestGracefulExit,
          saveSession: async () => {
            if (context.messages.length > 0) {
              const title = extractTitle(context.messages);
              context.title = title;
              const lineage = context.lineage ?? reconcileContextLineage(context.messages);
              context.lineage = lineage;
              await storage.save(context.sessionId, buildHostSessionPayload({
                messages: context.messages,
                title,
                gitRoot: context.gitRoot ?? "",
                runtimeInfo: context.runtimeInfo,
                tag: currentOptionsRef.current.session?.tag,
                uiHistory: persistedUiHistoryRef.current,
                lineage,
                artifactLedger: context.artifactLedger,
                extensionState: context.extensionState,
                extensionRecords: context.extensionRecords,
              }));
              context.extensionStateDirty = false;
              context.extensionRecordsDirty = false;
              context.sessionSnapshotDirty = false;
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
            context.extensionState = undefined;
            context.extensionRecords = undefined;
            context.extensionStateDirty = false;
            context.extensionRecordsDirty = false;
            context.sessionSnapshotDirty = false;
            persistedUiHistoryRef.current = [];
            context.createdAt = now;
            context.lastAccessed = now;
            applyInteractiveRuntimeInfo(startupRuntimeInfo);
            currentOptionsRef.current.session = {
              ...currentOptionsRef.current.session,
              id: nextSessionId,
            };
            setLiveTokenCount(null);
            clearUIHistory();
            // FEATURE_151 (v0.7.38): drop the persisted todo plan surface
            // at session boundary so the new session starts visually
            // clean (matches Claude Code's `expandedView` reset semantics
            // on session-new path).
            setTodoItems([]);
            // Issue 121: drop paste-store entries at session boundary so
            // ids restart from 1 and stale refs don't linger into the
            // fresh session. Input history (↑↓) is handled separately.
            getActivePasteStore()?.reset();
            setSessionId(nextSessionId);
            teamModeHandle?.writer.update({ sessionId: nextSessionId });
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
              const currentWorkspaceRuntime = await inspectWorkspaceRuntime({ cwd: process.cwd() });
              const savedRuntime = resolveSessionRuntimeInfo(loaded);
              let appliedRuntime = savedRuntime ?? currentWorkspaceRuntime;
              if (savedRuntime?.workspaceRoot && !workspaceExists(savedRuntime)) {
                appliedRuntime = currentWorkspaceRuntime;
              }
              context.messages = loaded.messages;
              context.uiHistory = normalizePersistedUiHistory(loaded.uiHistory);
              context.lineage = loaded.lineage;
              context.artifactLedger = loaded.artifactLedger;
              context.extensionState = loaded.extensionState
                ? structuredClone(loaded.extensionState)
                : undefined;
              context.extensionRecords = loaded.extensionRecords?.map((record) => ({ ...record }));
              context.extensionStateDirty = false;
              context.extensionRecordsDirty = false;
              context.title = loaded.title;
              context.sessionId = id;
              context.contextTokenSnapshot = undefined;
              applyInteractiveRuntimeInfo(appliedRuntime);
              context.sessionSnapshotDirty = JSON.stringify(appliedRuntime)
                !== JSON.stringify(savedRuntime);
              // FEATURE_226: back-propagate the loaded session's tag into the
              // live options so subsequent saves / forks reflect it (the save
              // side reads currentOptionsRef.current.session?.tag).
              currentOptionsRef.current.session = {
                ...currentOptionsRef.current.session,
                id,
                tag: loaded.tag,
              };
              persistedUiHistoryRef.current = context.uiHistory ?? [];
              setLiveTokenCount(null);
              clearUIHistory();
              // FEATURE_151 (v0.7.38): reset todo plan surface on session
              // load — the loaded session has its own message stream and
              // does not carry over runtime todoStore state.
              setTodoItems([]);
              setSessionId(id);
              teamModeHandle?.writer.update({ sessionId: id });
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
            // FEATURE_151 (v0.7.38): also drop the persisted todo plan
            // surface so a new prompt starts from a clean slate. Without
            // this the previous task's completed [✓✓✓] list lingers
            // visually until the next Scout `init()` or LLM `op:'init'`
            // replaces it. The `/clear` command's intent is "wipe the
            // session view"; the todo surface is part of that view.
            setTodoItems([]);
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
            const effortResolution = resolveProviderReasoningRuntimeEffort({
              provider,
              model,
              effort: currentConfigRef.current.effort,
              effortOverride: currentConfigRef.current.effortOverride,
              permissionMode: currentConfigRef.current.permissionMode,
              planModeEffort: currentConfigRef.current.planModeEffort,
              thinking: currentConfigRef.current.thinking,
              reasoningMode: currentConfigRef.current.reasoningMode,
            });
            setCurrentConfig((prev) => ({ ...prev, provider, model }));
            currentOptionsRef.current.provider = provider;
            currentOptionsRef.current.model = model;
            currentOptionsRef.current.effort = effortResolution.runtimeEffort;
            if (effortResolution.diagnostic) {
              console.log(chalk.yellow(`\n[${effortResolution.diagnostic}]`));
            }
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
          setEffort: (effort?: string) => {
            setCurrentConfig((prev) => ({
              ...prev,
              effort,
              effortOverride: effort !== undefined,
            }));
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
          setPermissionMode: setSessionPermissionMode,
          setRepoIntelligenceRuntime: (update) => {
            setCurrentConfig((prev) => ({
              ...prev,
              ...(update.mode !== undefined ? { repoIntelligenceMode: update.mode } : {}),
              ...(update.trace !== undefined ? { repoIntelligenceTrace: update.trace } : {}),
            }));
            if (update.mode !== undefined) {
              process.env.KODAX_REPO_INTELLIGENCE = update.mode;
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
            context.lineage = loaded.lineage;
            context.artifactLedger = loaded.artifactLedger;
            context.extensionState = loaded.extensionState
              ? structuredClone(loaded.extensionState)
              : undefined;
            context.extensionRecords = loaded.extensionRecords?.map((record) => ({ ...record }));
            context.extensionStateDirty = false;
            context.extensionRecordsDirty = false;
            context.title = loaded.title;
            context.contextTokenSnapshot = undefined;
            const savedRuntime = resolveSessionRuntimeInfo(loaded);
            const appliedRuntime = savedRuntime ?? context.runtimeInfo ?? startupRuntimeInfo;
            applyInteractiveRuntimeInfo(appliedRuntime);
            context.sessionSnapshotDirty = JSON.stringify(appliedRuntime)
              !== JSON.stringify(savedRuntime);
            persistedUiHistoryRef.current = context.uiHistory ?? [];
            setLiveTokenCount(null);
            clearUIHistory();
            // FEATURE_151 (v0.7.38): reset todo plan surface on tree-switch.
            setTodoItems([]);
            console.log(chalk.green(`\n[Switched to tree entry: ${selector}]`));
            console.log(chalk.dim(`  Messages: ${loaded.messages.length}`));
            return "switched";
          },
          labelSessionBranch: async (selector: string, label?: string) => {
            const updated = await storage.setLabel?.(context.sessionId, selector, label);
            if (!updated) {
              return false;
            }

            // setLabel persists and returns a rotated canonical lineage. Keep
            // the interactive snapshot on that exact prefix so the next turn
            // cannot overwrite the checkpoint with its pre-label lineage.
            context.lineage = updated.lineage;

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
            context.lineage = forked.data.lineage;
            context.artifactLedger = forked.data.artifactLedger;
            context.extensionState = forked.data.extensionState
              ? structuredClone(forked.data.extensionState)
              : undefined;
            context.extensionRecords = forked.data.extensionRecords?.map((record) => ({ ...record }));
            context.extensionStateDirty = false;
            context.extensionRecordsDirty = false;
            context.title = forked.data.title;
            context.contextTokenSnapshot = undefined;
            const savedRuntime = resolveSessionRuntimeInfo(forked.data);
            const appliedRuntime = savedRuntime ?? context.runtimeInfo ?? startupRuntimeInfo;
            applyInteractiveRuntimeInfo(appliedRuntime);
            context.sessionSnapshotDirty = JSON.stringify(appliedRuntime)
              !== JSON.stringify(savedRuntime);
            persistedUiHistoryRef.current = context.uiHistory ?? [];
            const now = new Date().toISOString();
            context.createdAt = now;
            context.lastAccessed = now;
            currentOptionsRef.current.session = {
              ...currentOptionsRef.current.session,
              id: forked.sessionId,
              tag: forked.data.tag,
            };
            setLiveTokenCount(null);
            clearUIHistory();
            // FEATURE_151 (v0.7.38): reset todo plan surface on fork —
            // the new fork starts a fresh task tree.
            setTodoItems([]);
            setSessionId(forked.sessionId);
            teamModeHandle?.writer.update({ sessionId: forked.sessionId });
            console.log(chalk.green(`\n[Forked session: ${forked.sessionId}]`));
            console.log(chalk.dim(`  Messages: ${forked.data.messages.length}`));
            return "forked";
          },
          recoverSession: recoverCurrentSession,
          rewindSession: async (selector?: string) => {
            const allowed = enforceSessionTransitionGuard(
              currentConfig,
              "Rewinding session",
              logSessionTransitionGuard,
            );
            if (!allowed) {
              return "blocked";
            }

            const rewound = await storage.rewind?.(context.sessionId, selector);
            if (!rewound) {
              return "failed";
            }

            context.messages = rewound.messages;
            context.uiHistory = normalizePersistedUiHistory(rewound.uiHistory);
            context.lineage = rewound.lineage;
            context.artifactLedger = rewound.artifactLedger;
            context.extensionState = rewound.extensionState
              ? structuredClone(rewound.extensionState)
              : undefined;
            context.extensionRecords = rewound.extensionRecords?.map((record) => ({ ...record }));
            context.extensionStateDirty = false;
            context.extensionRecordsDirty = false;
            context.title = rewound.title;
            context.contextTokenSnapshot = undefined;
            const savedRuntime = resolveSessionRuntimeInfo(rewound);
            const appliedRuntime = savedRuntime ?? context.runtimeInfo ?? startupRuntimeInfo;
            applyInteractiveRuntimeInfo(appliedRuntime);
            context.sessionSnapshotDirty = JSON.stringify(appliedRuntime)
              !== JSON.stringify(savedRuntime);
            persistedUiHistoryRef.current = context.uiHistory ?? [];
            setLiveTokenCount(null);
            clearUIHistory();
            // FEATURE_151 (v0.7.38): reset todo plan surface on rewind.
            setTodoItems([]);
            console.log(chalk.green(`\n[Rewound session${selector ? ` to ${selector}` : " to previous turn"}]`));
            console.log(chalk.dim(`  Messages: ${rewound.messages.length}`));
            return "rewound";
          },
          getCostReport: () => inkCostReportRef.current?.() ?? null,
          // Read-only auto-mode diagnostics. Returning undefined outside Auto lets the slash
          // command print "not in auto mode" instead of leaking guardrail
          // internals to non-auto sessions.
          getAutoModeStats: async () => {
            if (!isAutoMode(permissionModeRef.current)) return undefined;
            if (options.runtimeAutoModeControl) {
              return options.runtimeAutoModeControl.getStats(context.sessionId);
            }
            return autoModeBootstrap.getGuardrail().getStats();
          },
          createKodaXOptions: () => ({
            ...currentOptionsRef.current,
            provider: currentConfig.provider,
            model: currentConfig.model,
            effort: runtimeEffort,
            thinking: currentConfig.thinking,
            reasoningMode: currentConfig.reasoningMode,
            agentMode: currentConfig.agentMode,
            // Runtime-backed sessions classify in the Runtime owner. Standalone
            // sessions retain the local guardrail for backwards compatibility.
            guardrails: options.runtimeRunner
              ? undefined
              : buildAutoModeGuardrails(permissionModeRef.current, autoModeBootstrap),
            // workflowRunsBaseDir is inherited from `...currentOptionsRef.current`
            // (set at session init for FEATURE_246 A5).
            events: createStreamingEvents(), // Include streaming events for /project commands
          }),
          reloadAgentsFiles: async (): Promise<AgentsFile[]> => {
            const fresh = await loadAgentsFiles({
              cwd: process.cwd(),
              projectRoot: context.gitRoot ?? undefined,
            });
            return fresh;
          },
          // Start and stop the compacting indicator.
          startCompacting: () => {
            startCompacting();
          },
          stopCompacting: () => {
            stopCompacting();
          },
          // Mirror the agent-runtime `onCompactStats` callback (see
          // `runKodaXCallbacks.onCompactStats` above) so manual
          // `/compact` invocations refresh the live token count too —
          // otherwise the status bar's `liveTokenCount` outranks the
          // post-compact `contextTokenSnapshot` and the bar keeps
          // showing the pre-compact total.
          onCompactStats: (info) => {
            lastCompactionTokensBeforeRef.current = info.tokensBefore;
            setLiveTokenCount(info.tokensAfter);
          },
          // Confirmation callback for interactive commands.
          confirm: async (message: string): Promise<boolean> => {
            const result = await showConfirmDialog("confirm", {
              _alwaysConfirm: true,
              _message: message,
            });
            return result.confirmed;
          },
          onWorkflowBuilderEvent: handleWorkflowBuilderEvent,
          onWorkflowRunMessage: (event) => {
            handleWorkflowRunMessage(event);
            if (event.type !== "assistant" || event.final !== true) {
              return;
            }
            const text = stripAnsi(event.text).trimEnd();
            if (!text.trim()) {
              return;
            }
            commitSlashWorkflowFinalMessage(text);
          },
          onWorkflowRunUpdate: handleWorkflowRunUpdate,
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
          capturedOutput.push(formatCapturedConsoleOutput(args));
        };

        let invocationToExecute: CommandInvocationRequest | undefined = inlineSkillInvocation;
        let workflowToExecute: CommandWorkflowInvocationRequest | undefined = undefined;

        try {
          const result = parsed
            ? await executeCommand(parsed, context, callbacks, currentConfig, fullText.trim())
            : undefined;

          // Check if result contains invocation metadata to execute
          if (typeof result === 'object' && result !== null && 'invocation' in result) {
            invocationToExecute = result.invocation;
          }
          if (typeof result === 'object' && result !== null && 'workflow' in result) {
            workflowToExecute = result.workflow;
          }
        } finally {
          setWorkflowBuilderMessage(null);
          console.log = originalLog;
        }

        // Add captured command output to history as info item
        const capturedText = joinCapturedConsoleOutput(capturedOutput);
        if (capturedText) {
          addHistoryItem({
            type: "info",
            text: capturedText,
          });
        }

        if (workflowToExecute) {
          try {
            await runWorkflowInvocation(workflowToExecute, fullText.trim(), callbacks);
          } finally {
            if (streamingStateRef.current.pendingInputs.length > 0) {
              workflowIntentBoundaryQueueLockedRef.current = true;
            }
            setIsLoading(false);
            stopStreaming();
            clearThinkingContent();
          }
          return;
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
            await executeInvocation(invocationToExecute, fullText.trim());
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
              // FEATURE_057 Track E: route the error solely through the
              // history-item channel. The previous double-emit (raw
              // console.log + appendHistoryItemsWithPersistence) wrote the
              // same message to two different rendering layers — the bare
              // stdout write would land in the wrong position now that
              // patchConsole is disabled (Ink no longer captures it).
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

        setIsLoading(false);
        stopStreaming();
        return;
      }

      // Process special syntax (shell `!...`, @image-path expansion, etc.)
      // against the EXPANDED input so paste placeholders don't get misparsed
      // as literal text (Issue 121).
      const processed = await processSpecialSyntax(fullText.trim());

      // Skip if shell command was executed successfully
      if (
        fullText.trim().startsWith("!") &&
        isShellCommandHandled(processed)
      ) {
        setIsLoading(false);
        stopStreaming();
        return;
      }

      // Note: Do NOT push user message to context.messages here!
      // runKodaX (agent.ts:76) will add the prompt to messages automatically.
      // If we push here, the message gets duplicated (Issue 046).

      // FEATURE_246 A5 (ADR-047): natural language is never intercepted into a
      // host-generated workflow; it flows to the agent, which authors workflows
      // itself via the run_workflow tool. Only `/workflow` commands launch above.

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

      // Run agent
      // Start thinking indicator - will be updated by onThinkingDelta with char count
      startThinking();

      // Capture console.log output to add to history instead of
      // letting Ink render it in the wrong position (Issue 045)
      const capturedOutput: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        capturedOutput.push(formatCapturedConsoleOutput(args));
      };

      try {
        await runQueueableAgentSequence(
          processed,
          async (prompt) => {
            const skillResult = await runQueuedUserSkillRound(prompt);
            if (skillResult) return skillResult;
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

          // Route the error to the correct rendering layer:
          //   - When a managed-foreground worker is still owning the turn
          //     (Scout/Planner/Generator/Evaluator was mid-flight), append
          //     the error into the foreground ledger so it renders *inside*
          //     the worker's group, right where the failure happened. This
          //     mirrors the 052c23b recovery-position fix and the onRetry /
          //     onProviderRecovery routing elsewhere in this file.
          //   - Otherwise, add a normal error history item (previous
          //     behaviour for non-AMA flows).
          //
          // Critical: do NOT `console.log(chalk.red(...))` here. Two
          // independent reasons:
          //   - Historic: when Ink's `patchConsole` was active it routed
          //     console output into the static area below the user prompt.
          //   - Current: with `patchConsole: false` (vendored substrate,
          //     FEATURE_057), console.log bypasses the React tree and
          //     writes raw bytes into the alt-screen buffer — colliding
          //     with Ink's rendered output and showing in the wrong slot
          //     when a managed-foreground worker just crashed.
          // The history-item path below is the single rendering source of
          // truth and lands in the correct chronological slot.
          if (managedForegroundOwnerRef.current.workerId) {
            appendManagedForegroundLedgerItem({
              id: `error-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              type: "error",
              text: errorContent,
              timestamp: Date.now(),
            } as HistoryItem);
          } else {
            appendHistoryItemsWithPersistence([{
              type: "error",
              text: errorContent,
            }]);
          }

          if (shouldOfferSessionRecovery({ error, messageCount: context.messages.length })) {
            const recoveryHintItem = {
              type: "info" as const,
              text: SESSION_RECOVERY_HINT_MESSAGE,
            };
            if (managedForegroundOwnerRef.current.workerId) {
              appendManagedForegroundLedgerItem({
                id: `recover-hint-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                ...recoveryHintItem,
                timestamp: Date.now(),
              } as HistoryItem);
              persistHistoryAdditionsInBackground([recoveryHintItem]);
            } else {
              appendHistoryItemsWithPersistence([recoveryHintItem]);
            }

            const result = await showConfirmDialog("confirm", {
              _alwaysConfirm: true,
              _message: SESSION_RECOVERY_CONFIRM_MESSAGE,
            });
            if (result.confirmed) {
              try {
                await recoverCurrentSession(processed);
              } catch (recoverError) {
                const message = recoverError instanceof Error
                  ? recoverError.message
                  : String(recoverError);
                appendHistoryItemsWithPersistence([{
                  type: "error",
                  text: `[Recover failed] ${message}`,
                }]);
              }
            }
          }
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
          const capturedText = joinCapturedConsoleOutput(uniqueOutput);

          if (capturedText) {
            addHistoryItem({
              type: "info",
              text: capturedText,
            });
          }
        }

        // v0.7.39 run-end safety net — finalize any tool calls left in
        // Executing state when the run terminates. The per-turn
        // `onStreamEnd` handler (line ~5195) is the primary cleanup
        // path: it cancels stragglers per LLM turn so the displayed
        // `tool_group` items flip out of "(running)". But the V2 chain's
        // terminal `emit_verdict` path can exit the Runner-driven idle-
        // yield outer loop (runner-driven.ts ~5460) before that final
        // stream-end signal lands in the REPL, stranding the last tool
        // as `Executing` in `iterationToolCallsRef` and the foreground
        // tool_group history item. Mirrors the FEATURE_151 Slice C
        // correction (1c630723) — clear stale UI on the run-end edge
        // rather than depending on an event that may not fire.
        // Skip when the user interrupted: `resetInterruptedPromptState`
        // already cleared `liveToolCalls` and the foreground turn
        // history, so this would be a no-op and adding a Cancelled
        // patch into history items that no longer exist is wasted work.
        if (!userInterruptedRef.current) {
          const orphanedTools = finalizeAllExecutingToolCalls(
            ToolCallStatus.Cancelled,
            () => ({
              error: "Run ended before the tool result was observed.",
              output: undefined,
            }),
          );
          if (orphanedTools.length > 0 && managedForegroundOwnerRef.current.workerId) {
            orphanedTools.forEach((tool) => syncManagedForegroundToolGroup(tool));
          }
        }

        setIsLoading(false);
        stopStreaming();
        clearResponse(); // Fix: clear stale buffer to prevent ghost [Interrupted] on next submit
        clearChildActivityRecords();
        clearThinkingContent();
        // After a run ends (success or abort), worker-scoped onIterationEnd events
        // may have left context.contextTokenSnapshot pointing at a sub-agent's
        // token count rather than the parent context. In AMA mode the parent
        // REPL never gets a final iteration event of its own, so the snapshot
        // stays stale and the status bar shows an inflated value that never
        // drops. Re-derive the snapshot from the authoritative local messages
        // before refreshing the live count.
        const authoritativeTokens = estimateTokens(context.messages);
        context.contextTokenSnapshot = {
          currentTokens: authoritativeTokens,
          baselineEstimatedTokens: authoritativeTokens,
          source: 'estimate',
        };
        setLiveTokenCount(authoritativeTokens);
      }
    },
    [
      isRunning,
      context,
      currentConfig,
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
      appendManagedForegroundLedgerItem,
      appendHistoryItemsToCurrentSnapshot,
      appendHistoryItemsWithPersistence,
      appendLastAssistantToHistory,
      persistContextState,
      persistContextStateInBackground,
      persistHistoryAdditionsInBackground,
      reconcileContextLineage,
      runQueueableAgentSequence,
      runQueuedUserSkillRound,
      drainPendingInputsAsFollowUps,
      startCompacting,
      stopCompacting,
      resetLiveToolCalls,
      clearChildActivityRecords,
      finalizeAllExecutingToolCalls,
      syncManagedForegroundToolGroup,
      clearWorkStripTimers,
      dismissLearningRecovery,
      replaceWorkflowLiveStatus,
      updateWorkflowLiveStatus,
    ]
  );

  const workflowFooterSurface = workflowLiveViewModel.shouldRender ? (
    <Box paddingX={1}>
      <WorkflowRunSurface viewModel={workflowLiveViewModel} />
    </Box>
  ) : undefined;
  const todoFooterSurface = (isLoading && todoPlanViewModel.shouldRender) ? (
    <Box paddingX={1}>
      <TodoListSurface viewModel={todoPlanViewModel} />
    </Box>
  ) : undefined;
  const childActivityFooterSurface = shouldRenderChildActivitySurface ? (
    <Box paddingX={1}>
      <ChildActivitySurface viewModel={childActivityViewModel} />
    </Box>
  ) : undefined;
  const promptEmbeddedStatusSurface = workflowFooterSurface || todoFooterSurface || childActivityFooterSurface ? (
    // Order reads as a hierarchy, general -> specific / stable -> transient, top
    // to bottom: the todo PLAN first; the workflow that one of its steps launched
    // under it; the most granular, fastest-moving per-agent activity last (closest
    // to the prompt, where the eye sits). A workflow is a sub-activity of the
    // "run workflow" plan step, so it nests below the plan, not above it.
    <Box flexDirection="column">
      {todoFooterSurface}
      {workflowFooterSurface}
      {childActivityFooterSurface}
    </Box>
  ) : undefined;
  const workflowFooterCounterText = workflowLiveViewModel.shouldRender
    ? workflowLiveViewModel.counterText
    : undefined;

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
      activityBar={footerActivityViewModel ? (
        // The spinner row is the user's liveness heartbeat. Keep it
        // mounted whenever an agent/workflow is active, even when a richer
        // progress panel is also visible below it.
        <Box paddingX={1} flexDirection="row">
          <Box flexGrow={1}>
            {footerActivityViewModel?.showSpinner ? (
              <Spinner color={getTheme("dark").colors.accent} />
            ) : null}
            {footerActivityViewModel ? (
              <Text
                color={
                  footerActivityViewModel.kind === "waiting"
                    ? getTheme("dark").colors.warning
                    : getTheme("dark").colors.accent
                }
                wrap="truncate"
              >
                {footerActivityViewModel.showSpinner ? " " : ""}
                {footerActivityViewModel.text}
              </Text>
            ) : null}
            {/*
              v0.7.41 — query-total stats tail.
              Rendered when the activity-bar is showing the busy spinner
              (i.e. the round is actively running). Reads roundStartedAt
              + currentResponse straight from streamingState rather than
              the promptStreamingState projection — the projection zeroes
              currentResponse during foregroundManagedOwnsLivePreview but
              the streaming context still accumulates real bytes, so the
              tokens-since-round-start figure should reflect them. Format:
              `(MmSs · ↓ N tokens)`; for queries crossing 1h the elapsed
              rolls to `HhMmSs`.
            */}
            {footerActivityViewModel?.showSpinner
              && streamingState.roundStartedAt != null ? (
              <SpinnerStatsTail
                roundStartedAt={streamingState.roundStartedAt}
                charCount={streamingState.currentResponse.length}
                theme={getTheme("dark")}
              />
            ) : null}
          </Box>
          {workflowFooterCounterText ? (
            <Text dimColor wrap="truncate">
              {workflowFooterCounterText}
            </Text>
          ) : (isLoading && todoPlanViewModel.shouldRender) ? (
            <Text dimColor wrap="truncate">
              {formatTodoPlanProgressText(todoPlanViewModel)}
            </Text>
          ) : null}
        </Box>
      ) : undefined}
      todoSurface={
        // FEATURE_097 (v0.7.34) — surface mount.
        // FEATURE_151 (v0.7.38) — spinner gate REMOVED unconditionally.
        // v0.7.38 hotfix (2026-05-11) — Slice C CORRECTION.
        //
        // FEATURE_151 Slice C cited Claude Code's
        // `expandedView === 'tasks'` as the rationale for unconditional
        // mount. Re-verifying against `c:/Works/claudecode/src/` shows
        // CC actually has TWO gates that together produce a
        // "default-OFF after run ends" behaviour:
        //   1. Spinner.tsx:282-285 — TaskListV2 rendered INSIDE Spinner,
        //      i.e. only while a run is active.
        //   2. screens/REPL.tsx:4606 — standalone TaskListV2 rendered
        //      ONLY when `expandedView === 'tasks'` (user-toggled via
        //      Ctrl+O); default `expandedView` is 'none' so the post-
        //      run path is hidden by default.
        // Combined: CC's list disappears when the run ends (which is
        // exactly what the user reported as the desired behaviour in
        // 2026-05-11 — "对话完成、计划列表也都完成时，列表残留在对话框
        // 上方").
        //
        // KodaX correction: gate mount on `isLoading`. The list shows
        // during an active run (matches CC's Spinner path) and hides
        // once the run terminates (matches CC's default-OFF
        // expandedView). A user-facing toggle equivalent to CC's
        // Ctrl+O / expandedView==='tasks' is out of scope here — can be
        // a separate feature if requested.
        //
        // `todoItems` clear on `isLoading` true→false (see the
        // `useEffect` below) prevents stale plan items from a
        // previous run flashing back when the next prompt re-enters
        // the loading state.
        promptEmbeddedStatusSurface
      }
      composer={(
        <PromptComposer
          onSubmit={handleSubmit}
          onHistoryRecall={handleHistoryRecall}
          // FEATURE_149 Phase 2.1 (v0.7.38) — ↑ on empty buffer pulls the
          // queued follow-ups back into the editor for editing/reordering.
          // `consumePendingInputs` clears the queue atomically; we stitch the
          // entries with `\n---\n` so the user can split them back apart by
          // hand (mirrors Claude Code's `popAllEditable`).
          onPopPendingInputs={() => {
            const inputs = consumePendingInputs();
            if (inputs.length === 0) return undefined;
            return inputs.join("\n---\n");
          }}
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
          onPasteFallback={showPasteFallbackNotice}
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
      transcriptModel={options?.rendererWindow ? ownedTranscriptRenderModel : inlineLedgerBoundedModel}
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
    inlineLedgerBoundedModel,
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
      liveStatusLines={transcriptLiveStatusLines}
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
    transcriptLiveStatusLines,
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
          overscanRows={FULLSCREEN_SCROLL_OVERSCAN_ROWS}
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
      <StreamingProvider
        getPendingInputAgentId={() => actorQueueId(props.context.sessionId, "/root")}
      >
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
  const { prepareRuntimeConfig } = await import("../common/utils.js");
  const { loadCompactionConfig } = await import("../common/compaction-config.js");
  const { resolveProvider } = await import("@kodax-ai/coding");

  const config = prepareRuntimeConfig();

  const initialProvider = resolveRuntimeProviderSelection({
    explicitProvider: options.provider,
    environmentProvider: process.env.KODAX_PROVIDER,
    configuredProvider: config.provider,
    defaultProvider: KODAX_DEFAULT_PROVIDER,
  });
  const initialModel = resolveRuntimeModelSelection({
    explicitProvider: options.provider,
    environmentProvider: process.env.KODAX_PROVIDER,
    explicitModel: options.model,
    configuredProvider: config.provider,
    configuredModel: config.model,
  });
  const initialReasoningMode = resolveInitialReasoningMode(options, config);
  const initialEffort = resolveRuntimeEffortSelection({
    explicitEffort: options.effort,
    environmentEffort: process.env.KODAX_EFFORT,
    configuredEffort: config.effort,
  });
  const initialEffortOverride = resolveInitialEffortOverride(
    options,
    config,
    process.env.KODAX_EFFORT,
  );
  const initialAgentMode = options.agentMode ?? config.agentMode ?? 'ama';
  const initialThinking = initialReasoningMode !== 'off';
  // Load permission mode from config file (not from CLI options)
  // CLI is always YOLO mode; REPL uses config file for permission mode
  const initialPermissionMode: PermissionMode =
    normalizePermissionMode(config.permissionMode, 'accept-edits') ?? 'accept-edits';
  const repoIntelligenceRuntime = resolveRepoIntelligenceRuntimeConfig();
  // v0.7.27 FEATURE_086 — repo-intelligence trace is OFF by default in
  // the Ink REPL to match v0.7.20-era transcript density (tool calls
  // surface normally; auto-injection stages stay silent unless the user
  // opts in). Enable via `/repo-intel trace on` or persist
  // `repoIntelligenceTrace: true` in the config file. The
  // `KODAX_REPO_INTELLIGENCE_TRACE=1` env var and the CLI/ACP surfaces
  // retain their existing defaults.
  const repoIntelligenceTraceDefault = config.repoIntelligenceTrace === true;

  const currentConfig: CurrentConfig = {
    provider: initialProvider,
    model: initialModel,
    effort: initialEffort,
    effortOverride: initialEffortOverride,
    planModeEffort: config.planModeEffort,
    thinking: initialThinking,
    reasoningMode: initialReasoningMode,
    agentMode: initialAgentMode,
    permissionMode: initialPermissionMode,
    repoIntelligenceMode: repoIntelligenceRuntime.mode,
    repoIntelligenceTrace: repoIntelligenceTraceDefault,
  };

  // Handle session resume/load
  let sessionId = options.session?.id;
  let existingMessages: KodaXMessage[] = [];
  let existingUiHistory: KodaXSessionUiHistoryItem[] | undefined;
  let existingLineage: KodaXSessionLineage | undefined;
  let existingArtifactLedger: KodaXSessionArtifactLedgerEntry[] | undefined;
  let existingExtensionState: InteractiveContext['extensionState'];
  let existingExtensionRecords: InteractiveContext['extensionRecords'];
  let sessionTitle = "";
  const startupRuntime = await inspectWorkspaceRuntime({ cwd: process.cwd() });
  const gitRoot = startupRuntime.workspaceRoot ?? undefined;
  let activeRuntimeInfo: NonNullable<InteractiveContext["runtimeInfo"]> = startupRuntime;
  let activeGitRoot = gitRoot;

  // FEATURE_125 v0.7.41 — Bootstrap Team Mode (multi-instance auto
  // coordination). Mirrors the wiring in the legacy `runInteractiveMode`
  // path so Ink REPL users also get the per-instance state broadcast +
  // sibling-awareness system-prompt block. Returns null when
  // KODAX_DISABLE_MULTI_INSTANCE=1 is set; otherwise registers this
  // session under `<configHome>/instances/<pid>/`, reaps stale peer
  // directories from crashed sessions, and installs the writer in the
  // process-level singleton. Tools / runner-driven adapter consume the
  // singleton via `getActiveTeamModeWriter()`.
  const teamModeHandle: TeamModeHandle | null = bootstrapTeamMode({
    meta: {
      cwd: process.cwd(),
      startedAt: Date.now(),
    },
  });
  // Fire-and-forget cleanup on abnormal exit (Ctrl+C, SIGTERM, crash).
  // state-writer.shutdown clearInterval + fs.rmSync run synchronously
  // before the trailing `await Promise.resolve()`, so the instance dir
  // is removed before the handler returns even though the promise is
  // not awaited. The clean-exit path (after `waitUntilExit`) also calls
  // shutdown; both are idempotent.
  if (teamModeHandle) {
    const teamModeCleanup = (): void => {
      void teamModeHandle.shutdown();
    };
    process.on('exit', teamModeCleanup);
    process.on('SIGTERM', teamModeCleanup);
  }

  // FEATURE_087/088 (v0.7.28): bootstrap ConstructionRuntime + rehydrate
  // any previously-activated constructed tools BEFORE the Ink component
  // renders, so the first system prompt build sees the rehydrated tool
  // set. The bootstrap is idempotent (configureRuntime overrides; rehydrate
  // re-registers atomically).
  try {
    const { bootstrapConstructionRuntime } = await import('../common/construction-bootstrap.js');
    const construction = await bootstrapConstructionRuntime(gitRoot ?? process.cwd());
    if (construction.loaded > 0 || construction.failed > 0 || construction.tampered > 0) {
      const failedSuffix = construction.failed > 0 ? `; ${construction.failed} failed` : '';
      const tamperedSuffix = construction.tampered > 0
        ? `; ${construction.tampered} skipped due to manifest contentHash mismatch — re-stage and re-activate to re-approve`
        : '';
      emitKodaXDiagnostic({
        source: 'repl:construction',
        level: construction.failed > 0 || construction.tampered > 0 ? 'warn' : 'info',
        message: `Rehydrated ${construction.loaded} active tool(s)${failedSuffix}${tamperedSuffix}.`,
      });
    }
    // FEATURE_191 — surface markdown-defined agent count + per-file failures
    // so users with malformed `~/.kodax/agents/*.md` or `<repo>/.kodax/agents/*.md`
    // get actionable feedback at boot (otherwise admission rejection / missing
    // description is silently dropped).
    if (construction.markdownLoaded > 0 || construction.markdownFailures.length > 0) {
      emitKodaXDiagnostic({
        source: 'repl:agents',
        level: construction.markdownFailures.length > 0 ? 'warn' : 'info',
        message: `Loaded ${construction.markdownLoaded} markdown agent(s).`,
      });
      for (const failure of construction.markdownFailures) {
        emitKodaXDiagnostic({
          source: 'repl:agents',
          level: 'warn',
          message: `Skipped markdown agent ${failure.path}: ${failure.reason}`,
        });
      }
    }
  } catch (err) {
    // Bootstrap failure must not break the REPL; log and proceed without
    // construction support for this session.
    emitKodaXDiagnostic({
      source: 'repl:construction',
      level: 'warn',
      message: `Bootstrap failed: ${(err as Error).message}. Self-construction disabled this session.`,
    });
  }

  // Load compaction config before rendering so the <Static> banner has it immediately
  let compactionInfo:
    | {
        contextWindow: number;
        triggerPercent: number;
        triggerTokens?: number;
        enabled: boolean;
        reservedResponseTokens?: number;
        userOverrideContextWindow?: number;
      }
    | undefined;
  try {
    const compConfig = await loadCompactionConfig(gitRoot);
    const providerInstance = resolveProvider(initialProvider);
    const effectiveContextWindow = compConfig.contextWindow
      ?? providerInstance.getContextWindow?.()
      ?? 200000;

    compactionInfo = {
      contextWindow: effectiveContextWindow,
      triggerPercent: compConfig.triggerPercent,
      triggerTokens: compConfig.triggerTokens,
      enabled: compConfig.enabled,
      reservedResponseTokens: providerInstance.getEffectiveMaxOutputTokens?.(initialModel),
      // Track the raw user override separately so the React layer can
      // honour it across `/model` swaps (per-model resolution must NOT
      // override an explicit `compaction.contextWindow` setting).
      userOverrideContextWindow: compConfig.contextWindow,
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
      existingExtensionState = loaded.extensionState;
      existingExtensionRecords = loaded.extensionRecords;
      sessionTitle = loaded.title;
      sessionId = options.session.id;
      activeRuntimeInfo = resolveSessionRuntimeInfo(loaded) ?? startupRuntime;
      activeGitRoot = activeRuntimeInfo.workspaceRoot ?? undefined;
      // FEATURE_226: carry the resumed session's tag into options so the
      // live currentOptionsRef reflects it (save side reads it back).
      options = { ...options, session: { ...(options.session ?? {}), id: sessionId, tag: loaded.tag } };
      console.log(chalk.green(`[Session loaded: ${sessionId}]`));
    }
  }
  // -c or autoResume: Load most recent non-empty session
  else if (options.session?.resume || options.session?.autoResume) {
    const recentSession = await findMostRecentResumableSession(storage, gitRoot);
    if (recentSession) {
      const loaded = await storage.load(recentSession.id);
      if (loaded) {
        existingMessages = loaded.messages;
        existingUiHistory = normalizePersistedUiHistory(loaded.uiHistory);
        existingLineage = loaded.lineage;
        existingArtifactLedger = loaded.artifactLedger;
        existingExtensionState = loaded.extensionState;
        existingExtensionRecords = loaded.extensionRecords;
        sessionTitle = loaded.title;
        sessionId = recentSession.id;
        activeRuntimeInfo = resolveSessionRuntimeInfo(loaded) ?? startupRuntime;
        activeGitRoot = activeRuntimeInfo.workspaceRoot ?? undefined;
        // FEATURE_226: carry the resumed session's tag into options.
        options = {
          ...options,
          session: { ...(options.session ?? {}), id: sessionId, tag: loaded.tag },
        };
        console.log(chalk.green(`[Continuing session: ${recentSession.id}]`));
      }
    }
  }

  // Create context with loaded session
  const context = await createInteractiveContext({
    sessionId,
    gitRoot: activeGitRoot,
    runtimeInfo: activeRuntimeInfo,
    existingMessages,
    existingUiHistory,
    existingLineage,
    existingArtifactLedger,
    existingExtensionState,
    existingExtensionRecords,
  });
  context.title = sessionTitle;
  options = {
    ...options,
    context: {
      ...options.context,
      gitRoot: context.gitRoot ?? undefined,
      executionCwd: context.runtimeInfo?.executionCwd ?? context.gitRoot ?? process.cwd(),
    },
  };

  // v0.7.43 (FEATURE_173 Part B follow-up) — publish the resolved
  // sessionId to the FEATURE_125 heartbeat so `listRunningSessions()`
  // can correlate a running instance with its `.jsonl` file.
  teamModeHandle?.writer.update({ sessionId: context.sessionId });

  // FEATURE_092 phase 2b.7b: bootstrap the auto-mode guardrail factory before
  // render so the Ink component receives a ready-to-use accessor. The
  // classifier reads project AGENTS.md fresh via `loadAgentsFiles`
  // (mtime-cached) on every classify, so no agents-files ref bridge is needed
  // (FEATURE_092 follow-up — AGENTS.md staleness fix).
  // FEATURE_092 v0.7.34 hotfix-3: ref-bridge for live currentConfig.
  //
  // The React component at the bottom of this file owns the live
  // `currentConfig` (a `useState<CurrentConfig>` populated by
  // `setCurrentConfig` on every `/model` / `/provider` / `/mode` swap). The
  // bootstrap callbacks below run OUTSIDE the component (they're closures in
  // `runReplApp` scope), so they cannot read React state directly. The ref
  // here is the bridge: the component calls `setCurrentConfigRef` (passed as
  // a prop) inside a `useEffect` that fires on every state change, keeping
  // `inkCurrentConfigRef.current` in sync with the live value. The bootstrap
  // closures read `inkCurrentConfigRef.current.provider` etc. so they
  // observe the latest values whenever the classifier runs.
  //
  const inkCurrentConfigRef: { current: CurrentConfig } = { current: currentConfig };
  const autoModeSettings = loadAutoModeSettings();
  const autoModeBootstrap: AutoModeBootstrapResult = await bootstrapAutoMode({
    projectRoot: gitRoot ?? process.cwd(),
    executionCwd: activeRuntimeInfo.executionCwd ?? gitRoot ?? process.cwd(),
    getCurrentProviderName: () => inkCurrentConfigRef.current.provider,
    getCurrentModel: () => inkCurrentConfigRef.current.model,
    getCurrentPermissionMode: () => inkCurrentConfigRef.current.permissionMode,
    autoModeSettings,
    log: (level, msg) => {
      emitKodaXDiagnostic({
        source: 'repl:auto-mode',
        level: level === 'warn' ? 'warn' : 'info',
        message: msg,
      });
    },
    // FEATURE_158: inject the REPL-specific path signal collector. Shared path
    // utilities are coding-owned; this collector adds REPL protected paths.
    extraCollectors: [replBashPathSignalCollector],
  });

  // Note: Banner is now shown inside Ink component (Banner.tsx)
  // This ensures it's visible in the alternate buffer

  try {
    const stdout = process.stdout;
    const stdin = process.stdin;
    // FEATURE_134 v0.7.40 follow-up — DEC 2004 bracketed paste mode is
    // owned by `KeypressContext.tsx` (which writes `\x1b[?2004h` via
    // Ink's managed stdout in a useEffect AFTER Ink's first render, and
    // writes `\x1b[?2004l` on unmount). The previous FEATURE_134 v1 also
    // wrote the enable sequence HERE (before `render()`), which on
    // Windows ConPTY corrupted Ink's startup: ConPTY consumed the
    // pre-render escape as pending-output state, causing Ink's diff
    // renderer to write into a buffer that was only flushed on
    // significant state changes (task completion). User-visible symptom:
    // transcript middle section blank during agent run, all updates
    // "popping in" at task end. Removed the redundant pre-render write;
    // `KeypressContext.tsx:134` is the single source of truth for
    // bracketed paste lifecycle. The 4 explicit paste sources
    // (Source 2 `@<path>`, Source 3 macOS Cmd+V, Source 4 Win Alt+V,
    // Source 5 macOS/Linux Ctrl+V) are unchanged; Source 1 (bracketed
    // paste) still flows through `KeypressParser.flushPasteAccumulator`.
    // Render Ink app
    // Issue 058/060: Ink 6.x options to reduce flickering
    let exitMessageRequested = false;
    const { waitUntilExit, cleanup } = render(
      <InkREPL
        options={options}
        config={currentConfig}
        context={context}
        startupRuntimeInfo={startupRuntime}
        storage={storage}
        autoModeSettings={toReplRuntimeAutoModeSettings(autoModeSettings)}
        compactionInfo={compactionInfo}
        rendererMode={rendererMode}
        fullscreenPolicy={fullscreenPolicy}
        autoModeBootstrap={autoModeBootstrap}
        setCurrentConfigRef={(cfg) => {
          inkCurrentConfigRef.current = cfg;
        }}
        teamModeHandle={teamModeHandle}
        onExit={() => {
          exitMessageRequested = true;
        }}
      />,
      {
        stdout,
        stdin,
        exitOnCtrlC: false,
        patchConsole: false,
        // FEATURE_057 Track F Phase 6 (v0.7.30): cell-level diff renderer
        // is the sole render path. The legacy `log-update.js` factory and
        // its `incrementalRendering` toggle are gone.
        maxFps: 30,          // Ink 6.3.0+: Limit frame rate to reduce flickering
        shellMode: fullscreenPolicy.enabled ? fullscreenPolicy.promptShell : "main-screen",
      }
    );

    // Wait for exit
    await waitUntilExit();
    cleanup();
    // FEATURE_125 v0.7.41 — release the instance directory + clear the
    // process-level singleton so the next session's discovery scan does
    // not have to reap us as a stale peer. state-writer.shutdown does
    // its work synchronously (clearInterval + fs.rmSync) before the
    // trailing `await Promise.resolve()`, so the directory is gone by
    // the time the handler returns even though the promise is unawaited.
    void teamModeHandle?.shutdown();
    // FEATURE_134 v0.7.40 follow-up — DEC 2004 disable on clean exit is
    // now handled by `KeypressContext.tsx` useEffect cleanup (matching
    // pair to its enable write at line 134). The previous explicit
    // `disableBracketedPasteMode()` here was the matching pair to the
    // pre-render enable that's now removed.
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
