import { describe, expect, it } from "vitest";
import { createRetryHistoryItem } from "./retry-history.js";

describe("retry-history", () => {
  it("keeps retry info compact when the reason already includes attempt details", () => {
    const item = createRetryHistoryItem("Stream stalled · retry 1/3 in 2s", 1, 3) as {
      icon?: string;
      text: string;
    };

    expect(item.icon).toBe("\u23F3");
    expect(item.text).toBe("Stream stalled · retry 1/3 in 2s");
  });

  it("appends attempt details only when the reason does not already include them", () => {
    const item = createRetryHistoryItem("Provider request timed out", 2, 3) as {
      text: string;
    };

    expect(item.text).toBe("Provider request timed out · retry 2/3");
  });
});
