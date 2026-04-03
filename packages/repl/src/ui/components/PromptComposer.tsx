import React from "react";
import { Box } from "ink";
import { InputPrompt, type InputPromptAutocompleteProps } from "./InputPrompt.js";

export interface PromptComposerProps extends InputPromptAutocompleteProps {}

export const PromptComposer: React.FC<PromptComposerProps> = (props) => {
  return (
    <Box flexDirection="column">
      <InputPrompt {...props} />
    </Box>
  );
};
