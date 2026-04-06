import React from "react";
import { Box } from "../tui.js";
import type { TranscriptViewportProps } from "./TranscriptViewport.js";
import { TranscriptViewport } from "./TranscriptViewport.js";

export interface TranscriptModeSurfaceProps extends Omit<
  TranscriptViewportProps,
  | "showFullThinking"
  | "showDetailedTools"
  | "showLiveProgressRows"
  | "windowed"
> {
  banner?: React.ReactNode;
}

export const TranscriptModeSurface: React.FC<TranscriptModeSurfaceProps> = ({
  banner,
  ...messageListProps
}) => {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {banner}
      <TranscriptViewport
        {...messageListProps}
        chromeMode="hidden"
        windowed
        showFullThinking
        showDetailedTools={false}
        showLiveProgressRows
      />
    </Box>
  );
};
