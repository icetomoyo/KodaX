import { describe, expect, it, vi } from "vitest";
import {
  withCapture,
} from "../../packages/repl/src/ui/utils/console-capturer.js";
import {
  createRetryHistoryItem,
  emitRetryHistoryItem,
} from "../../packages/repl/src/ui/utils/retry-history.js";
import type { CreatableHistoryItem } from "../../packages/repl/src/ui/types.js";

describe("retry-history utils", () => {
  it("should create the expected retry info item", () => {
    expect(createRetryHistoryItem("API error, retrying in 3s (1/3)", 1, 3)).toEqual({
      type: "info",
      icon: "⏳",
      text: "API error, retrying in 3s (1/3)\n   Retry attempt 1/3",
    });
  });

  it("should emit retry history without writing to console.log", async () => {
    const addHistoryItem = vi.fn<(item: CreatableHistoryItem) => void>();

    const { captured } = await withCapture(async () => {
      emitRetryHistoryItem(addHistoryItem, "API error, retrying in 3s (1/3)", 1, 3);
    });

    expect(captured).toEqual([]);
    expect(addHistoryItem).toHaveBeenCalledTimes(1);
    expect(addHistoryItem).toHaveBeenCalledWith({
      type: "info",
      icon: "⏳",
      text: "API error, retrying in 3s (1/3)\n   Retry attempt 1/3",
    });
  });
});
