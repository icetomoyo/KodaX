import React from "react";
import { Box, Text } from "ink";
import type { MessageListProps } from "./MessageList.js";
import { MessageList } from "./MessageList.js";
import { MessageActions } from "./MessageActions.js";
import { MessageSelector } from "./MessageSelector.js";

export interface TranscriptViewportBrowseState {
  hintText?: string;
}

export interface TranscriptViewportSelectionState {
  itemSummary?: string;
  itemKind?: string;
  position?: {
    current: number;
    total: number;
  };
  detailState?: "compact" | "expanded";
  copyCapabilities?: {
    message?: boolean;
    toolInput?: boolean;
    copyOnSelect?: boolean;
  };
  toggleDetail?: boolean;
  navigationCapabilities?: {
    selection?: boolean;
  };
}

export interface TranscriptViewportSearchState {
  query?: string;
  matches?: Array<{ itemId: string; excerpt: string }>;
  currentMatchIndex?: number;
  anchorItemId?: string;
  statusText?: string;
  surface?: React.ReactNode;
  onNext?: () => void;
  onPrev?: () => void;
}

export interface TranscriptViewportProps extends MessageListProps {
  browse?: TranscriptViewportBrowseState;
  selection?: TranscriptViewportSelectionState;
  search?: TranscriptViewportSearchState;
}

export const TranscriptViewport: React.FC<TranscriptViewportProps> = ({
  browse,
  selection,
  search,
  ...messageListProps
}) => {
  const selectedSummary = selection?.itemSummary;
  const selectedPosition = selection?.position;
  const selectedKindLabel = selection?.itemKind;
  const selectedDetailState = selection?.detailState ?? "compact";
  const copyCapabilities = selection?.copyCapabilities;
  const canCopySelection = copyCapabilities?.message ?? false;
  const canCopyToolInput = copyCapabilities?.toolInput ?? false;
  const supportsCopyOnSelect = copyCapabilities?.copyOnSelect ?? false;
  const canToggleSelectionDetail = selection?.toggleDetail ?? false;
  const canNavigateSelection = selection?.navigationCapabilities?.selection ?? false;
  const searchStatusText = search?.statusText;
  const searchMatchCount = search?.matches?.length ?? 0;
  const searchSurface = search?.surface;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {browse?.hintText ? (
        <Box paddingX={1}>
          <Text dimColor>{browse.hintText}</Text>
        </Box>
      ) : null}
      {selectedSummary ? (
        <MessageSelector
          itemSummary={selectedSummary}
          itemKind={selectedKindLabel}
          position={selectedPosition}
          detailState={selectedDetailState}
        />
      ) : null}
      {(canCopySelection || canCopyToolInput || supportsCopyOnSelect || canToggleSelectionDetail || canNavigateSelection || searchMatchCount > 0) ? (
        <MessageActions
          copyMessage={canCopySelection}
          copyToolInput={canCopyToolInput}
          copyOnSelect={supportsCopyOnSelect}
          toggleDetail={canToggleSelectionDetail}
          selectionNavigation={canNavigateSelection}
          matchNavigation={Boolean(searchStatusText) && searchMatchCount > 0}
        />
      ) : null}
      {searchStatusText ? (
        <Box paddingX={1}>
          <Text dimColor>{searchStatusText}</Text>
        </Box>
      ) : null}
      {searchSurface}
      <MessageList {...messageListProps} />
    </Box>
  );
};
