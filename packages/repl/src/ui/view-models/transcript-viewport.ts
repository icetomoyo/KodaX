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
  resolveTranscriptSelectedItemId,
  supportsPassiveTranscriptCopyOnSelect,
} from "../utils/transcript-state.js";

export interface TranscriptSelectionRuntimeState {
  selectionEnabled: boolean;
  selectedItemId?: string;
  selectedItemIndex: number;
  position?: {
    current: number;
    total: number;
  };
  detailState: "compact" | "expanded";
  copyCapabilities: {
    message: boolean;
    toolInput: boolean;
    copyOnSelect: boolean;
  };
  toggleDetail: boolean;
  navigationCapabilities: {
    selection: boolean;
  };
}

export interface BuildTranscriptSelectionRuntimeStateOptions {
  state: TranscriptSelectionCapabilityState;
  selectableItemIds: readonly string[];
  selectedItemId?: string;
  selectedItemType?: string;
  isExpanded: boolean;
}

export interface BuildTranscriptSelectionViewModelOptions {
  runtime: TranscriptSelectionRuntimeState;
  itemSummary?: TranscriptSelectionSummary;
}

export interface BuildTranscriptSearchViewModelOptions {
  query: string;
  matches: TranscriptSearchMatch[];
  currentMatchIndex: number;
  anchorItemId?: string;
  statusText?: string;
  useOverlaySurface: boolean;
}

export function buildTranscriptSelectionRuntimeState(
  options: BuildTranscriptSelectionRuntimeStateOptions,
): TranscriptSelectionRuntimeState {
  const selectionEnabled = ownsTranscriptSelectionPath(options.state);
  const selectedItemId = resolveTranscriptSelectedItemId(
    options.state,
    options.selectableItemIds,
    options.selectedItemId,
  );
  const selectedItemIndex = selectedItemId
    ? options.selectableItemIds.indexOf(selectedItemId)
    : -1;

  return {
    selectionEnabled,
    selectedItemId,
    selectedItemIndex,
    position: selectedItemId
      ? {
        current: Math.max(1, selectedItemIndex + 1),
        total: options.selectableItemIds.length,
      }
      : undefined,
    detailState: selectedItemId && options.isExpanded ? "expanded" : "compact",
    copyCapabilities: {
      message: Boolean(selectedItemId),
      toolInput: Boolean(selectedItemId) && options.selectedItemType === "tool_group",
      copyOnSelect: supportsPassiveTranscriptCopyOnSelect(options.state),
    },
    toggleDetail: Boolean(selectedItemId),
    navigationCapabilities: {
      selection: options.selectableItemIds.length > 1,
    },
  };
}

export function buildTranscriptSelectionViewModel(
  options: BuildTranscriptSelectionViewModelOptions,
): TranscriptViewportSelectionState | undefined {
  if (!options.runtime.selectionEnabled || !options.runtime.selectedItemId) {
    return undefined;
  }

  return {
    itemSummary: options.itemSummary?.summary,
    itemKind: options.itemSummary?.kindLabel,
    position: options.runtime.position,
    detailState: options.runtime.detailState,
    copyCapabilities: options.runtime.copyCapabilities,
    toggleDetail: options.runtime.toggleDetail,
    navigationCapabilities: options.runtime.navigationCapabilities,
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
