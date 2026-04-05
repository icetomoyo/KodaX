import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "../tui.js";
import {
  PromptFooter,
  PromptFooterLeftSide,
  PromptFooterRightSide,
} from "./PromptFooter.js";

const BULLET_SEPARATOR = " \u00B7 ";

describe("PromptFooter", () => {
  it("renders footer surfaces including help, notices, task bar, and dialog surface", () => {
    const { lastFrame } = render(
      <PromptFooter
        left={<Text>History</Text>}
        right={<Text>native_vt | verbose</Text>}
        queued={<Text>Queued 2 follow-ups</Text>}
        stashNotice={<Text>Draft preserved</Text>}
        notifications={<Text>Fallback viewport mode</Text>}
        inlineNotices={<Text>Search: planner</Text>}
        composer={<Text>Composer</Text>}
        helpSurface={<Text>Help Menu</Text>}
        taskBar={<Text>Task Bar</Text>}
        statusLine={<Text>Status Line</Text>}
        inlineDialogs={<Text>Dialog</Text>}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("History");
    expect(frame).toContain("native_vt | verbose");
    expect(frame).toContain("Queued 2 follow-ups");
    expect(frame).toContain("Draft preserved");
    expect(frame).toContain("Fallback viewport mode");
    expect(frame).toContain("Composer");
    expect(frame).toContain("Help Menu");
    expect(frame).toContain("Search: planner");
    expect(frame).toContain("Task Bar");
    expect(frame).toContain("Status Line");
    expect(frame).toContain("Dialog");

    expect(frame.indexOf("History")).toBeLessThan(frame.indexOf("Queued 2 follow-ups"));
    expect(frame.indexOf("Queued 2 follow-ups")).toBeLessThan(frame.indexOf("Search: planner"));
    expect(frame.indexOf("Search: planner")).toBeLessThan(frame.indexOf("Composer"));
    expect(frame.indexOf("Composer")).toBeLessThan(frame.indexOf("Dialog"));
    expect(frame.indexOf("Dialog")).toBeLessThan(frame.indexOf("Help Menu"));
    expect(frame.indexOf("Help Menu")).toBeLessThan(frame.indexOf("Task Bar"));
    expect(frame.indexOf("Task Bar")).toBeLessThan(frame.indexOf("Status Line"));
  });

  it("preserves the original bullet separators for footer header items", () => {
    const { lastFrame } = render(
      <PromptFooter
        left={<PromptFooterLeftSide items={[
          { id: "history", label: "History" },
          { id: "queue", label: "Queue 2", accent: true },
        ]} />}
        right={<PromptFooterRightSide items={[
          { id: "host", label: "native_vt" },
          { id: "verbosity", label: "verbose", accent: true },
        ]} />}
        composer={<Text>Composer</Text>}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain(`History${BULLET_SEPARATOR}Queue 2`);
    expect(frame).toContain(`native_vt${BULLET_SEPARATOR}verbose`);
    expect(frame).not.toContain("路");
  });
});
