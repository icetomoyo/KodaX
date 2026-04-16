/**
 * MessageList Tests
 *
 * Tests for the message list component using HistoryItem types.
 * Following Gemini CLI's message display architecture.
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { render as renderInk, Box, Text } from "ink";
import { EventEmitter } from "node:events";
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
} from "../../packages/repl/src/ui/types.js";
import {
  MessageList,
  HistoryItemRenderer,
} from "../../packages/repl/src/ui/components/MessageList.js";
import { getTheme } from "../../packages/repl/src/ui/themes/index.js";
import { buildTranscriptRenderModel } from "../../packages/repl/src/ui/utils/transcript-layout.js";

// === Test Helpers ===

let idCounter = 0;
const uniqueId = () => `${Date.now()}-${++idCounter}`;
const DEFAULT_VIEWPORT_ROWS = 100;

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

class MockStdout extends EventEmitter {
  columns = 80;
  rows: number;
  frames: string[] = [];
  private currentFrame = "";

  constructor(rows: number) {
    super();
    this.rows = rows;
  }

  write = (frame: unknown) => {
    const output = String(frame);
    this.frames.push(output);
    this.currentFrame = output;
  };

  lastFrame = (): string => this.currentFrame;
}

class MockStderr extends EventEmitter {
  write = () => undefined;
}

class MockStdin extends EventEmitter {
  isTTY = true;
  setRawMode = () => undefined;
  resume = () => undefined;
  pause = () => undefined;
  ref = () => undefined;
  unref = () => undefined;
  read = () => null;
  setEncoding = () => undefined;
}

function getVisibleViewport(frame: string, rows: number): string {
  const lines = frame.split(/\r?\n/);
  return lines.slice(-rows).join("\n");
}

function splitMessageHistorySectionsForCurrentModel(items: HistoryItem[]) {
  const renderModel = buildTranscriptRenderModel({
    items,
    viewportWidth: 80,
    windowed: false,
  });
  const activeItemCount = renderModel.sections.length;
  const activeRoundStartIndex = Math.max(0, items.length - activeItemCount);

  return {
    activeRoundStartIndex,
    staticItems: items.slice(0, activeRoundStartIndex),
    activeItems: items.slice(activeRoundStartIndex),
  };
}

// === Tests ===

describe("MessageList", () => {
  describe("empty state", () => {
    it("should render empty state when no messages", () => {
      const { lastFrame } = render(<MessageList items={[]} />);

      expect(lastFrame()).toContain("No messages");
    });

    it("can transition between empty and populated states without changing hook order", () => {
      const populatedItems: HistoryItem[] = [createUserItem("Hello after empty state")];
      const { lastFrame, rerender } = render(
        <MessageList items={[]} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />
      );

      expect(lastFrame()).toContain("No messages");

      rerender(
        <MessageList
          items={populatedItems}
          viewportRows={DEFAULT_VIEWPORT_ROWS}
          viewportWidth={80}
        />
      );
      expect(lastFrame()).toContain("Hello after empty state");

      rerender(<MessageList items={[]} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);
      expect(lastFrame()).toContain("No messages");
    });
  });

  describe("single items", () => {
    it("should render user message", () => {
      const items: HistoryItem[] = [createUserItem("Hello, world!")];
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

      expect(lastFrame()).toContain("You");
      expect(lastFrame()).toContain("Hello, world!");
    });

    it("should render assistant message", () => {
      const items: HistoryItem[] = [createAssistantItem("Hello! How can I help?")];
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

      expect(lastFrame()).toContain("Assistant");
      expect(lastFrame()).toContain("Hello! How can I help?");
    });

    it("should keep the final assistant line visible without trailing newline", () => {
      const items: HistoryItem[] = [
        createAssistantItem("## 验证\n\n```bash\nmysql -h 127.0.0.1 -P 13306\n```\n\n**关键**：最后一行必须能显示"),
      ];
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

      expect(lastFrame()).toContain("**关键**：最后一行必须能显示");
    });

    it("should render streaming indicator for assistant message", () => {
      const items: HistoryItem[] = [createAssistantItem("Thinking...", true)];
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

      expect(lastFrame()).toContain("Assistant");
      expect(lastFrame()).toContain("Thinking...");
      expect(lastFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    });

    it("can suppress spinner animation while preserving the message body", () => {
      const items: HistoryItem[] = [createAssistantItem("Thinking...", true)];
      const { lastFrame } = render(
        <MessageList
          items={items}
          viewportRows={DEFAULT_VIEWPORT_ROWS}
          viewportWidth={80}
          animateSpinners={false}
        />
      );

      expect(lastFrame()).toContain("Assistant");
      expect(lastFrame()).toContain("Thinking...");
      expect(lastFrame()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    });

    it("should render thinking item with dim styling", () => {
      const items: HistoryItem[] = [createThinkingItem("Let me think about this...")];
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

      expect(lastFrame()).toContain("Thinking");
      expect(lastFrame()).toContain("Let me think about this");
    });

    it("should render error item with error styling", () => {
      const items: HistoryItem[] = [createErrorItem("Something went wrong")];
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

      expect(lastFrame()).toContain("Error");
      expect(lastFrame()).toContain("Something went wrong");
    });

    it("should render info item in the compact icon-first format", () => {
      const items: HistoryItem[] = [createInfoItem("Session started")];
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

      expect(lastFrame()).toContain("Session started");
      expect(lastFrame()).not.toContain(" Info");
    });

    it("should render hint item", () => {
      const items: HistoryItem[] = [createHintItem("Press Ctrl+C to exit")];
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

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
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

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
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

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
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

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
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

      expect(lastFrame()).toContain("delete_file");
      // Tool errors render with a generic "failed" indicator rather than the raw error message.
      expect(lastFrame()).toContain("failed");
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
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

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
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

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
      const { lastFrame } = render(<MessageList items={items} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

      expect(lastFrame()).toContain("User input");
      expect(lastFrame()).toContain("Processing");
      expect(lastFrame()).toContain("Response");
      expect(lastFrame()).toContain("Done");
    });

    it("should rerender the latest response while keeping older history static", () => {
      const initialItems: HistoryItem[] = [
        createUserItem("Prompt"),
        createAssistantItem("Old latest line"),
      ];
      const updatedItems: HistoryItem[] = [
        initialItems[0],
        { ...initialItems[1], text: "Updated latest line\nTail line" },
      ];

      const { lastFrame, rerender } = render(<MessageList items={initialItems} />);
      expect(lastFrame()).toContain("Old latest line");

      rerender(<MessageList items={updatedItems} />);

      expect(lastFrame()).toContain("Prompt");
      expect(lastFrame()).toContain("Updated latest line");
      expect(lastFrame()).toContain("Tail line");
      expect(lastFrame()).not.toContain("Old latest line");
    });

    it("keeps completed rounds stable while rerendering the active round", () => {
      const firstUser = createUserItem("Round 1 prompt");
      const firstAssistant = createAssistantItem("Round 1 answer");
      const secondUser = createUserItem("Round 2 prompt");
      const secondAssistant = createAssistantItem("Round 2 old");

      const initialItems: HistoryItem[] = [
        firstUser,
        firstAssistant,
        secondUser,
        secondAssistant,
      ];
      const updatedItems: HistoryItem[] = [
        firstUser,
        firstAssistant,
        secondUser,
        { ...secondAssistant, text: "Round 2 new\nRound 2 tail" },
      ];

      const { lastFrame, rerender } = render(
        <MessageList items={initialItems} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />
      );

      rerender(<MessageList items={updatedItems} viewportRows={DEFAULT_VIEWPORT_ROWS} viewportWidth={80} />);

      const output = lastFrame() ?? "";
      expect(output).toContain("Round 1 prompt");
      expect(output).toContain("Round 1 answer");
      expect(output).toContain("Round 2 prompt");
      expect(output).toContain("Round 2 new");
      expect(output).toContain("Round 2 tail");
      expect(output).not.toContain("Round 2 old");
      expect(output.match(/Round 1 answer/g)?.length ?? 0).toBe(1);
    });

    it("splits completed rounds from the active round at the last user message", () => {
      const firstUser = createUserItem("Round 1 prompt");
      const firstAssistant = createAssistantItem("Round 1 answer");
      const secondUser = createUserItem("Round 2 prompt");
      const secondThinking = createThinkingItem("Round 2 thinking");
      const secondAssistant = createAssistantItem("Round 2 answer");

      const sections = splitMessageHistorySectionsForCurrentModel([
        firstUser,
        firstAssistant,
        secondUser,
        secondThinking,
        secondAssistant,
      ]);

      expect(sections.activeRoundStartIndex).toBe(2);
      expect(sections.staticItems).toEqual([firstUser, firstAssistant]);
      expect(sections.activeItems).toEqual([secondUser, secondThinking, secondAssistant]);
    });

    it("keeps all items active when there is no user boundary", () => {
      const thinking = createThinkingItem("Standalone thinking");
      const assistant = createAssistantItem("Standalone answer");

      const sections = splitMessageHistorySectionsForCurrentModel([thinking, assistant]);

      expect(sections.activeRoundStartIndex).toBe(0);
      expect(sections.staticItems).toEqual([]);
      expect(sections.activeItems).toEqual([thinking, assistant]);
    });
  });

  describe("loading state", () => {
    it("should show loading indicator when isLoading is true", () => {
      const items: HistoryItem[] = [createUserItem("Hello")];
      const { lastFrame } = render(<MessageList items={items} isLoading={true} />);

      expect(lastFrame()).toMatch(/Thinking|Loading/);
    });
  });

  describe("fixed footer layout", () => {
    it("keeps the latest assistant tail line visible above the footer in the viewport", async () => {
      const rows = 12;
      const stdout = new MockStdout(rows);
      const items: HistoryItem[] = [
        createUserItem("Prompt"),
        createAssistantItem(["a", "b", "c", "d", "e", "f", "g", "tail line"].join("\n")),
      ];

      const App = () => (
        <Box flexDirection="column" width={80} height={rows}>
          <Box flexDirection="column" flexGrow={1} overflowY="hidden">
            <MessageList items={items} viewportRows={rows - 3} viewportWidth={80} />
          </Box>
          <Box flexDirection="column" flexShrink={0}>
            <Text>{"> input"}</Text>
            <Text>status</Text>
            <Text>footer</Text>
          </Box>
        </Box>
      );

      const instance = renderInk(<App />, {
        stdout: stdout as never,
        stderr: new MockStderr() as never,
        stdin: new MockStdin() as never,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const visibleFrame = getVisibleViewport(stdout.lastFrame(), rows);
      expect(visibleFrame).toContain("tail line");
      expect(visibleFrame).toContain("> input");
      expect(visibleFrame).toContain("footer");

      instance.unmount();
      instance.cleanup();
    });
  });

  it("keeps completed rounds visible outside the windowed review mode", () => {
    const items: HistoryItem[] = [
      createUserItem("Round 1 prompt"),
      createAssistantItem("Round 1 answer"),
      createUserItem("Round 2 prompt"),
      createAssistantItem(["Round 2 line 1", "Round 2 line 2", "Round 2 tail"].join("\n")),
    ];

    const { lastFrame } = render(
      <MessageList
        items={items}
        viewportRows={4}
        viewportWidth={80}
        animateSpinners={false}
      />
    );

    const output = lastFrame() ?? "";
    expect(output).toContain("Round 1 prompt");
    expect(output).toContain("Round 1 answer");
    expect(output).toContain("Round 2 tail");
  });

  it("keeps the full active round visible outside windowed review mode", () => {
    const items: HistoryItem[] = [
      createUserItem("Prompt"),
      createAssistantItem(["line 1", "line 2", "line 3", "line 4", "line 5", "tail"].join("\n")),
    ];

    const { lastFrame } = render(
      <MessageList
        items={items}
        viewportRows={4}
        viewportWidth={80}
        animateSpinners={false}
      />
    );

    const output = lastFrame() ?? "";
    expect(output).toContain("line 1");
    expect(output).toContain("line 3");
    expect(output).toContain("tail");
  });

  describe("review scrolling", () => {
    it("renders an older slice when scrollOffset is set", () => {
      const items: HistoryItem[] = [
        createUserItem("Round 1"),
        createAssistantItem(["a", "b", "c", "d", "e", "tail"].join("\n")),
      ];

      const { lastFrame } = render(
        <MessageList
          items={items}
          viewportRows={4}
          viewportWidth={80}
          scrollOffset={3}
          animateSpinners={false}
          windowed={true}
        />
      );

      const output = lastFrame() ?? "";
      expect(output).toContain("b");
      expect(output).toContain("c");
      expect(output).not.toContain("tail");
    });

    it("preserves the frozen thinking block while review mode is windowed", () => {
      const items: HistoryItem[] = [createUserItem("Round 1")];

      const { lastFrame } = render(
        <MessageList
          items={items}
          isLoading={true}
          isThinking={true}
          thinkingCharCount={120}
          thinkingContent={"first thought\nsecond thought"}
          viewportRows={6}
          viewportWidth={80}
          animateSpinners={false}
          windowed={true}
        />
      );

      const output = lastFrame() ?? "";
      expect(output).toContain("Thinking");
      expect(output).toContain("first thought");
      expect(output).toContain("second thought");
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
      icon: "i",
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

  it("can transition between implicit and explicit themes without changing hook order", () => {
    const item = createAssistantItem("Theme-safe assistant message");
    const theme = getTheme("dark");
    const { lastFrame, rerender } = render(<HistoryItemRenderer item={item} />);

    expect(lastFrame()).toContain("Theme-safe assistant message");

    rerender(<HistoryItemRenderer item={item} theme={theme} />);
    expect(lastFrame()).toContain("Theme-safe assistant message");

    rerender(<HistoryItemRenderer item={item} />);
    expect(lastFrame()).toContain("Theme-safe assistant message");
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
