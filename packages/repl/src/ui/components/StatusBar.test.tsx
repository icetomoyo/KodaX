import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar, getStatusBarText } from "./StatusBar.js";
import { buildStatusBarViewModel } from "../view-models/status-bar.js";

const BULLET_SEPARATOR = " \u00B7 ";

describe("StatusBar", () => {
  it("includes estimated thinking tokens in busy text", () => {
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
    expect(text).toContain("~11 tokens");
  });

  it("includes estimated tool tokens in busy text", () => {
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
    expect(text).toContain("~3 tokens");
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
      agentMode: "ama" as const,
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

  it("preserves the original per-segment colors in the view model", () => {
    const viewModel = buildStatusBarViewModel({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      reasoningMode: "auto",
      contextUsage: {
        currentTokens: 40_000,
        contextWindow: 200_000,
        triggerPercent: 80,
      },
    });

    expect(viewModel.segments.map((segment) => segment.color)).toEqual([
      "primary",
      "green",
      "cyan",
      "dim",
      "secondary",
      "green",
    ]);
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
    expect(text).not.toContain("Bash");
  });

  it("shows agent mode in the first status segment", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "sa",
      provider: "anthropic",
      model: "sonnet",
    });

    expect(text).toContain("KodaX - Coding");
  });

  it("shows managed worker in busy status text while showing round and global work budget", () => {
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

    expect(text).toContain("Planner");
    expect(text).not.toContain("AMA H2 - Planner");
    expect(text).not.toContain("H2 - Planner");
    expect(text).toContain("~11 tokens");
    expect(text).toContain("Round 2/6");
    expect(text).toContain("Work 87/200");
    expect(text).not.toContain("Iter 14/24");
    expect(text).not.toContain("r2/6");
    expect(text).toContain("session-1 | Planner");
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

    expect(text).toContain("Planner");
    expect(text).not.toContain("AMA H2 - Planner");
    expect(text).not.toContain("H2 - Planner");
    expect(text).toContain("Planner - Bash (~3 tokens)");
    expect(text).toContain("Bash (~3 tokens)");
    expect(text).toContain("session-1 | Planner");
  });

  it("uses the original bullet separator inside multi-part iteration progress", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
      managedRound: 2,
      managedMaxRounds: 6,
      managedGlobalWorkBudget: 200,
      managedBudgetUsage: 87,
    });

    expect(text).toContain(`Round 2/6${BULLET_SEPARATOR}Work 87/200`);
    expect(text).not.toContain("璺");
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

    expect(text).toContain("session-1 | Scout - 3 tools running");
    expect(text).not.toContain("Bash");
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

    expect(text).toContain("session-1 | Routing - changed_scope (~3 tokens)");
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
    expect(text).toContain("~11 tokens");
    expect(text).not.toContain("H2");
  });

  it("shows verifier status instead of the PLANNED harness fallback", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      agentMode: "ama",
      provider: "anthropic",
      model: "sonnet",
      managedPhase: "verifying",
      managedHarnessProfile: "PLANNED",
      managedWorkerTitle: "Worker",
    });

    expect(text).toContain("session-1 | Verifying");
    expect(text).not.toContain("PLANNED - Worker");
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

  // v0.7.38 FEATURE_156 — idle-wait visual indicator (status-bar render side).
  describe("FEATURE_156 idle-wait label", () => {
    const baseProps = {
      sessionId: "session-1",
      permissionMode: "accept-edits" as const,
      agentMode: "ama" as const,
      provider: "anthropic",
      model: "sonnet",
      managedHarnessProfile: "H0_DIRECT",
      managedWorkerTitle: "Worker",
    };

    it("renders 'waiting for N children' when idleWaiting=true and N>1", () => {
      const text = getStatusBarText({
        ...baseProps,
        managedIdleWaiting: true,
        managedIdleWaitingPendingCount: 3,
      });
      expect(text).toContain("Worker - waiting for 3 children");
      expect(text).not.toContain("H0 - Worker");
    });

    it("renders 'waiting for 1 child' (singular) when count=1", () => {
      const text = getStatusBarText({
        ...baseProps,
        managedIdleWaiting: true,
        managedIdleWaitingPendingCount: 1,
      });
      expect(text).toContain("Worker - waiting for 1 child");
      expect(text).not.toContain("H0 - Worker");
      expect(text).not.toContain("children");
    });

    it("renders 'idle - resuming' transitional state when count=0 (fast-child race recovery)", () => {
      const text = getStatusBarText({
        ...baseProps,
        managedIdleWaiting: true,
        managedIdleWaitingPendingCount: 0,
      });
      expect(text).toContain("Worker - idle - resuming");
      expect(text).not.toContain("H0 - Worker");
    });

    it("falls back to bare role label when idleWaiting is undefined (default = not idle)", () => {
      const text = getStatusBarText({
        ...baseProps,
        // managedIdleWaiting omitted (undefined)
      });
      // No "waiting for" phrase — old behaviour preserved for all
      // non-idle-yield emit sites that don't set the field.
      expect(text).not.toContain("waiting for");
      expect(text).not.toContain("idle");
      expect(text).toContain("Worker");
      expect(text).not.toContain("H0 - Worker");
    });

    it("falls back to bare role label when idleWaiting=false (explicit non-idle)", () => {
      const text = getStatusBarText({
        ...baseProps,
        managedIdleWaiting: false,
        managedIdleWaitingPendingCount: 3,  // ignored when idleWaiting !== true
      });
      expect(text).not.toContain("waiting for");
      expect(text).toContain("Worker");
      expect(text).not.toContain("H0 - Worker");
    });

    it("idle-wait label is suppressed when a tool is currently running (active execution wins)", () => {
      const text = getStatusBarText({
        ...baseProps,
        managedIdleWaiting: true,
        managedIdleWaitingPendingCount: 2,
        currentTool: "read_file",
        toolInputCharCount: 30,
        activeToolCount: 1,
      });
      // Running tool indicates the agent already resumed and is
      // executing — `idleWaiting` from a stale event must not stamp
      // "waiting for" onto a Worker that's actively reading a file.
      expect(text).not.toContain("waiting for");
      expect(text).toContain("1 tool running");
    });

    it("agent-agnostic: renders Evaluator label correctly if idle-wait ever extends to Evaluator", () => {
      // Today only Worker can idle-yield (Evaluator can't dispatch
      // children, and `hasEmittedHandoff` gate blocks Evaluator
      // idle-yield path). The label code is intentionally
      // role-agnostic — pin that with a forward-looking test so a
      // future role-set change doesn't silently hardcode "Worker".
      const text = getStatusBarText({
        ...baseProps,
        managedWorkerTitle: "Evaluator",
        managedIdleWaiting: true,
        managedIdleWaitingPendingCount: 2,
      });
      expect(text).toContain("Evaluator - waiting for 2 children");
      expect(text).not.toContain("H0 - Evaluator");
    });
  });
});
