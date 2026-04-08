import React, { useMemo } from "react";
import { Box, Text } from "../tui.js";
import type { MessageListProps } from "./MessageList.js";
import { MessageList } from "./MessageList.js";
import { MessageActions, buildMessageActionsText } from "./MessageActions.js";
import { MessageSelector, buildMessageSelectorText } from "./MessageSelector.js";
import { calculateVisualLayout } from "../utils/textUtils.js";

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
  chromeMode?: "inline" | "hidden";
}

function countWrappedRows(text: string, width: number): number {
  return Math.max(
    1,
    calculateVisualLayout(
      text.length > 0 ? text.split("\n") : [""],
      Math.max(1, width),
      0,
      0,
    ).visualLines.length,
  );
}

export const TranscriptViewport: React.FC<TranscriptViewportProps> = ({
  browse,
  selection,
  search,
  chromeMode = "inline",
  ...messageListProps
}) => {
  const inlineChromeVisible = chromeMode === "inline";
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
  const viewportWidth = messageListProps.viewportWidth ?? 80;
  const chromeWidth = Math.max(1, viewportWidth - 2);
  const dismissAction = search?.query?.trim()
    ? "close-search"
    : (selectedSummary || canCopySelection || canCopyToolInput || canToggleSelectionDetail || canNavigateSelection)
      ? "clear"
      : undefined;
  const selectionText = buildMessageSelectorText({
    itemSummary: selectedSummary,
    itemKind: selectedKindLabel,
    position: selectedPosition,
    detailState: selectedDetailState,
  });
  const actionsText = useMemo(() => buildMessageActionsText({
    copyMessage: canCopySelection,
    copyToolInput: canCopyToolInput,
    copyOnSelect: supportsCopyOnSelect,
    toggleDetail: canToggleSelectionDetail,
    selectionNavigation: canNavigateSelection,
    matchNavigation: Boolean(searchStatusText) && searchMatchCount > 0,
    dismissAction,
  }), [
    canCopySelection,
    canCopyToolInput,
    canNavigateSelection,
    canToggleSelectionDetail,
    dismissAction,
    searchMatchCount,
    searchStatusText,
    supportsCopyOnSelect,
  ]);
  const chromeRows = useMemo(() => {
    if (!inlineChromeVisible) {
      return 0;
    }
    let rows = 0;
    if (browse?.hintText) {
      rows += countWrappedRows(browse.hintText, chromeWidth);
    }
    if (selectionText) {
      rows += countWrappedRows(selectionText, chromeWidth);
    }
    if (actionsText) {
      rows += countWrappedRows(actionsText, chromeWidth);
    }
    if (searchStatusText) {
      rows += countWrappedRows(searchStatusText, chromeWidth);
    }
    if (searchSurface) {
      rows += 1;
    }
    return rows;
  }, [actionsText, browse?.hintText, chromeWidth, inlineChromeVisible, searchStatusText, searchSurface, selectionText]);
  const adjustedViewportRows = typeof messageListProps.viewportRows === "number"
    ? Math.max(1, messageListProps.viewportRows - chromeRows)
    : messageListProps.viewportRows;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {inlineChromeVisible && browse?.hintText ? (
        <Box paddingX={1}>
          <Text dimColor>{browse.hintText}</Text>
        </Box>
      ) : null}
      {inlineChromeVisible && false ? (
        <MessageSelector
          itemSummary={selectedSummary}
          itemKind={selectedKindLabel}
          position={selectedPosition}
          detailState={selectedDetailState}
        />
      ) : null}
      {inlineChromeVisible && (canCopySelection || canCopyToolInput || supportsCopyOnSelect || canToggleSelectionDetail || canNavigateSelection || searchMatchCount > 0) ? (
        <MessageActions
          copyMessage={canCopySelection}
          copyToolInput={canCopyToolInput}
          copyOnSelect={supportsCopyOnSelect}
          toggleDetail={canToggleSelectionDetail}
          selectionNavigation={canNavigateSelection}
          matchNavigation={Boolean(searchStatusText) && searchMatchCount > 0}
          dismissAction={dismissAction}
        />
      ) : null}
      {inlineChromeVisible && searchStatusText ? (
        <Box paddingX={1}>
          <Text dimColor>{searchStatusText}</Text>
        </Box>
      ) : null}
      {inlineChromeVisible ? searchSurface : null}
      <MessageList
        {...messageListProps}
        viewportRows={adjustedViewportRows}
      />
    </Box>
  );
};

