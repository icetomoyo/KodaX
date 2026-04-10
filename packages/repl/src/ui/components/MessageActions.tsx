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
  dismissAction?: "clear" | "close-search";
}

export function buildMessageActionsText({
  copyMessage = false,
  copyToolInput = false,
  copyOnSelect = false,
  toggleDetail = false,
  selectionNavigation = false,
  matchNavigation = false,
  dismissAction,
}: MessageActionsProps): string | undefined {
  const actions: string[] = [];
  if (selectionNavigation) {
    actions.push("\u2190/\u2192 browse");
  }
  if (copyMessage) {
    actions.push("C copy");
  }
  if (copyToolInput) {
    actions.push("I tool input");
  }
  if (copyOnSelect) {
    actions.push("Mouse select copies");
  }
  if (toggleDetail) {
    actions.push("V details");
  }
  if (matchNavigation) {
    actions.push("N/Shift+N matches");
  }
  if (dismissAction === "clear") {
    actions.push("Esc clear");
  }
  if (dismissAction === "close-search") {
    actions.push("Esc close search");
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
  dismissAction,
}) => {
  const theme = getTheme("dark");
  const actionsText = buildMessageActionsText({
    copyMessage,
    copyToolInput,
      copyOnSelect,
      toggleDetail,
      selectionNavigation,
      matchNavigation,
      dismissAction,
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

