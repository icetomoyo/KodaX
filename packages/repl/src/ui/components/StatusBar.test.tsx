import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar, getStatusBarText } from "./StatusBar.js";

describe("StatusBar", () => {
  it("includes thinking char counts in budget text", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      thinking: true,
      reasoningMode: "auto",
      isThinkingActive: true,
      thinkingCharCount: 42,
    });

    expect(text).toContain("Thinking");
    expect(text).not.toContain("42 chars");
  });

  it("includes tool char counts in budget text", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      currentTool: "shell_command",
      toolInputCharCount: 12,
    });

    expect(text).toContain("Bash");
    expect(text).not.toContain("12 chars");
  });

  it("renders the visible busy status", () => {
    const { lastFrame } = render(
      <StatusBar
        sessionId="session-1"
        permissionMode="accept-edits"
        agentMode="ama"
        provider="anthropic"
        model="sonnet"
        currentTool="shell_command"
        toolInputCharCount={12}
      />
    );

    expect(lastFrame()).toContain("Bash");
    expect(lastFrame()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it("can hide busy status while preserving the rest of the bar", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      currentTool: "shell_command",
      toolInputCharCount: 12,
      showBusyStatus: false,
    });

    expect(text).toContain("session-1");
    expect(text).not.toContain("Bash (12 chars)");
  });

  it("shows execution mode in the status text", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      parallel: true,
      provider: "anthropic",
      model: "sonnet",
    });

    expect(text).toContain("parallel");
  });

  it("shows sequential execution mode when parallel execution is disabled", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "sa",
      parallel: false,
      provider: "anthropic",
      model: "sonnet",
    });

    expect(text).toContain("sequential");
    expect(text).not.toContain("serial");
  });

  it("shows agent mode in the first status segment", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "sa",
      provider: "anthropic",
      model: "sonnet",
    });

    expect(text).toContain("KodaX - SA");
  });
});
