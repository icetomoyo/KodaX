import type {
  TranscriptScreenBuffer,
  TranscriptScreenPoint,
  TranscriptScreenRow,
} from "./screen.js";
import { resolveTranscriptTextIndexAtVisualColumn } from "../../ui/utils/transcript-text-metrics.js";

export interface TranscriptScreenHit {
  screenRow: TranscriptScreenRow;
  point: TranscriptScreenPoint;
}

function clampTextColumn(
  row: TranscriptScreenRow,
  screenColumn: number,
): number {
  const safeScreenColumn = Math.max(1, Math.floor(screenColumn));
  return resolveTranscriptTextIndexAtVisualColumn(
    row.text,
    safeScreenColumn - row.textStartColumn,
  );
}

function toHit(
  row: TranscriptScreenRow,
  screenColumn: number,
): TranscriptScreenHit {
  return {
    screenRow: row,
    point: {
      rowKey: row.key,
      modelRowIndex: row.modelRowIndex,
      column: clampTextColumn(row, screenColumn),
    },
  };
}

export function hitTestTranscriptScreen(
  buffer: TranscriptScreenBuffer,
  screenRow: number,
  screenColumn: number,
): TranscriptScreenHit | undefined {
  const targetRow = buffer.rows.find((row) => row.screenRow === screenRow);
  return targetRow ? toHit(targetRow, screenColumn) : undefined;
}

export function clampTranscriptScreenHit(
  buffer: TranscriptScreenBuffer,
  screenRow: number,
  screenColumn: number,
): TranscriptScreenHit | undefined {
  if (buffer.rows.length === 0) {
    return undefined;
  }

  if (screenRow <= buffer.topRow) {
    return toHit(buffer.rows[0]!, screenColumn);
  }

  if (screenRow >= buffer.bottomRow) {
    return toHit(buffer.rows[buffer.rows.length - 1]!, screenColumn);
  }

  return hitTestTranscriptScreen(buffer, screenRow, screenColumn);
}
