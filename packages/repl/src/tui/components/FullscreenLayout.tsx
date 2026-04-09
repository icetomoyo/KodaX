import React from "react";
import { Box, Text } from "../index.js";
import { ScrollBox, type ScrollBoxHandle, type ScrollBoxWindow } from "./ScrollBox.js";
import {
  measureFullscreenChromeSlotRows,
  resolveFullscreenChromeSlotText,
} from "./fullscreen-layout-utils.js";

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
  const stickyHeaderText = resolveFullscreenChromeSlotText(stickyHeader);
  const jumpToLatestText = resolveFullscreenChromeSlotText(jumpToLatest);
  const stickyHeaderRows = measureFullscreenChromeSlotRows(stickyHeaderText, width);
  const stickyHeaderNode = renderChromeSlot(stickyHeader, stickyHeaderText);
  const jumpToLatestNode = overlay ? null : renderChromeSlot(jumpToLatest, jumpToLatestText);
  const effectiveViewportHeight = Math.max(0, viewportHeight - stickyHeaderRows);

  return (
    <Box flexDirection="column" width={width} flexGrow={1} flexShrink={0}>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        <ScrollBox
          width={width}
          flexGrow={1}
          flexShrink={1}
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
