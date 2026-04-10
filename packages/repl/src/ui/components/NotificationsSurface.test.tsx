import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { NotificationsSurface } from "./NotificationsSurface.js";

describe("NotificationsSurface", () => {
  it("renders only non-empty notifications", () => {
    const { lastFrame } = render(
      <NotificationsSurface
        notifications={[
          { id: "fallback", text: "Fallback viewport mode", tone: "warning" },
          { id: "empty", text: "   " },
        ]}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Fallback viewport mode");
    expect(frame).not.toContain("empty");
  });
});
