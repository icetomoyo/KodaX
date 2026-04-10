import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ClipboardToastSurface } from "./ClipboardToastSurface.js";

describe("ClipboardToastSurface", () => {
  it("renders a compact success toast without AMA notification framing", () => {
    const { lastFrame } = render(
      <ClipboardToastSurface text="Copied 3 selected lines to clipboard." />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓ Copied 3 selected lines to clipboard.");
    expect(frame).not.toContain("[AMA");
    expect(frame).not.toContain("Routing");
  });

  it("renders warning feedback for copy failures", () => {
    const { lastFrame } = render(
      <ClipboardToastSurface
        text="Failed to copy transcript selection: clipboard unavailable"
        tone="warning"
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("! Failed to copy transcript selection: clipboard unavailable");
  });
});
