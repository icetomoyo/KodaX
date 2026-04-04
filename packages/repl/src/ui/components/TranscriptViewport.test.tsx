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
        browse={{ hintText: "Browsing" }}
        selection={{
          summary: "Planner response",
          index: 0,
          total: 3,
          kindLabel: "assistant",
          detailExpanded: true,
          canCopy: true,
          canCopyToolInput: true,
        }}
        search={{
          surface: <Text>2 matches</Text>,
          statusText: "1/2 transcript matches",
          matchCount: 2,
        }}
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
