import React from "react";
import { Box, Text } from "../index.js";
import { ScrollBox, type ScrollBoxHandle, type ScrollBoxWindow } from "./ScrollBox.js";
import { calculateVisualLayout } from "../../ui/utils/textUtils.js";

export interface FullscreenChromeSlot {
  visible?: boolean;
  label?: string;
  hint?: string;
  tone?: "dim" | "accent";
}

export interface FullscreenLayoutProps {
  scrollable?: React.ReactNode;
  renderScrollableWindow?: (window: ScrollBoxWindow) => React.ReactNode;
  bottom: React.ReactNode;
  overlay?: React.ReactNode;
  stickyHeader?: FullscreenChromeSlot;
  jumpToLatest?: FullscreenChromeSlot;
  width?: number;
  scrollTop?: number;
  scrollHeight?: number;
  viewportHeight?: number;
  stickyScroll?: boolean;
  scrollRef?: React.Ref<ScrollBoxHandle>;
  onScrollTopChange?: (nextScrollTop: number) => void;
  onStickyChange?: (sticky: boolean) => void;
  onWindowChange?: (window: ScrollBoxWindow) => void;
}

const DEFAULT_LAYOUT_WIDTH = 80;

function resolveChromeSlotText(slot: FullscreenChromeSlot | undefined): string | undefined {
  if (!slot?.visible || !slot.label) {
    return undefined;
  }

  return slot.hint ? `${slot.label}: ${slot.hint}` : slot.label;
}

function measureChromeSlotRows(
  slotText: string | undefined,
  width: number | string | undefined,
): number {
  if (!slotText) {
    return 0;
  }

  const availableWidth = Math.max(
    1,
    (typeof width === "number" ? width : DEFAULT_LAYOUT_WIDTH) - 2,
  );
  return Math.max(
    1,
    calculateVisualLayout(slotText.split("\n"), availableWidth, 0, 0).visualLines.length,
  );
}

export const FullscreenLayout: React.FC<FullscreenLayoutProps> = ({
  scrollable,
  renderScrollableWindow,
  bottom,
  overlay,
  stickyHeader,
  jumpToLatest,
  width,
  scrollTop = 0,
  scrollHeight = 0,
  viewportHeight = 0,
  stickyScroll = true,
  scrollRef,
  onScrollTopChange,
  onStickyChange,
  onWindowChange,
}) => {
  const renderChromeSlot = (slot: FullscreenChromeSlot | undefined, text: string | undefined) => {
    if (!text) {
      return null;
    }
    return (
      <Box paddingX={1}>
        <Text dimColor={slot?.tone !== "accent"}>{text}</Text>
      </Box>
    );
  };
  const stickyHeaderText = resolveChromeSlotText(stickyHeader);
  const jumpToLatestText = resolveChromeSlotText(jumpToLatest);
  const stickyHeaderRows = measureChromeSlotRows(stickyHeaderText, width);
  const stickyHeaderNode = renderChromeSlot(stickyHeader, stickyHeaderText);
  const jumpToLatestNode = overlay ? null : renderChromeSlot(jumpToLatest, jumpToLatestText);
  const effectiveViewportHeight = Math.max(0, viewportHeight - stickyHeaderRows);

  return (
    <Box flexDirection="column" width={width} flexGrow={1} flexShrink={0}>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        <ScrollBox
          width={width}
          paddingTop={stickyHeaderRows}
          scrollTop={scrollTop}
          scrollHeight={scrollHeight}
          viewportHeight={effectiveViewportHeight}
          stickyScroll={stickyScroll}
          scrollRef={scrollRef}
          onScrollTopChange={onScrollTopChange}
          onStickyChange={onStickyChange}
          onWindowChange={onWindowChange}
          renderWindow={renderScrollableWindow}
        >
          {scrollable}
        </ScrollBox>
        {stickyHeaderNode ? (
          <Box position="absolute" top={0} left={0} right={0} flexDirection="column">
            {stickyHeaderNode}
          </Box>
        ) : null}
        {jumpToLatestNode ? (
          <Box position="absolute" bottom={0} left={0} right={0} flexDirection="column">
            {jumpToLatestNode}
          </Box>
        ) : null}
        {overlay ? (
          <Box position="absolute" bottom={0} left={0} right={0} flexDirection="column">
            {overlay}
          </Box>
        ) : null}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {bottom}
      </Box>
    </Box>
  );
};
