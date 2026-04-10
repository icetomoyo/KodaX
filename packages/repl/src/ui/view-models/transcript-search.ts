import type { TranscriptSearchMatch } from "../utils/transcript-search.js";
import { buildTranscriptSearchSummary } from "../utils/transcript-search.js";
import { buildTranscriptSearchViewModel } from "./transcript-viewport.js";

export interface BuildTranscriptSearchChromeOptions {
  isHistorySearchActive: boolean;
  historySearchQuery: string;
  matches: TranscriptSearchMatch[];
  selectedIndex: number;
  anchorItemId?: string;
  useOverlaySurface: boolean;
}

export interface TranscriptSearchChromeViewModel {
  clampedSelectedIndex: number;
  statusText?: string;
  detailText?: string;
  searchState: ReturnType<typeof buildTranscriptSearchViewModel>;
}

export function clampTranscriptSearchSelectedIndex(
  matchesLength: number,
  selectedIndex: number,
): number {
  if (matchesLength === 0) {
    return 0;
  }
  if (selectedIndex < 0) {
    return -1;
  }
  return Math.min(selectedIndex, matchesLength - 1);
}

export function buildTranscriptSearchDetailText(
  options: Pick<BuildTranscriptSearchChromeOptions, "isHistorySearchActive" | "historySearchQuery" | "matches"> & {
    clampedSelectedIndex: number;
  },
): string | undefined {
  if (!options.isHistorySearchActive) {
    return undefined;
  }

  const trimmedQuery = options.historySearchQuery.trim();
  if (!trimmedQuery) {
    return "Type to search transcript";
  }

  if (options.matches.length === 0) {
    return "No matches yet";
  }

  if (options.clampedSelectedIndex < 0) {
    return `${options.matches.length} matches | use n/N or Enter to jump`;
  }

  return options.matches[options.clampedSelectedIndex]?.excerpt;
}

export function buildTranscriptSearchChrome(
  options: BuildTranscriptSearchChromeOptions,
): TranscriptSearchChromeViewModel {
  const clampedSelectedIndex = clampTranscriptSearchSelectedIndex(
    options.matches.length,
    options.selectedIndex,
  );
  const statusText = buildTranscriptSearchSummary(
    options.matches,
    clampedSelectedIndex,
  );
  const detailText = buildTranscriptSearchDetailText({
    isHistorySearchActive: options.isHistorySearchActive,
    historySearchQuery: options.historySearchQuery,
    matches: options.matches,
    clampedSelectedIndex,
  });

  return {
    clampedSelectedIndex,
    statusText,
    detailText,
    searchState: buildTranscriptSearchViewModel({
      query: options.historySearchQuery,
      matches: options.matches,
      currentMatchIndex: clampedSelectedIndex,
      anchorItemId: options.anchorItemId,
      statusText,
      useOverlaySurface: options.useOverlaySurface,
    }),
  };
}
