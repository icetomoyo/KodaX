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
        scrollHeight={20}
        viewportHeight={20}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Transcript");
    expect(frame).toContain("Overlay");
    expect(frame).toContain("Footer");
  });

  it("can render transcript content from the renderer-owned window", () => {
    const { lastFrame } = render(
      <FullscreenTranscriptLayout
        renderTranscriptWindow={(window) => <Text>{`Window ${window.start}-${window.end}`}</Text>}
        footer={<Text>Footer</Text>}
        scrollTop={10}
        scrollHeight={120}
        viewportHeight={20}
      />,
    );

    expect(lastFrame()).toContain("Window 90-110");
    expect(lastFrame()).toContain("Footer");
  });

  it("reserves wrapped sticky-header rows in the transcript window", () => {
    let observedWindow = "";
    const { lastFrame } = render(
      <FullscreenTranscriptLayout
        renderTranscriptWindow={(window) => {
          observedWindow = `${window.start}-${window.end}`;
          return <Text>{`Window ${window.start}-${window.end}`}</Text>;
        }}
        footer={<Text>Footer</Text>}
        stickyHeader={{ visible: true, label: "Sticky prompt", hint: "wraps twice" }}
        jumpToLatest={{ visible: true, label: "Jump to latest", hint: "End" }}
        width={16}
        scrollTop={10}
        scrollHeight={120}
        viewportHeight={20}
      />,
    );

    const frame = lastFrame();
    expect((frame ?? "").replace(/\s+/g, " ")).toContain("Jump to");
    expect(observedWindow).toBe("93-110");
  });

  it("does not reduce the visible transcript window when only bottom chrome is shown", () => {
    let observedWindow = "";
    const { lastFrame } = render(
      <FullscreenTranscriptLayout
        renderTranscriptWindow={(window) => {
          observedWindow = `${window.start}-${window.end}`;
          return <Text>{`Window ${window.start}-${window.end}`}</Text>;
        }}
        footer={<Text>Footer</Text>}
        jumpToLatest={{ visible: true, label: "Jump to latest", hint: "End" }}
        scrollTop={10}
        scrollHeight={120}
        viewportHeight={20}
      />,
    );

    const frame = lastFrame();
    expect((frame ?? "").replace(/\s+/g, " ")).toContain("Jump to latest: End");
    expect(observedWindow).toBe("90-110");
  });

  it("reserves top chrome rows outside the transcript content window", () => {
    let observedWindow = "";
    const { lastFrame } = render(
      <FullscreenTranscriptLayout
        top={<Text>Banner</Text>}
        topRows={3}
        renderTranscriptWindow={(window) => {
          observedWindow = `${window.start}-${window.end}`;
          return <Text>{`Window ${window.start}-${window.end}`}</Text>;
        }}
        footer={<Text>Footer</Text>}
        scrollTop={10}
        scrollHeight={120}
        viewportHeight={20}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Banner");
    expect(frame).toContain("Window 93-110");
    expect(observedWindow).toBe("93-110");
  });
});

