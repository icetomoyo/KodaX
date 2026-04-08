import { describe, expect, it } from "vitest";
import { buildFooterHeaderViewModel } from "./footer-header.js";

describe("buildFooterHeaderViewModel", () => {
  it("hides raw host and default verbosity diagnostics on the default idle footer", () => {
    const model = buildFooterHeaderViewModel({
      isHistorySearchActive: false,
      isTranscriptMode: false,
      pendingInputCount: 0,
      buffering: "buffered-fallback",
      pendingLiveUpdates: 0,
    });

    expect(model.leftItems).toEqual([]);
    expect(model.rightItems).toEqual([]);
    expect(model.summary).toBe("");
  });

  it("shows buffered only while transcript browsing or search makes it relevant", () => {
    const model = buildFooterHeaderViewModel({
      isHistorySearchActive: false,
      isTranscriptMode: true,
      pendingInputCount: 0,
      buffering: "buffered-fallback",
      pendingLiveUpdates: 0,
    });

    expect(model.leftItems.map((item) => item.label)).toEqual(["Transcript", "Buffered"]);
    expect(model.rightItems).toEqual([]);
    expect(model.summary).toBe("Transcript | Buffered");
  });

  it("shows pending transcript updates while transcript mode is active", () => {
    const model = buildFooterHeaderViewModel({
      isHistorySearchActive: true,
      isTranscriptMode: true,
      pendingInputCount: 2,
      buffering: "live",
      pendingLiveUpdates: 3,
    });

    expect(model.leftItems.map((item) => item.label)).toEqual(["Search", "Queue 2", "3 updates"]);
    expect(model.rightItems).toEqual([]);
    expect(model.summary).toBe("Search | Queue 2 | 3 updates");
  });
});
