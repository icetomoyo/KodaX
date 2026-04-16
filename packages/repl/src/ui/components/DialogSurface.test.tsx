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

  it("renders select with focus pointer instead of numbers", () => {
    const { lastFrame } = render(
      <DialogSurface
        request={{
          kind: "select",
          title: "Choose option",
          options: [
            { label: "Alpha", value: "a" },
            { label: "Beta", value: "b" },
            { label: "Gamma", value: "c" },
          ],
          buffer: "",
          focusedIndex: 1,
          selectedIndices: [],
        }}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("[Select]");
    expect(frame).toContain("Choose option");
    // Focused item (Beta at index 1) should have the pointer
    expect(frame).toContain("\u276F Beta");
    // Non-focused items should not have pointer
    expect(frame).not.toContain("\u276F Alpha");
    expect(frame).not.toContain("\u276F Gamma");
  });

  it("renders multiSelect with check marks", () => {
    const { lastFrame } = render(
      <DialogSurface
        request={{
          kind: "select",
          title: "Choose steps",
          options: [
            { label: "Step 1", value: "1" },
            { label: "Step 2", value: "2" },
            { label: "Step 3", value: "3" },
          ],
          buffer: "",
          focusedIndex: 0,
          selectedIndices: [0, 2],
          multiSelect: true,
        }}
      />,
    );

    const frame = lastFrame();
    // Selected items should show checkmark
    expect(frame).toContain("Step 1");
    expect(frame).toContain("\u2713");
    // Shows multiselect hint
    expect(frame).toContain("Space");
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
