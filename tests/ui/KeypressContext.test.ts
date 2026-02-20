/**
 * KeypressContext Tests
 *
 * Tests for the priority-based keyboard event handling system.
 * Following Gemini CLI's KeypressContext architecture.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  KeypressHandlerPriority,
  type KeyInfo,
  type KeypressHandler,
} from "../../src/ui/types.js";
import {
  createKeypressManager,
  type KeypressManager,
} from "../../src/ui/contexts/KeypressContext.js";

// === Test Helpers ===

const createKeyEvent = (overrides: Partial<KeyInfo> = {}): KeyInfo => ({
  name: "a",
  sequence: "a",
  ctrl: false,
  meta: false,
  shift: false,
  ...overrides,
});

const createHandler = (
  returnValue: boolean | void = false
): { handler: KeypressHandler; called: ReturnType<typeof vi.fn> } => {
  const called = vi.fn();
  const handler: KeypressHandler = (event) => {
    called(event);
    return returnValue;
  };
  return { handler, called };
};

// === Tests ===

describe("KeypressHandlerPriority", () => {
  it("should have correct priority values", () => {
    expect(KeypressHandlerPriority.Low).toBe(-100);
    expect(KeypressHandlerPriority.Normal).toBe(0);
    expect(KeypressHandlerPriority.High).toBe(100);
    expect(KeypressHandlerPriority.Critical).toBe(200);
  });

  it("should be ordered correctly", () => {
    expect(KeypressHandlerPriority.Low).toBeLessThan(KeypressHandlerPriority.Normal);
    expect(KeypressHandlerPriority.Normal).toBeLessThan(KeypressHandlerPriority.High);
    expect(KeypressHandlerPriority.High).toBeLessThan(KeypressHandlerPriority.Critical);
  });
});

describe("KeypressManager", () => {
  let manager: KeypressManager;

  beforeEach(() => {
    manager = createKeypressManager();
  });

  describe("register", () => {
    it("should register a handler", () => {
      const { handler, called } = createHandler();
      const unregister = manager.register(KeypressHandlerPriority.Normal, handler);

      expect(typeof unregister).toBe("function");

      // Test dispatch
      const event = createKeyEvent();
      manager.dispatch(event);

      expect(called).toHaveBeenCalledTimes(1);
      expect(called).toHaveBeenCalledWith(event);
    });

    it("should return unregister function", () => {
      const { handler, called } = createHandler();
      const unregister = manager.register(KeypressHandlerPriority.Normal, handler);

      // Unregister
      unregister();

      // Dispatch should not call handler
      manager.dispatch(createKeyEvent());
      expect(called).not.toHaveBeenCalled();
    });
  });

  describe("dispatch", () => {
    it("should dispatch to single handler", () => {
      const { handler, called } = createHandler();
      manager.register(KeypressHandlerPriority.Normal, handler);

      const event = createKeyEvent({ name: "enter", sequence: "\r" });
      const handled = manager.dispatch(event);

      expect(called).toHaveBeenCalledTimes(1);
    });

    it("should dispatch to multiple handlers in priority order", () => {
      const order: number[] = [];

      const handler1: KeypressHandler = () => {
        order.push(1);
        return false;
      };
      const handler2: KeypressHandler = () => {
        order.push(2);
        return false;
      };
      const handler3: KeypressHandler = () => {
        order.push(3);
        return false;
      };

      manager.register(KeypressHandlerPriority.Low, handler1);
      manager.register(KeypressHandlerPriority.High, handler2);
      manager.register(KeypressHandlerPriority.Normal, handler3);

      manager.dispatch(createKeyEvent());

      // High -> Normal -> Low
      expect(order).toEqual([2, 3, 1]);
    });

    it("should stop propagation when handler returns true", () => {
      const order: number[] = [];

      const handler1: KeypressHandler = () => {
        order.push(1);
        return false;
      };
      const handler2: KeypressHandler = () => {
        order.push(2);
        return true; // Stop propagation
      };
      const handler3: KeypressHandler = () => {
        order.push(3);
        return false;
      };

      manager.register(KeypressHandlerPriority.High, handler1);
      manager.register(KeypressHandlerPriority.Normal, handler2);
      manager.register(KeypressHandlerPriority.Low, handler3);

      manager.dispatch(createKeyEvent());

      // High (1) runs, Normal (2) runs and returns true, Low (3) should not run
      expect(order).toEqual([1, 2]);
    });

    it("should handle handlers at same priority level (LIFO)", () => {
      const order: number[] = [];

      const handler1: KeypressHandler = () => {
        order.push(1);
        return false;
      };
      const handler2: KeypressHandler = () => {
        order.push(2);
        return false;
      };

      manager.register(KeypressHandlerPriority.Normal, handler1);
      manager.register(KeypressHandlerPriority.Normal, handler2);

      manager.dispatch(createKeyEvent());

      // Same priority: last registered runs first
      expect(order).toEqual([2, 1]);
    });

    it("should return true if any handler returned true", () => {
      const { handler } = createHandler(true);
      manager.register(KeypressHandlerPriority.Normal, handler);

      const result = manager.dispatch(createKeyEvent());
      expect(result).toBe(true);
    });

    it("should return false if no handler returned true", () => {
      const { handler } = createHandler(false);
      manager.register(KeypressHandlerPriority.Normal, handler);

      const result = manager.dispatch(createKeyEvent());
      expect(result).toBe(false);
    });

    it("should return false if no handlers registered", () => {
      const result = manager.dispatch(createKeyEvent());
      expect(result).toBe(false);
    });
  });

  describe("priority scenarios", () => {
    it("should allow critical handler to intercept before others", () => {
      const { handler: criticalHandler, called: criticalCalled } = createHandler(true);
      const { handler: normalHandler, called: normalCalled } = createHandler(false);

      manager.register(KeypressHandlerPriority.Critical, criticalHandler);
      manager.register(KeypressHandlerPriority.Normal, normalHandler);

      manager.dispatch(createKeyEvent());

      expect(criticalCalled).toHaveBeenCalled();
      expect(normalCalled).not.toHaveBeenCalled();
    });

    it("should allow modal to override default behavior", () => {
      // Scenario: Modal dialog with escape key
      const escapeKey = createKeyEvent({ name: "escape", sequence: "\x1b" });

      let modalOpen = true;
      const order: string[] = [];

      const modalHandler: KeypressHandler = (event) => {
        if (modalOpen && event.name === "escape") {
          order.push("modal-close");
          modalOpen = false;
          return true; // Consume event
        }
        return false;
      };

      const defaultHandler: KeypressHandler = (event) => {
        if (event.name === "escape") {
          order.push("default-cancel");
        }
        return false;
      };

      manager.register(KeypressHandlerPriority.High, modalHandler);
      manager.register(KeypressHandlerPriority.Normal, defaultHandler);

      // First press - modal consumes
      manager.dispatch(escapeKey);
      expect(order).toEqual(["modal-close"]);

      // Second press - default handles
      order.length = 0;
      manager.dispatch(escapeKey);
      expect(order).toEqual(["default-cancel"]);
    });
  });

  describe("edge cases", () => {
    it("should handle unregister during dispatch", () => {
      let unregister: () => void;
      const order: number[] = [];

      const handler1: KeypressHandler = () => {
        order.push(1);
        unregister(); // Unregister handler2 during dispatch
        return false;
      };

      const handler2: KeypressHandler = () => {
        order.push(2);
        return false;
      };

      manager.register(KeypressHandlerPriority.Normal, handler1);
      unregister = manager.register(KeypressHandlerPriority.Low, handler2);

      manager.dispatch(createKeyEvent());

      // handler1 (Normal) runs first, unregisters handler2 (Low)
      expect(order).toEqual([1]);
    });

    it("should handle multiple dispatches", () => {
      const { handler, called } = createHandler(false);
      manager.register(KeypressHandlerPriority.Normal, handler);

      manager.dispatch(createKeyEvent());
      manager.dispatch(createKeyEvent());
      manager.dispatch(createKeyEvent());

      expect(called).toHaveBeenCalledTimes(3);
    });
  });
});

// === Type Tests ===

describe("KeyInfo Type", () => {
  it("should have required properties", () => {
    const keyInfo: KeyInfo = {
      name: "a",
      sequence: "a",
      ctrl: false,
      meta: false,
      shift: false,
    };

    expect(keyInfo.name).toBeDefined();
    expect(keyInfo.sequence).toBeDefined();
    expect(typeof keyInfo.ctrl).toBe("boolean");
    expect(typeof keyInfo.meta).toBe("boolean");
    expect(typeof keyInfo.shift).toBe("boolean");
  });

  it("should support modifier combinations", () => {
    const ctrlA: KeyInfo = { name: "a", sequence: "\x01", ctrl: true, meta: false, shift: false };
    const altEnter: KeyInfo = { name: "enter", sequence: "\x1b\r", ctrl: false, meta: true, shift: false };
    const ctrlShiftC: KeyInfo = { name: "c", sequence: "\x03", ctrl: true, meta: false, shift: true };

    expect(ctrlA.ctrl).toBe(true);
    expect(altEnter.meta).toBe(true);
    expect(ctrlShiftC.ctrl).toBe(true);
    expect(ctrlShiftC.shift).toBe(true);
  });
});
