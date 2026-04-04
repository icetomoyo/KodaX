import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";

export interface MessageSelectorProps {
  summary?: string;
  selectedIndex: number;
  total: number;
  kindLabel?: string;
  detailExpanded?: boolean;
}

export const MessageSelector: React.FC<MessageSelectorProps> = ({
  summary,
  selectedIndex,
  total,
  kindLabel,
  detailExpanded = false,
}) => {
  const theme = getTheme("dark");
  if (!summary || total <= 0) {
    return null;
  }

  const detailLabel = detailExpanded ? "expanded" : "compact";
  const kindPrefix = kindLabel ? `${kindLabel}: ` : "";

  return (
    <Box paddingX={1}>
      <Text color={theme.colors.dim}>
        {`Selected ${selectedIndex + 1}/${total}: ${kindPrefix}${summary} [${detailLabel}]`}
      </Text>
    </Box>
  );
};
