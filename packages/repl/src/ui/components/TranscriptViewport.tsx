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
  canCopySelection?: boolean;
  canToggleSelectionDetail?: boolean;
  searchStatusText?: string;
  searchSurface?: React.ReactNode;
}

export const TranscriptViewport: React.FC<TranscriptViewportProps> = ({
  browseHintText,
  selectedSummary,
  selectedIndex = 0,
  selectedTotal = 0,
  canCopySelection = false,
  canToggleSelectionDetail = false,
  searchStatusText,
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
        />
      ) : null}
      {(canCopySelection || canToggleSelectionDetail) ? (
        <MessageActions
          canCopy={canCopySelection}
          canToggleDetail={canToggleSelectionDetail}
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
