import React from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";
import { Spinner } from "./LoadingIndicator.js";

export interface BackgroundTaskBarItem {
  id: string;
  label: string;
  accent?: boolean;
  selected?: boolean;
  hint?: string;
}

export interface BackgroundTaskBarProps {
  items: readonly BackgroundTaskBarItem[];
  overflowLabel?: string;
  ctaHint?: string;
  showSpinner?: boolean;
}

function Pill({
  text,
  accent = false,
  selected = false,
}: {
  text: string;
  accent?: boolean;
  selected?: boolean;
}) {
  const theme = getTheme("dark");
  return (
    <Box marginRight={1}>
      <Text
        color={accent ? theme.colors.accent : theme.colors.primary}
        bold={selected || accent}
      >
        {`[ ${text} ]`}
      </Text>
    </Box>
  );
}

export const BackgroundTaskBar: React.FC<BackgroundTaskBarProps> = ({
  items,
  overflowLabel,
  ctaHint,
  showSpinner = false,
}) => {
  const visibleItems = items.filter((item) => item.label.trim().length > 0);
  if (visibleItems.length === 0 && !overflowLabel && !ctaHint && !showSpinner) {
    return null;
  }

  return (
    <Box flexDirection="row" paddingX={1}>
      {showSpinner ? (
        <Box marginRight={1}>
          <Spinner />
        </Box>
      ) : null}
      {visibleItems.map((item) => (
        <Pill
          key={item.id}
          text={item.hint ? `${item.label} (${item.hint})` : item.label}
          accent={item.accent}
          selected={item.selected}
        />
      ))}
      {overflowLabel ? <Pill text={overflowLabel} /> : null}
      {ctaHint ? <Text dimColor>{ctaHint}</Text> : null}
    </Box>
  );
};

