/**
 * StreamingContext Tests
 *
 * Tests for the streaming response handling context.
 * Following Gemini CLI's StreamingContext architecture.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StreamingState } from "../../src/ui/types.js";
import {
  type StreamingContextValue,
  type StreamingActions,
  createStreamingManager,
  type StreamingManager,
} from "../../src/ui/contexts/StreamingContext.js";

// === Tests ===

describe("StreamingState", () => {
  it("should have Idle state", () => {
    expect(StreamingState.Idle).toBe("idle");
  });

  it("should have Responding state", () => {
    expect(StreamingState.Responding).toBe("responding");
  });

  it("should have WaitingForConfirmation state", () => {
    expect(StreamingState.WaitingForConfirmation).toBe(
      "waiting_for_confirmation"
    );
  });
});

describe("StreamingManager", () => {
  let manager: StreamingManager;

  beforeEach(() => {
    manager = createStreamingManager();
  });

  describe("initial state", () => {
    it("should start in Idle state", () => {
      expect(manager.getState().state).toBe(StreamingState.Idle);
    });

    it("should have empty response", () => {
      expect(manager.getState().currentResponse).toBe("");
    });

    it("should have no error", () => {
      expect(manager.getState().error).toBeUndefined();
    });

    it("should not have abort controller", () => {
      expect(manager.getState().abortController).toBeUndefined();
    });
  });

  describe("setState", () => {
    it("should update streaming state", () => {
      manager.setState(StreamingState.Responding);
      expect(manager.getState().state).toBe(StreamingState.Responding);
    });

    it("should transition to WaitingForConfirmation", () => {
      manager.setState(StreamingState.WaitingForConfirmation);
      expect(manager.getState().state).toBe(StreamingState.WaitingForConfirmation);
    });

    it("should transition back to Idle", () => {
      manager.setState(StreamingState.Responding);
      manager.setState(StreamingState.Idle);
      expect(manager.getState().state).toBe(StreamingState.Idle);
    });
  });

  describe("appendResponse", () => {
    it("should append text to current response", () => {
      manager.appendResponse("Hello");
      expect(manager.getState().currentResponse).toBe("Hello");

      manager.appendResponse(" World");
      expect(manager.getState().currentResponse).toBe("Hello World");
    });

    it("should handle empty string", () => {
      manager.appendResponse("");
      expect(manager.getState().currentResponse).toBe("");
    });

    it("should handle special characters", () => {
      manager.appendResponse("Line1\n");
      manager.appendResponse("Line2\r\n");
      manager.appendResponse("Line3");
      expect(manager.getState().currentResponse).toBe("Line1\nLine2\r\nLine3");
    });
  });

  describe("clearResponse", () => {
    it("should clear current response", () => {
      manager.appendResponse("Some text");
      manager.clearResponse();
      expect(manager.getState().currentResponse).toBe("");
    });
  });

  describe("setError", () => {
    it("should set error message", () => {
      manager.setError("Network error");
      expect(manager.getState().error).toBe("Network error");
    });

    it("should clear error", () => {
      manager.setError("Error");
      manager.setError(undefined);
      expect(manager.getState().error).toBeUndefined();
    });
  });

  describe("abort", () => {
    it("should create abort controller when starting", () => {
      manager.startStreaming();
      expect(manager.getState().abortController).toBeDefined();
    });

    it("should abort current stream", () => {
      manager.startStreaming();
      const controller = manager.getState().abortController;
      expect(controller).toBeDefined();

      manager.abort();
      expect(controller?.signal.aborted).toBe(true);
    });

    it("should clear abort controller after abort", () => {
      manager.startStreaming();
      manager.abort();
      expect(manager.getState().abortController).toBeUndefined();
    });
  });

  describe("reset", () => {
    it("should reset all state to defaults", () => {
      manager.setState(StreamingState.Responding);
      manager.appendResponse("Some response");
      manager.setError("Some error");

      manager.reset();

      expect(manager.getState().state).toBe(StreamingState.Idle);
      expect(manager.getState().currentResponse).toBe("");
      expect(manager.getState().error).toBeUndefined();
    });
  });

  describe("isStreaming", () => {
    it("should return false when idle", () => {
      expect(manager.isStreaming()).toBe(false);
    });

    it("should return true when responding", () => {
      manager.setState(StreamingState.Responding);
      expect(manager.isStreaming()).toBe(true);
    });

    it("should return true when waiting for confirmation", () => {
      manager.setState(StreamingState.WaitingForConfirmation);
      expect(manager.isStreaming()).toBe(true);
    });
  });

  describe("subscribe", () => {
    it("should notify listeners on state change", () => {
      const listener = vi.fn();
      manager.subscribe(listener);

      manager.setState(StreamingState.Responding);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(manager.getState());
    });

    it("should notify listeners on response append", () => {
      const listener = vi.fn();
      manager.subscribe(listener);

      manager.appendResponse("Hello");

      expect(listener).toHaveBeenCalled();
    });

    it("should support multiple listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      manager.subscribe(listener1);
      manager.subscribe(listener2);

      manager.setState(StreamingState.Responding);

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it("should unsubscribe correctly", () => {
      const listener = vi.fn();
      const unsubscribe = manager.subscribe(listener);

      unsubscribe();
      manager.setState(StreamingState.Responding);

      expect(listener).not.toHaveBeenCalled();
    });
  });
});

describe("StreamingContextValue Type", () => {
  it("should have correct structure", () => {
    const state: StreamingContextValue = {
      state: StreamingState.Idle,
      currentResponse: "",
      error: undefined,
      abortController: undefined,
      isThinking: false,
      thinkingCharCount: 0,
      thinkingContent: "",
      currentTool: undefined,
      toolInputCharCount: 0,
    };

    expect(state.state).toBe(StreamingState.Idle);
    expect(state.currentResponse).toBe("");
    expect(state.isThinking).toBe(false);
    expect(state.thinkingContent).toBe("");
  });

  it("should support all states", () => {
    const states: StreamingState[] = [
      StreamingState.Idle,
      StreamingState.Responding,
      StreamingState.WaitingForConfirmation,
    ];

    for (const s of states) {
      const ctx: StreamingContextValue = {
        state: s,
        currentResponse: "",
        isThinking: false,
        thinkingCharCount: 0,
        thinkingContent: "",
        toolInputCharCount: 0,
      };
      expect(ctx.state).toBe(s);
    }
  });

  it("should support thinking state fields", () => {
    const ctx: StreamingContextValue = {
      state: StreamingState.Responding,
      currentResponse: "",
      isThinking: true,
      thinkingCharCount: 100,
      thinkingContent: "Analyzing the code...",
    };

    expect(ctx.isThinking).toBe(true);
    expect(ctx.thinkingCharCount).toBe(100);
    expect(ctx.thinkingContent).toBe("Analyzing the code...");
  });

  it("should support tool state fields", () => {
    const ctx: StreamingContextValue = {
      state: StreamingState.Responding,
      currentResponse: "",
      isThinking: false,
      thinkingCharCount: 0,
      thinkingContent: "",
      currentTool: "Read",
      toolInputCharCount: 500,
    };

    expect(ctx.currentTool).toBe("Read");
    expect(ctx.toolInputCharCount).toBe(500);
  });
});

describe("StreamingActions Type", () => {
  it("should define all required actions", () => {
    // This is a type-check test
    const actions: StreamingActions = {
      startStreaming: vi.fn(),
      stopStreaming: vi.fn(),
      appendResponse: vi.fn(),
      clearResponse: vi.fn(),
      setError: vi.fn(),
      abort: vi.fn(),
      reset: vi.fn(),
      startThinking: vi.fn(),
      appendThinkingChars: vi.fn(),
      appendThinkingContent: vi.fn(),
      stopThinking: vi.fn(),
      setCurrentTool: vi.fn(),
      appendToolInputChars: vi.fn(),
    };

    expect(typeof actions.startStreaming).toBe("function");
    expect(typeof actions.stopStreaming).toBe("function");
    expect(typeof actions.appendResponse).toBe("function");
    expect(typeof actions.clearResponse).toBe("function");
    expect(typeof actions.setError).toBe("function");
    expect(typeof actions.abort).toBe("function");
    expect(typeof actions.reset).toBe("function");
    expect(typeof actions.startThinking).toBe("function");
    expect(typeof actions.appendThinkingChars).toBe("function");
    expect(typeof actions.appendThinkingContent).toBe("function");
    expect(typeof actions.stopThinking).toBe("function");
    expect(typeof actions.setCurrentTool).toBe("function");
    expect(typeof actions.appendToolInputChars).toBe("function");
  });
});

// === Thinking Feature Tests ===

describe("StreamingManager - Thinking Feature", () => {
  let manager: StreamingManager;

  beforeEach(() => {
    manager = createStreamingManager();
  });

  describe("initial thinking state", () => {
    it("should not be thinking initially", () => {
      expect(manager.getState().isThinking).toBe(false);
    });

    it("should have zero thinking char count initially", () => {
      expect(manager.getState().thinkingCharCount).toBe(0);
    });

    it("should have empty thinking content initially", () => {
      expect(manager.getState().thinkingContent).toBe("");
    });
  });

  describe("startThinking", () => {
    it("should set isThinking to true", () => {
      manager.startThinking();
      expect(manager.getState().isThinking).toBe(true);
    });

    it("should reset thinking char count to 0", () => {
      manager.appendThinkingChars(100);
      manager.startThinking();
      expect(manager.getState().thinkingCharCount).toBe(0);
    });

    it("should reset thinking content to empty", () => {
      manager.appendThinkingContent("some content");
      manager.startThinking();
      expect(manager.getState().thinkingContent).toBe("");
    });

    it("should notify listeners", () => {
      const listener = vi.fn();
      manager.subscribe(listener);
      manager.startThinking();
      expect(listener).toHaveBeenCalled();
    });
  });

  describe("appendThinkingChars", () => {
    it("should increment thinking char count", () => {
      manager.appendThinkingChars(10);
      expect(manager.getState().thinkingCharCount).toBe(10);

      manager.appendThinkingChars(5);
      expect(manager.getState().thinkingCharCount).toBe(15);
    });

    it("should set isThinking to true", () => {
      manager.appendThinkingChars(1);
      expect(manager.getState().isThinking).toBe(true);
    });

    it("should notify listeners", () => {
      const listener = vi.fn();
      manager.subscribe(listener);
      manager.appendThinkingChars(100);
      expect(listener).toHaveBeenCalled();
    });
  });

  describe("appendThinkingContent", () => {
    it("should append text to thinking content", () => {
      manager.appendThinkingContent("Thinking...");
      expect(manager.getState().thinkingContent).toBe("Thinking...");

      manager.appendThinkingContent(" More text.");
      expect(manager.getState().thinkingContent).toBe("Thinking... More text.");
    });

    it("should update thinking char count based on content length", () => {
      manager.appendThinkingContent("Hello");
      expect(manager.getState().thinkingCharCount).toBe(5);

      manager.appendThinkingContent(" World");
      expect(manager.getState().thinkingCharCount).toBe(11);
    });

    it("should set isThinking to true", () => {
      manager.appendThinkingContent("any content");
      expect(manager.getState().isThinking).toBe(true);
    });

    it("should handle empty string", () => {
      manager.appendThinkingContent("");
      expect(manager.getState().thinkingContent).toBe("");
      expect(manager.getState().thinkingCharCount).toBe(0);
    });

    it("should handle multiline content", () => {
      manager.appendThinkingContent("Line1\n");
      manager.appendThinkingContent("Line2\n");
      manager.appendThinkingContent("Line3");
      expect(manager.getState().thinkingContent).toBe("Line1\nLine2\nLine3");
      expect(manager.getState().thinkingCharCount).toBe(17);
    });

    it("should handle unicode content", () => {
      manager.appendThinkingContent("你好世界");
      expect(manager.getState().thinkingContent).toBe("你好世界");
      expect(manager.getState().thinkingCharCount).toBe(4);
    });
  });

  describe("stopThinking", () => {
    it("should set isThinking to false", () => {
      manager.startThinking();
      manager.stopThinking();
      expect(manager.getState().isThinking).toBe(false);
    });

    it("should reset thinking char count to 0", () => {
      manager.appendThinkingChars(100);
      manager.stopThinking();
      expect(manager.getState().thinkingCharCount).toBe(0);
    });

    it("should reset thinking content to empty", () => {
      manager.appendThinkingContent("some content");
      manager.stopThinking();
      expect(manager.getState().thinkingContent).toBe("");
    });

    it("should notify listeners", () => {
      const listener = vi.fn();
      manager.subscribe(listener);
      manager.startThinking();
      listener.mockClear();
      manager.stopThinking();
      expect(listener).toHaveBeenCalled();
    });
  });

  describe("thinking integration with streaming", () => {
    it("should track thinking and response separately", () => {
      manager.startThinking();
      manager.appendThinkingContent("Analyzing request...");
      manager.stopThinking();
      manager.appendResponse("Here is my response.");

      // After stopping thinking, thinking state is reset
      expect(manager.getState().isThinking).toBe(false);
      expect(manager.getState().thinkingContent).toBe("");
      expect(manager.getState().currentResponse).toBe("Here is my response.");
    });

    it("should handle multiple thinking-response cycles", () => {
      // First cycle
      manager.startThinking();
      manager.appendThinkingContent("First thought");
      manager.stopThinking();
      manager.appendResponse("First response. ");
      // Second cycle
      manager.startThinking();
      manager.appendThinkingContent("Second thought");
      manager.stopThinking();
      manager.appendResponse("Second response.");

      expect(manager.getState().currentResponse).toBe("First response. Second response.");
      expect(manager.getState().thinkingContent).toBe("");
    });
  });
});

// === Tool Feature Tests ===

describe("StreamingManager - Tool Feature", () => {
  let manager: StreamingManager;

  beforeEach(() => {
    manager = createStreamingManager();
  });

  describe("initial tool state", () => {
    it("should not have current tool initially", () => {
      expect(manager.getState().currentTool).toBeUndefined();
    });

    it("should have zero tool input char count initially", () => {
      expect(manager.getState().toolInputCharCount).toBe(0);
    });
  });

  describe("setCurrentTool", () => {
    it("should set current tool name", () => {
      manager.setCurrentTool("Read");
      expect(manager.getState().currentTool).toBe("Read");
    });

    it("should reset tool input char count to 0", () => {
      manager.appendToolInputChars(50);
      manager.setCurrentTool("Write");
      expect(manager.getState().toolInputCharCount).toBe(0);
    });

    it("should clear tool when set to undefined", () => {
      manager.setCurrentTool("Read");
      manager.setCurrentTool(undefined);
      expect(manager.getState().currentTool).toBeUndefined();
    });

    it("should notify listeners", () => {
      const listener = vi.fn();
      manager.subscribe(listener);
      manager.setCurrentTool("Bash");
      expect(listener).toHaveBeenCalled();
    });
  });

  describe("appendToolInputChars", () => {
    it("should increment tool input char count", () => {
      manager.setCurrentTool("Read");
      manager.appendToolInputChars(100);
      expect(manager.getState().toolInputCharCount).toBe(100);

      manager.appendToolInputChars(50);
      expect(manager.getState().toolInputCharCount).toBe(150);
    });

    it("should work without setting tool first", () => {
      manager.appendToolInputChars(10);
      expect(manager.getState().toolInputCharCount).toBe(10);
    });

    it("should notify listeners", () => {
      const listener = vi.fn();
      manager.subscribe(listener);
      manager.appendToolInputChars(100);
      expect(listener).toHaveBeenCalled();
    });
  });

  describe("tool integration with reset", () => {
    it("should reset tool state on reset()", () => {
      manager.setCurrentTool("Read");
      manager.appendToolInputChars(500);
      manager.reset();

      expect(manager.getState().currentTool).toBeUndefined();
      expect(manager.getState().toolInputCharCount).toBe(0);
    });
  });
});
