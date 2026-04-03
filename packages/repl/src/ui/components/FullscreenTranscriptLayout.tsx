import React from "react";
import { Box, Text } from "ink";

export interface FullscreenTranscriptLayoutProps {
  transcript: React.ReactNode;
  footer: React.ReactNode;
  overlay?: React.ReactNode;
  stickyHeaderText?: string;
  jumpToLatestText?: string;
  width?: number;
}

export const FullscreenTranscriptLayout: React.FC<FullscreenTranscriptLayoutProps> = ({
  transcript,
  footer,
  overlay,
  stickyHeaderText,
  jumpToLatestText,
  width,
}) => {
  return (
    <Box flexDirection="column" width={width} flexGrow={1} flexShrink={0}>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {stickyHeaderText ? (
          <Box paddingX={1}>
            <Text dimColor>{stickyHeaderText}</Text>
          </Box>
        ) : null}
        {transcript}
        {jumpToLatestText ? (
          <Box paddingX={1}>
            <Text dimColor>{jumpToLatestText}</Text>
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
