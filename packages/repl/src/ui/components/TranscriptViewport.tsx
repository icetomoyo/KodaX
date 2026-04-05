import React, { useMemo } from "react";
import { Box, Text } from "../tui.js";
import type { MessageListProps } from "./MessageList.js";
import { MessageList } from "./MessageList.js";
import { MessageActions } from "./MessageActions.js";
import { MessageSelector } from "./MessageSelector.js";
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
  const viewportWidth = messageListProps.viewportWidth ?? 80;
  const chromeWidth = Math.max(1, viewportWidth - 2);
  const selectionText = selectedSummary && selectedPosition
    ? `Selected ${selectedPosition.current}/${selectedPosition.total}: ${selectedKindLabel ? `${selectedKindLabel}: ` : ""}${selectedSummary} [${selectedDetailState}]`
    : undefined;
  const actionsText = useMemo(() => {
    const actions: string[] = [];
    if (canNavigateSelection) {
      actions.push("\u2190/\u2192 select");
    }
    if (canCopySelection) {
      actions.push("C copy");
    }
    if (canCopyToolInput) {
      actions.push("I copy input");
    }
    if (supportsCopyOnSelect) {
      actions.push("Select copies");
    }
    if (canToggleSelectionDetail) {
      actions.push("V toggle detail");
    }
    if (Boolean(searchStatusText) && searchMatchCount > 0) {
      actions.push("Up/Down matches");
    }
    return actions.length > 0 ? actions.join(" | ") : undefined;
  }, [
    canCopySelection,
    canCopyToolInput,
    canNavigateSelection,
    canToggleSelectionDetail,
    searchMatchCount,
    searchStatusText,
    supportsCopyOnSelect,
  ]);
  const chromeRows = useMemo(() => {
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
  }, [actionsText, browse?.hintText, chromeWidth, searchStatusText, searchSurface, selectionText]);
  const adjustedViewportRows = typeof messageListProps.viewportRows === "number"
    ? Math.max(1, messageListProps.viewportRows - chromeRows)
    : messageListProps.viewportRows;

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
      <MessageList
        {...messageListProps}
        viewportRows={adjustedViewportRows}
      />
    </Box>
  );
};

