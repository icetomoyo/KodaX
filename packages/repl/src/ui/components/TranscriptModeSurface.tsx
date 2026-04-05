import React from "react";
import { Box } from "../tui.js";
import type { MessageListProps } from "./MessageList.js";
import { MessageList } from "./MessageList.js";

export interface TranscriptModeSurfaceProps extends MessageListProps {
  banner?: React.ReactNode;
}

export const TranscriptModeSurface: React.FC<TranscriptModeSurfaceProps> = ({
  banner,
  ...messageListProps
}) => {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {banner}
      <MessageList {...messageListProps} />
    </Box>
  );
};
