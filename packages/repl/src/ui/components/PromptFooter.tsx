import React from "react";
import { Box } from "ink";

export interface PromptFooterLeftProps {
  children?: React.ReactNode;
}

export const PromptFooterLeft: React.FC<PromptFooterLeftProps> = ({ children }) => {
  if (!children) {
    return null;
  }
  return (
    <Box flexGrow={1}>
      {children}
    </Box>
  );
};

export interface PromptFooterRightProps {
  children?: React.ReactNode;
}

export const PromptFooterRight: React.FC<PromptFooterRightProps> = ({ children }) => {
  if (!children) {
    return null;
  }
  return (
    <Box justifyContent="flex-end">
      {children}
    </Box>
  );
};

export interface PromptFooterProps {
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
  pendingInputs?: React.ReactNode;
  composer: React.ReactNode;
  suggestions?: React.ReactNode;
  helpBar?: React.ReactNode;
  browseHint?: React.ReactNode;
  taskBar?: React.ReactNode;
  statusLine?: React.ReactNode;
  dialogSurface?: React.ReactNode;
}

export const PromptFooter: React.FC<PromptFooterProps> = ({
  headerLeft,
  headerRight,
  pendingInputs,
  composer,
  suggestions,
  helpBar,
  browseHint,
  taskBar,
  statusLine,
  dialogSurface,
}) => {
  return (
    <Box flexDirection="column">
      {(headerLeft || headerRight) ? (
        <Box paddingX={1}>
          <PromptFooterLeft>{headerLeft}</PromptFooterLeft>
          <PromptFooterRight>{headerRight}</PromptFooterRight>
        </Box>
      ) : null}
      {pendingInputs}
      {composer}
      {suggestions}
      {helpBar}
      {browseHint}
      {taskBar}
      {statusLine}
      {dialogSurface}
    </Box>
  );
};
