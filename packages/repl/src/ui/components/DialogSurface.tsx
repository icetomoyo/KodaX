import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "../tui.js";
import { t } from "../../common/i18n.js";

export interface DialogSelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface DialogSurfaceConfirmState {
  prompt: string;
  instruction?: string;
  /**
   * FEATURE_075: full plan content rendered in a scrollable panel for
   * `exit_plan_mode` approval. Arrow keys and PgUp/PgDn scroll the plan
   * inside the dialog while the approval buttons stay pinned.
   */
  planContent?: string;
}

const PLAN_VIEWPORT_LINES = 15;
const PLAN_PAGE_STEP = Math.max(1, PLAN_VIEWPORT_LINES - 2);

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
        {confirm.planContent ? (
          <PlanScrollPanel content={confirm.planContent} />
        ) : null}
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

/**
 * FEATURE_075: scrollable plan panel rendered inside the exit_plan_mode
 * approval dialog. Uses local scroll state + useInput so the approval
 * buttons stay pinned below the panel.
 */
const PlanScrollPanel: React.FC<{ content: string }> = ({ content }) => {
  const lines = React.useMemo(() => content.split("\n"), [content]);
  const total = lines.length;
  const overflows = total > PLAN_VIEWPORT_LINES;
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    // Clamp offset when the plan shrinks (e.g., receiving a fresh shorter plan).
    setScrollOffset((prev) => {
      const maxOffset = Math.max(0, total - PLAN_VIEWPORT_LINES);
      if (prev > maxOffset) return maxOffset;
      return prev;
    });
  }, [total]);

  useInput(
    (_input, key) => {
      if (!overflows) return;
      const maxOffset = Math.max(0, total - PLAN_VIEWPORT_LINES);
      if (key.upArrow) {
        setScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setScrollOffset((prev) => Math.min(maxOffset, prev + 1));
      } else if (key.pageUp) {
        setScrollOffset((prev) => Math.max(0, prev - PLAN_PAGE_STEP));
      } else if (key.pageDown) {
        setScrollOffset((prev) => Math.min(maxOffset, prev + PLAN_PAGE_STEP));
      }
    },
    // Always register listener so scroll is responsive whenever this panel mounts.
    { isActive: true },
  );

  const visible = lines.slice(scrollOffset, scrollOffset + PLAN_VIEWPORT_LINES);
  const hiddenAbove = scrollOffset;
  const hiddenBelow = Math.max(0, total - scrollOffset - PLAN_VIEWPORT_LINES);

  return (
    <Box flexDirection="column" marginTop={1}>
      {overflows && hiddenAbove > 0 ? (
        <Text dimColor>… {hiddenAbove} more line{hiddenAbove === 1 ? "" : "s"} above</Text>
      ) : null}
      {visible.map((line, idx) => (
        <Text key={`plan-line-${scrollOffset + idx}`}>{line}</Text>
      ))}
      {overflows && hiddenBelow > 0 ? (
        <Text dimColor>… {hiddenBelow} more line{hiddenBelow === 1 ? "" : "s"} below</Text>
      ) : null}
      {overflows ? (
        <Text dimColor>
          PgUp/PgDn/↑↓ to scroll
        </Text>
      ) : null}
    </Box>
  );
};
