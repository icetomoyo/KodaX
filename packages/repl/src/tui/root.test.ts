import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const render = vi.fn();
  const unmount = vi.fn();
  const clear = vi.fn();
  const waitUntilExit = vi.fn(async () => undefined);
  const InkMock = vi.fn().mockImplementation((options: { concurrent?: boolean }) => ({
    isConcurrent: options.concurrent ?? false,
    render,
    unmount,
    clear,
    waitUntilExit,
  }));

  return {
    render,
    unmount,
    clear,
    waitUntilExit,
    InkMock,
  };
});

vi.mock("../../../../node_modules/ink/build/ink.js", () => ({
  default: mocks.InkMock,
}));

import { createRoot, render } from "./root.js";

describe("tui root", () => {
  beforeEach(() => {
    mocks.render.mockClear();
    mocks.unmount.mockClear();
    mocks.clear.mockClear();
    mocks.waitUntilExit.mockClear();
    mocks.InkMock.mockClear();
  });

  it("reuses the local root instance for the same stdout", () => {
    const stdout = { write: vi.fn(), isTTY: true } as unknown as NodeJS.WriteStream;
    const stdin = {} as NodeJS.ReadStream;

    const first = render("first", { stdout, stdin });
    render("second", { stdout, stdin });

    expect(mocks.InkMock).toHaveBeenCalledTimes(1);
    expect(mocks.render).toHaveBeenNthCalledWith(1, "first");
    expect(mocks.render).toHaveBeenNthCalledWith(2, "second");

    first.cleanup();

    render("third", { stdout, stdin });
    expect(mocks.InkMock).toHaveBeenCalledTimes(2);
  });

  it("creates an isolated root instance when requested explicitly", async () => {
    const stdout = { write: vi.fn(), isTTY: true } as unknown as NodeJS.WriteStream;
    const stdin = {} as NodeJS.ReadStream;

    const root = createRoot({ stdout, stdin });
    root.render("owned");
    await root.waitUntilExit();
    root.clear();
    root.unmount();

    expect(mocks.InkMock).toHaveBeenCalledTimes(1);
    expect(mocks.render).toHaveBeenCalledWith("owned");
    expect(mocks.waitUntilExit).toHaveBeenCalledTimes(1);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.unmount).toHaveBeenCalledTimes(1);
  });
});
