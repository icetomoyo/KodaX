import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { TranscriptModeFooter } from "./TranscriptModeFooter.js";

describe("TranscriptModeFooter", () => {
  it("renders transcript browsing guidance by default", () => {
    const { lastFrame } = render(<TranscriptModeFooter />);

    const frame = lastFrame();
    expect(frame).toContain("Showing detailed transcript");
    expect(frame).toContain("PgUp/PgDn/j/k scroll");
    expect(frame).toContain("/ search");
    expect(frame).toContain("Ctrl+O/q/Esc back to live");
  });

  it("renders search-focused footer content when transcript search is active", () => {
    const { lastFrame } = render(
      <TranscriptModeFooter
        searchActive
        searchQuery="planner"
        searchCurrent={2}
        searchCount={5}
        pendingLiveUpdates={3}
        secondaryText="Selected 2/9 · C copy"
        noticeText="Copied selection"
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Search /planne");
    expect(frame).toContain("Enter select");
    expect(frame).toContain("2/5");
    expect(frame).toContain("3 new updates");
    expect(frame).toContain("Selected 2/9");
    expect(frame).toContain("Copied selection");
  });
});
