import { describe, expect, it } from "vitest";
import { resolveTranscriptOwnedWindowGeometry } from "./transcript-window-geometry.js";

describe("transcript-window-geometry", () => {
  it("shares wrapped sticky-header measurement with fullscreen layout geometry", () => {
    const geometry = resolveTranscriptOwnedWindowGeometry({
      window: {
        start: 90,
        end: 110,
        scrollTop: 10,
        scrollHeight: 120,
        viewportHeight: 20,
        viewportTop: 90,
        pendingDelta: 0,
        sticky: false,
      },
      stickyHeader: {
        visible: true,
        label: "Searching transcript for \"very long query\"",
      },
      width: 18,
    });

    expect(geometry.stickyHeaderRows).toBeGreaterThan(1);
    expect(geometry.topOffsetRows).toBe(geometry.stickyHeaderRows);
    expect(geometry.contentWindow.viewportHeight).toBe(20);
  });

  it("normalizes banner-owned rows out of the transcript content window", () => {
    const geometry = resolveTranscriptOwnedWindowGeometry({
      window: {
        start: 4,
        end: 24,
        scrollTop: 96,
        scrollHeight: 140,
        viewportHeight: 20,
        viewportTop: 4,
        pendingDelta: 0,
        sticky: false,
      },
      width: 80,
      bannerVisible: true,
      fullscreenBannerRows: 6,
    });

    expect(geometry.bannerVisibleRows).toBe(6);
    expect(geometry.contentWindow.start).toBe(0);
    expect(geometry.contentWindow.end).toBe(18);
    expect(geometry.contentWindow.viewportHeight).toBe(14);
    expect(geometry.topOffsetRows).toBe(6);
  });
});
