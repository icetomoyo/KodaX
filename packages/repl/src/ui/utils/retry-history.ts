import type { CreatableHistoryItem } from "../types.js";

/**
 * Build the retry info history item shown during automatic provider retries.
 * Keeping this out of InkREPL makes the regression easy to test and avoids
 * falling back to console.log, which gets captured and deferred.
 */
export function createRetryHistoryItem(
  reason: string,
  attempt: number,
  maxAttempts: number,
): CreatableHistoryItem {
  const trimmed = reason.trim();
  const text = /\bretry\s+\d+\/\d+\b/i.test(trimmed) || /\b\d+\/\d+\b/.test(trimmed)
    ? trimmed
    : `${trimmed} · retry ${attempt}/${maxAttempts}`;

  return {
    type: "info",
    icon: "\u23F3",
    text,
  };
}

export function emitRetryHistoryItem(
  addHistoryItem: (item: CreatableHistoryItem) => void,
  reason: string,
  attempt: number,
  maxAttempts: number,
): void {
  addHistoryItem(createRetryHistoryItem(reason, attempt, maxAttempts));
}
