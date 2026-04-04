import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar, getStatusBarText } from "./StatusBar.js";
import { buildStatusBarViewModel } from "../view-models/status-bar.js";

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
    expect(text).toContain("42 chars");
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
    expect(text).toContain("12 chars");
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

  it("preserves the current visible status text when rendering from the view model", () => {
    const props = {
      sessionId: "session-1",
      permissionMode: "accept-edits" as const,
      agentMode: "ama" as any,
      provider: "anthropic",
      model: "sonnet",
      currentTool: "shell_command",
      toolInputCharCount: 12,
      currentIteration: 3,
      maxIter: 9,
    };

    const expectedText = getStatusBarText(props);
    const { lastFrame } = render(
      <StatusBar
        {...props}
        viewModel={buildStatusBarViewModel(props)}
      />,
    );

    expect(lastFrame()).toContain(expectedText);
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

  it("shows managed AMA harness and worker in busy status text while showing round and global work budget", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      isThinkingActive: true,
      thinkingCharCount: 42,
      currentIteration: 14,
      maxIter: 24,
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
      managedRound: 2,
      managedMaxRounds: 6,
      managedGlobalWorkBudget: 200,
      managedBudgetUsage: 87,
    });

    expect(text).toContain("H2 - Planner");
    expect(text).not.toContain("AMA H2 - Planner");
    expect(text).toContain("42 chars");
    expect(text).toContain("Round 2/6");
    expect(text).toContain("Work 87/200");
    expect(text).not.toContain("Iter 14/24");
    expect(text).not.toContain("r2/6");
    expect(text).toContain("session-1 | H2 - Planner");
  });

  it("shows managed tool progress together with the active role", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      currentTool: "shell_command",
      toolInputCharCount: 12,
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    expect(text).toContain("H2 - Planner");
    expect(text).not.toContain("AMA H2 - Planner");
    expect(text).toContain("H2 - Planner - Bash (12 chars)");
    expect(text).toContain("Bash (12 chars)");
    expect(text).toContain("session-1 | H2 - Planner");
  });

  it("prefers the aggregate tool count in the status bar when tools are running", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      currentTool: "shell_command",
      toolInputCharCount: 120,
      activeToolCount: 3,
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Scout",
    });

    expect(text).toContain("session-1 | H2 - Scout - 3 tools running");
    expect(text).not.toContain("Bash (120 chars)");
  });

  it("hides the initial round counter for AMA and only shows work on the first pass", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Generator",
      managedRound: 1,
      managedMaxRounds: 2,
      managedGlobalWorkBudget: 45,
      managedBudgetUsage: 9,
      currentIteration: 28,
      maxIter: 146,
    });

    expect(text).toContain("Work 9/45");
    expect(text).not.toContain("Round 1/2");
    expect(text).not.toContain("Iter 28/146");
  });

  it("shows neutral routing status before Scout confirms the final harness", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      managedPhase: "routing",
      currentTool: "changed_scope",
      toolInputCharCount: 12,
    });

    expect(text).toContain("session-1 | Routing - changed_scope (12 chars)");
    expect(text).not.toContain("H1");
    expect(text).not.toContain("H2");
  });

  it("shows neutral Scout preflight status without leaking the final harness", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      managedPhase: "preflight",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Scout",
      isThinkingActive: true,
      thinkingCharCount: 42,
    });

    expect(text).toContain("session-1 | Scout");
    expect(text).toContain("42 chars");
    expect(text).not.toContain("H2");
  });

  it("never falls back to generic iter counters for AMA when managed status is absent", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      currentIteration: 28,
      maxIter: 146,
    });

    expect(text).not.toContain("Iter 28/146");
  });

  it("does not expose generic iter counters for plan mode", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "plan" as any,
      provider: "anthropic",
      model: "sonnet",
      currentIteration: 28,
      maxIter: 146,
    });

    expect(text).not.toContain("Iter 28/146");
  });

  it("still shows generic iter counters for SA runs", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "sa",
      provider: "anthropic",
      model: "sonnet",
      currentIteration: 3,
      maxIter: 8,
    });

    expect(text).toContain("Iter 3/8");
  });
});
