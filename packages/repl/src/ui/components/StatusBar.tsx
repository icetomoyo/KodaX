/**
 * StatusBar - Bottom status bar component.
 */

import React, { useMemo } from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";
import type { StatusBarProps } from "../types.js";
import {
  buildStatusBarViewModel,
  getStatusBarText,
  type StatusBarViewModel,
} from "../view-models/status-bar.js";

interface StatusBarRendererProps extends StatusBarProps {
  viewModel?: StatusBarViewModel;
}

function resolveViewModelSegmentColor(
  segment: StatusBarViewModel["segments"][number],
  theme: ReturnType<typeof getTheme>,
): string {
  if (segment.color) {
    const themeColor = theme.colors[segment.color as keyof typeof theme.colors];
    return themeColor ?? segment.color;
  }
  const tone = segment.tone;
  switch (tone) {
    case "primary":
      return theme.colors.primary;
    case "accent":
      return theme.colors.accent;
    case "success":
      return theme.colors.success;
    case "warning":
      return theme.colors.warning;
    case "error":
      return theme.colors.error;
    case "dim":
    default:
      return theme.colors.dim;
  }
}

export { getStatusBarText };

export const StatusBar: React.FC<StatusBarRendererProps> = ({
  viewModel,
  ...props
}) => {
  const theme = useMemo(() => getTheme("dark"), []);
  const resolvedViewModel = useMemo(
    () => viewModel ?? buildStatusBarViewModel(props),
    [props, viewModel],
  );

  return (
    <Box paddingX={1}>
      {resolvedViewModel.segments.map((segment, index) => (
        <React.Fragment key={segment.id}>
          <Text
            color={resolveViewModelSegmentColor(segment, theme)}
            bold={segment.bold}
          >
            {segment.text}
          </Text>
          {index < resolvedViewModel.segments.length - 1 ? <Text dimColor> | </Text> : null}
        </React.Fragment>
      ))}
    </Box>
  );
};

export const SimpleStatusBar: React.FC<{
  permissionMode: string;
  provider: string;
  model: string;
}> = ({ permissionMode, provider, model }) => {
  const theme = useMemo(() => getTheme("dark"), []);

  return (
    <Box>
      <Text color={theme.colors.primary} bold>
        [{permissionMode}]
      </Text>
      <Text dimColor>
        {" "}
        {provider}/{model}
      </Text>
    </Box>
  );
};

