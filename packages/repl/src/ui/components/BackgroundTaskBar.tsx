import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";

export interface BackgroundTaskBarProps {
  primaryText?: string;
  parallelText?: string;
}

function Pill({ text, accent = false }: { text: string; accent?: boolean }) {
  const theme = getTheme("dark");
  return (
    <Box marginRight={1}>
      <Text color={accent ? theme.colors.accent : theme.colors.primary}>
        {`[ ${text} ]`}
      </Text>
    </Box>
  );
}

export const BackgroundTaskBar: React.FC<BackgroundTaskBarProps> = ({
  primaryText,
  parallelText,
}) => {
  if (!primaryText && !parallelText) {
    return null;
  }

  return (
    <Box flexDirection="row" paddingX={1}>
      {primaryText ? <Pill text={primaryText} accent /> : null}
      {parallelText ? <Pill text={parallelText} /> : null}
    </Box>
  );
};
