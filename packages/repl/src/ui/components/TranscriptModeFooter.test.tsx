import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { TranscriptModeFooter } from "./TranscriptModeFooter.js";

describe("TranscriptModeFooter", () => {
  it("renders transcript browsing guidance by default", () => {
    const { lastFrame } = render(<TranscriptModeFooter />);

    const normalizedFrame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(normalizedFrame).toContain("Transcri");
    expect(normalizedFrame).toContain("PgUp/PgDn page");
    expect(normalizedFrame).toContain("j/k scroll");
    expect(normalizedFrame).toContain("select");
    expect(normalizedFrame).toContain("/ search");
    expect(normalizedFrame).toContain("n/N matches");
    expect(normalizedFrame).toContain("Ctrl+E show all");
    expect(normalizedFrame).toContain("Ctrl+O/q/Esc back");
  });

  it("shows escape as clear-focus when transcript selection is active", () => {
    const { lastFrame } = render(<TranscriptModeFooter selectionActive />);

    const normalizedFrame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(normalizedFrame).toContain("Esc clear");
    expect(normalizedFrame).toContain("focus");
    expect(normalizedFrame).toContain("Ctrl+E show all");
    expect(normalizedFrame).toContain("Ctrl+O/q back");
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
    expect(normalizedFrame).toContain("Enter jump");
    expect(normalizedFrame).toContain("n/N next/prev");
    expect(normalizedFrame).toContain("Ctrl+E show all");
    expect(normalizedFrame).toContain("Esc close");
    expect(normalizedFrame).toContain("Ctrl+O/q back");
    expect(normalizedFrame).toContain("3 new");
    expect(normalizedFrame).toContain("updates");
    expect(normalizedFrame).toContain("filesystem edit path");
    expect(normalizedFrame).toContain("Copied selection");
  });

  it("keeps the supplemental footer row visible when search detail text is empty", () => {
    const { lastFrame } = render(
      <TranscriptModeFooter
        searchActive
        searchQuery="planner"
        searchCurrent={0}
        searchCount={0}
        secondaryText="←/→ enter select mode | Ctrl+E show all | Mouse drag selects text"
      />,
    );

    const normalizedFrame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(normalizedFrame).toContain("Mouse drag selects text");
    expect(normalizedFrame).toContain("Ctrl+E show all");
  });

  it("shows collapse guidance when show-all is active", () => {
    const { lastFrame } = render(<TranscriptModeFooter showAllActive />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ctrl+E collapse");
  });
});
