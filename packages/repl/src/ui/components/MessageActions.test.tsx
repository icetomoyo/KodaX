import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MessageActions } from "./MessageActions.js";

describe("MessageActions", () => {
  it("renders available transcript actions", () => {
    const { lastFrame } = render(
      <MessageActions canCopy canCopyToolInput canToggleDetail searchActive searchMatchCount={3} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("C copy");
    expect(frame).toContain("I copy input");
    expect(frame).toContain("V toggle detail");
    expect(frame).toContain("Up/Down matches");
  });
});
