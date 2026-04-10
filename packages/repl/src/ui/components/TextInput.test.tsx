import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { TextInput } from "./TextInput.js";

describe("TextInput", () => {
  it("hides the cursor when terminal focus is unavailable", () => {
    const { lastFrame } = render(
      <TextInput
        lines={["draft"]}
        cursorRow={0}
        cursorCol={2}
        focus
        terminalFocused={false}
        width={40}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("draft");
    expect(frame).not.toContain("\u2588");
  });

  it("renders a paste hint while paste mode is active", () => {
    const { lastFrame } = render(
      <TextInput
        lines={["draft", "follow-up"]}
        cursorRow={1}
        cursorCol={3}
        focus
        terminalFocused
        isPasting
        editingMode="pasting"
        width={40}
      />,
    );

    expect(lastFrame()).toContain("Pasting input...");
  });
});
