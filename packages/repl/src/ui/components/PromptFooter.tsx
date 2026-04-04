import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";

const ITEM_SEPARATOR = " \u00B7 ";

export interface PromptFooterSurfaceItem {
  id: string;
  label: string;
  accent?: boolean;
}

export interface PromptFooterLeftSideProps {
  items?: readonly PromptFooterSurfaceItem[];
}

export const PromptFooterLeftSide: React.FC<PromptFooterLeftSideProps> = ({
  items = [],
}) => {
  const visibleItems = items.filter((item) => item.label.trim().length > 0);
  const theme = getTheme("dark");
  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <Box flexGrow={1}>
      {visibleItems.map((item, index) => (
        <React.Fragment key={item.id}>
          <Text color={item.accent ? theme.colors.accent : theme.colors.dim} bold={item.accent}>
            {item.label}
          </Text>
          {index < visibleItems.length - 1 ? <Text dimColor>{ITEM_SEPARATOR}</Text> : null}
        </React.Fragment>
      ))}
    </Box>
  );
};

export interface PromptFooterRightSideProps {
  items?: readonly PromptFooterSurfaceItem[];
}

export const PromptFooterRightSide: React.FC<PromptFooterRightSideProps> = ({
  items = [],
}) => {
  const visibleItems = items.filter((item) => item.label.trim().length > 0);
  const theme = getTheme("dark");
  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <Box justifyContent="flex-end">
      {visibleItems.map((item, index) => (
        <React.Fragment key={item.id}>
          <Text color={item.accent ? theme.colors.primary : theme.colors.dim} bold={item.accent}>
            {item.label}
          </Text>
          {index < visibleItems.length - 1 ? <Text dimColor>{ITEM_SEPARATOR}</Text> : null}
        </React.Fragment>
      ))}
    </Box>
  );
};

export interface PromptFooterProps {
  left?: React.ReactNode;
  right?: React.ReactNode;
  queued?: React.ReactNode;
  stashNotice?: React.ReactNode;
  notifications?: React.ReactNode;
  inlineNotices?: React.ReactNode;
  composer: React.ReactNode;
  inlineSuggestions?: React.ReactNode;
  helpSurface?: React.ReactNode;
  taskBar?: React.ReactNode;
  statusLine?: React.ReactNode;
  inlineDialogs?: React.ReactNode;
}

export const PromptFooter: React.FC<PromptFooterProps> = ({
  left,
  right,
  queued,
  stashNotice,
  notifications,
  inlineNotices,
  composer,
  inlineSuggestions,
  helpSurface,
  taskBar,
  statusLine,
  inlineDialogs,
}) => {
  return (
    <Box flexDirection="column">
      {(left || right) ? (
        <Box paddingX={1}>
          <Box flexGrow={1}>{left}</Box>
          {right}
        </Box>
      ) : null}
      {queued}
      {stashNotice}
      {notifications}
      {inlineNotices}
      {composer}
      {inlineSuggestions}
      {inlineDialogs}
      {helpSurface}
      {taskBar}
      {statusLine}
    </Box>
  );
};
