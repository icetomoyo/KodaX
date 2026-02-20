/**
 * MessageList Tests
 *
 * Tests for the message list component using HistoryItem types.
 * Following Gemini CLI's message display architecture.
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import {
  ToolCallStatus,
  type HistoryItem,
  type HistoryItemUser,
  type HistoryItemAssistant,
  type HistoryItemToolGroup,
  type HistoryItemThinking,
  type HistoryItemError,
  type HistoryItemInfo,
  type HistoryItemHint,
  type ToolCall,
} from "../../src/ui/types.js";
import { MessageList, HistoryItemRenderer } from "../../src/ui/components/MessageList.js";

// === Test Helpers ===

let idCounter = 0;
const uniqueId = () => `${Date.now()}-${++idCounter}`;

const createUserItem = (text: string): HistoryItemUser => ({
  id: `user-${uniqueId()}`,
  type: "user",
  text,
  timestamp: Date.now(),
});

const createAssistantItem = (text: string, isStreaming = false): HistoryItemAssistant => ({
  id: `assistant-${uniqueId()}`,
  type: "assistant",
  text,
  timestamp: Date.now(),
  isStreaming,
});

const createToolGroup = (tools: ToolCall[]): HistoryItemToolGroup => ({
  id: `tool-group-${uniqueId()}`,
  type: "tool_group",
  tools,
  timestamp: Date.now(),
});

const createThinkingItem = (text: string): HistoryItemThinking => ({
  id: `thinking-${uniqueId()}`,
  type: "thinking",
  text,
  timestamp: Date.now(),
});

const createErrorItem = (text: string): HistoryItemError => ({
  id: `error-${uniqueId()}`,
  type: "error",
  text,
  timestamp: Date.now(),
});

const createInfoItem = (text: string): HistoryItemInfo => ({
  id: `info-${uniqueId()}`,
  type: "info",
  text,
  timestamp: Date.now(),
});

const createHintItem = (text: string): HistoryItemHint => ({
  id: `hint-${uniqueId()}`,
  type: "hint",
  text,
  timestamp: Date.now(),
});

// === Tests ===

describe("MessageList", () => {
  describe("empty state", () => {
    it("should render empty state when no messages", () => {
      const { lastFrame } = render(<MessageList items={[]} />);

      expect(lastFrame()).toContain("No messages");
    });
  });

  describe("single items", () => {
    it("should render user message", () => {
      const items: HistoryItem[] = [createUserItem("Hello, world!")];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("You");
      expect(lastFrame()).toContain("Hello, world!");
    });

    it("should render assistant message", () => {
      const items: HistoryItem[] = [createAssistantItem("Hello! How can I help?")];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("Assistant");
      expect(lastFrame()).toContain("Hello! How can I help?");
    });

    it("should render streaming indicator for assistant message", () => {
      const items: HistoryItem[] = [createAssistantItem("Thinking...", true)];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("Assistant");
      expect(lastFrame()).toContain("Thinking...");
      // Should show streaming indicator (spinner frames: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
      expect(lastFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    });

    it("should render thinking item with dim styling", () => {
      const items: HistoryItem[] = [createThinkingItem("Let me think about this...")];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("Thinking");
      expect(lastFrame()).toContain("Let me think about this");
    });

    it("should render error item with error styling", () => {
      const items: HistoryItem[] = [createErrorItem("Something went wrong")];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("Error");
      expect(lastFrame()).toContain("Something went wrong");
    });

    it("should render info item", () => {
      const items: HistoryItem[] = [createInfoItem("Session started")];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("Info");
      expect(lastFrame()).toContain("Session started");
    });

    it("should render hint item", () => {
      const items: HistoryItem[] = [createHintItem("Press Ctrl+C to exit")];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("Hint");
      expect(lastFrame()).toContain("Press Ctrl+C to exit");
    });
  });

  describe("tool group", () => {
    it("should render tool group with scheduled status", () => {
      const tool: ToolCall = {
        id: "tool-1",
        name: "read_file",
        status: ToolCallStatus.Scheduled,
        startTime: Date.now(),
      };
      const items: HistoryItem[] = [createToolGroup([tool])];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("read_file");
    });

    it("should render tool group with executing status", () => {
      const tool: ToolCall = {
        id: "tool-1",
        name: "write_file",
        status: ToolCallStatus.Executing,
        input: { path: "/test.txt" },
        progress: 50,
        startTime: Date.now(),
      };
      const items: HistoryItem[] = [createToolGroup([tool])];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("write_file");
      expect(lastFrame()).toContain("50%");
    });

    it("should render tool group with success status", () => {
      const tool: ToolCall = {
        id: "tool-1",
        name: "read_file",
        status: ToolCallStatus.Success,
        startTime: Date.now(),
        endTime: Date.now() + 100,
      };
      const items: HistoryItem[] = [createToolGroup([tool])];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("read_file");
    });

    it("should render tool group with error status", () => {
      const tool: ToolCall = {
        id: "tool-1",
        name: "delete_file",
        status: ToolCallStatus.Error,
        error: "Permission denied",
        startTime: Date.now(),
      };
      const items: HistoryItem[] = [createToolGroup([tool])];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("delete_file");
      expect(lastFrame()).toContain("Permission denied");
    });

    it("should render multiple tools in group", () => {
      const tools: ToolCall[] = [
        {
          id: "tool-1",
          name: "read_file",
          status: ToolCallStatus.Success,
          startTime: Date.now(),
        },
        {
          id: "tool-2",
          name: "write_file",
          status: ToolCallStatus.Executing,
          progress: 75,
          startTime: Date.now(),
        },
      ];
      const items: HistoryItem[] = [createToolGroup(tools)];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("read_file");
      expect(lastFrame()).toContain("write_file");
    });
  });

  describe("multiple items", () => {
    it("should render multiple items in order", () => {
      const items: HistoryItem[] = [
        createUserItem("First"),
        createAssistantItem("Second"),
        createUserItem("Third"),
      ];
      const { lastFrame } = render(<MessageList items={items} />);

      const output = lastFrame() ?? "";
      const firstIndex = output.indexOf("First");
      const secondIndex = output.indexOf("Second");
      const thirdIndex = output.indexOf("Third");

      expect(firstIndex).toBeLessThan(secondIndex);
      expect(secondIndex).toBeLessThan(thirdIndex);
    });

    it("should handle mixed item types", () => {
      const items: HistoryItem[] = [
        createUserItem("User input"),
        createThinkingItem("Processing..."),
        createAssistantItem("Response"),
        createInfoItem("Done"),
      ];
      const { lastFrame } = render(<MessageList items={items} />);

      expect(lastFrame()).toContain("User input");
      expect(lastFrame()).toContain("Processing");
      expect(lastFrame()).toContain("Response");
      expect(lastFrame()).toContain("Done");
    });
  });

  describe("loading state", () => {
    it("should show loading indicator when isLoading is true", () => {
      const items: HistoryItem[] = [createUserItem("Hello")];
      const { lastFrame } = render(<MessageList items={items} isLoading={true} />);

      expect(lastFrame()).toMatch(/Thinking|Loading|…/);
    });
  });
});

describe("HistoryItemRenderer", () => {
  it("should render user item", () => {
    const item = createUserItem("Test user message");
    const { lastFrame } = render(<HistoryItemRenderer item={item} />);

    expect(lastFrame()).toContain("Test user message");
  });

  it("should render assistant item", () => {
    const item = createAssistantItem("Test assistant message");
    const { lastFrame } = render(<HistoryItemRenderer item={item} />);

    expect(lastFrame()).toContain("Test assistant message");
  });

  it("should render thinking item", () => {
    const item = createThinkingItem("Deep thoughts");
    const { lastFrame } = render(<HistoryItemRenderer item={item} />);

    expect(lastFrame()).toContain("Deep thoughts");
  });

  it("should render error item", () => {
    const item = createErrorItem("Test error");
    const { lastFrame } = render(<HistoryItemRenderer item={item} />);

    expect(lastFrame()).toContain("Test error");
  });

  it("should render info item with icon", () => {
    const item: HistoryItemInfo = {
      id: "info-1",
      type: "info",
      text: "Info message",
      icon: "ℹ",
      timestamp: Date.now(),
    };
    const { lastFrame } = render(<HistoryItemRenderer item={item} />);

    expect(lastFrame()).toContain("Info message");
  });

  it("should render hint item", () => {
    const item = createHintItem("Tip: use arrows");
    const { lastFrame } = render(<HistoryItemRenderer item={item} />);

    expect(lastFrame()).toContain("Tip: use arrows");
  });
});

// === Type Tests ===

describe("HistoryItem Types", () => {
  it("should have correct type discrimination for user", () => {
    const item: HistoryItem = createUserItem("test");
    expect(item.type).toBe("user");
  });

  it("should have correct type discrimination for assistant", () => {
    const item: HistoryItem = createAssistantItem("test");
    expect(item.type).toBe("assistant");
  });

  it("should have correct type discrimination for tool_group", () => {
    const item: HistoryItem = createToolGroup([]);
    expect(item.type).toBe("tool_group");
  });
});
