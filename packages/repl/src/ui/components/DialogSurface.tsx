import React from "react";
import { Box, Text } from "../tui.js";
import { t } from "../../common/i18n.js";

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
        width="100%"
      >
        <Text color="yellow" bold>
          {t("dialog.confirm")} {confirm.prompt}
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
        width="100%"
      >
        {request.kind === "select" ? (
          <>
            <Text color="cyan" bold>
              {t("dialog.select")} {request.title}
            </Text>
            {(request.options ?? []).slice(0, request.visibleSelectOptions ?? 5).map((option, index) => (
              <Text key={`${option.value}-${index}`} dimColor>
                {`${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`}
              </Text>
            ))}
            {(request.options?.length ?? 0) > (request.visibleSelectOptions ?? 5) ? (
              <Text dimColor>{t("select.more", { count: (request.options?.length ?? 0) - (request.visibleSelectOptions ?? 5) })}</Text>
            ) : null}
            <Text dimColor>{`${t("select.choice")} ${request.buffer || t("select.type_number")}`}</Text>
            <Text dimColor>{t("select.confirm_hint")}</Text>
          </>
        ) : (
          <>
            <Text color="cyan" bold>
              {t("dialog.input")} {request.prompt}
            </Text>
            {request.defaultValue !== undefined ? (
              <Text dimColor>{`${t("input.default")} ${request.defaultValue}`}</Text>
            ) : null}
            <Text dimColor>{`${t("input.value")} ${request.buffer || t("input.type_response")}`}</Text>
            <Text dimColor>{t("select.confirm_hint")}</Text>
          </>
        )}
        {request.error ? <Text color="red">{request.error}</Text> : null}
      </Box>
    );
  }

  return null;
};

