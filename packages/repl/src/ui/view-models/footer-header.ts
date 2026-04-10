import type { TranscriptBufferingMode } from "../utils/transcript-state.js";

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
  isTranscriptMode: boolean;
  pendingInputCount: number;
  buffering: TranscriptBufferingMode;
  pendingLiveUpdates: number;
}

export function buildFooterHeaderViewModel(
  input: FooterHeaderViewModelInput,
): FooterHeaderViewModel {
  const leftItems: FooterHeaderItem[] = [];

  if (input.isHistorySearchActive) {
    leftItems.push({ id: "search", label: "Search", accent: true });
  } else if (input.isTranscriptMode) {
    leftItems.push({ id: "transcript", label: "Transcript" });
  }

  if (input.pendingInputCount > 0) {
    leftItems.push({
      id: "queue",
      label: `Queue ${input.pendingInputCount}`,
    });
  }

  if (
    input.buffering === "buffered-fallback"
    && (input.isHistorySearchActive || input.isTranscriptMode)
  ) {
    leftItems.push({ id: "buffered", label: "Buffered" });
  }

  if (input.isTranscriptMode && input.pendingLiveUpdates > 0) {
    leftItems.push({
      id: "updates",
      label: input.pendingLiveUpdates === 1
        ? "1 update"
        : `${input.pendingLiveUpdates} updates`,
      accent: true,
    });
  }

  const rightItems: FooterHeaderItem[] = [];

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
