import { describe, expect, it } from "vitest";
import {
  formatManagedTaskBreadcrumb,
  formatManagedTaskLiveStatusLabel,
  formatSilentIterationToolsSummary,
  mergeLiveThinkingContent,
} from "./live-streaming.js";

describe("live-streaming", () => {
  it("prefers the authoritative final thinking when it extends the current buffer", () => {
    expect(mergeLiveThinkingContent("Need to inspect", "Need to inspect the file first."))
      .toBe("Need to inspect the file first.");
  });

  it("keeps the current thinking when the final event is shorter", () => {
    expect(mergeLiveThinkingContent("Need to inspect the file first.", "Need to inspect"))
      .toBe("Need to inspect the file first.");
  });

  it("formats managed-task preflight breadcrumbs", () => {
    expect(formatManagedTaskBreadcrumb({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      activeWorkerTitle: "Scout",
      currentRound: 0,
      maxRounds: 4,
      phase: "preflight",
      note: "Scout preflight starting",
    })).toBe("AMA Scout - Scout preflight starting");
  });

  it("formats managed-task worker breadcrumbs", () => {
    expect(formatManagedTaskBreadcrumb({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      activeWorkerTitle: "Planner",
      currentRound: 1,
      maxRounds: 4,
      phase: "worker",
    })).toBe("AMA H2 - Planner starting");
  });

  it("keeps worker completion summaries in managed-task breadcrumbs", () => {
    expect(formatManagedTaskBreadcrumb({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      activeWorkerTitle: "Planner",
      currentRound: 1,
      maxRounds: 4,
      phase: "worker",
      note: "Planner completed: Compared ScrollBox ownership with Claude's fullscreen host.",
    })).toBe("AMA H2 - Planner completed: Compared ScrollBox ownership with Claude's fullscreen host.");
  });

  it("uses the expanded detail note when transcript show-all requests the full breadcrumb", () => {
    expect(formatManagedTaskBreadcrumb({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      activeWorkerTitle: "Planner",
      currentRound: 1,
      maxRounds: 4,
      phase: "worker",
      note: "Planner completed: compact summary",
      detailNote: "Planner completed: compact summary\n\nFull multiline planner detail that should stay available in transcript mode.",
    }, { expanded: true })).toBe(
      "AMA H2 - Planner completed: compact summary\n\nFull multiline planner detail that should stay available in transcript mode."
    );
  });

  it("shows round info only after an actual additional pass starts", () => {
    expect(formatManagedTaskBreadcrumb({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      activeWorkerTitle: "Generator",
      currentRound: 2,
      maxRounds: 4,
      phase: "worker",
    })).toBe("AMA H2 - Generator starting - Round 2/4");
  });

  it("formats managed-task routing breadcrumbs", () => {
    expect(formatManagedTaskBreadcrumb({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      phase: "routing",
      note: "AMA routing: raw=H0_DIRECT(model) -> final=H2_PLAN_EXECUTE_EVAL reason=large current-diff review",
    })).toBe("AMA Routing - Routing ready");
  });

  it("formats managed-task round breadcrumbs", () => {
    expect(formatManagedTaskBreadcrumb({
      agentMode: "ama",
      harnessProfile: "H1_EXECUTE_EVAL",
      currentRound: 2,
      maxRounds: 2,
      phase: "round",
      note: "Starting refinement round 2",
    })).toBe("AMA H1 - Starting refinement round 2");
  });

  it("formats managed-task live labels for round updates without a worker title", () => {
    expect(formatManagedTaskLiveStatusLabel({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      currentRound: 2,
      maxRounds: 3,
      phase: "round",
      note: "Additional work budget approved (+200). Continuing the run.",
    })).toBe("[Round] Additional work budget approved (+200). Continuing the run.");
  });

  it("keeps the scout note in managed-task live labels during preflight", () => {
    expect(formatManagedTaskLiveStatusLabel({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      activeWorkerTitle: "Scout",
      phase: "preflight",
      note: "Scout analyzing task complexity",
    })).toBe("[Scout] analyzing task complexity");
  });

  it("keeps worker completion notes in managed-task live labels", () => {
    expect(formatManagedTaskLiveStatusLabel({
      agentMode: "ama",
      harnessProfile: "H1_EXECUTE_EVAL",
      activeWorkerTitle: "Planner",
      phase: "worker",
      note: "Planner completed",
    })).toBe("[Phase] AMA H1 - Planner - completed");
  });

  it("formats silent tool-only iteration summaries", () => {
    expect(formatSilentIterationToolsSummary(3, ["changed_scope", "changed_diff"], {
      activeWorkerTitle: "Planner",
    })).toBe("[Planner] Iter 3 tools: changed_scope, changed_diff");
  });
});
