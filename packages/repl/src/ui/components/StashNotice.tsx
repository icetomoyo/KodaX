import React from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";

export interface StashNoticeProps {
  text?: string;
}

export const StashNotice: React.FC<StashNoticeProps> = ({ text }) => {
  const normalized = text?.trim();
  if (!normalized) {
    return null;
  }

  const theme = getTheme("dark");
  return (
    <Box paddingX={1}>
      <Text color={theme.colors.hint}>{"\u22ef"} </Text>
      <Text color={theme.colors.dim}>{normalized}</Text>
    </Box>
  );
};

