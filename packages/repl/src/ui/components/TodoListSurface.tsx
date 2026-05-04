/**
 * TodoListSurface — FEATURE_097 (v0.7.34).
 *
 * Renders the Scout-seeded todo list under the spinner / above the
 * BackgroundTaskBar. Pure presentational layer — every layout decision
 * (anchor, window, summary folds, failed-item priority, post-completion
 * linger) lives in `view-models/todo-plan.ts`. This component just walks
 * the rows and emits one `<Text>` per row.
 *
 * Layout (per design):
 *   - One header line with the "X / N completed" indicator on the right.
 *   - One `<Text>` per row, prefixed by a dimmed `▏` gutter (U+258F) so
 *     the surface visually nests under the spinner like Claude Code does.
 *   - Symbol colors come from the view-model's `symbolColor` field; the
 *     row text is rendered in default text color (failed item content
 *     gets a dim suffix `(note)` from the view-model).
 *
 * Surface visibility:
 *   - `vm.shouldRender === false` → return `null` (component unmounts).
 *   - `vm.rows.length === 0` → return `null` (empty list, surface hidden).
 *
 * The 5 s linger after completion is enforced by the host's
 * `lastAllCompletedAt` timestamp; this component only cares about the
 * rows it is told to render.
 */

import React from "react";

import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";
import type {
  TodoPlanViewModel,
  TodoRow,
  TodoSymbolColor,
} from "../view-models/todo-plan.js";

const GUTTER = "▏"; // ▏

function resolveSymbolColor(
  color: TodoSymbolColor,
): string | undefined {
  // Map view-model abstract color tokens to theme colors. Returning
  // `undefined` falls through to the default text color. We intentionally
  // do NOT pass `dimColor` here — the symbol color sits beside dim text
  // and the dim symbol color (#666666) does the visual job already.
  const theme = getTheme("dark");
  switch (color) {
    case "cyan":
      return theme.colors.primary; // #01A4FF (Warp cyan)
    case "green":
      return theme.colors.success; // #19C37D
    case "red":
      return theme.colors.error; // #FF5F56
    case "gray":
    case "dim":
    default:
      return theme.colors.dim; // #666666
  }
}

interface TodoListRowProps {
  readonly row: TodoRow;
}

const TodoListRow: React.FC<TodoListRowProps> = ({ row }) => {
  const symbolColor = resolveSymbolColor(row.symbolColor);
  const isSummary = row.kind !== "item";
  return (
    <Box flexDirection="row">
      <Text color={getTheme("dark").colors.dim}>{`${GUTTER} `}</Text>
      <Text color={symbolColor} bold={row.isActive}>
        {row.symbol}
      </Text>
      <Text> </Text>
      <Text dimColor={isSummary} bold={row.isActive}>
        {row.text}
      </Text>
    </Box>
  );
};

export interface TodoListSurfaceProps {
  readonly viewModel: TodoPlanViewModel;
}

export const TodoListSurface: React.FC<TodoListSurfaceProps> = ({
  viewModel,
}) => {
  if (!viewModel.shouldRender) return null;
  if (viewModel.rows.length === 0) return null;
  const counter = `${viewModel.completedCount}/${viewModel.totalCount} completed`;
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="flex-end">
        <Text dimColor>{counter}</Text>
      </Box>
      {viewModel.rows.map((row, idx) => (
        <TodoListRow key={`${row.kind}-${row.id ?? idx}`} row={row} />
      ))}
    </Box>
  );
};
