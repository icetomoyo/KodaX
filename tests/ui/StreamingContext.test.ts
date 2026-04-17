/**
 * StreamingContext Tests
 *
 * Tests for the streaming response handling context.
 * Following Gemini CLI's StreamingContext architecture.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StreamingState } from "@kodax/repl";
import {
  type StreamingContextValue,
  type StreamingActions,
  createStreamingManager,
  type StreamingManager,
} from "@kodax/repl";

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
      // Use getFullResponse() to include pending buffered content (async flush mechanism)
      expect(manager.getFullResponse()).toBe("Hello");

      manager.appendResponse(" World");
      expect(manager.getFullResponse()).toBe("Hello World");
    });

    it("should handle empty string", () => {
      manager.appendResponse("");
      expect(manager.getFullResponse()).toBe("");
    });

    it("should handle special characters", () => {
      manager.appendResponse("Line1\n");
      manager.appendResponse("Line2\r\n");
      manager.appendResponse("Line3");
      expect(manager.getFullResponse()).toBe("Line1\nLine2\r\nLine3");
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

    it("should clear queued follow-ups after abort", () => {
      manager.startStreaming();
      manager.addPendingInput("queued");

      manager.abort();

      expect(manager.getState().pendingInputs).toEqual([]);
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

    it("should notify listeners on response append (via flush)", () => {
      const listener = vi.fn();
      manager.subscribe(listener);

      manager.appendResponse("Hello");

      // appendResponse uses batched update (scheduleFlush with 80ms delay)
      // Listener is not called immediately - need to trigger flush
      expect(listener).not.toHaveBeenCalled();

      // Trigger flush by calling a method that flushes before its action
      manager.stopStreaming();

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

  describe("pending input queue", () => {
    it("should queue trimmed inputs in FIFO order", () => {
      manager.addPendingInput("  first task  ");
      manager.addPendingInput("second task");

      expect(manager.getState().pendingInputs).toEqual(["first task", "second task"]);
    });

    it("should ignore empty queued input", () => {
      manager.addPendingInput("   ");
      expect(manager.getState().pendingInputs).toEqual([]);
    });

    it("should cap queued inputs at five items", () => {
      for (let i = 1; i <= 6; i++) {
        manager.addPendingInput(`item ${i}`);
      }

      expect(manager.getState().pendingInputs).toEqual([
        "item 1",
        "item 2",
        "item 3",
        "item 4",
        "item 5",
      ]);
    });

    it("should remove the last queued input", () => {
      manager.addPendingInput("first");
      manager.addPendingInput("second");
      manager.removeLastPendingInput();

      expect(manager.getState().pendingInputs).toEqual(["first"]);
    });

    it("should shift the next queued input in FIFO order", () => {
      manager.addPendingInput("first");
      manager.addPendingInput("second");

      expect(manager.shiftPendingInput()).toBe("first");
      expect(manager.getState().pendingInputs).toEqual(["second"]);
    });

    it("should consume queued inputs and clear the queue", () => {
      manager.addPendingInput("first");
      manager.addPendingInput("second");

      expect(manager.consumePendingInputs()).toEqual(["first", "second"]);
      expect(manager.getState().pendingInputs).toEqual([]);
    });

    it("should clear queued inputs on reset", () => {
      manager.addPendingInput("queued");
      manager.reset();

      expect(manager.getState().pendingInputs).toEqual([]);
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
      toolInputContent: "",
      iterationHistory: [],
      currentIteration: 1,
      maxIter: 200,
      isCompacting: false,
      pendingInputs: [],
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
        toolInputContent: "",
        iterationHistory: [],
        currentIteration: 1,
        maxIter: 200,
        isCompacting: false,
        pendingInputs: [],
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
      toolInputCharCount: 0,
      toolInputContent: "",
      iterationHistory: [],
      currentIteration: 1,
      maxIter: 200,
      isCompacting: false,
      pendingInputs: [],
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
      toolInputContent: "",
      iterationHistory: [],
      currentIteration: 1,
      maxIter: 200,
      isCompacting: false,
      pendingInputs: [],
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
      clearThinkingContent: vi.fn(),
      setCurrentTool: vi.fn(),
      appendToolInputChars: vi.fn(),
      appendToolInputContent: vi.fn(),
      clearToolInputContent: vi.fn(),
      getSignal: vi.fn(),
      getFullResponse: vi.fn(() => ""),
      getThinkingContent: vi.fn(() => ""),
      startNewIteration: vi.fn(),
      clearIterationHistory: vi.fn(),
      setMaxIter: vi.fn(),
      startCompacting: vi.fn(),
      stopCompacting: vi.fn(),
      addPendingInput: vi.fn(),
      removeLastPendingInput: vi.fn(),
      shiftPendingInput: vi.fn(() => undefined),
      clearPendingInputs: vi.fn(),
      consumePendingInputs: vi.fn(() => []),
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
    expect(typeof actions.clearThinkingContent).toBe("function");
    expect(typeof actions.setCurrentTool).toBe("function");
    expect(typeof actions.appendToolInputChars).toBe("function");
    expect(typeof actions.addPendingInput).toBe("function");
    expect(typeof actions.shiftPendingInput).toBe("function");
    expect(typeof actions.consumePendingInputs).toBe("function");
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
    // appendThinkingChars is batched (same flush window as thinking/response
    // text) to reduce setState churn during streaming. Tests use fake timers
    // to advance past the flush interval before asserting.
    it("should increment thinking char count after flush", () => {
      vi.useFakeTimers();
      try {
        const m = createStreamingManager();
        m.appendThinkingChars(10);
        m.appendThinkingChars(5);
        vi.advanceTimersByTime(100);
        expect(m.getState().thinkingCharCount).toBe(15);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should set isThinking to true after flush", () => {
      vi.useFakeTimers();
      try {
        const m = createStreamingManager();
        m.appendThinkingChars(1);
        vi.advanceTimersByTime(100);
        expect(m.getState().isThinking).toBe(true);
        expect(m.getState().thinkingCharCount).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should notify listeners after flush", () => {
      vi.useFakeTimers();
      try {
        const m = createStreamingManager();
        const listener = vi.fn();
        m.subscribe(listener);
        m.appendThinkingChars(100);
        vi.advanceTimersByTime(100);
        expect(listener).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("appendThinkingContent", () => {
    it("should append text to thinking content", () => {
      manager.appendThinkingContent("Thinking...");
      manager.stopThinking(); // Flush pending updates before checking
      expect(manager.getState().thinkingContent).toBe("Thinking...");

      // Note: startThinking() clears thinkingContent, so second append starts fresh
      manager.startThinking();
      manager.appendThinkingContent("More text.");
      manager.stopThinking(); // Flush pending updates before checking
      expect(manager.getState().thinkingContent).toBe("More text.");
    });

    it("should update thinking char count based on content length", () => {
      manager.appendThinkingContent("Hello");
      // Char count is tracked internally, but reset to 0 on stopThinking()
      // Use content.length after stopThinking() to verify
      manager.stopThinking();
      expect(manager.getState().thinkingContent.length).toBe(5);

      // Note: startThinking() clears thinkingContent, so second cycle starts fresh
      manager.startThinking();
      manager.appendThinkingContent(" World");
      manager.stopThinking();
      expect(manager.getState().thinkingContent.length).toBe(6); // Only " World" (startThinking clears previous content)
    });

    it("should not immediately set isThinking to true (batched update)", () => {
      // appendThinkingContent uses batched update via scheduleFlush()
      // isThinking is not immediately set until flush or startThinking() is called
      manager.appendThinkingContent("any content");
      // State is not immediately updated due to batching
      expect(manager.getState().isThinking).toBe(false);
      // After flush (via stopThinking), content is visible but isThinking is false
      manager.stopThinking();
      expect(manager.getState().isThinking).toBe(false);
      expect(manager.getState().thinkingContent).toBe("any content");
    });

    it("should handle empty string", () => {
      manager.appendThinkingContent("");
      manager.stopThinking(); // Flush pending updates before checking
      expect(manager.getState().thinkingContent).toBe("");
      expect(manager.getState().thinkingContent.length).toBe(0);
    });

    it("should handle multiline content", () => {
      manager.appendThinkingContent("Line1\n");
      manager.appendThinkingContent("Line2\n");
      manager.appendThinkingContent("Line3");
      manager.stopThinking(); // Flush pending updates before checking
      expect(manager.getState().thinkingContent).toBe("Line1\nLine2\nLine3");
      expect(manager.getState().thinkingContent.length).toBe(17);
    });

    it("should handle unicode content", () => {
      manager.appendThinkingContent("你好世界");
      manager.stopThinking(); // Flush pending updates before checking
      expect(manager.getState().thinkingContent).toBe("你好世界");
      expect(manager.getState().thinkingContent.length).toBe(4);
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

    it("should preserve thinking content for display (not clear on stop)", () => {
      manager.appendThinkingContent("some content");
      manager.stopThinking();
      // Implementation preserves thinkingContent for display after stopThinking()
      expect(manager.getState().thinkingContent).toBe("some content");
    });

    it("should clear thinking content with clearThinkingContent()", () => {
      manager.appendThinkingContent("some content");
      manager.stopThinking();
      manager.clearThinkingContent();
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

      // After stopping thinking, thinking state is reset but content is preserved
      expect(manager.getState().isThinking).toBe(false);
      expect(manager.getState().thinkingContent).toBe("Analyzing request..."); // preserved for display
      // Use getFullResponse() to include pending buffered content (async flush mechanism)
      expect(manager.getFullResponse()).toBe("Here is my response.");
    });

    it("should handle multiple thinking-response cycles with clearThinkingContent", () => {
      // First cycle
      manager.startThinking();
      manager.appendThinkingContent("First thought");
      manager.stopThinking();
      manager.clearThinkingContent(); // explicitly clear after displaying
      manager.appendResponse("First response. ");
      // Second cycle
      manager.startThinking();
      manager.appendThinkingContent("Second thought");
      manager.stopThinking();
      manager.appendResponse("Second response.");

      // Use getFullResponse() to include pending buffered content (async flush mechanism)
      expect(manager.getFullResponse()).toBe("First response. Second response.");
      // Second thought is preserved
      expect(manager.getState().thinkingContent).toBe("Second thought");
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
