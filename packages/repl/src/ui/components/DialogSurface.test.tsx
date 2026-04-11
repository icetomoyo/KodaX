import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { DialogSurface } from "./DialogSurface.js";
import { setLocale } from "../../common/i18n.js";

describe("DialogSurface", () => {
  beforeEach(() => {
    setLocale("en");
  });
  afterEach(() => {
    setLocale("en");
  });

  it("renders confirm dialogs", () => {
    const { lastFrame } = render(
      <DialogSurface confirm={{ prompt: "Apply changes?", instruction: "Press y to confirm" }} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("[Confirm]");
    expect(frame).toContain("Apply changes?");
  });

  it("renders confirm dialogs in Chinese when locale is zh", () => {
    setLocale("zh");
    const { lastFrame } = render(
      <DialogSurface confirm={{ prompt: "Apply changes?", instruction: "按 (y) 确认" }} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("[确认]");
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
