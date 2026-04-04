import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TranscriptViewport } from "./TranscriptViewport.js";

describe("TranscriptViewport", () => {
  it("renders browse/search chrome above the message list", () => {
    const { lastFrame } = render(
      <TranscriptViewport
        items={[]}
        browseHintText="Browsing"
        selectedSummary="Planner response"
        selectedIndex={0}
        selectedTotal={3}
        selectedKindLabel="assistant"
        selectedDetailExpanded
        canCopySelection
        canCopyToolInput
        searchSurface={<Text>2 matches</Text>}
        searchStatusText="1/2 transcript matches"
        searchMatchCount={2}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Browsing");
    expect(frame).toContain("Selected 1/3");
    expect(frame).toContain("assistant: Planner response");
    expect(frame).toContain("C copy");
    expect(frame).toContain("I copy input");
    expect(frame).toContain("1/2 transcript matches");
    expect(frame).toContain("2 matches");
  });
});
