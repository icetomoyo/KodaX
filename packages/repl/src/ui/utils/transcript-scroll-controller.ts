import type { HistoryItem } from "../types.js";
import {
  buildTranscriptBrowseHint,
  type TranscriptDisplayState,
} from "./transcript-state.js";
import {
  buildHistoryItemTranscriptSections,
  flattenTranscriptSections,
  getVisibleTranscriptRows,
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

export interface TranscriptSearchAnchorOptions {
  items: HistoryItem[];
  selectedItemId?: string;
  terminalWidth?: number;
  transcriptMaxLines?: number;
  viewportRows?: number;
  scrollOffset?: number;
  expandedItemKeys?: ReadonlySet<string>;
  showDetailedTools?: boolean;
  preferViewportAnchor?: boolean;
}

export function resolveTranscriptSearchAnchorItemId(
  options: TranscriptSearchAnchorOptions,
): string | undefined {
  const {
    items,
    selectedItemId,
    terminalWidth = 80,
    transcriptMaxLines = 1000,
    viewportRows,
    scrollOffset = 0,
    expandedItemKeys,
    showDetailedTools = false,
    preferViewportAnchor = false,
  } = options;

  if (selectedItemId && items.some((item) => item.id === selectedItemId)) {
    return selectedItemId;
  }

  if (preferViewportAnchor && scrollOffset > 0 && viewportRows && viewportRows > 0) {
    const sections = buildHistoryItemTranscriptSections(
      items,
      terminalWidth,
      transcriptMaxLines,
      showDetailedTools,
      expandedItemKeys,
    );
    const visibleRows = getVisibleTranscriptRows(
      flattenTranscriptSections(sections),
      viewportRows,
      scrollOffset,
    );
    const firstVisibleRowKey = visibleRows[0]?.key;
    const firstVisibleSection = firstVisibleRowKey
      ? sections.find((section) => section.rows.some((row) => row.key === firstVisibleRowKey))
      : undefined;
    if (firstVisibleSection?.key) {
      return firstVisibleSection.key;
    }
  }

  return items[items.length - 1]?.id;
}
