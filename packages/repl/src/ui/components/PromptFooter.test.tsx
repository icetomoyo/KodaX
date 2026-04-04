import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { PromptFooter } from "./PromptFooter.js";

describe("PromptFooter", () => {
  it("renders footer surfaces including help, notices, task bar, and dialog surface", () => {
    const { lastFrame } = render(
      <PromptFooter
        headerRight={<Text>native_vt | verbose</Text>}
        pendingInputs={<Text>Queued 2 follow-ups</Text>}
        composer={<Text>Composer</Text>}
        helpMenu={<Text>Help Menu</Text>}
        statusNotices={<Text>Search: planner</Text>}
        taskBar={<Text>Task Bar</Text>}
        statusLine={<Text>Status Line</Text>}
        dialogSurface={<Text>Dialog</Text>}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("native_vt | verbose");
    expect(frame).toContain("Queued 2 follow-ups");
    expect(frame).toContain("Composer");
    expect(frame).toContain("Help Menu");
    expect(frame).toContain("Search: planner");
    expect(frame).toContain("Task Bar");
    expect(frame).toContain("Status Line");
    expect(frame).toContain("Dialog");
  });
});
