import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "../tui.js";
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
    expect(frame).not.toContain("Selected item 1/3");
    expect(frame).not.toContain("assistant: Planner response");
    expect(frame).toContain("C copy");
    expect(frame).toContain("I copy tool args");
    expect(frame).toContain("Mouse select copies");
    expect(frame).toContain("1/2 transcript matches");
    expect(frame).toContain("2 matches");
  });

  it("shrinks the message viewport when transcript chrome is visible", () => {
    const onMetricsChange = vi.fn();

    render(
      <TranscriptViewport
        items={[]}
        viewportWidth={80}
        viewportRows={10}
        onMetricsChange={onMetricsChange}
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
            toolInput: false,
            copyOnSelect: false,
          },
          navigationCapabilities: {
            selection: true,
          },
        }}
        search={{
          query: "planner",
          matches: [
            { itemId: "assistant-1", excerpt: "Planner response" },
          ],
          currentMatchIndex: 0,
          statusText: "1/1 transcript matches",
        }}
      />,
    );

    expect(onMetricsChange).toHaveBeenCalledWith({
      scrollHeight: 0,
      viewportHeight: 6,
    });
  });

  it("can hide inline chrome while keeping the message viewport intact", () => {
    const onMetricsChange = vi.fn();
    const { lastFrame } = render(
      <TranscriptViewport
        items={[]}
        viewportWidth={80}
        viewportRows={10}
        onMetricsChange={onMetricsChange}
        chromeMode="hidden"
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
            toolInput: false,
            copyOnSelect: false,
          },
          navigationCapabilities: {
            selection: true,
          },
        }}
        search={{
          query: "planner",
          matches: [
            { itemId: "assistant-1", excerpt: "Planner response" },
          ],
          currentMatchIndex: 0,
          statusText: "1/1 transcript matches",
        }}
      />,
    );

    expect(lastFrame()).not.toContain("Browsing");
    expect(lastFrame()).not.toContain("Selected 1/3");
    expect(onMetricsChange).toHaveBeenCalledWith({
      scrollHeight: 0,
      viewportHeight: 10,
    });
  });
});

