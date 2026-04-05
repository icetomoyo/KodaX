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
          itemSummary: "Planner response",
          itemKind: "assistant",
          position: {
            current: 1,
            total: 3,
          },
          detailState: "expanded",
          copyCapabilities: {
            message: true,
            toolInput: true,
            copyOnSelect: true,
          },
          navigationCapabilities: {
            selection: true,
          },
        }}
        search={{
          query: "planner",
          matches: [
            { itemId: "assistant-1", excerpt: "Planner response" },
            { itemId: "assistant-2", excerpt: "Planner follow-up" },
          ],
          currentMatchIndex: 0,
          surface: <Text>2 matches</Text>,
          statusText: "1/2 transcript matches",
        }}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Browsing");
    expect(frame).toContain("Selected 1/3");
    expect(frame).toContain("assistant: Planner response");
    expect(frame).toContain("select");
    expect(frame).toContain("C copy");
    expect(frame).toContain("I copy tool input");
    expect(frame).toContain("Select copies");
    expect(frame).toContain("1/2 transcript matches");
    expect(frame).toContain("2 matches");
  });
});
