import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";
import type { HelpBarSegment } from "../constants/layout.js";

export interface PromptHelpMenuProps {
  segments: HelpBarSegment[];
  title?: string;
}

export const PromptHelpMenu: React.FC<PromptHelpMenuProps> = ({
  segments,
  title = "Help",
}) => {
  const theme = getTheme("dark");

  if (segments.length === 0) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text color={theme.colors.accent} bold>
        {title}
      </Text>
      <Text dimColor>
        {segments.map((segment, index) => (
          <Text key={`${segment.text}-${index}`} color={segment.color} bold={segment.bold}>
            {segment.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
};
