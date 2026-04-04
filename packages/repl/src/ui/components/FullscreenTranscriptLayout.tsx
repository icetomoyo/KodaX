import React from "react";
import { Box, Text } from "ink";

export interface FullscreenTranscriptChromeSlot {
  text?: string;
}

export interface FullscreenTranscriptLayoutProps {
  transcript: React.ReactNode;
  footer: React.ReactNode;
  overlay?: React.ReactNode;
  stickyHeader?: FullscreenTranscriptChromeSlot;
  jumpToLatest?: FullscreenTranscriptChromeSlot;
  width?: number;
}

export const FullscreenTranscriptLayout: React.FC<FullscreenTranscriptLayoutProps> = ({
  transcript,
  footer,
  overlay,
  stickyHeader,
  jumpToLatest,
  width,
}) => {
  return (
    <Box flexDirection="column" width={width} flexGrow={1} flexShrink={0}>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {stickyHeader?.text ? (
          <Box paddingX={1}>
            <Text dimColor>{stickyHeader.text}</Text>
          </Box>
        ) : null}
        {transcript}
        {jumpToLatest?.text ? (
          <Box paddingX={1}>
            <Text dimColor>{jumpToLatest.text}</Text>
          </Box>
        ) : null}
      </Box>
      {overlay}
      <Box flexDirection="column" flexShrink={0}>
        {footer}
      </Box>
    </Box>
  );
};
