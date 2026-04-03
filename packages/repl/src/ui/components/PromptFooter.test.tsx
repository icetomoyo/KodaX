import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { PromptFooter } from "./PromptFooter.js";

describe("PromptFooter", () => {
  it("renders header, composer, task bar, status line, and dialog surface", () => {
    const { lastFrame } = render(
      <PromptFooter
        headerLeft={<Text>Search: planner</Text>}
        headerRight={<Text>native_vt | verbose</Text>}
        composer={<Text>Composer</Text>}
        taskBar={<Text>Task Bar</Text>}
        statusLine={<Text>Status Line</Text>}
        dialogSurface={<Text>Dialog</Text>}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Search: planner");
    expect(frame).toContain("native_vt | verbose");
    expect(frame).toContain("Composer");
    expect(frame).toContain("Task Bar");
    expect(frame).toContain("Status Line");
    expect(frame).toContain("Dialog");
  });
});
