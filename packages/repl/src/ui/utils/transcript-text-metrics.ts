import {
  LRUCache,
  getVisualWidthCached,
  splitByCodePoints,
} from "./textUtils.js";

interface TranscriptTextMetrics {
  graphemes: string[];
  codeUnitOffsets: number[];
  visualOffsets: number[];
  length: number;
  displayWidth: number;
}

const METRICS_CACHE = new LRUCache<string, TranscriptTextMetrics>(500);

function buildTranscriptTextMetrics(text: string): TranscriptTextMetrics {
  const graphemes = splitByCodePoints(text);
  const codeUnitOffsets: number[] = [];
  const visualOffsets: number[] = [];
  let codeUnitOffset = 0;
  let visualOffset = 0;

  for (const grapheme of graphemes) {
    codeUnitOffsets.push(codeUnitOffset);
    visualOffsets.push(visualOffset);
    codeUnitOffset += grapheme.length;
    visualOffset += getVisualWidthCached(grapheme);
  }

  return {
    graphemes,
    codeUnitOffsets,
    visualOffsets,
    length: graphemes.length,
    displayWidth: visualOffset,
  };
}

export function getTranscriptTextMetrics(text: string): TranscriptTextMetrics {
  const cached = METRICS_CACHE.get(text);
  if (cached) {
    return cached;
  }

  const metrics = buildTranscriptTextMetrics(text);
  METRICS_CACHE.set(text, metrics);
  return metrics;
}

export function getTranscriptTextLength(text: string): number {
  return getTranscriptTextMetrics(text).length;
}

export function getTranscriptTextDisplayWidth(text: string): number {
  return getTranscriptTextMetrics(text).displayWidth;
}

export function charAtTranscriptText(text: string, index: number): string {
  const metrics = getTranscriptTextMetrics(text);
  const safeIndex = Math.max(0, Math.min(metrics.length - 1, index));
  return metrics.graphemes[safeIndex] ?? "";
}

export function sliceTranscriptText(
  text: string,
  start: number,
  end?: number,
): string {
  const metrics = getTranscriptTextMetrics(text);
  const safeStart = Math.max(0, Math.min(metrics.length, Math.floor(start)));
  const safeEnd = typeof end === "number"
    ? Math.max(safeStart, Math.min(metrics.length, Math.floor(end)))
    : metrics.length;
  return metrics.graphemes.slice(safeStart, safeEnd).join("");
}

export function resolveTranscriptTextIndexAtVisualColumn(
  text: string,
  visualColumn: number,
): number {
  const metrics = getTranscriptTextMetrics(text);
  const safeVisualColumn = Math.max(0, Math.floor(visualColumn));
  if (safeVisualColumn <= 0 || metrics.length === 0) {
    return 0;
  }

  for (let index = 0; index < metrics.length; index += 1) {
    const start = metrics.visualOffsets[index] ?? 0;
    const end = index + 1 < metrics.length
      ? (metrics.visualOffsets[index + 1] ?? metrics.displayWidth)
      : metrics.displayWidth;
    if (safeVisualColumn < end) {
      return index;
    }
    if (safeVisualColumn === start) {
      return index;
    }
  }

  return metrics.length;
}

export function resolveTranscriptTextCodeUnitOffset(
  text: string,
  index: number,
): number {
  const metrics = getTranscriptTextMetrics(text);
  const safeIndex = Math.max(0, Math.min(metrics.length, Math.floor(index)));
  if (safeIndex >= metrics.length) {
    return text.length;
  }
  return metrics.codeUnitOffsets[safeIndex] ?? text.length;
}
