import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { HistoryItem } from "../types.js";
import type { ScrollBoxHandle } from "../../tui/components/ScrollBox.js";
import {
  buildTranscriptBrowseHint,
  type TranscriptDisplayState,
} from "./transcript-state.js";
import {
  buildHistoryItemTranscriptSections,
  type TranscriptRenderModel,
  flattenTranscriptSections,
  getVisibleTranscriptRows,
  resolveScrollOffsetForTranscriptItem,
} from "./transcript-layout.js";

export interface TranscriptChromeModel {
  browseHintText?: string;
  stickyHeader?: {
    visible: boolean;
    label: string;
  };
  jumpToLatest?: {
    visible: boolean;
    label: string;
    hint?: string;
    tone?: "dim" | "accent";
  };
}

export interface TranscriptChromeOptions {
  state: TranscriptDisplayState;
  ownsViewport: boolean;
  isAwaitingUserInteraction: boolean;
  isHistorySearchActive: boolean;
  isTranscriptMode: boolean;
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
    isTranscriptMode,
    historySearchQuery,
  } = options;

  const browseHintText = buildTranscriptBrowseHint(state);

  let stickyHeader: TranscriptChromeModel["stickyHeader"];
  if (state.supportsStickyPrompt && state.stickyPromptVisible) {
    if (isHistorySearchActive) {
      const query = historySearchQuery.trim();
      stickyHeader = {
        visible: true,
        label: query
          ? `Searching transcript for "${query}"`
          : "Searching transcript",
      };
    } else if (isTranscriptMode) {
      stickyHeader = {
        visible: true,
        label: "Transcript Mode",
      };
    } else if (isAwaitingUserInteraction) {
      stickyHeader = {
        visible: true,
        label: "Interaction active",
      };
    }
  }

  let jumpToLatest: TranscriptChromeModel["jumpToLatest"];
  if (ownsViewport && state.supportsViewportChrome) {
    if (isTranscriptMode && state.pendingLiveUpdates > 0) {
      jumpToLatest = {
        visible: true,
        label: state.pendingLiveUpdates === 1
          ? "1 new update"
          : `${state.pendingLiveUpdates} new updates`,
        hint: "Ctrl+O",
        tone: "accent",
      };
    } else if (!isTranscriptMode && state.jumpToLatestAvailable) {
      jumpToLatest = {
        visible: true,
        label: "Back to live",
        hint: "End",
        tone: "accent",
      };
    }
  }

  return {
    browseHintText,
    stickyHeader,
    jumpToLatest,
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

export function clampTranscriptScrollOffset(
  currentOffset: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  const maxScrollOffset = Math.max(0, scrollHeight - viewportHeight);
  return Math.min(Math.max(0, currentOffset), maxScrollOffset);
}

export interface TranscriptViewportScrollController {
  scrollRef: MutableRefObject<ScrollBoxHandle | null>;
  scrollOffset: number;
  sticky: boolean;
  setScrollOffset: Dispatch<SetStateAction<number>>;
  setSticky: Dispatch<SetStateAction<boolean>>;
  handleScrollTopChange: (nextScrollTop: number) => void;
  handleStickyChange: (sticky: boolean) => void;
  scrollTo: (nextScrollOffset: number) => void;
  scrollBy: (delta: number) => void;
  scrollToBottom: () => void;
}

export function useTranscriptViewportScrollController(
): TranscriptViewportScrollController {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [sticky, setSticky] = useState(true);

  const handleScrollTopChange = useCallback((nextScrollTop: number) => {
    setScrollOffset(Math.max(0, nextScrollTop));
  }, []);

  const handleStickyChange = useCallback((nextSticky: boolean) => {
    setSticky(nextSticky);
  }, []);

  const scrollTo = useCallback((nextScrollOffset: number) => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo(nextScrollOffset);
      return;
    }

    setScrollOffset(Math.max(0, nextScrollOffset));
    setSticky(nextScrollOffset === 0);
  }, []);

  const scrollBy = useCallback((delta: number) => {
    if (scrollRef.current) {
      scrollRef.current.scrollBy(delta);
      return;
    }

    setScrollOffset((prev) => incrementTranscriptScrollOffset(prev, delta));
    setSticky(false);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollToBottom();
      return;
    }

    setScrollOffset(0);
    setSticky(true);
  }, []);

  return {
    scrollRef,
    scrollOffset,
    sticky,
    setScrollOffset,
    setSticky,
    handleScrollTopChange,
    handleStickyChange,
    scrollTo,
    scrollBy,
    scrollToBottom,
  };
}

export interface TranscriptSelectionOffsetOptions {
  items: HistoryItem[];
  renderModel?: TranscriptRenderModel;
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
    renderModel,
    terminalWidth,
    transcriptMaxLines,
    viewportRows,
    itemId,
    expandedItemKeys,
    showDetailedTools = false,
  } = options;

  const sections = renderModel?.sections ?? buildHistoryItemTranscriptSections(
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
  renderModel?: TranscriptRenderModel;
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
    renderModel,
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
    const sections = renderModel?.sections ?? buildHistoryItemTranscriptSections(
      items,
      terminalWidth,
      transcriptMaxLines,
      showDetailedTools,
      expandedItemKeys,
    );
    const rows = renderModel?.rows ?? flattenTranscriptSections(sections);
    const visibleRows = getVisibleTranscriptRows(
      rows,
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
