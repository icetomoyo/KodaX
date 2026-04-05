import type { TranscriptRow } from "../../ui/utils/transcript-layout.js";
import type { TranscriptScreenPoint } from "./screen.js";
import { resolveTranscriptTextStartColumn } from "./screen.js";

export interface TranscriptRowSelectionRange {
  start: number;
  end: number;
}

export interface TranscriptTextSelection {
  anchor: TranscriptScreenPoint;
  focus: TranscriptScreenPoint;
  rowRanges: Map<string, TranscriptRowSelectionRange>;
  rowCount: number;
  charCount: number;
  text: string;
}

export interface BuildTranscriptSelectionOptions {
  animateSpinners?: boolean;
  selectFullRowOnCollapsed?: boolean;
}

function normalizeTranscriptRowText(row: TranscriptRow): string {
  return row.text === " " ? "" : row.text;
}

function comparePoints(
  left: TranscriptScreenPoint,
  right: TranscriptScreenPoint,
): number {
  if (left.modelRowIndex !== right.modelRowIndex) {
    return left.modelRowIndex - right.modelRowIndex;
  }
  return left.column - right.column;
}

function resolveTranscriptTextColumn(
  row: TranscriptRow,
  screenColumn: number,
  options: BuildTranscriptSelectionOptions = {},
): number {
  const normalizedColumn = Math.max(1, Math.floor(screenColumn));
  const text = normalizeTranscriptRowText(row);
  const textStartColumn = resolveTranscriptTextStartColumn(row, options);
  return Math.max(0, Math.min(text.length, normalizedColumn - textStartColumn));
}

function resolveAbsoluteScreenColumn(
  row: TranscriptRow,
  column: number,
  options: BuildTranscriptSelectionOptions = {},
): number {
  return resolveTranscriptTextStartColumn(row, options) + Math.max(0, column);
}

export function buildTranscriptScreenSelection(
  rows: readonly TranscriptRow[],
  anchor: TranscriptScreenPoint,
  focus: TranscriptScreenPoint,
  options: BuildTranscriptSelectionOptions = {},
): TranscriptTextSelection | undefined {
  if (rows.length === 0) {
    return undefined;
  }

  const [startPoint, endPoint] = comparePoints(anchor, focus) <= 0
    ? [anchor, focus]
    : [focus, anchor];
  const selectFullRowOnCollapsed = options.selectFullRowOnCollapsed === true;
  const isCollapsed = comparePoints(anchor, focus) === 0;
  const startRow = rows[startPoint.modelRowIndex];
  const endRow = rows[endPoint.modelRowIndex];
  if (!startRow || !endRow) {
    return undefined;
  }

  const effectiveStartPoint = selectFullRowOnCollapsed && isCollapsed
    ? {
        ...startPoint,
        column: 0,
      }
    : startPoint;
  const effectiveEndPoint = selectFullRowOnCollapsed && isCollapsed
    ? {
        ...endPoint,
        column: normalizeTranscriptRowText(endRow).length,
      }
    : endPoint;

  const rowRanges = new Map<string, TranscriptRowSelectionRange>();
  const segments: string[] = [];
  let charCount = 0;

  for (
    let rowIndex = effectiveStartPoint.modelRowIndex;
    rowIndex <= effectiveEndPoint.modelRowIndex;
    rowIndex += 1
  ) {
    const row = rows[rowIndex];
    if (!row) {
      continue;
    }

    const rowText = normalizeTranscriptRowText(row);
    const start = rowIndex === effectiveStartPoint.modelRowIndex
      ? resolveTranscriptTextColumn(
          row,
          resolveAbsoluteScreenColumn(row, effectiveStartPoint.column, options),
          options,
        )
      : 0;
    const end = rowIndex === effectiveEndPoint.modelRowIndex
      ? resolveTranscriptTextColumn(
          row,
          resolveAbsoluteScreenColumn(row, effectiveEndPoint.column, options),
          options,
        )
      : rowText.length;
    const safeStart = Math.max(0, Math.min(start, rowText.length));
    const safeEnd = Math.max(safeStart, Math.min(end, rowText.length));
    const segment = rowText.slice(safeStart, safeEnd);

    if (safeEnd > safeStart) {
      rowRanges.set(row.key, { start: safeStart, end: safeEnd });
      charCount += segment.length;
    }

    segments.push(segment);
  }

  if (rowRanges.size === 0) {
    return undefined;
  }

  return {
    anchor,
    focus,
    rowRanges,
    rowCount: segments.length,
    charCount,
    text: segments.join("\n"),
  };
}

export function buildTranscriptScreenSelectionSummary(
  selection: TranscriptTextSelection | undefined,
): string | undefined {
  if (!selection) {
    return undefined;
  }

  const charLabel = `${selection.charCount} char${selection.charCount === 1 ? "" : "s"}`;
  if (selection.rowCount <= 1) {
    return `Selected ${charLabel}`;
  }

  return `Selected ${charLabel} across ${selection.rowCount} lines`;
}
