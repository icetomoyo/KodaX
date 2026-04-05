import React from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";

export interface MessageActionsProps {
  copyMessage?: boolean;
  copyToolInput?: boolean;
  copyOnSelect?: boolean;
  toggleDetail?: boolean;
  selectionNavigation?: boolean;
  matchNavigation?: boolean;
}

export function buildMessageActionsText({
  copyMessage = false,
  copyToolInput = false,
  copyOnSelect = false,
  toggleDetail = false,
  selectionNavigation = false,
  matchNavigation = false,
}: MessageActionsProps): string | undefined {
  const actions: string[] = [];
  if (selectionNavigation) {
    actions.push("\u2190/\u2192 select");
  }
  if (copyMessage) {
    actions.push("C copy");
  }
  if (copyToolInput) {
    actions.push("I copy input");
  }
  if (copyOnSelect) {
    actions.push("Select copies");
  }
  if (toggleDetail) {
    actions.push("V toggle detail");
  }
  if (matchNavigation) {
    actions.push("Up/Down matches");
  }

  return actions.length > 0 ? actions.join(" | ") : undefined;
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
  const actionsText = buildMessageActionsText({
    copyMessage,
    copyToolInput,
    copyOnSelect,
    toggleDetail,
    selectionNavigation,
    matchNavigation,
  });

  if (!actionsText) {
    return null;
  }

  return (
    <Box paddingX={1}>
      <Text color={theme.colors.dim}>{actionsText}</Text>
    </Box>
  );
};

