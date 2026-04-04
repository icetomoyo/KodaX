import type {
  TranscriptViewportSearchState,
  TranscriptViewportSelectionState,
} from "../components/TranscriptViewport.js";
import type {
  TranscriptSearchMatch,
  TranscriptSelectionSummary,
} from "../utils/transcript-search.js";
import type {
  TranscriptSelectionCapabilityState,
} from "../utils/transcript-state.js";
import {
  ownsTranscriptSelectionPath,
  supportsPassiveTranscriptCopyOnSelect,
} from "../utils/transcript-state.js";

export interface BuildTranscriptSelectionViewModelOptions {
  state: TranscriptSelectionCapabilityState;
  itemSummary?: TranscriptSelectionSummary;
  selectedItemId?: string;
  selectedItemIndex: number;
  selectableCount: number;
  canCopyToolInput: boolean;
  isExpanded: boolean;
}

export interface BuildTranscriptSearchViewModelOptions {
  query: string;
  matches: TranscriptSearchMatch[];
  currentMatchIndex: number;
  anchorItemId?: string;
  statusText?: string;
  useOverlaySurface: boolean;
}

export function buildTranscriptSelectionViewModel(
  options: BuildTranscriptSelectionViewModelOptions,
): TranscriptViewportSelectionState | undefined {
  const selectionEnabled = ownsTranscriptSelectionPath(options.state);
  if (!selectionEnabled) {
    return undefined;
  }

  return {
    itemSummary: options.itemSummary?.summary,
    itemKind: options.itemSummary?.kindLabel,
    position: options.selectedItemId
      ? {
        current: Math.max(1, options.selectedItemIndex + 1),
        total: options.selectableCount,
      }
      : undefined,
    detailState:
      options.selectedItemId && options.isExpanded ? "expanded" : "compact",
    copyCapabilities: {
      message: Boolean(options.selectedItemId),
      toolInput: options.canCopyToolInput,
      copyOnSelect: supportsPassiveTranscriptCopyOnSelect(options.state),
    },
    toggleDetail: Boolean(options.selectedItemId),
    navigationCapabilities: {
      selection: options.selectableCount > 1,
    },
  };
}

export function buildTranscriptSearchViewModel(
  options: BuildTranscriptSearchViewModelOptions,
): TranscriptViewportSearchState {
  return {
    query: options.query,
    matches: options.matches,
    currentMatchIndex: options.currentMatchIndex,
    anchorItemId: options.anchorItemId,
    statusText: options.useOverlaySurface ? undefined : options.statusText,
  };
}
