import React from "react";
import { Box, Text } from "ink";
import type { MessageListProps } from "./MessageList.js";
import { MessageList } from "./MessageList.js";
import { MessageActions } from "./MessageActions.js";
import { MessageSelector } from "./MessageSelector.js";

export interface TranscriptViewportProps extends MessageListProps {
  browseHintText?: string;
  selectedSummary?: string;
  selectedIndex?: number;
  selectedTotal?: number;
  selectedKindLabel?: string;
  selectedDetailExpanded?: boolean;
  canCopySelection?: boolean;
  canCopyToolInput?: boolean;
  canToggleSelectionDetail?: boolean;
  searchStatusText?: string;
  searchMatchCount?: number;
  searchSurface?: React.ReactNode;
}

export const TranscriptViewport: React.FC<TranscriptViewportProps> = ({
  browseHintText,
  selectedSummary,
  selectedIndex = 0,
  selectedTotal = 0,
  selectedKindLabel,
  selectedDetailExpanded = false,
  canCopySelection = false,
  canCopyToolInput = false,
  canToggleSelectionDetail = false,
  searchStatusText,
  searchMatchCount = 0,
  searchSurface,
  ...messageListProps
}) => {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {browseHintText ? (
        <Box paddingX={1}>
          <Text dimColor>{browseHintText}</Text>
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
