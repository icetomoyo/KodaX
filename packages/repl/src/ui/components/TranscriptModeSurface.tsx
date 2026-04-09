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
  showAllContent?: boolean;
}

export const TranscriptModeSurface: React.FC<TranscriptModeSurfaceProps> = ({
  banner,
  windowed = false,
  showDetailedTools = false,
  showAllContent = false,
  ...messageListProps
}) => {
  return (
    <Box flexDirection="column">
      {banner}
      <TranscriptViewport
        {...messageListProps}
        chromeMode="hidden"
        windowed={windowed}
        showFullThinking
        showDetailedTools={showDetailedTools}
        showAllContent={showAllContent}
        showLiveProgressRows
      />
    </Box>
  );
};
