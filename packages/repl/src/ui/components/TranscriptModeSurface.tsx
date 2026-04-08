import React from "react";
import { Box } from "../tui.js";
import type { TranscriptViewportProps } from "./TranscriptViewport.js";
import { TranscriptViewport } from "./TranscriptViewport.js";

export interface TranscriptModeSurfaceProps extends Omit<
  TranscriptViewportProps,
  | "showFullThinking"
  | "showLiveProgressRows"
> {
  banner?: React.ReactNode;
  windowed?: boolean;
  showDetailedTools?: boolean;
}

export const TranscriptModeSurface: React.FC<TranscriptModeSurfaceProps> = ({
  banner,
  windowed = false,
  showDetailedTools = false,
  ...messageListProps
}) => {
  return (
    <Box flexDirection="column" flexGrow={windowed ? 1 : 0}>
      {banner}
      <TranscriptViewport
        {...messageListProps}
        chromeMode="hidden"
        windowed={windowed}
        showFullThinking
        showDetailedTools={showDetailedTools}
        showLiveProgressRows
      />
    </Box>
  );
};
