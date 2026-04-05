import React from "react";
import { Box } from "../tui.js";
import type { MessageListProps } from "./MessageList.js";
import { MessageList } from "./MessageList.js";

export interface PromptTranscriptSurfaceProps extends MessageListProps {
  banner?: React.ReactNode;
}

export const PromptTranscriptSurface: React.FC<PromptTranscriptSurfaceProps> = ({
  banner,
  ...messageListProps
}) => {
  return (
    <Box flexDirection="column">
      {banner}
      <MessageList {...messageListProps} />
    </Box>
  );
};
