import React from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";
import { formatPendingInputsSummary } from "../utils/pending-inputs.js";

export interface PendingInputsIndicatorProps {
  pendingInputs: readonly string[];
}

export const PendingInputsIndicator: React.FC<PendingInputsIndicatorProps> = ({
  pendingInputs,
}) => {
  const summary = formatPendingInputsSummary(pendingInputs);
  if (!summary) {
    return null;
  }

  const theme = getTheme("dark");

  return (
    <Box>
      <Text color={theme.colors.hint}>{"\u23F3"} </Text>
      <Text color={theme.colors.dim}>{summary}</Text>
    </Box>
  );
};

