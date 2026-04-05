import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";

export interface MessageActionsProps {
  copyMessage?: boolean;
  copyToolInput?: boolean;
  copyOnSelect?: boolean;
  toggleDetail?: boolean;
  selectionNavigation?: boolean;
  matchNavigation?: boolean;
}

export const MessageActions: React.FC<MessageActionsProps> = ({
  copyMessage = false,
  copyToolInput = false,
  copyOnSelect = false,
  toggleDetail = false,
  selectionNavigation = false,
  matchNavigation = false,
}) => {
  const theme = getTheme("dark");
  const actions: string[] = [];
  if (selectionNavigation) {
    actions.push("\u2190/\u2192 select");
  }
  if (copyMessage) {
    actions.push("C copy result");
  }
  if (copyToolInput) {
    actions.push("I copy tool input");
  }
  if (copyOnSelect) {
    actions.push("Select copies");
  }
  if (toggleDetail) {
    actions.push("V details");
  }
  if (matchNavigation) {
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
