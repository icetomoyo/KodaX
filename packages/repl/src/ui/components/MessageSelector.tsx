import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";

export interface MessageSelectorProps {
  summary?: string;
  selectedIndex: number;
  total: number;
}

export const MessageSelector: React.FC<MessageSelectorProps> = ({
  summary,
  selectedIndex,
  total,
}) => {
  const theme = getTheme("dark");
  if (!summary || total <= 0) {
    return null;
  }

  return (
    <Box paddingX={1}>
      <Text color={theme.colors.dim}>
        {`Selected ${selectedIndex + 1}/${total}: ${summary}`}
      </Text>
    </Box>
  );
};
