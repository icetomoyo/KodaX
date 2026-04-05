import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createTerminalInputController } from "./renderer-runtime.js";

class MockInput extends EventEmitter {
  isRaw = false;
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
