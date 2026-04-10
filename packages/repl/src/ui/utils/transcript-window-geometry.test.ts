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

  it("tracks top chrome rows separately from transcript content rows", () => {
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
      topChromeRows: 6,
    });

    expect(geometry.topChromeRows).toBe(6);
    expect(geometry.contentWindow.start).toBe(4);
    expect(geometry.contentWindow.end).toBe(24);
    expect(geometry.contentWindow.viewportHeight).toBe(20);
    expect(geometry.topOffsetRows).toBe(6);
  });

  it("preserves transcript coordinates when there is no top chrome", () => {
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
      topChromeRows: 0,
    });

    expect(geometry.topChromeRows).toBe(0);
    expect(geometry.contentWindow.start).toBe(4);
    expect(geometry.contentWindow.end).toBe(24);
    expect(geometry.contentWindow.viewportHeight).toBe(20);
    expect(geometry.topOffsetRows).toBe(0);
  });

  it("combines sticky-header and top-chrome rows in screen offsets without changing content coordinates", () => {
    const geometry = resolveTranscriptOwnedWindowGeometry({
      window: {
        start: 80,
        end: 100,
        scrollTop: 40,
        scrollHeight: 140,
        viewportHeight: 20,
        viewportTop: 80,
        pendingDelta: 0,
        sticky: false,
      },
      stickyHeader: {
        visible: true,
        label: "Transcript Mode",
      },
      width: 80,
      topChromeRows: 6,
    });

    expect(geometry.topChromeRows).toBe(6);
    expect(geometry.contentWindow.start).toBe(80);
    expect(geometry.contentWindow.end).toBe(100);
    expect(geometry.contentWindow.viewportTop).toBe(80);
    expect(geometry.contentWindow.viewportHeight).toBe(20);
    expect(geometry.topOffsetRows).toBeGreaterThan(6);
  });
});
