import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "../tui.js";
import { FullscreenTranscriptLayout } from "./FullscreenTranscriptLayout.js";

describe("FullscreenTranscriptLayout", () => {
  it("renders transcript, overlay, and footer slots", () => {
    const { lastFrame } = render(
      <FullscreenTranscriptLayout
        transcript={<Text>Transcript</Text>}
        overlay={<Text>Overlay</Text>}
        footer={<Text>Footer</Text>}
        stickyHeader={{ visible: true, label: "Sticky prompt" }}
        jumpToLatest={{ visible: true, label: "Jump to latest", hint: "End" }}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Sticky prompt");
    expect(frame).toContain("Transcript");
    expect(frame).toContain("Jump to latest: End");
    expect(frame).toContain("Overlay");
    expect(frame).toContain("Footer");
  });
});

