import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MessageActions } from "./MessageActions.js";

describe("MessageActions", () => {
  it("renders available transcript actions", () => {
    const { lastFrame } = render(
      <MessageActions canCopy canToggleDetail />,
    );

    const frame = lastFrame();
    expect(frame).toContain("C copy");
    expect(frame).toContain("V toggle detail");
  });
});
