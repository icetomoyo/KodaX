import type { HistoryItem } from "../types.js";
import {
  buildTranscriptBrowseHint,
  type TranscriptDisplayState,
} from "./transcript-state.js";
import {
  buildHistoryItemTranscriptSections,
  resolveScrollOffsetForTranscriptItem,
} from "./transcript-layout.js";

export interface TranscriptChromeModel {
  browseHintText?: string;
  stickyHeaderText?: string;
  jumpToLatestText?: string;
}

export interface TranscriptChromeOptions {
  state: TranscriptDisplayState;
  ownsViewport: boolean;
  isAwaitingUserInteraction: boolean;
  isHistorySearchActive: boolean;
  isReviewingHistory: boolean;
  historySearchQuery: string;
}

export function buildTranscriptChromeModel(
  options: TranscriptChromeOptions,
): TranscriptChromeModel {
  const {
    state,
    ownsViewport,
    isAwaitingUserInteraction,
    isHistorySearchActive,
    isReviewingHistory,
    historySearchQuery,
  } = options;

  const browseHintText = buildTranscriptBrowseHint(state);

  let stickyHeaderText: string | undefined;
  if (state.supportsStickyPrompt && state.stickyPromptVisible) {
    if (isHistorySearchActive) {
      const query = historySearchQuery.trim();
      stickyHeaderText = query
        ? `Searching transcript for "${query}"`
        : "Searching transcript history";
    } else if (isAwaitingUserInteraction) {
      stickyHeaderText = "Interaction active - transcript follow is paused";
    } else if (isReviewingHistory) {
      stickyHeaderText = "Browsing transcript history";
    }
  }

  const jumpToLatestText =
    ownsViewport && state.supportsViewportChrome && state.jumpToLatestAvailable
      ? "Jump to latest: End"
      : undefined;

  return {
    browseHintText,
    stickyHeaderText,
    jumpToLatestText,
  };
}

export function resolveTranscriptPageSize(messageRows: number): number {
  return Math.max(1, messageRows - 2);
}

export function resolveTranscriptWheelStep(pageSize: number): number {
  return Math.max(3, Math.floor(pageSize / 4));
}

export function incrementTranscriptScrollOffset(
  currentOffset: number,
  delta: number,
): number {
  return Math.max(0, currentOffset + delta);
}

export interface TranscriptSelectionOffsetOptions {
  items: HistoryItem[];
  terminalWidth: number;
  transcriptMaxLines: number;
  viewportRows: number | undefined;
  itemId: string | undefined;
  expandedItemKeys?: ReadonlySet<string>;
  showDetailedTools?: boolean;
}

export function resolveTranscriptSelectionOffset(
  options: TranscriptSelectionOffsetOptions,
): number {
  const {
    items,
    terminalWidth,
    transcriptMaxLines,
    viewportRows,
    itemId,
    expandedItemKeys,
    showDetailedTools = false,
  } = options;

  const sections = buildHistoryItemTranscriptSections(
    items,
    terminalWidth,
    transcriptMaxLines,
    showDetailedTools,
    expandedItemKeys,
  );

  return resolveScrollOffsetForTranscriptItem(
    sections,
    itemId,
    viewportRows,
  );
}

export function resolveTranscriptSearchAnchorItemId(
  items: HistoryItem[],
  selectedItemId: string | undefined,
): string | undefined {
  return selectedItemId ?? items[items.length - 1]?.id;
}
