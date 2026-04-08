import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MessageActions } from "./MessageActions.js";

describe("MessageActions", () => {
  it("renders available transcript actions", () => {
    const { lastFrame } = render(
      <MessageActions
        copyMessage
        copyToolInput
        copyOnSelect
        toggleDetail
        selectionNavigation
        matchNavigation
        dismissAction="clear"
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("browse");
    expect(frame).toContain("C copy");
    expect(frame).toContain("I tool input");
    expect(frame).toContain("Mouse select copies");
    expect(frame).toContain("V details");
    expect(frame).toContain("N/Shift+N matches");
    expect(frame).toContain("Esc");
    expect(frame).toContain("clear");
  });
});
