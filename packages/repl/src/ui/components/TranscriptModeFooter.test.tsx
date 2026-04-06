import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { TranscriptModeFooter } from "./TranscriptModeFooter.js";

describe("TranscriptModeFooter", () => {
  it("renders transcript browsing guidance by default", () => {
    const { lastFrame } = render(<TranscriptModeFooter />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Transcript browser");
    expect(frame).toContain("PgUp/PgDn page");
    expect(frame).toContain("j/k scroll");
    expect(frame).toContain("/ search");
    expect(frame).toContain("Ctrl+O/q/Esc back");
  });

  it("renders search-focused footer content when transcript search is active", () => {
    const { lastFrame } = render(
      <TranscriptModeFooter
        searchActive
        searchQuery="planner"
        searchCurrent={2}
        searchCount={5}
        searchDetailText="...planner chooses the filesystem edit path..."
        pendingLiveUpdates={3}
        secondaryText="Selected item 2/9 | C copy block"
        noticeText="Copied selection"
      />,
    );

    const frame = lastFrame() ?? "";
    const normalizedFrame = frame.replace(/\s+/g, " ");
    expect(normalizedFrame).toContain("Search");
    expect(normalizedFrame).toContain("/planner");
    expect(normalizedFrame).toContain("Enter open");
    expect(normalizedFrame).toContain("N/Shift+N next/prev");
    expect(normalizedFrame).toContain("Esc close");
    expect(normalizedFrame).toContain("Ctrl+O/q back");
    expect(normalizedFrame).toContain("3 new");
    expect(normalizedFrame).toContain("updates");
    expect(normalizedFrame).toContain("filesystem edit path");
    expect(normalizedFrame).toContain("Copied selection");
  });
});
