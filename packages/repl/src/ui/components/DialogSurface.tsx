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
  /** Index of the currently focused option (arrow-key navigation). */
  focusedIndex?: number;
  /** Indices of selected options (multiSelect mode). */
  selectedIndices?: number[];
  /** Whether this is a multi-select dialog. */
  multiSelect?: boolean;
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
            {(() => {
              const allOptions = request.options ?? [];
              const maxVisible = request.visibleSelectOptions ?? 5;
              const focused = request.focusedIndex ?? 0;
              const total = allOptions.length;

              // Compute scroll offset: keep focused item centred in the visible window.
              let scrollOffset = 0;
              if (total > maxVisible) {
                const half = Math.floor(maxVisible / 2);
                scrollOffset = Math.max(0, Math.min(focused - half, total - maxVisible));
              }

              const hiddenAbove = scrollOffset;
              const hiddenBelow = Math.max(0, total - scrollOffset - maxVisible);

              return (
                <>
                  {hiddenAbove > 0 ? (
                    <Text dimColor>{t("select.more_above", { count: hiddenAbove })}</Text>
                  ) : null}
                  {allOptions.slice(scrollOffset, scrollOffset + maxVisible).map((option, localIndex) => {
                    const globalIndex = scrollOffset + localIndex;
                    const isFocused = globalIndex === focused;
                    const isSelected = request.selectedIndices?.includes(globalIndex) ?? false;
                    const pointer = isFocused ? "\u276F " : "  ";
                    const check = isSelected ? " \u2713" : "";
                    const descSuffix = option.description ? ` - ${option.description}` : "";
                    return (
                      <Text key={`${option.value}-${globalIndex}`} color={isFocused ? "cyan" : undefined} dimColor={!isFocused}>
                        {`${pointer}${option.label}${descSuffix}${check}`}
                      </Text>
                    );
                  })}
                  {hiddenBelow > 0 ? (
                    <Text dimColor>{t("select.more_below", { count: hiddenBelow })}</Text>
                  ) : null}
                </>
              );
            })()}
            <Text dimColor>
              {request.multiSelect
                ? t("select.multiselect_hint")
                : t("select.navigate_hint")}
            </Text>
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
