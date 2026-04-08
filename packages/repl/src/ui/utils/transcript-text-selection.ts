import type { TranscriptRow } from "./transcript-layout.js";
import {
  getTranscriptTextLength,
  resolveTranscriptTextIndexAtVisualColumn,
  sliceTranscriptText,
} from "./transcript-text-metrics.js";

export interface TranscriptSelectionPoint {
  rowIndex: number;
  column: number;
}

export interface TranscriptRowSelectionRange {
  start: number;
  end: number;
}

export interface TranscriptTextSelection {
  anchor: TranscriptSelectionPoint;
  focus: TranscriptSelectionPoint;
  rowRanges: Map<string, TranscriptRowSelectionRange>;
  rowCount: number;
  charCount: number;
  text: string;
}

export interface BuildTranscriptTextSelectionOptions {
  animateSpinners?: boolean;
  selectFullRowOnCollapsed?: boolean;
}

function normalizeTranscriptRowText(row: TranscriptRow): string {
  return row.text === " " ? "" : row.text;
}

function resolveTextStartColumn(
  row: TranscriptRow,
  options: BuildTranscriptTextSelectionOptions = {},
): number {
  const indentColumns = Math.max(0, row.indent ?? 0);
  const spinnerColumns = row.spinner && options.animateSpinners !== false ? 2 : 0;
  return 1 + indentColumns + spinnerColumns;
}

export function resolveTranscriptTextColumn(
  row: TranscriptRow,
  column: number,
  options: BuildTranscriptTextSelectionOptions = {},
): number {
  const normalizedColumn = Math.max(1, Math.floor(column));
  const text = normalizeTranscriptRowText(row);
  const textStartColumn = resolveTextStartColumn(row, options);
  return resolveTranscriptTextIndexAtVisualColumn(
    text,
    normalizedColumn - textStartColumn,
  );
}

function compareSelectionPoints(
  left: TranscriptSelectionPoint,
  right: TranscriptSelectionPoint,
): number {
  if (left.rowIndex !== right.rowIndex) {
    return left.rowIndex - right.rowIndex;
  }
  return left.column - right.column;
}

export function buildTranscriptTextSelection(
  rows: readonly TranscriptRow[],
  anchor: TranscriptSelectionPoint,
  focus: TranscriptSelectionPoint,
  options: BuildTranscriptTextSelectionOptions = {},
): TranscriptTextSelection | undefined {
  if (rows.length === 0) {
    return undefined;
  }

  const [startPoint, endPoint] = compareSelectionPoints(anchor, focus) <= 0
    ? [anchor, focus]
    : [focus, anchor];
  const selectFullRowOnCollapsed = options.selectFullRowOnCollapsed === true;
  const isCollapsed = compareSelectionPoints(anchor, focus) === 0;
  const effectiveStartPoint = selectFullRowOnCollapsed && isCollapsed
    ? { rowIndex: startPoint.rowIndex, column: 1 }
    : startPoint;
  const effectiveEndPoint = selectFullRowOnCollapsed && isCollapsed
    ? { rowIndex: endPoint.rowIndex, column: Number.MAX_SAFE_INTEGER }
    : endPoint;

  const rowRanges = new Map<string, TranscriptRowSelectionRange>();
  const segments: string[] = [];
  let charCount = 0;

  for (let rowIndex = effectiveStartPoint.rowIndex; rowIndex <= effectiveEndPoint.rowIndex; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row) {
      continue;
    }

    const rowText = normalizeTranscriptRowText(row);
    const rowTextLength = getTranscriptTextLength(rowText);
    const start = rowIndex === effectiveStartPoint.rowIndex
      ? resolveTranscriptTextColumn(row, effectiveStartPoint.column, options)
      : 0;
    const end = rowIndex === effectiveEndPoint.rowIndex
      ? resolveTranscriptTextColumn(row, effectiveEndPoint.column, options)
      : rowTextLength;
    const safeStart = Math.max(0, Math.min(start, rowTextLength));
    const safeEnd = Math.max(safeStart, Math.min(end, rowTextLength));
    const segment = sliceTranscriptText(rowText, safeStart, safeEnd);

    if (safeEnd > safeStart) {
      rowRanges.set(row.key, { start: safeStart, end: safeEnd });
      charCount += safeEnd - safeStart;
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

export function buildTranscriptTextSelectionSummary(
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
