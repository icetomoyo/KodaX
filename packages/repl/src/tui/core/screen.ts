import type { TranscriptRow } from "../../ui/utils/transcript-layout.js";

export interface TranscriptScreenRow {
  key: string;
  row: TranscriptRow;
  modelRowIndex: number;
  screenRow: number;
  text: string;
  textStartColumn: number;
  textEndColumn: number;
}

export interface TranscriptScreenPoint {
  rowKey: string;
  modelRowIndex: number;
  column: number;
}

export interface TranscriptScreenBuffer {
  rows: TranscriptScreenRow[];
  topRow: number;
  bottomRow: number;
  viewportHeight: number;
}

export interface BuildTranscriptScreenBufferOptions {
  topOffsetRows?: number;
  viewportHeight?: number;
  animateSpinners?: boolean;
  allRows?: readonly TranscriptRow[];
  rowIndexByKey?: ReadonlyMap<string, number>;
}

function normalizeTranscriptRowText(row: TranscriptRow): string {
  return row.text === " " ? "" : row.text;
}

export function buildTranscriptRowIndexByKey(
  rows: readonly TranscriptRow[],
): Map<string, number> {
  const indexByKey = new Map<string, number>();
  rows.forEach((row, index) => {
    indexByKey.set(row.key, index);
  });
  return indexByKey;
}

export function resolveTranscriptTextStartColumn(
  row: TranscriptRow,
  options: Pick<BuildTranscriptScreenBufferOptions, "animateSpinners"> = {},
): number {
  const indentColumns = Math.max(0, row.indent ?? 0);
  const spinnerColumns = row.spinner && options.animateSpinners !== false ? 2 : 0;
  return 1 + indentColumns + spinnerColumns;
}

export function buildTranscriptScreenBuffer(
  visibleRows: readonly TranscriptRow[],
  options: BuildTranscriptScreenBufferOptions = {},
): TranscriptScreenBuffer {
  const topOffsetRows = Math.max(0, options.topOffsetRows ?? 0);
  const indexByKey = options.rowIndexByKey
    ?? buildTranscriptRowIndexByKey(options.allRows ?? visibleRows);
  const rows = visibleRows.map<TranscriptScreenRow>((row, index) => {
    const text = normalizeTranscriptRowText(row);
    const textStartColumn = resolveTranscriptTextStartColumn(row, options);
    return {
      key: row.key,
      row,
      modelRowIndex: indexByKey.get(row.key) ?? index,
      screenRow: topOffsetRows + index + 1,
      text,
      textStartColumn,
      textEndColumn: textStartColumn + text.length,
    };
  });

  return {
    rows,
    topRow: rows[0]?.screenRow ?? topOffsetRows + 1,
    bottomRow: rows[rows.length - 1]?.screenRow ?? topOffsetRows,
    viewportHeight: Math.max(0, options.viewportHeight ?? visibleRows.length),
  };
}
