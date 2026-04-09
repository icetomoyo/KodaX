import React from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";

export interface ClipboardToastSurfaceProps {
  text?: string;
  tone?: "success" | "warning";
}

export const ClipboardToastSurface: React.FC<ClipboardToastSurfaceProps> = ({
  text,
  tone = "success",
}) => {
  const trimmedText = text?.trim();
  if (!trimmedText) {
    return null;
  }

  const theme = getTheme("dark");
  const foreground = tone === "warning" ? theme.colors.warning : theme.colors.accent;
  const icon = tone === "warning" ? "!" : "✓";

  return (
    <Box paddingX={1} backgroundColor={theme.colors.inputBackground}>
      <Text color={foreground}>
        {icon} {trimmedText}
      </Text>
    </Box>
  );
};
