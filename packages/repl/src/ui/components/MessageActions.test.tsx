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
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("select");
    expect(frame).toContain("C copy result");
    expect(frame).toContain("I copy tool input");
    expect(frame).toContain("Select copies");
    expect(frame).toContain("V details");
    expect(frame).toContain("Up/Down matches");
  });
});
