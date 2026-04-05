import { EventEmitter } from "node:events";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createTerminalInputController,
  render,
  useInput,
  type Key,
} from "./renderer-runtime.js";

class MockInput extends EventEmitter {
  isRaw = false;

  setRawMode(enabled: boolean) {
    this.isRaw = enabled;
  }
}

class MockOutput extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 40;
  write = vi.fn(() => true);
}

describe("createTerminalInputController", () => {
  it("keeps raw mode enabled until the last raw subscriber unsubscribes", () => {
    const stdin = new MockInput();
    const setRawMode = vi.fn((enabled: boolean) => {
      stdin.isRaw = enabled;
    });
    const controller = createTerminalInputController({
      stdin,
      setRawMode,
      isRawModeSupported: true,
    });

    const unsubscribeA = controller.subscribe(() => undefined, { rawMode: true });
    const unsubscribeB = controller.subscribe(() => undefined, { rawMode: true });

    expect(setRawMode).toHaveBeenCalledTimes(1);
    expect(setRawMode).toHaveBeenLastCalledWith(true);
    expect(stdin.isRaw).toBe(true);

    unsubscribeA();
    expect(setRawMode).toHaveBeenCalledTimes(1);
    expect(stdin.isRaw).toBe(true);

    unsubscribeB();
    expect(setRawMode).toHaveBeenCalledTimes(2);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.isRaw).toBe(false);
  });

  it("fans out input data to every active subscriber", () => {
    const stdin = new MockInput();
    const controller = createTerminalInputController({
      stdin,
      setRawMode: vi.fn(),
      isRawModeSupported: true,
    });
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    controller.subscribe(handlerA, { rawMode: false });
    controller.subscribe(handlerB, { rawMode: false });

    stdin.emit("data", Buffer.from("a"));

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerA.mock.calls[0]?.[0]).toEqual(Buffer.from("a"));
  });
});

describe("renderer-runtime useInput", () => {
  it("parses printable and special keys through the local terminal pipeline", () => {
    const stdout = new MockOutput() as unknown as NodeJS.WriteStream;
    const stderr = new MockOutput() as unknown as NodeJS.WriteStream;
    const stdin = new MockInput() as unknown as NodeJS.ReadStream;
    const events: Array<{ input: string; key: Key }> = [];

    function Harness() {
      useInput((input, key) => {
        events.push({ input, key });
      });
      return null;
    }

    const instance = render(React.createElement(Harness), { stdout, stderr, stdin });

    (stdin as unknown as MockInput).emit("data", Buffer.from("a"));
    (stdin as unknown as MockInput).emit("data", Buffer.from("\x1b[A"));

    expect(events).toHaveLength(2);
    expect(events[0]?.input).toBe("a");
    expect(events[0]?.key).toMatchObject({ ctrl: false, upArrow: false });
    expect(events[1]?.input).toBe("");
    expect(events[1]?.key).toMatchObject({ upArrow: true });

    instance.unmount();
    instance.cleanup();
  });

  it("flushes a pending escape sequence through the local timeout path", () => {
    vi.useFakeTimers();

    const stdout = new MockOutput() as unknown as NodeJS.WriteStream;
    const stderr = new MockOutput() as unknown as NodeJS.WriteStream;
    const stdin = new MockInput() as unknown as NodeJS.ReadStream;
    const events: Array<{ input: string; key: Key }> = [];

    function Harness() {
      useInput((input, key) => {
        events.push({ input, key });
      });
      return null;
    }

    const instance = render(React.createElement(Harness), { stdout, stderr, stdin });

    (stdin as unknown as MockInput).emit("data", Buffer.from("\x1b"));
    vi.runAllTimers();

    expect(events).toHaveLength(1);
    expect(events[0]?.input).toBe("");
    expect(events[0]?.key).toMatchObject({ escape: true, meta: true });

    instance.unmount();
    instance.cleanup();
    vi.useRealTimers();
  });
});
