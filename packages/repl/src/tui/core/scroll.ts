import type { TranscriptScreenBuffer } from "./screen.js";

export function resolveTranscriptDragEdgeScrollDirection(
  buffer: TranscriptScreenBuffer,
  screenRow: number,
): -1 | 0 | 1 {
  if (buffer.rows.length === 0) {
    return 0;
  }

  if (screenRow < buffer.topRow) {
    return 1;
  }

  if (screenRow > buffer.bottomRow) {
    return -1;
  }

  return 0;
}
