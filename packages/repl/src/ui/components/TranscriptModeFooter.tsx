import React from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";

export interface TranscriptModeFooterProps {
  searchActive?: boolean;
  searchQuery?: string;
  searchCurrent?: number;
  searchCount?: number;
  pendingLiveUpdates?: number;
  secondaryText?: string;
  noticeText?: string;
}

export const TranscriptModeFooter: React.FC<TranscriptModeFooterProps> = ({
  searchActive = false,
  searchQuery = "",
  searchCurrent = 0,
  searchCount = 0,
  pendingLiveUpdates = 0,
  secondaryText,
  noticeText,
}) => {
  const theme = getTheme("dark");
  const trimmedQuery = searchQuery.trim();
  const trimmedSecondaryText = secondaryText?.trim();
  const trimmedNoticeText = noticeText?.trim();
  const statusText = searchActive
    ? trimmedQuery
      ? `Search /${trimmedQuery}`
      : "Search transcript"
    : "Showing detailed transcript";
  const helpText = searchActive
    ? "Enter select | n/N next match | Esc close | Ctrl+O/q back to live"
    : "PgUp/PgDn/j/k scroll | / search | Ctrl+O/q/Esc back to live";
  const updateText = pendingLiveUpdates > 0
    ? pendingLiveUpdates === 1
      ? "1 new update"
      : `${pendingLiveUpdates} new updates`
    : undefined;
  const searchCountText = searchActive && searchCount > 0
    ? `${Math.max(0, searchCurrent)}/${searchCount}`
    : undefined;
  const showSupplementalRow = Boolean(trimmedSecondaryText || trimmedNoticeText);

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={theme.colors.dim}>{statusText}</Text>
        <Text dimColor>{" · "}</Text>
        <Text color={theme.colors.dim}>{helpText}</Text>
        {(searchCountText || updateText) ? <Box flexGrow={1} /> : null}
        {searchCountText ? (
          <>
            <Text dimColor>{searchCountText}</Text>
            {updateText ? <Text dimColor>{" · "}</Text> : null}
          </>
        ) : null}
        {updateText ? (
          <Text color={theme.colors.accent} bold>
            {updateText}
          </Text>
        ) : null}
      </Box>
      {showSupplementalRow ? (
        <Box paddingX={1}>
          {trimmedSecondaryText ? (
            <Text color={theme.colors.dim}>{trimmedSecondaryText}</Text>
          ) : null}
          {trimmedSecondaryText && trimmedNoticeText ? <Text dimColor>{" · "}</Text> : null}
          {trimmedNoticeText ? (
            <Text color={theme.colors.accent} bold>
              {trimmedNoticeText}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
};
