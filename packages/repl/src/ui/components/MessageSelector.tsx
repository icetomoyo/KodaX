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

export const MessageSelector: React.FC<MessageSelectorProps> = ({
  itemSummary,
  itemKind,
  position,
  detailState = "compact",
}) => {
  const theme = getTheme("dark");
  if (!itemSummary || !position || position.total <= 0) {
    return null;
  }

  return (
    <Box paddingX={1}>
      <Text color={theme.colors.dim}>
        {`Selected ${position.current}/${position.total}: ${itemKind ? `${itemKind}: ` : ""}${itemSummary} [${detailState}]`}
      </Text>
    </Box>
  );
};

