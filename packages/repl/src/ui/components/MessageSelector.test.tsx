import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MessageSelector } from "./MessageSelector.js";

describe("MessageSelector", () => {
  it("renders item kind and detail density for the current selection", () => {
    const { lastFrame } = render(
      <MessageSelector
        itemSummary="Tool call: changed_diff"
        itemKind="tool"
        position={{ current: 2, total: 4 }}
        detailState="expanded"
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Selected item 2/4");
    expect(frame).toContain("tool: Tool call: changed_diff");
    expect(frame).toContain("expanded");
  });
});
