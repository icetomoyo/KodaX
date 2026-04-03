import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";

export interface MessageActionsProps {
  canCopy?: boolean;
  canToggleDetail?: boolean;
}

export const MessageActions: React.FC<MessageActionsProps> = ({
  canCopy = false,
  canToggleDetail = false,
}) => {
  const theme = getTheme("dark");
  const actions: string[] = [];
  if (canCopy) {
    actions.push("C copy");
  }
  if (canToggleDetail) {
    actions.push("V toggle detail");
  }

  if (actions.length === 0) {
    return null;
  }

  return (
    <Box paddingX={1}>
      <Text color={theme.colors.dim}>{actions.join(" | ")}</Text>
    </Box>
  );
};
