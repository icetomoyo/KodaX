import React from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";

const ITEM_SEPARATOR = " | ";

export interface TranscriptModeFooterProps {
  searchActive?: boolean;
  selectionActive?: boolean;
  showAllActive?: boolean;
  searchQuery?: string;
  searchCurrent?: number;
  searchCount?: number;
  searchDetailText?: string;
  pendingLiveUpdates?: number;
  secondaryText?: string;
  noticeText?: string;
}

export const TranscriptModeFooter: React.FC<TranscriptModeFooterProps> = ({
  searchActive = false,
  selectionActive = false,
  showAllActive = false,
  searchQuery = "",
  searchCurrent = 0,
  searchCount = 0,
  searchDetailText,
  pendingLiveUpdates = 0,
  secondaryText,
  noticeText,
}) => {
  const theme = getTheme("dark");
  const trimmedQuery = searchQuery.trim();
  const trimmedSearchDetailText = searchDetailText?.trim();
  const trimmedSecondaryText = secondaryText?.trim();
  const trimmedNoticeText = noticeText?.trim();
  const statusText = searchActive
    ? trimmedQuery
      ? `Search /${trimmedQuery}`
      : "Search"
    : "Transcript";
  const helpText = searchActive
    ? `Enter jump | n/N next/prev | Ctrl+E ${showAllActive ? "collapse" : "show all"} | Esc close | Ctrl+O/q back`
    : selectionActive
      ? `PgUp/PgDn page | j/k scroll | / search | n/N matches | Ctrl+E ${showAllActive ? "collapse" : "show all"} | Esc clear focus | Ctrl+O/q back`
      // FEATURE_058: `s` dumps the transcript to native scrollback. Shown
      // only in the default (non-search, non-selection) variant to keep
      // the other variants compact.
      : `PgUp/PgDn page | j/k scroll | \u2190/\u2192 select | / search | n/N matches | Ctrl+E ${showAllActive ? "collapse" : "show all"} | s dump | Ctrl+O/q/Esc back`;
  const updateText = pendingLiveUpdates > 0
    ? pendingLiveUpdates === 1
      ? "1 new update"
      : `${pendingLiveUpdates} new updates`
    : undefined;
  const searchCountText = searchActive && searchCount > 0
    ? `${Math.max(0, searchCurrent)}/${searchCount}`
    : undefined;
  const supplementalPrimaryText = searchActive
    ? (trimmedSearchDetailText || trimmedSecondaryText)
    : trimmedSecondaryText;
  const showSupplementalRow = Boolean(supplementalPrimaryText || trimmedNoticeText);

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={theme.colors.dim}>{statusText}</Text>
        <Text dimColor>{ITEM_SEPARATOR}</Text>
        <Text color={theme.colors.dim}>{helpText}</Text>
        {(searchCountText || updateText) ? <Box flexGrow={1} /> : null}
        {searchCountText ? (
          <>
            <Text dimColor>{searchCountText}</Text>
            {updateText ? <Text dimColor>{ITEM_SEPARATOR}</Text> : null}
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
          {supplementalPrimaryText ? (
            <Text color={theme.colors.dim}>{supplementalPrimaryText}</Text>
          ) : null}
          {supplementalPrimaryText && trimmedNoticeText ? (
            <Text dimColor>{ITEM_SEPARATOR}</Text>
          ) : null}
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
