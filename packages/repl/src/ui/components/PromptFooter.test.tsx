import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { PromptFooter } from "./PromptFooter.js";

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

    const frame = lastFrame();
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
  });
});
