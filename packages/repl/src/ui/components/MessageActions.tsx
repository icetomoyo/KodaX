import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";

export interface MessageActionsProps {
  canCopy?: boolean;
  canCopyToolInput?: boolean;
  canToggleDetail?: boolean;
  searchActive?: boolean;
  searchMatchCount?: number;
}

export const MessageActions: React.FC<MessageActionsProps> = ({
  canCopy = false,
  canCopyToolInput = false,
  canToggleDetail = false,
  searchActive = false,
  searchMatchCount = 0,
}) => {
  const theme = getTheme("dark");
  const actions: string[] = [];
  if (canCopy) {
    actions.push("C copy");
  }
  if (canCopyToolInput) {
    actions.push("I copy input");
  }
  if (canToggleDetail) {
    actions.push("V toggle detail");
  }
  if (searchActive && searchMatchCount > 0) {
    actions.push("Up/Down matches");
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
