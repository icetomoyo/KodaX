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
  return {
    type: "info",
    icon: "⏳",
    text: `${reason}\n   Retry attempt ${attempt}/${maxAttempts}`,
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
