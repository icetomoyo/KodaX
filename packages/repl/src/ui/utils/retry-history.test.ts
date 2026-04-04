import { describe, expect, it } from "vitest";
import { createRecoveryHistoryItem, createRetryHistoryItem } from "./retry-history.js";

describe("retry-history", () => {
  it("keeps retry info compact when the reason already includes attempt details", () => {
    const item = createRetryHistoryItem("Stream stalled · retry 1/3 in 2s", 1, 3);

    expect(item).toMatchObject({
      type: "info",
      icon: "\u23F3",
      text: "Stream stalled · retry 1/3 in 2s",
    });
  });

  it("appends attempt details only when the reason does not already include them", () => {
    const item = createRetryHistoryItem("Provider request timed out", 2, 3);

    expect(item).toMatchObject({
      type: "info",
      text: "Provider request timed out · retry 2/3",
    });
  });

  it("renders structured recovery history items", () => {
    const item = createRecoveryHistoryItem({
      stage: "mid_stream_text",
      errorClass: "stream_idle_timeout",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 8000,
      recoveryAction: "stable_boundary_retry",
      ladderStep: 2,
      fallbackUsed: false,
    });

    expect(item).toMatchObject({
      type: "info",
      text: "Stream interrupted after partial output · recovering 2/3 in 8s",
    });
  });
});
