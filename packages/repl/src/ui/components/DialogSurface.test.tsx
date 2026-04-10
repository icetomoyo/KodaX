import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { DialogSurface } from "./DialogSurface.js";

describe("DialogSurface", () => {
  it("renders confirm dialogs", () => {
    const { lastFrame } = render(
      <DialogSurface confirm={{ prompt: "Apply changes?", instruction: "Press y to confirm" }} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("[Confirm]");
    expect(frame).toContain("Apply changes?");
  });

  it("renders input requests", () => {
    const { lastFrame } = render(
      <DialogSurface
        request={{
          kind: "input",
          prompt: "Workspace name",
          defaultValue: "kodax",
          buffer: "workspace-a",
        }}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("[Input]");
    expect(frame).toContain("Workspace name");
    expect(frame).toContain("workspace-a");
  });

  it("renders nothing when no dialog state is active", () => {
    const { lastFrame } = render(<DialogSurface />);
    expect(lastFrame()).toBe("");
  });
});
