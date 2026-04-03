import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../themes/index.js";

export interface DialogSelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface DialogSurfaceConfirmState {
  prompt: string;
  instruction?: string;
}

export interface DialogSurfaceUIRequestState {
  kind: "select" | "input";
  title?: string;
  prompt?: string;
  options?: DialogSelectOption[];
  defaultValue?: string;
  buffer: string;
  error?: string;
  visibleSelectOptions?: number;
}

export interface DialogSurfaceHistorySearchState {
  query: string;
  matches: Array<{ itemId: string; excerpt: string }>;
  selectedIndex: number;
}

export interface DialogSurfaceProps {
  confirm?: DialogSurfaceConfirmState | null;
  request?: DialogSurfaceUIRequestState | null;
  historySearch?: DialogSurfaceHistorySearchState | null;
}

export const DialogSurface: React.FC<DialogSurfaceProps> = ({
  confirm,
  request,
  historySearch,
}) => {
  const theme = getTheme("dark");

  if (confirm) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="yellow"
        paddingX={1}
        marginTop={1}
      >
        <Text color="yellow" bold>
          [Confirm] {confirm.prompt}
        </Text>
        {confirm.instruction ? <Text dimColor>{confirm.instruction}</Text> : null}
      </Box>
    );
  }

  if (request) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        marginTop={1}
      >
        {request.kind === "select" ? (
          <>
            <Text color="cyan" bold>
              [Select] {request.title}
            </Text>
            {(request.options ?? []).slice(0, request.visibleSelectOptions ?? 5).map((option, index) => (
              <Text key={`${option.value}-${index}`} dimColor>
                {`${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`}
              </Text>
            ))}
            {(request.options?.length ?? 0) > (request.visibleSelectOptions ?? 5) ? (
              <Text dimColor>{`${(request.options?.length ?? 0) - (request.visibleSelectOptions ?? 5)} more choices...`}</Text>
            ) : null}
            <Text dimColor>{`Choice: ${request.buffer || "(type a number)"}`}</Text>
            <Text dimColor>Press Enter to confirm, Esc to cancel</Text>
          </>
        ) : (
          <>
            <Text color="cyan" bold>
              [Input] {request.prompt}
            </Text>
            {request.defaultValue !== undefined ? (
              <Text dimColor>{`Default: ${request.defaultValue}`}</Text>
            ) : null}
            <Text dimColor>{`Value: ${request.buffer || "(type your response)"}`}</Text>
            <Text dimColor>Press Enter to confirm, Esc to cancel</Text>
          </>
        )}
        {request.error ? <Text color="red">{request.error}</Text> : null}
      </Box>
    );
  }

  if (historySearch) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.colors.accent}
        paddingX={1}
        marginTop={1}
      >
        <Text color={theme.colors.accent} bold>
          [Search] Transcript history
        </Text>
        <Text dimColor>{`Query: ${historySearch.query || "(type to search)"}`}</Text>
        {historySearch.matches.length === 0 ? (
          <Text dimColor>No matches yet</Text>
        ) : (
          <>
            <Text dimColor>{`${historySearch.selectedIndex + 1}/${historySearch.matches.length} matches`}</Text>
            <Text dimColor>{historySearch.matches[historySearch.selectedIndex]?.excerpt ?? ""}</Text>
          </>
        )}
        <Text dimColor>Enter jump | Up/Down cycle | Esc cancel</Text>
      </Box>
    );
  }

  return null;
};
