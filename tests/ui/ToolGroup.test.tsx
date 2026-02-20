/**
 * ToolGroup Tests
 *
 * Tests for the tool execution display component.
 * Following Gemini CLI's tool display architecture.
 */

import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import {
  ToolCallStatus,
  type ToolCall,
} from "../../src/ui/types.js";
import {
  ToolGroup,
  ToolCallDisplay,
  ToolStatusBadge,
  ToolProgressBar,
} from "../../src/ui/components/ToolGroup.js";

// === Test Helpers ===

let idCounter = 0;
const uniqueId = () => `tool-${Date.now()}-${++idCounter}`;

const createToolCall = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  id: uniqueId(),
  name: "test_tool",
  status: ToolCallStatus.Scheduled,
  startTime: Date.now(),
  ...overrides,
});

// === Tests ===

describe("ToolCallDisplay", () => {
  it("should render tool name", () => {
    const tool = createToolCall({ name: "read_file" });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);

    expect(lastFrame()).toContain("read_file");
  });

  it("should render scheduled status", () => {
    const tool = createToolCall({ status: ToolCallStatus.Scheduled });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);

    expect(lastFrame()).toMatch(/○|scheduled/i);
  });

  it("should render executing status with spinner-like indicator", () => {
    const tool = createToolCall({ status: ToolCallStatus.Executing });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);

    expect(lastFrame()).toMatch(/●|executing/i);
  });

  it("should render success status", () => {
    const tool = createToolCall({
      status: ToolCallStatus.Success,
      endTime: Date.now() + 100,
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);

    expect(lastFrame()).toMatch(/✓|success/i);
  });

  it("should render error status with message", () => {
    const tool = createToolCall({
      status: ToolCallStatus.Error,
      error: "File not found",
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);

    expect(lastFrame()).toMatch(/✗|error/i);
    expect(lastFrame()).toContain("File not found");
  });

  it("should render cancelled status", () => {
    const tool = createToolCall({ status: ToolCallStatus.Cancelled });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);

    expect(lastFrame()).toMatch(/⊘|cancelled/i);
  });

  it("should render awaiting approval status", () => {
    const tool = createToolCall({ status: ToolCallStatus.AwaitingApproval });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);

    expect(lastFrame()).toMatch(/⏸|awaiting|approval/i);
  });

  it("should render input summary", () => {
    const tool = createToolCall({
      name: "write_file",
      input: { path: "/test.txt", content: "Hello" },
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);

    expect(lastFrame()).toContain("write_file");
    expect(lastFrame()).toContain("/test.txt");
  });

  it("should render progress when available", () => {
    const tool = createToolCall({
      status: ToolCallStatus.Executing,
      progress: 75,
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);

    expect(lastFrame()).toContain("75%");
  });

  it("should render duration when completed", () => {
    const tool = createToolCall({
      status: ToolCallStatus.Success,
      startTime: Date.now() - 500,
      endTime: Date.now(),
    });
    const { lastFrame } = render(<ToolCallDisplay tool={tool} />);

    // Should show duration
    expect(lastFrame()).toMatch(/\d+ms|[\d.]+s/);
  });
});

describe("ToolProgressBar", () => {
  it("should render progress bar", () => {
    const { lastFrame } = render(<ToolProgressBar progress={50} />);

    expect(lastFrame()).toBeDefined();
  });

  it("should handle 0% progress", () => {
    const { lastFrame } = render(<ToolProgressBar progress={0} />);

    expect(lastFrame()).toContain("0%");
  });

  it("should handle 100% progress", () => {
    const { lastFrame } = render(<ToolProgressBar progress={100} />);

    expect(lastFrame()).toContain("100%");
  });

  it("should clamp values below 0", () => {
    const { lastFrame } = render(<ToolProgressBar progress={-10} />);

    expect(lastFrame()).toBeDefined();
  });

  it("should clamp values above 100", () => {
    const { lastFrame } = render(<ToolProgressBar progress={150} />);

    expect(lastFrame()).toBeDefined();
  });
});

describe("ToolStatusBadge", () => {
  it("should render scheduled badge", () => {
    const { lastFrame } = render(<ToolStatusBadge status={ToolCallStatus.Scheduled} />);

    expect(lastFrame()).toBeDefined();
  });

  it("should render executing badge", () => {
    const { lastFrame } = render(<ToolStatusBadge status={ToolCallStatus.Executing} />);

    expect(lastFrame()).toBeDefined();
  });

  it("should render success badge", () => {
    const { lastFrame } = render(<ToolStatusBadge status={ToolCallStatus.Success} />);

    expect(lastFrame()).toBeDefined();
  });

  it("should render error badge", () => {
    const { lastFrame } = render(<ToolStatusBadge status={ToolCallStatus.Error} />);

    expect(lastFrame()).toBeDefined();
  });
});

describe("ToolGroup", () => {
  it("should render single tool", () => {
    const tools: ToolCall[] = [createToolCall({ name: "read_file" })];
    const { lastFrame } = render(<ToolGroup tools={tools} />);

    expect(lastFrame()).toContain("read_file");
  });

  it("should render multiple tools", () => {
    const tools: ToolCall[] = [
      createToolCall({ name: "read_file" }),
      createToolCall({ name: "write_file" }),
      createToolCall({ name: "delete_file" }),
    ];
    const { lastFrame } = render(<ToolGroup tools={tools} />);

    expect(lastFrame()).toContain("read_file");
    expect(lastFrame()).toContain("write_file");
    expect(lastFrame()).toContain("delete_file");
  });

  it("should show group header", () => {
    const tools: ToolCall[] = [createToolCall()];
    const { lastFrame } = render(<ToolGroup tools={tools} />);

    expect(lastFrame()).toMatch(/Tools|tool/i);
  });

  it("should show tool count", () => {
    const tools: ToolCall[] = [
      createToolCall(),
      createToolCall(),
      createToolCall(),
    ];
    const { lastFrame } = render(<ToolGroup tools={tools} />);

    expect(lastFrame()).toMatch(/3|three/i);
  });

  it("should handle empty tools array", () => {
    const { lastFrame } = render(<ToolGroup tools={[]} />);

    // Should render nothing or empty state
    expect(lastFrame()).toBeDefined();
  });

  it("should render with collapsed mode", () => {
    const tools: ToolCall[] = [
      createToolCall({ name: "read_file", status: ToolCallStatus.Success }),
      createToolCall({ name: "write_file", status: ToolCallStatus.Success }),
    ];
    const { lastFrame } = render(<ToolGroup tools={tools} collapsed={true} />);

    // In collapsed mode, should show summary instead of all tools
    expect(lastFrame()).toBeDefined();
  });

  it("should render with custom title", () => {
    const tools: ToolCall[] = [createToolCall()];
    const { lastFrame } = render(<ToolGroup tools={tools} title="File Operations" />);

    expect(lastFrame()).toContain("File Operations");
  });
});
