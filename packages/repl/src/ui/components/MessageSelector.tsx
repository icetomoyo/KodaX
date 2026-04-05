import React from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";

export interface MessageSelectorProps {
  itemSummary?: string;
  itemKind?: string;
  position?: {
    current: number;
    total: number;
  };
  detailState?: "compact" | "expanded";
}

export function buildMessageSelectorText({
  itemSummary,
  itemKind,
  position,
  detailState = "compact",
}: MessageSelectorProps): string | undefined {
  if (!itemSummary || !position || position.total <= 0) {
    return undefined;
  }

  return `Selected ${position.current}/${position.total}: ${itemKind ? `${itemKind}: ` : ""}${itemSummary} [${detailState}]`;
}

export const MessageSelector: React.FC<MessageSelectorProps> = ({
  itemSummary,
  itemKind,
  position,
  detailState = "compact",
}) => {
  const theme = getTheme("dark");
  const text = buildMessageSelectorText({
    itemSummary,
    itemKind,
    position,
    detailState,
  });

  if (!text) {
    return null;
  }

  return (
    <Box paddingX={1}>
      <Text color={theme.colors.dim}>
        {text}
      </Text>
    </Box>
  );
};

