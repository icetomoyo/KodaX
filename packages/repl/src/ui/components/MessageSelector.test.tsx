import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MessageSelector } from "./MessageSelector.js";

describe("MessageSelector", () => {
  it("renders item kind and detail density for the current selection", () => {
    const { lastFrame } = render(
      <MessageSelector
        summary="Tool call: changed_diff"
        kindLabel="tool"
        selectedIndex={1}
        total={4}
        detailExpanded
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Selected 2/4");
    expect(frame).toContain("tool: Tool call: changed_diff");
    expect(frame).toContain("[expanded]");
  });
});
