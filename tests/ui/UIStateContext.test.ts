/**
 * UIStateContext Tests
 *
 * Tests for the global UI state management context.
 * Following Gemini CLI's architecture pattern.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  StreamingState,
  ToolCallStatus,
  type ToolCall,
  type HistoryItem,
  type HistoryItemUser,
  type HistoryItemAssistant,
  type HistoryItemToolGroup,
  type UIState,
  DEFAULT_UI_STATE,
} from "../../src/ui/types.js";
import {
  generateId,
  createHistoryItem,
  createToolCall,
} from "../../src/ui/contexts/UIStateContext.js";

// === Test Constants ===

const createMockState = (): UIState => ({
  ...DEFAULT_UI_STATE,
  sessionId: "test-session",
  provider: "test-provider",
  model: "test-model",
});

// === Tests ===

describe("UIState Types", () => {
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

  describe("ToolCallStatus", () => {
    it("should have all required statuses", () => {
      const statuses = [
        ToolCallStatus.Scheduled,
        ToolCallStatus.Validating,
        ToolCallStatus.AwaitingApproval,
        ToolCallStatus.Executing,
        ToolCallStatus.Success,
        ToolCallStatus.Error,
        ToolCallStatus.Cancelled,
      ];

      expect(statuses).toHaveLength(7);
      expect(ToolCallStatus.Scheduled).toBe("scheduled");
      expect(ToolCallStatus.Success).toBe("success");
      expect(ToolCallStatus.Error).toBe("error");
    });
  });

  describe("HistoryItem types", () => {
    it("should create user history item", () => {
      const item: HistoryItemUser = {
        id: "1",
        type: "user",
        text: "Hello",
        timestamp: Date.now(),
      };

      expect(item.type).toBe("user");
      expect(item.text).toBe("Hello");
    });

    it("should create assistant history item with streaming flag", () => {
      const item: HistoryItemAssistant = {
        id: "2",
        type: "assistant",
        text: "Hi there!",
        timestamp: Date.now(),
        isStreaming: true,
      };

      expect(item.type).toBe("assistant");
      expect(item.isStreaming).toBe(true);
    });

    it("should create tool group history item", () => {
      const toolCall: ToolCall = {
        id: "tool-1",
        name: "read_file",
        status: ToolCallStatus.Success,
        startTime: Date.now(),
      };

      const item: HistoryItemToolGroup = {
        id: "3",
        type: "tool_group",
        tools: [toolCall],
        timestamp: Date.now(),
      };

      expect(item.type).toBe("tool_group");
      expect(item.tools).toHaveLength(1);
      expect(item.tools[0]?.name).toBe("read_file");
    });
  });

  describe("UIState", () => {
    it("should have required fields", () => {
      const state = createMockState();

      expect(state.streamingState).toBeDefined();
      expect(state.currentResponse).toBeDefined();
      expect(state.history).toBeDefined();
      expect(state.pendingToolCalls).toBeDefined();
      expect(state.sessionId).toBeDefined();
      expect(state.mode).toBeDefined();
    });

    it("should have optional tokenUsage", () => {
      const state: UIState = {
        ...createMockState(),
        tokenUsage: { input: 100, output: 50, total: 150 },
      };

      expect(state.tokenUsage).toBeDefined();
      expect(state.tokenUsage?.total).toBe(150);
    });
  });

  describe("DEFAULT_UI_STATE", () => {
    it("should have default values", () => {
      expect(DEFAULT_UI_STATE.streamingState).toBe(StreamingState.Idle);
      expect(DEFAULT_UI_STATE.currentResponse).toBe("");
      expect(DEFAULT_UI_STATE.history).toEqual([]);
      expect(DEFAULT_UI_STATE.pendingToolCalls).toEqual([]);
      expect(DEFAULT_UI_STATE.isLoading).toBe(false);
    });
  });
});

describe("Helper Functions", () => {
  describe("generateId", () => {
    it("should generate unique IDs", () => {
      const id1 = generateId();
      const id2 = generateId();

      expect(id1).not.toBe(id2);
      expect(id1.length).toBeGreaterThan(0);
    });

    it("should generate IDs with timestamp", () => {
      const before = Date.now();
      const id = generateId();
      const timestamp = parseInt(id.split("-")[0] ?? "0", 10);

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("createHistoryItem", () => {
    it("should create item with auto-generated id", () => {
      const item = createHistoryItem({ type: "user", text: "Test" });

      expect(item.id).toBeDefined();
      expect(item.id.length).toBeGreaterThan(0);
    });

    it("should create item with auto-generated timestamp", () => {
      const before = Date.now();
      const item = createHistoryItem({ type: "user", text: "Test" });
      const after = Date.now();

      expect(item.timestamp).toBeGreaterThanOrEqual(before);
      expect(item.timestamp).toBeLessThanOrEqual(after);
    });

    it("should preserve item type and content", () => {
      const item = createHistoryItem({ type: "assistant", text: "Response" });

      expect(item.type).toBe("assistant");
      expect((item as HistoryItemAssistant).text).toBe("Response");
    });
  });

  describe("createToolCall", () => {
    it("should create tool call with auto-generated id", () => {
      const tool = createToolCall({
        name: "test_tool",
        status: ToolCallStatus.Scheduled,
      });

      expect(tool.id).toBeDefined();
      expect(tool.startTime).toBeDefined();
    });

    it("should preserve tool properties", () => {
      const tool = createToolCall({
        name: "read_file",
        status: ToolCallStatus.Executing,
        input: { path: "/test.txt" },
        progress: 50,
      });

      expect(tool.name).toBe("read_file");
      expect(tool.status).toBe(ToolCallStatus.Executing);
      expect(tool.input).toEqual({ path: "/test.txt" });
      expect(tool.progress).toBe(50);
    });
  });
});

describe("UIState Reducer Functions", () => {
  /**
   * Simple state reducer for testing (duplicated from implementation for unit testing)
   */
  type UIAction =
    | { type: "SET_STREAMING_STATE"; payload: StreamingState }
    | { type: "APPEND_TO_RESPONSE"; payload: string }
    | { type: "CLEAR_RESPONSE" }
    | { type: "ADD_HISTORY_ITEM"; payload: HistoryItem }
    | { type: "SET_ERROR"; payload: string | undefined }
    | { type: "SET_LOADING"; payload: boolean };

  function uiReducer(state: UIState, action: UIAction): UIState {
    switch (action.type) {
      case "SET_STREAMING_STATE":
        return { ...state, streamingState: action.payload };
      case "APPEND_TO_RESPONSE":
        return { ...state, currentResponse: state.currentResponse + action.payload };
      case "CLEAR_RESPONSE":
        return { ...state, currentResponse: "" };
      case "ADD_HISTORY_ITEM":
        return { ...state, history: [...state.history, action.payload] };
      case "SET_ERROR":
        return { ...state, error: action.payload };
      case "SET_LOADING":
        return { ...state, isLoading: action.payload };
      default:
        return state;
    }
  }

  let state: UIState;

  beforeEach(() => {
    state = createMockState();
  });

  describe("SET_STREAMING_STATE", () => {
    it("should update streaming state", () => {
      const newState = uiReducer(state, {
        type: "SET_STREAMING_STATE",
        payload: StreamingState.Responding,
      });

      expect(newState.streamingState).toBe(StreamingState.Responding);
    });

    it("should not mutate original state", () => {
      const originalState = { ...state };
      uiReducer(state, { type: "SET_STREAMING_STATE", payload: StreamingState.Responding });

      expect(state.streamingState).toBe(originalState.streamingState);
    });
  });

  describe("APPEND_TO_RESPONSE", () => {
    it("should append text to current response", () => {
      const state1 = uiReducer(state, { type: "APPEND_TO_RESPONSE", payload: "Hello" });
      const state2 = uiReducer(state1, { type: "APPEND_TO_RESPONSE", payload: " World" });

      expect(state2.currentResponse).toBe("Hello World");
    });

    it("should handle empty initial response", () => {
      const newState = uiReducer(state, { type: "APPEND_TO_RESPONSE", payload: "First" });

      expect(newState.currentResponse).toBe("First");
    });
  });

  describe("CLEAR_RESPONSE", () => {
    it("should clear current response", () => {
      const stateWithResponse = { ...state, currentResponse: "Some text" };
      const newState = uiReducer(stateWithResponse, { type: "CLEAR_RESPONSE" });

      expect(newState.currentResponse).toBe("");
    });
  });

  describe("ADD_HISTORY_ITEM", () => {
    it("should add item to history", () => {
      const item: HistoryItemUser = {
        id: "1",
        type: "user",
        text: "Test message",
        timestamp: Date.now(),
      };

      const newState = uiReducer(state, { type: "ADD_HISTORY_ITEM", payload: item });

      expect(newState.history).toHaveLength(1);
      expect(newState.history[0]).toEqual(item);
    });

    it("should append to existing history", () => {
      const item1: HistoryItemUser = {
        id: "1",
        type: "user",
        text: "First",
        timestamp: Date.now(),
      };
      const item2: HistoryItemAssistant = {
        id: "2",
        type: "assistant",
        text: "Second",
        timestamp: Date.now(),
      };

      let newState = uiReducer(state, { type: "ADD_HISTORY_ITEM", payload: item1 });
      newState = uiReducer(newState, { type: "ADD_HISTORY_ITEM", payload: item2 });

      expect(newState.history).toHaveLength(2);
    });
  });

  describe("SET_ERROR", () => {
    it("should set error message", () => {
      const newState = uiReducer(state, {
        type: "SET_ERROR",
        payload: "Something went wrong",
      });

      expect(newState.error).toBe("Something went wrong");
    });

    it("should clear error when set to undefined", () => {
      const stateWithError = { ...state, error: "Previous error" };
      const newState = uiReducer(stateWithError, {
        type: "SET_ERROR",
        payload: undefined,
      });

      expect(newState.error).toBeUndefined();
    });
  });

  describe("SET_LOADING", () => {
    it("should set loading state", () => {
      const newState = uiReducer(state, { type: "SET_LOADING", payload: true });
      expect(newState.isLoading).toBe(true);

      const newState2 = uiReducer(newState, { type: "SET_LOADING", payload: false });
      expect(newState2.isLoading).toBe(false);
    });
  });
});
