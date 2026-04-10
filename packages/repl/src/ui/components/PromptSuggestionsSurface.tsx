import React from "react";
import { Box, Text } from "../tui.js";
import { useAutocompleteContext } from "../hooks/useAutocomplete.js";
import { SuggestionsDisplay } from "./SuggestionsDisplay.js";
import { getTheme } from "../themes/index.js";

export interface PromptSuggestionsSurfaceProps {
  reserveSpace: boolean;
  width: number;
  hidden?: boolean;
  mode?: "inline" | "overlay";
}

export const PromptSuggestionsSurface: React.FC<PromptSuggestionsSurfaceProps> = ({
  reserveSpace,
  width,
  hidden = false,
  mode = "inline",
}) => {
  const autocomplete = useAutocompleteContext();
  const theme = getTheme("dark");

  if (hidden) {
    return null;
  }

  if (!autocomplete) {
    return reserveSpace ? <Box height={8} /> : null;
  }

  const { state, suggestions } = autocomplete;
  const hasSuggestions = state.visible && suggestions.length > 0;
  if (!hasSuggestions) {
    return reserveSpace ? <Box height={8} /> : null;
  }

  if (mode === "overlay") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.colors.accent}
        paddingX={1}
        marginTop={1}
      >
        <Text color={theme.colors.accent} bold>
          Suggestions
        </Text>
        <SuggestionsDisplay
          suggestions={suggestions}
          selectedIndex={state.selectedIndex}
          visible={state.visible}
          maxVisible={7}
          width={Math.max(20, width - 6)}
        />
      </Box>
    );
  }

  return (
    <Box height={8}>
      <SuggestionsDisplay
        suggestions={suggestions}
        selectedIndex={state.selectedIndex}
        visible={state.visible}
        maxVisible={7}
        width={Math.max(20, width - 2)}
      />
    </Box>
  );
};

