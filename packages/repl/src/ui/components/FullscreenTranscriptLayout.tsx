import React from "react";
import { FullscreenLayout } from "../../tui/components/FullscreenLayout.js";
import type { ScrollBoxHandle, ScrollBoxWindow } from "../../tui/components/ScrollBox.js";

export interface FullscreenTranscriptChromeSlot {
  visible?: boolean;
  label?: string;
  hint?: string;
  onTrigger?: () => void;
  tone?: "dim" | "accent";
}

export interface FullscreenTranscriptLayoutProps {
  top?: React.ReactNode;
  topRows?: number;
  transcript?: React.ReactNode;
  renderTranscriptWindow?: (window: ScrollBoxWindow) => React.ReactNode;
  footer: React.ReactNode;
  overlay?: React.ReactNode;
  stickyHeader?: FullscreenTranscriptChromeSlot;
  jumpToLatest?: FullscreenTranscriptChromeSlot;
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

export const FullscreenTranscriptLayout: React.FC<FullscreenTranscriptLayoutProps> = ({
  top,
  topRows = 0,
  transcript,
  renderTranscriptWindow,
  footer,
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
  return (
    <FullscreenLayout
      width={width}
      top={top}
      topRows={topRows}
      stickyHeader={stickyHeader}
      jumpToLatest={jumpToLatest}
      scrollable={transcript}
      renderScrollableWindow={renderTranscriptWindow}
      overlay={overlay}
      bottom={footer}
      scrollTop={scrollTop}
      scrollHeight={scrollHeight}
      viewportHeight={viewportHeight}
      stickyScroll={stickyScroll}
      scrollRef={scrollRef}
      onScrollTopChange={onScrollTopChange}
      onStickyChange={onStickyChange}
      onWindowChange={onWindowChange}
    />
  );
};
