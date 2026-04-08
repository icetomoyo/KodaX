import { buildMessageActionsText } from "../components/MessageActions.js";
import type { TranscriptViewportSelectionState } from "../components/TranscriptViewport.js";
import {
  buildTranscriptScreenSelectionSummary,
  type TranscriptTextSelection,
} from "../../tui/core/selection.js";

function buildDefaultTranscriptSecondaryText(showAllActive = false): string {
  return `\u2190/\u2192 enter select mode | Ctrl+E ${showAllActive ? "collapse" : "show all"} | Mouse drag selects text`;
}

export interface SurfaceNotification {
  id: string;
  text: string;
  tone?: "info" | "warning" | "accent";
}

export interface BuildFooterNotificationsOptions {
  historySearchQuery: string;
  isHistorySearchActive: boolean;
  historySearchMatchCount: number;
  pendingInputCount: number;
  maxPendingInputs: number;
}

export function buildFooterNotifications(
  options: BuildFooterNotificationsOptions,
): SurfaceNotification[] {
  const notifications: SurfaceNotification[] = [];

  if (
    options.historySearchQuery.trim().length > 0
    && options.isHistorySearchActive
    && options.historySearchMatchCount === 0
  ) {
    notifications.push({
      id: "search-empty",
      text: "No transcript matches yet",
      tone: "info",
    });
  }

  if (options.pendingInputCount >= options.maxPendingInputs) {
    notifications.push({
      id: "queue-full",
      text: `Queued follow-up limit reached (${options.maxPendingInputs})`,
      tone: "warning",
    });
  }

  return notifications;
}

export interface BuildBaseFooterNoticesOptions {
  historySearchQuery: string;
  pendingInputCount: number;
}

export function buildBaseFooterNotices(
  options: BuildBaseFooterNoticesOptions,
): string[] {
  const notices: string[] = [];

  if (options.historySearchQuery.trim()) {
    notices.push(`Search: ${options.historySearchQuery.trim()}`);
  }

  if (options.pendingInputCount > 0) {
    notices.push(`Queued follow-ups: ${options.pendingInputCount}`);
  }

  return notices;
}

export interface BuildStashNoticeTextOptions {
  inputText: string;
  isTranscriptMode: boolean;
  isHistorySearchActive: boolean;
}

export function buildStashNoticeText(
  options: BuildStashNoticeTextOptions,
): string | undefined {
  if (!options.inputText.trim()) {
    return undefined;
  }

  if (options.isTranscriptMode || options.isHistorySearchActive) {
    return "Draft preserved while viewing transcript";
  }

  return undefined;
}

export function buildPromptFooterNotices(
  baseFooterNotices: readonly string[],
  selectionCopyNotice?: string,
): string[] {
  const notices = [...baseFooterNotices];
  if (selectionCopyNotice) {
    notices.unshift(selectionCopyNotice);
  }
  return notices;
}

export interface BuildTranscriptFooterSecondaryTextOptions {
  isHistorySearchActive: boolean;
  historySearchDetailText?: string;
  selectionSummary?: string;
  actionSummary?: string;
  showAllActive?: boolean;
  baseFooterNotices: readonly string[];
}

export function buildTranscriptFooterSecondaryText(
  options: BuildTranscriptFooterSecondaryTextOptions,
): string | undefined {
  const parts = options.isHistorySearchActive
    ? [options.historySearchDetailText]
    : [
        options.selectionSummary,
        options.actionSummary,
      ];

  const normalizedParts = parts.filter(
    (value): value is string => Boolean(value && value.trim().length > 0),
  );

  if (normalizedParts.length === 0) {
    return buildDefaultTranscriptSecondaryText(options.showAllActive);
  }

  return normalizedParts.join(" | ");
}

export function buildTranscriptFooterBudgetNotices(
  secondaryText?: string,
  selectionCopyNotice?: string,
): string[] {
  const notices: string[] = [];

  if (secondaryText) {
    notices.push(secondaryText);
  }

  if (selectionCopyNotice) {
    notices.push(selectionCopyNotice);
  }

  return notices;
}

export interface BuildTranscriptFooterViewModelOptions {
  textSelection?: TranscriptTextSelection;
  selectionState?: TranscriptViewportSelectionState;
  copySelectionNotice?: string;
  isHistorySearchActive: boolean;
  historySearchDetailText?: string;
  historySearchHasMatches: boolean;
  showAllActive?: boolean;
  baseFooterNotices: readonly string[];
}

export interface TranscriptFooterViewModel {
  selectionSummary?: string;
  actionSummary?: string;
  secondaryText?: string;
  budgetNotices: string[];
}

export function buildTranscriptFooterViewModel(
  options: BuildTranscriptFooterViewModelOptions,
): TranscriptFooterViewModel {
  const copyCapabilities = options.selectionState?.copyCapabilities;
  const navigationCapabilities = options.selectionState?.navigationCapabilities;
  const textSelectionSummary = buildTranscriptScreenSelectionSummary(options.textSelection);
  const selectionSummary = textSelectionSummary;
  const actionSummary = options.textSelection
    ? buildMessageActionsText({
      copyMessage: true,
      copyToolInput: false,
      copyOnSelect: Boolean(copyCapabilities?.copyOnSelect),
      toggleDetail: false,
      selectionNavigation: false,
      matchNavigation: false,
    })
    : options.selectionState?.itemSummary
      ? buildMessageActionsText({
        copyMessage: Boolean(copyCapabilities?.message),
        copyToolInput: Boolean(copyCapabilities?.toolInput),
        copyOnSelect: Boolean(copyCapabilities?.copyOnSelect),
        toggleDetail: Boolean(options.selectionState?.toggleDetail),
        selectionNavigation: Boolean(navigationCapabilities?.selection),
        matchNavigation: false,
      })
    : undefined;
  const secondaryText = buildTranscriptFooterSecondaryText({
    isHistorySearchActive: options.isHistorySearchActive,
    historySearchDetailText: options.historySearchDetailText,
    selectionSummary,
    actionSummary,
    showAllActive: options.showAllActive,
    baseFooterNotices: options.baseFooterNotices,
  });

  return {
    selectionSummary,
    actionSummary,
    secondaryText,
    budgetNotices: buildTranscriptFooterBudgetNotices(
      secondaryText,
      options.copySelectionNotice,
    ),
  };
}
