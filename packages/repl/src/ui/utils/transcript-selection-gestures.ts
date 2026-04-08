import type { TranscriptScreenPoint } from "../../tui/core/screen.js";
import type { TranscriptRow } from "./transcript-layout.js";

export type TranscriptSelectionGestureMode = "char" | "word" | "line";

export interface TranscriptSelectionSpan {
  start: TranscriptScreenPoint;
  end: TranscriptScreenPoint;
  kind: "word" | "line";
}

export interface TranscriptMultiClickTrackerState {
  time: number;
  row: number;
  column: number;
  count: number;
}

export interface ResolveTranscriptMultiClickOptions {
  previous: TranscriptMultiClickTrackerState;
  time: number;
  row: number;
  column: number;
  timeoutMs?: number;
  distance?: number;
}

const DEFAULT_MULTI_CLICK_TIMEOUT_MS = 500;
const DEFAULT_MULTI_CLICK_DISTANCE = 1;
const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u;

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

function charClass(character: string): 0 | 1 | 2 {
  if (character === "" || /\s/.test(character)) {
    return 0;
  }
  if (WORD_CHAR.test(character)) {
    return 1;
  }
  return 2;
}

export function resolveTranscriptMultiClickState(
  options: ResolveTranscriptMultiClickOptions,
): TranscriptMultiClickTrackerState {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MULTI_CLICK_TIMEOUT_MS;
  const distance = options.distance ?? DEFAULT_MULTI_CLICK_DISTANCE;
  const withinTimeout = options.time - options.previous.time <= timeoutMs;
  const withinDistance =
    Math.abs(options.row - options.previous.row) <= distance
    && Math.abs(options.column - options.previous.column) <= distance;
  const count = withinTimeout && withinDistance
    ? Math.min(3, options.previous.count + 1)
    : 1;

  return {
    time: options.time,
    row: options.row,
    column: options.column,
    count,
  };
}

export function resolveTranscriptSelectionSpanAt(
  rows: readonly TranscriptRow[],
  point: TranscriptScreenPoint,
  kind: "word" | "line",
): TranscriptSelectionSpan | undefined {
  const row = rows[point.modelRowIndex];
  if (!row) {
    return undefined;
  }

  const text = normalizeTranscriptRowText(row);
  if (kind === "line") {
    return {
      kind,
      start: { ...point, column: 0 },
      end: { ...point, column: text.length },
    };
  }

  if (text.length === 0) {
    return {
      kind,
      start: { ...point, column: 0 },
      end: { ...point, column: 0 },
    };
  }

  let column = Math.max(0, Math.min(text.length - 1, point.column));
  if (point.column === text.length) {
    column = text.length - 1;
  }

  const klass = charClass(text.charAt(column));
  let start = column;
  let end = column + 1;

  while (start > 0 && charClass(text.charAt(start - 1)) === klass) {
    start -= 1;
  }
  while (end < text.length && charClass(text.charAt(end)) === klass) {
    end += 1;
  }

  return {
    kind,
    start: { ...point, column: start },
    end: { ...point, column: end },
  };
}

export function extendTranscriptSelectionSpan(
  anchorSpan: TranscriptSelectionSpan,
  targetSpan: TranscriptSelectionSpan,
): { anchor: TranscriptScreenPoint; focus: TranscriptScreenPoint } {
  if (comparePoints(targetSpan.end, anchorSpan.start) < 0) {
    return {
      anchor: anchorSpan.end,
      focus: targetSpan.start,
    };
  }

  if (comparePoints(targetSpan.start, anchorSpan.end) > 0) {
    return {
      anchor: anchorSpan.start,
      focus: targetSpan.end,
    };
  }

  return {
    anchor: anchorSpan.start,
    focus: anchorSpan.end,
  };
}
