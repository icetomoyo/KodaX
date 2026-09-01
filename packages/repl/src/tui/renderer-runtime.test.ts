import { EventEmitter } from "node:events";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createTerminalInputController,
  render,
  useApp,
  useInput,
  type Key,
} from "./renderer-runtime.js";

class MockInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  acceptsInput = true;
  hasRef = vi.fn(() => false);
  ref = vi.fn();
  unref = vi.fn(() => {
    this.acceptsInput = false;
  });
  resume = vi.fn(() => {
    this.acceptsInput = true;
    return this;
  });

  setRawMode(enabled: boolean) {
    this.isRaw = enabled;
  }

  emitInput(chunk: Buffer): void {
    if (this.acceptsInput) {
      this.emit("data", chunk);
    }
  }
}

class BunWindowsMockInput extends MockInput {
  private rawModeWasReleased = false;

  override setRawMode(enabled: boolean) {
    if (this.isRaw && !enabled) {
      this.rawModeWasReleased = true;
    }
    super.setRawMode(enabled);
  }

  override emitInput(chunk: Buffer): void {
    if (!this.rawModeWasReleased) {
      super.emitInput(chunk);
    }
  }
}

class MockOutput extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 40;
  write = vi.fn(() => true);
}

describe("createTerminalInputController", () => {
  it("keeps terminal input referenced while subscribers are active", () => {
    const stdin = new MockInput();
    const controller = createTerminalInputController({
      stdin,
      setRawMode: vi.fn(),
      isRawModeSupported: true,
    });

    const unsubscribeA = controller.subscribe(() => undefined);
    const unsubscribeB = controller.subscribe(() => undefined);

    expect(stdin.ref).toHaveBeenCalledTimes(1);
    expect(stdin.unref).not.toHaveBeenCalled();

    unsubscribeA();
    expect(stdin.unref).not.toHaveBeenCalled();

    unsubscribeB();
    expect(stdin.unref).toHaveBeenCalledTimes(1);
  });

  it("does not release an input reference owned by the caller", () => {
    const stdin = new MockInput();
    stdin.hasRef.mockReturnValue(true);
    const controller = createTerminalInputController({
      stdin,
      setRawMode: vi.fn(),
      isRawModeSupported: true,
    });

    const unsubscribe = controller.subscribe(() => undefined);
    unsubscribe();

    expect(stdin.ref).not.toHaveBeenCalled();
    expect(stdin.unref).not.toHaveBeenCalled();
  });

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

  it("restores input flow when a new controller takes over an unreferenced terminal", () => {
    const stdin = new MockInput();
    const first = createTerminalInputController({
      stdin,
      setRawMode: (enabled) => stdin.setRawMode(enabled),
      isRawModeSupported: true,
    });
    const stopFirst = first.subscribe(() => undefined);

    stopFirst();
    expect(stdin.acceptsInput).toBe(false);

    const handler = vi.fn();
    const second = createTerminalInputController({
      stdin,
      setRawMode: (enabled) => stdin.setRawMode(enabled),
      isRawModeSupported: true,
    });
    second.subscribe(handler);
    stdin.emitInput(Buffer.from("next"));

    expect(stdin.resume).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(Buffer.from("next"));
  });
});

describe("renderer-runtime useInput", () => {
  it("hands terminal input from a completed renderer to the next renderer", async () => {
    const stdout = new MockOutput() as unknown as NodeJS.WriteStream;
    const stderr = new MockOutput() as unknown as NodeJS.WriteStream;
    const mockInput = new BunWindowsMockInput();
    const stdin = mockInput as unknown as NodeJS.ReadStream;
    let handoffReady = false;

    function PickerHarness() {
      const { exit } = useApp();
      useInput((_input, key) => {
        if (key.return) {
          handoffReady = true;
          exit();
        }
      });
      return null;
    }

    const picker = render(React.createElement(PickerHarness), {
      stdout,
      stderr,
      stdin,
      preserveRawModeOnUnmount: () => handoffReady,
    });
    const pickerExit = picker.waitUntilExit();
    mockInput.emitInput(Buffer.from("\r"));
    await pickerExit;
    picker.cleanup();
    expect(mockInput.isRaw).toBe(true);

    const replHandler = vi.fn();
    function ReplHarness() {
      useInput(replHandler);
      return null;
    }

    const repl = render(React.createElement(ReplHarness), { stdout, stderr, stdin });
    mockInput.emitInput(Buffer.from("a"));

    expect(replHandler).toHaveBeenCalledWith("a", expect.objectContaining({ ctrl: false }));

    repl.unmount();
    repl.cleanup();
    expect(mockInput.isRaw).toBe(false);
  });

  it("delivers Ctrl+C to an active input handler", () => {
    const stdout = new MockOutput() as unknown as NodeJS.WriteStream;
    const stderr = new MockOutput() as unknown as NodeJS.WriteStream;
    const stdin = new MockInput() as unknown as NodeJS.ReadStream;
    const handler = vi.fn();

    function Harness() {
      useInput(handler);
      return null;
    }

    const instance = render(React.createElement(Harness), { stdout, stderr, stdin });

    (stdin as unknown as MockInput).emit("data", Buffer.from("\x03"));

    expect(handler).toHaveBeenCalledWith("c", expect.objectContaining({ ctrl: true }));

    instance.unmount();
    instance.cleanup();
  });

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
