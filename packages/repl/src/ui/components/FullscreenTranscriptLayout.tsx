import React from "react";
import { Box, Text } from "ink";

export interface FullscreenTranscriptChromeSlot {
  visible?: boolean;
  label?: string;
  hint?: string;
  onTrigger?: () => void;
  tone?: "dim" | "accent";
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
  const renderChromeSlot = (slot: FullscreenTranscriptChromeSlot | undefined) => {
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
        {renderChromeSlot(stickyHeader)}
        {transcript}
        {renderChromeSlot(jumpToLatest)}
      </Box>
      {overlay}
      <Box flexDirection="column" flexShrink={0}>
        {footer}
      </Box>
    </Box>
  );
};
