import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

const mocks = vi.hoisted(() => {
  const writeRaw = vi.fn(() => true);
  const getRendererInstance = vi.fn();
  const setShellMode = vi.fn();
  const beginShellTransition = vi.fn();
  const setAltScreenActive = vi.fn();
  const clearTextSelection = vi.fn();
  const output = {
    isTTY: true,
    columns: 120,
    rows: 40,
    write: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as NodeJS.WriteStream;

  return {
    writeRaw,
    getRendererInstance,
    setShellMode,
    beginShellTransition,
    setAltScreenActive,
    clearTextSelection,
    output,
  };
});

vi.mock("../index.js", () => ({
  Box: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTerminalOutput: () => mocks.output,
  useTerminalSize: () => ({ rows: 40, columns: 120 }),
  useTerminalWrite: () => mocks.writeRaw,
}));

vi.mock("../core/root.js", () => ({
  getRendererInstance: (stdout: NodeJS.WriteStream) => {
    mocks.getRendererInstance(stdout);
    return {
      setShellMode: mocks.setShellMode,
      beginShellTransition: mocks.beginShellTransition,
      setAltScreenActive: mocks.setAltScreenActive,
      clearTextSelection: mocks.clearTextSelection,
    };
  },
}));

import {
  buildAlternateScreenEnterSequence,
  buildAlternateScreenExitSequence,
} from "../core/termio.js";
import { AlternateScreen } from "./AlternateScreen.js";

describe("AlternateScreen", () => {
  beforeEach(() => {
    mocks.writeRaw.mockClear();
    mocks.getRendererInstance.mockClear();
    mocks.setShellMode.mockClear();
    mocks.beginShellTransition.mockClear();
    mocks.setAltScreenActive.mockClear();
    mocks.clearTextSelection.mockClear();
  });

  it("uses the renderer-local terminal streams instead of global process.stdout", () => {
    const instance = render(
      <AlternateScreen>
        <></>
      </AlternateScreen>,
    );

    expect(mocks.getRendererInstance).toHaveBeenCalledWith(mocks.output);
    expect(mocks.getRendererInstance).not.toHaveBeenCalledWith(
      process.stdout as unknown as NodeJS.WriteStream,
    );
    expect(mocks.setShellMode).toHaveBeenCalledWith("virtual", true);
    expect(mocks.writeRaw).toHaveBeenCalledWith(
      buildAlternateScreenEnterSequence({ mouseTracking: true, clearOnEnter: false }),
    );
    expect(mocks.setAltScreenActive).toHaveBeenCalledWith(true, true);

    instance.unmount();

    expect(mocks.beginShellTransition).toHaveBeenCalledWith("exit-alt-screen");
    expect(mocks.clearTextSelection).toHaveBeenCalledTimes(1);
    expect(mocks.writeRaw).toHaveBeenLastCalledWith(
      buildAlternateScreenExitSequence({ mouseTracking: true }),
    );
  });
});
