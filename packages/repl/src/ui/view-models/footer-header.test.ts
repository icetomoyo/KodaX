import { describe, expect, it } from "vitest";
import { buildFooterHeaderViewModel } from "./footer-header.js";

describe("buildFooterHeaderViewModel", () => {
  it("hides raw host and default verbosity diagnostics on the default idle footer", () => {
    const model = buildFooterHeaderViewModel({
      isHistorySearchActive: false,
      isReviewingHistory: false,
      pendingInputCount: 0,
      buffering: "buffered-fallback",
      verbosity: "compact",
    });

    expect(model.leftItems).toEqual([]);
    expect(model.rightItems).toEqual([]);
    expect(model.summary).toBe("");
  });

  it("shows buffered only while transcript browsing or search makes it relevant", () => {
    const model = buildFooterHeaderViewModel({
      isHistorySearchActive: false,
      isReviewingHistory: true,
      pendingInputCount: 0,
      buffering: "buffered-fallback",
      verbosity: "compact",
    });

    expect(model.leftItems.map((item) => item.label)).toEqual(["History", "Buffered"]);
    expect(model.rightItems).toEqual([]);
    expect(model.summary).toBe("History | Buffered");
  });

  it("keeps verbose visible because it is a user-facing display mode", () => {
    const model = buildFooterHeaderViewModel({
      isHistorySearchActive: true,
      isReviewingHistory: false,
      pendingInputCount: 2,
      buffering: "live",
      verbosity: "verbose",
    });

    expect(model.leftItems.map((item) => item.label)).toEqual(["Search", "Queue 2"]);
    expect(model.rightItems.map((item) => item.label)).toEqual(["verbose"]);
    expect(model.summary).toBe("Search | Queue 2 | verbose");
  });
});
