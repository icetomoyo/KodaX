import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";
import type { HelpMenuSection } from "../constants/layout.js";

export interface PromptHelpMenuProps {
  sections: HelpMenuSection[];
  title?: string;
}

export const PromptHelpMenu: React.FC<PromptHelpMenuProps> = ({
  sections,
  title = "Help",
}) => {
  const theme = getTheme("dark");

  const visibleSections = sections.filter((section) => section.items.length > 0);
  if (visibleSections.length === 0) {
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
      {visibleSections.map((section) => (
        <Box key={section.id} flexDirection="column">
          <Text color={theme.colors.primary} bold>
            {section.title}
          </Text>
          <Text dimColor>{section.items.map((item) => item.label).join(" | ")}</Text>
        </Box>
      ))}
    </Box>
  );
};
