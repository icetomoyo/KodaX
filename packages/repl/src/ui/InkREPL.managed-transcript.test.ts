import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../common/i18n.js";
import { ToolCallStatus } from "./types.js";
import {
  appendPersistedUiHistorySnapshot,
  buildAmaWorkStripFromStatus,
  buildManagedForegroundTurnHistoryItems,
  buildManagedTaskTranscriptItems,
  buildRoundHistoryItems,
  shouldShowStatusBarBusyStatus,
} from "./InkREPL.js";

describe("buildManagedTaskTranscriptItems", () => {
  it("prefers compact role summaries over full internal reports", () => {
    const items = buildManagedTaskTranscriptItems({
      success: true,
      messages: [],
      lastText: "## Final Findings\n\n- The final answer.",
      managedTask: {
        runtime: {
          rawRoutingDecision: {
            harnessProfile: "H2_PLAN_EXECUTE_EVAL",
            routingSource: "model",
            primaryTask: "review",
            soloBoundaryConfidence: 0.82,
            needsIndependentQA: true,
          },
          finalRoutingDecision: {
            harnessProfile: "H2_PLAN_EXECUTE_EVAL",
            reviewTarget: "general",
            reviewScale: "massive",
          },
        },
        roleAssignments: [
          { id: "planner", role: "planner", title: "Planner" },
          { id: "generator", role: "generator", title: "Generator" },
          { id: "evaluator", role: "evaluator", title: "Evaluator" },
        ],
        evidence: {
          entries: [
            {
              assignmentId: "generator",
              title: "Generator",
              role: "generator",
              round: 1,
              status: "completed",
              summary: "Generator summarized the deep review findings.",
              output: "## Huge Generator Report\n\n- Lots of duplicated detail.",
            },
            {
              assignmentId: "evaluator",
              title: "Evaluator",
              role: "evaluator",
              round: 1,
              status: "completed",
              summary: "Evaluator accepted the review.",
              output: "## Final Findings\n\n- The final answer.",
            },
          ],
        },
        verdict: {
          decidedByAssignmentId: "evaluator",
        },
      },
    } as any);

    const transcript = items.join("\n\n");
    expect(transcript).toContain("Generator summarized the deep review findings.");
    expect(transcript).not.toContain("## Huge Generator Report");
    expect(transcript).not.toContain("## Final Findings");
  });

  it("appends a completion label when verdict disposition is complete (en)", () => {
    setLocale("en");
    const items = buildManagedTaskTranscriptItems({
      success: true,
      messages: [],
      lastText: "All checks passed.",
      managedTask: {
        runtime: {},
        roleAssignments: [
          { id: "generator", role: "generator", title: "Generator" },
          { id: "evaluator", role: "evaluator", title: "Evaluator" },
        ],
        evidence: {
          entries: [
            {
              assignmentId: "generator",
              title: "Generator",
              role: "generator",
              round: 1,
              status: "completed",
              summary: "Generator applied all fixes.",
            },
          ],
        },
        verdict: {
          decidedByAssignmentId: "evaluator",
          disposition: "complete",
        },
      },
    } as any);

    expect(items.at(-1)).toBe("[Task completed]");
  });

  it("appends a localized completion label for zh locale", () => {
    setLocale("zh");
    const items = buildManagedTaskTranscriptItems({
      success: true,
      messages: [],
      lastText: "All checks passed.",
      managedTask: {
        runtime: {},
        roleAssignments: [
          { id: "generator", role: "generator", title: "Generator" },
        ],
        evidence: {
          entries: [
            {
              assignmentId: "generator",
              title: "Generator",
              role: "generator",
              round: 1,
              status: "completed",
              summary: "Generator finished.",
            },
          ],
        },
        verdict: {
          decidedByAssignmentId: "generator",
          disposition: "complete",
        },
      },
    } as any);

    expect(items.at(-1)).toBe("[任务完成]");
    setLocale("en");
  });

  it("appends blocked label when verdict disposition is blocked", () => {
    setLocale("en");
    const items = buildManagedTaskTranscriptItems({
      success: false,
      messages: [],
      lastText: "",
      managedTask: {
        runtime: {},
        roleAssignments: [
          { id: "generator", role: "generator", title: "Generator" },
        ],
        evidence: {
          entries: [
            {
              assignmentId: "generator",
              title: "Generator",
              role: "generator",
              round: 1,
              status: "failed",
              summary: "Generator could not proceed.",
            },
          ],
        },
        verdict: {
          decidedByAssignmentId: "generator",
          disposition: "blocked",
          signalReason: "Budget denied.",
        },
      },
    } as any);

    expect(items.at(-1)).toBe("[Task blocked]");
  });

  it("appends continuation label when verdict disposition is needs_continuation", () => {
    setLocale("en");
    const items = buildManagedTaskTranscriptItems({
      success: false,
      messages: [],
      lastText: "",
      managedTask: {
        runtime: {},
        roleAssignments: [
          { id: "generator", role: "generator", title: "Generator" },
        ],
        evidence: {
          entries: [
            {
              assignmentId: "generator",
              title: "Generator",
              role: "generator",
              round: 1,
              status: "completed",
              summary: "Partial progress made.",
            },
          ],
        },
        verdict: {
          decidedByAssignmentId: "generator",
          disposition: "needs_continuation",
          continuationSuggested: true,
        },
      },
    } as any);

    expect(items.at(-1)).toBe("[Task needs continuation]");
  });

  it("omits completion label when verdict has no known disposition", () => {
    setLocale("en");
    const items = buildManagedTaskTranscriptItems({
      success: true,
      messages: [],
      lastText: "done",
      managedTask: {
        runtime: {},
        roleAssignments: [
          { id: "generator", role: "generator", title: "Generator" },
        ],
        evidence: {
          entries: [
            {
              assignmentId: "generator",
              title: "Generator",
              role: "generator",
              round: 1,
              status: "completed",
              summary: "Done.",
            },
          ],
        },
        verdict: {
          decidedByAssignmentId: "generator",
        },
      },
    } as any);

    // No completion label appended when disposition is undefined
    const last = items.at(-1) ?? "";
    expect(last).not.toMatch(/^\[Task/);
  });

  it("keeps the final round transcript visible when the managed run is interrupted", () => {
    const items = buildManagedTaskTranscriptItems({
      success: false,
      interrupted: true,
      messages: [],
      lastText: "## Partial Findings\n\n- The evaluator report was interrupted.",
      managedTask: {
        runtime: {
          rawRoutingDecision: {
            harnessProfile: "H1_EXECUTE_EVAL",
            routingSource: "model",
            primaryTask: "review",
            soloBoundaryConfidence: 0.82,
            needsIndependentQA: true,
          },
          finalRoutingDecision: {
            harnessProfile: "H1_EXECUTE_EVAL",
            reviewTarget: "general",
            reviewScale: "large",
          },
        },
        roleAssignments: [
          { id: "generator", role: "generator", title: "Generator" },
          { id: "evaluator", role: "evaluator", title: "Evaluator" },
        ],
        evidence: {
          entries: [
            {
              assignmentId: "evaluator",
              title: "Evaluator",
              role: "evaluator",
              round: 1,
              status: "completed",
              summary: "Evaluator identified three blocking issues.",
              output: "## Partial Findings\n\n- The evaluator report was interrupted.",
            },
          ],
        },
        verdict: {
          decidedByAssignmentId: "evaluator",
          signalReason: "Orchestration cancelled: This operation was aborted",
        },
      },
    } as any);

    const transcript = items.join("\n\n");
    expect(transcript).toContain("Evaluator identified three blocking issues.");
  });
});

describe("buildRoundHistoryItems", () => {
  it("keeps tool groups even when a round also has assistant text", () => {
    const items = buildRoundHistoryItems({
      thinking: "Reviewing the key diff.",
      response: "Found one issue.",
      toolCalls: [
        {
          id: "tool-1",
          name: "changed_diff",
          status: ToolCallStatus.Success,
          startTime: 100,
          endTime: 220,
          input: {
            preview: "{\"path\":\"packages/coding/src/task-engine.ts\",\"offset\":1775,\"limit\":480}",
          },
        },
      ],
      toolNames: ["changed_diff"],
    });

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ type: "thinking" });
    expect(items[1]).toMatchObject({ type: "tool_group" });
    expect(items[2]).toMatchObject({ type: "assistant", text: "Found one issue." });
  });
});

describe("appendPersistedUiHistorySnapshot", () => {
  it("accumulates back-to-back persisted additions on the latest snapshot", () => {
    const afterFirstAppend = appendPersistedUiHistorySnapshot([], [
      { type: "info", text: "> AMA Routing - Routing ready" },
    ]);
    const afterSecondAppend = appendPersistedUiHistorySnapshot(afterFirstAppend, [
      { type: "info", text: "> AMA H1 - Starting refinement round 2" },
    ]);

    expect(afterSecondAppend).toEqual([
      { type: "info", text: "> AMA Routing - Routing ready" },
      { type: "info", text: "> AMA H1 - Starting refinement round 2" },
    ]);
  });

  it("keeps the latest user prompt when a round later adds only tool output", () => {
    const afterPrompt = appendPersistedUiHistorySnapshot([
      { type: "assistant", text: "Round 1 answer" },
    ], [
      { type: "user", text: "Round 2 prompt" },
    ]);

    const afterToolOnlyUpdate = appendPersistedUiHistorySnapshot(afterPrompt, [
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-2",
            name: "changed_diff",
            status: ToolCallStatus.Success,
            startTime: 100,
            input: {
              preview: "{\"path\":\"packages/repl/src/ui/InkREPL.tsx\"}",
            },
          },
        ],
      },
    ]);

    expect(afterToolOnlyUpdate).toEqual([
      { type: "assistant", text: "Round 1 answer" },
      { type: "user", text: "Round 2 prompt" },
    ]);
  });

  it("keeps only the most recent persisted rounds once the transcript grows too large", () => {
    let history: ReturnType<typeof appendPersistedUiHistorySnapshot> = [];

    for (let round = 1; round <= 55; round += 1) {
      history = appendPersistedUiHistorySnapshot(history, [
        { type: "user", text: `Round ${round} prompt` },
        { type: "assistant", text: `Round ${round} answer` },
      ]);
    }

    expect(history).toHaveLength(100);
    expect(history[0]).toEqual({ type: "user", text: "Round 6 prompt" });
    expect(history[history.length - 1]).toEqual({ type: "assistant", text: "Round 55 answer" });
  });
});

describe("buildManagedForegroundTurnHistoryItems", () => {
  it("keeps completed foreground AMA phases as labeled thinking and assistant items", () => {
    const items = buildManagedForegroundTurnHistoryItems("Planner", {
      thinking: "Comparing ScrollBox ownership against the renderer viewport path.",
      response: "Planner narrowed the bug to the fullscreen transcript geometry.",
      toolCalls: [{
        id: "tool-1",
        name: "[Planner] changed_diff_bundle",
        input: { paths: ["packages/repl/src/ui/InkREPL.tsx"] },
        status: ToolCallStatus.Success,
        output: "Bundle: 3 files",
        startTime: 1,
        endTime: 2,
      }],
      createId: ((index = 0) => () => `fg-${++index}`)(),
    });

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      type: "thinking",
      text: "[Planner] Comparing ScrollBox ownership against the renderer viewport path.",
    });
    expect(items[1]).toMatchObject({
      type: "tool_group",
      tools: [expect.objectContaining({
        name: "[Planner] changed_diff_bundle",
      })],
    });
    expect(items[2]).toMatchObject({
      type: "assistant",
      text: "[Planner] Planner narrowed the bug to the fullscreen transcript geometry.",
    });
  });
});

describe("shouldShowStatusBarBusyStatus", () => {
  it("keeps busy text visible while the prompt surface is loading", () => {
    expect(shouldShowStatusBarBusyStatus({
      isLivePaused: false,
      isLoading: true,
      hasSpinnerLiveness: true,
    })).toBe(true);
  });

  it("hides busy text when live transcript updates are paused", () => {
    expect(shouldShowStatusBarBusyStatus({
      isLivePaused: true,
      isLoading: true,
      hasSpinnerLiveness: false,
    })).toBe(false);
  });
});

describe("buildAmaWorkStripFromStatus", () => {
  it("hides the strip outside AMA loading", () => {
    expect(buildAmaWorkStripFromStatus({
      agentMode: "sa",
      childFanoutClass: "finding-validation",
      childFanoutCount: 2,
    }, true)).toBeUndefined();
    expect(buildAmaWorkStripFromStatus({
      agentMode: "ama",
      childFanoutClass: "finding-validation",
      childFanoutCount: 2,
    }, false)).toBeUndefined();
  });

  it("formats AMA child fan-out as a compact work strip", () => {
    expect(buildAmaWorkStripFromStatus({
      agentMode: "ama",
      childFanoutClass: "finding-validation",
      childFanoutCount: 3,
    }, true)).toBe("Validating 3 findings");
  });
});
