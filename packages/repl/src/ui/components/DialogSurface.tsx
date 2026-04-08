import React from "react";
import { Box, Text } from "../tui.js";

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

export interface DialogSurfaceProps {
  confirm?: DialogSurfaceConfirmState | null;
  request?: DialogSurfaceUIRequestState | null;
}

export const DialogSurface: React.FC<DialogSurfaceProps> = ({
  confirm,
  request,
}) => {
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

  return null;
};

