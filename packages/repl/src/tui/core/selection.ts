import type { TranscriptRow } from "../../ui/utils/transcript-layout.js";
import type { TranscriptScreenPoint } from "./screen.js";
import {
  getTranscriptTextLength,
  sliceTranscriptText,
} from "../../ui/utils/transcript-text-metrics.js";

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
        column: getTranscriptTextLength(normalizeTranscriptRowText(endRow)),
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
    const rowTextLength = getTranscriptTextLength(rowText);
    const start = rowIndex === effectiveStartPoint.modelRowIndex
      ? effectiveStartPoint.column
      : 0;
    const end = rowIndex === effectiveEndPoint.modelRowIndex
      ? effectiveEndPoint.column
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
