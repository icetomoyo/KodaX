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
  summary?: string;
  index?: number;
  total?: number;
  kindLabel?: string;
  detailExpanded?: boolean;
  canCopy?: boolean;
  canCopyToolInput?: boolean;
  canToggleDetail?: boolean;
}

export interface TranscriptViewportSearchState {
  statusText?: string;
  matchCount?: number;
  surface?: React.ReactNode;
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
  const selectedSummary = selection?.summary;
  const selectedIndex = selection?.index ?? 0;
  const selectedTotal = selection?.total ?? 0;
  const selectedKindLabel = selection?.kindLabel;
  const selectedDetailExpanded = selection?.detailExpanded ?? false;
  const canCopySelection = selection?.canCopy ?? false;
  const canCopyToolInput = selection?.canCopyToolInput ?? false;
  const canToggleSelectionDetail = selection?.canToggleDetail ?? false;
  const searchStatusText = search?.statusText;
  const searchMatchCount = search?.matchCount ?? 0;
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
          summary={selectedSummary}
          selectedIndex={Math.max(0, selectedIndex)}
          total={selectedTotal}
          kindLabel={selectedKindLabel}
          detailExpanded={selectedDetailExpanded}
        />
      ) : null}
      {(canCopySelection || canCopyToolInput || canToggleSelectionDetail || searchMatchCount > 0) ? (
        <MessageActions
          canCopy={canCopySelection}
          canCopyToolInput={canCopyToolInput}
          canToggleDetail={canToggleSelectionDetail}
          searchActive={Boolean(searchStatusText)}
          searchMatchCount={searchMatchCount}
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
