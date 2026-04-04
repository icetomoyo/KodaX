import type { TranscriptBufferingMode, TranscriptVerbosity } from "../utils/transcript-state.js";

export interface FooterHeaderItem {
  id: string;
  label: string;
  accent?: boolean;
}

export interface FooterHeaderViewModel {
  leftItems: FooterHeaderItem[];
  rightItems: FooterHeaderItem[];
  summary: string;
}

export interface FooterHeaderViewModelInput {
  isHistorySearchActive: boolean;
  isReviewingHistory: boolean;
  pendingInputCount: number;
  buffering: TranscriptBufferingMode;
  verbosity: TranscriptVerbosity;
}

export function buildFooterHeaderViewModel(
  input: FooterHeaderViewModelInput,
): FooterHeaderViewModel {
  const leftItems: FooterHeaderItem[] = [];

  if (input.isHistorySearchActive) {
    leftItems.push({ id: "search", label: "Search", accent: true });
  } else if (input.isReviewingHistory) {
    leftItems.push({ id: "history", label: "History" });
  }

  if (input.pendingInputCount > 0) {
    leftItems.push({
      id: "queue",
      label: `Queue ${input.pendingInputCount}`,
    });
  }

  if (
    input.buffering === "buffered-fallback"
    && (input.isHistorySearchActive || input.isReviewingHistory)
  ) {
    leftItems.push({ id: "buffered", label: "Buffered" });
  }

  const rightItems: FooterHeaderItem[] = [];
  if (input.verbosity === "verbose") {
    rightItems.push({ id: "verbosity", label: "verbose", accent: true });
  }

  const summary = [...leftItems, ...rightItems]
    .map((item) => item.label.trim())
    .filter(Boolean)
    .join(" | ");

  return {
    leftItems,
    rightItems,
    summary,
  };
}
