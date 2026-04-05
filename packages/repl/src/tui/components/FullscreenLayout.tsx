import React from "react";
import { Box, Text } from "../index.js";
import { ScrollBox, type ScrollBoxHandle, type ScrollBoxWindow } from "./ScrollBox.js";

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
}) => {
  const renderChromeSlot = (slot: FullscreenChromeSlot | undefined) => {
    if (!slot?.visible || !slot.label) {
      return null;
    }

    const text = slot.hint ? `${slot.label}: ${slot.hint}` : slot.label;
    return (
      <Box paddingX={1}>
        <Text dimColor={slot.tone !== "accent"}>{text}</Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" width={width} flexGrow={1} flexShrink={0}>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        <ScrollBox
          width={width}
          scrollTop={scrollTop}
          scrollHeight={scrollHeight}
          viewportHeight={viewportHeight}
          stickyScroll={stickyScroll}
          scrollRef={scrollRef}
          onScrollTopChange={onScrollTopChange}
          onStickyChange={onStickyChange}
          renderWindow={renderScrollableWindow
            ? (window) => (
              <>
                {renderChromeSlot(stickyHeader)}
                {renderScrollableWindow(window)}
                {renderChromeSlot(jumpToLatest)}
              </>
            )
            : undefined}
        >
          {renderChromeSlot(stickyHeader)}
          {scrollable}
          {renderChromeSlot(jumpToLatest)}
        </ScrollBox>
        {overlay}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {bottom}
      </Box>
    </Box>
  );
};
