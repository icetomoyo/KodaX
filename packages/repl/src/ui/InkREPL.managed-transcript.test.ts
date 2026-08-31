import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KodaXMessage } from "@kodax-ai/agent";
import {
  createOutputSegmentProjection,
  reduceOutputSegmentProjection,
} from "@kodax-ai/coding";
import { setLocale } from "../common/i18n.js";
import { ToolCallStatus, type HistoryItem } from "./types.js";
import {
  applyDistinctOutputSegmentStart,
  applyProviderRecoveryTransientReset,
  appendPersistedUiHistorySnapshot,
  buildAmaWorkStripFromStatus,
  createFailedManagedForegroundCommitter,
  commitFailedManagedForegroundBeforeCleanup,
  commitFailedManagedForegroundLedger,
  buildFailedManagedForegroundPersistenceItems,
  buildManagedForegroundTurnHistoryItems,
  buildManagedTaskTranscriptItems,
  buildRoundHistoryItems,
  shouldPersistSessionSnapshot,
  shouldCommitFailedManagedForeground,
  discardReplacedOutputSegmentItems,
  hasSubstantiveManagedAssistantText,
  restoreHistoryItemsFromSession,
  shouldAppendManagedAssistantTextDelta,
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

  // FEATURE_195 (v0.7.43) — Sidecar Verifier UI silent accept.
  //
  // Hides accept verdict evidence entries by default (post-F184 design
  // intent — verifier.ts JSDoc + ADR-030 §F184 specify silent accept).
  // Revise / blocked still surface (user-actionable). `verifierLog`
  // opt-in (env `KODAX_VERIFIER_LOG=1` or config `verifierLog: true`)
  // restores accept visibility for debug/audit.
  describe("FEATURE_195 — Sidecar Verifier UI silent accept", () => {
    const baseSidecarAcceptResult = (): unknown => ({
      success: true,
      messages: [],
      lastText: "你好! 我是 KodaX 的开发助手。",
      managedTask: {
        runtime: {},
        roleAssignments: [
          { id: "worker", role: "worker", title: "Worker" },
          { id: "evaluator", role: "evaluator", title: "Evaluator" },
        ],
        evidence: {
          entries: [
            {
              assignmentId: "worker",
              title: "Worker",
              role: "worker",
              round: 1,
              status: "completed",
              summary: "你好! 我是 KodaX 的开发助手。",
            },
            {
              // Sidecar accept verdict — observer-bridge maps
              // `verdict.status='accept'` → `signal: 'COMPLETE'` +
              // `summary: verdict.reason` (the verifier reasoning text).
              assignmentId: "evaluator",
              title: "Evaluator",
              role: "evaluator",
              round: 1,
              status: "completed",
              signal: "COMPLETE",
              signalReason: "Greeting is a fitting response, no pending tasks.",
              summary: "用户用中文说\"你好\"，主 agent 用中文回复了问候。这是恰当回应，没有未完成的任务。",
            },
          ],
        },
        verdict: {
          // FEATURE_195: trivial "你好" goes H0_DIRECT — `payload-builder.ts:218`
          // sets decidedByAssignmentId='direct' (H0 branch wins over the
          // verdictStatus → 'evaluator' branch). The Evaluator evidence
          // entry's assignmentId='evaluator' ≠ 'direct', so the existing
          // "skip final" filter at InkREPL:584 does NOT drop it. This is
          // exactly the production path the F195 silent-accept filter targets.
          decidedByAssignmentId: "direct",
          disposition: "complete",
        },
      },
    });

    it("default mode (verifierLog=false): hides sidecar accept verdict entry", () => {
      const items = buildManagedTaskTranscriptItems(
        baseSidecarAcceptResult() as any,
        { verifierLog: false },
      );
      const transcript = items.join("\n\n");
      expect(transcript).not.toContain("[Evaluator]");
      expect(transcript).not.toContain("用户用中文说");
      // Worker entry still shows.
      expect(transcript).toContain("你好! 我是 KodaX 的开发助手。");
    });

    it("verifierLog=true: shows sidecar accept verdict entry", () => {
      const items = buildManagedTaskTranscriptItems(
        baseSidecarAcceptResult() as any,
        { verifierLog: true },
      );
      const transcript = items.join("\n\n");
      // verifierLog surfaces the accept entry too — under the Sidecar identity.
      expect(transcript).toContain("⚡ Sidecar Verifier");
      expect(transcript).not.toContain("[Evaluator]");
      expect(transcript).toContain("用户用中文说");
    });

    it("default mode: sidecar revise verdict (status='running', no signal) still surfaces — user actionable", () => {
      const result = {
        success: true,
        messages: [],
        lastText: "Worker text-only response before revise.",
        managedTask: {
          runtime: {},
          roleAssignments: [
            { id: "worker", role: "worker", title: "Worker" },
            { id: "evaluator", role: "evaluator", title: "Evaluator" },
          ],
          evidence: {
            entries: [
              {
                // Sidecar revise — observer-bridge maps to
                // status='running' with no `signal`. Filter must NOT
                // hide because the user needs to see what to revise.
                assignmentId: "evaluator",
                title: "Evaluator",
                role: "evaluator",
                round: 1,
                status: "running",
                summary: "Worker claimed completion but did not run any verification step — revise needed.",
              },
            ],
          },
          // Trivial-task H0_DIRECT path — decidedByAssignmentId='direct'
          // (per payload-builder.ts:218) so the skip-final filter at
          // InkREPL:584 does NOT drop the Evaluator entry. F195 silent-
          // accept filter must NOT drop revise verdicts (signal !== 'COMPLETE'
          // — user actionable).
          verdict: { decidedByAssignmentId: "direct" },
        },
      };
      const items = buildManagedTaskTranscriptItems(result as any, { verifierLog: false });
      const transcript = items.join("\n\n");
      // The verdict surfaces under the Sidecar identity, NOT the legacy
      // [Evaluator] role label (FEATURE_184 follow-up — the in-chain Evaluator
      // was retired; this feedback is the Sidecar Verifier's).
      expect(transcript).toContain("⚡ Sidecar Verifier");
      expect(transcript).not.toContain("[Evaluator]");
      expect(transcript).toContain("revise needed");
    });

    it("omits actionable sidecar evidence after the first-class sidecar message was delivered", () => {
      const result = {
        success: true,
        messages: [],
        lastText: "Worker completed the requested implementation on retry.",
        managedTask: {
          runtime: {},
          roleAssignments: [
            { id: "worker", role: "worker", title: "Worker" },
            { id: "evaluator", role: "evaluator", title: "Evaluator" },
          ],
          evidence: {
            entries: [
              {
                assignmentId: "evaluator",
                title: "Evaluator",
                role: "evaluator",
                round: 1,
                status: "running",
                summary: "Please perform the requested implementation.",
              },
            ],
          },
          verdict: { decidedByAssignmentId: "direct", disposition: "complete" },
        },
      };

      const items = buildManagedTaskTranscriptItems(
        result as Parameters<typeof buildManagedTaskTranscriptItems>[0],
        {
          verifierLog: false,
          sidecarMessageDelivered: true,
        },
      );
      const transcript = items.join("\n\n");

      expect(transcript).not.toContain("Sidecar Verifier");
      expect(transcript).not.toContain("Please perform the requested implementation.");
    });

    it("keeps verifier-log accept evidence because accept has no first-class sidecar message", () => {
      const items = buildManagedTaskTranscriptItems(
        baseSidecarAcceptResult() as Parameters<typeof buildManagedTaskTranscriptItems>[0],
        { verifierLog: true, sidecarMessageDelivered: true },
      );

      expect(items.join("\n\n")).toContain("Sidecar Verifier");
    });

    it("default mode: sidecar blocked verdict (signal='BLOCKED') still surfaces — user actionable", () => {
      const result = {
        success: false,
        signal: "BLOCKED",
        messages: [],
        lastText: "Worker reported blocker.",
        managedTask: {
          runtime: {},
          roleAssignments: [
            { id: "worker", role: "worker", title: "Worker" },
            { id: "evaluator", role: "evaluator", title: "Evaluator" },
          ],
          evidence: {
            entries: [
              {
                assignmentId: "evaluator",
                title: "Evaluator",
                role: "evaluator",
                round: 1,
                status: "blocked",
                signal: "BLOCKED",
                signalReason: "Cannot proceed — missing dependency in user environment.",
                summary: "Cannot proceed — missing dependency in user environment.",
              },
            ],
          },
          // BLOCKED case — per payload-builder.ts:218, harness='H0_DIRECT'
          // wins so decidedByAssignmentId='direct'. F195 filter must NOT
          // drop blocked verdict (signal='BLOCKED', not 'COMPLETE' — user
          // actionable).
          verdict: { decidedByAssignmentId: "direct", disposition: "blocked" },
        },
      };
      const items = buildManagedTaskTranscriptItems(result as any, { verifierLog: false });
      const transcript = items.join("\n\n");
      // Blocked verdict surfaces under the Sidecar identity, not [Evaluator].
      expect(transcript).toContain("⚡ Sidecar Verifier");
      expect(transcript).not.toContain("[Evaluator]");
      expect(transcript).toContain("missing dependency");
    });

    it("default mode: sidecar blocked verdict (signal='BLOCKED') is omitted once the sidecar message was delivered", () => {
      const result = {
        success: false,
        signal: "BLOCKED",
        messages: [],
        lastText: "Worker reported blocker.",
        managedTask: {
          runtime: {},
          roleAssignments: [
            { id: "worker", role: "worker", title: "Worker" },
            { id: "evaluator", role: "evaluator", title: "Evaluator" },
          ],
          evidence: {
            entries: [
              {
                assignmentId: "evaluator",
                title: "Evaluator",
                role: "evaluator",
                round: 1,
                status: "blocked",
                signal: "BLOCKED",
                signalReason: "Cannot proceed — missing dependency in user environment.",
                summary: "Cannot proceed — missing dependency in user environment.",
              },
            ],
          },
          // BLOCKED case — per payload-builder.ts:218, harness='H0_DIRECT'
          // wins so decidedByAssignmentId='direct'. The F195 sidecar filter
          // omits non-COMPLETE evaluator evidence once the first-class sidecar
          // message channel already delivered the verdict (no duplicate echo).
          verdict: { decidedByAssignmentId: "direct", disposition: "blocked" },
        },
      };
      const items = buildManagedTaskTranscriptItems(
        result as Parameters<typeof buildManagedTaskTranscriptItems>[0],
        { verifierLog: false, sidecarMessageDelivered: true },
      );
      const transcript = items.join("\n\n");
      // Evaluator title and BLOCKED content are filtered — already shown via
      // the first-class sidecar message.
      expect(transcript).not.toContain("[Evaluator]");
      expect(transcript).not.toContain("Sidecar Verifier");
      expect(transcript).not.toContain("missing dependency");
    });

    it("default mode: non-evaluator entries with signal='COMPLETE' (e.g. direct H0) still surface", () => {
      // Filter must be evaluator-role-specific; a Worker / Scout / direct
      // entry that happens to also carry signal='COMPLETE' must NOT be
      // affected by the silent-accept filter.
      const result = {
        success: true,
        messages: [],
        lastText: "Done.",
        managedTask: {
          runtime: {},
          roleAssignments: [
            { id: "worker", role: "worker", title: "Worker" },
          ],
          evidence: {
            entries: [
              {
                assignmentId: "worker",
                title: "Worker",
                role: "worker",
                round: 1,
                status: "completed",
                signal: "COMPLETE",
                summary: "Worker completed the trivial task.",
              },
            ],
          },
          // decidedByAssignmentId='direct' so the existing skip-final
          // filter doesn't drop the Worker entry (Worker entry's
          // assignmentId='worker' ≠ 'direct'). What we want to verify:
          // F195 silent-accept filter does NOT drop this entry even though
          // it has signal='COMPLETE' — because role !== 'evaluator'.
          verdict: { decidedByAssignmentId: "direct", disposition: "complete" },
        },
      };
      const items = buildManagedTaskTranscriptItems(result as any, { verifierLog: false });
      const transcript = items.join("\n\n");
      expect(transcript).toContain("[Worker]");
      expect(transcript).toContain("Worker completed");
    });

    it("env var KODAX_VERIFIER_LOG=1 is honored when options.verifierLog omitted", () => {
      const prev = process.env.KODAX_VERIFIER_LOG;
      process.env.KODAX_VERIFIER_LOG = "1";
      try {
        const items = buildManagedTaskTranscriptItems(baseSidecarAcceptResult() as any);
        const transcript = items.join("\n\n");
        expect(transcript).toContain("⚡ Sidecar Verifier");
        expect(transcript).not.toContain("[Evaluator]");
        expect(transcript).toContain("用户用中文说");
      } finally {
        if (prev === undefined) delete process.env.KODAX_VERIFIER_LOG;
        else process.env.KODAX_VERIFIER_LOG = prev;
      }
    });

    it("env var unset + options omitted: defaults to filter-on (silent accept)", () => {
      const prev = process.env.KODAX_VERIFIER_LOG;
      delete process.env.KODAX_VERIFIER_LOG;
      try {
        const items = buildManagedTaskTranscriptItems(baseSidecarAcceptResult() as any);
        const transcript = items.join("\n\n");
        expect(transcript).not.toContain("[Evaluator]");
        expect(transcript).not.toContain("用户用中文说");
      } finally {
        if (prev !== undefined) process.env.KODAX_VERIFIER_LOG = prev;
      }
    });

    it("options.verifierLog=false overrides env var KODAX_VERIFIER_LOG=1 (explicit option wins)", () => {
      // Test paths need deterministic behavior independent of test-env
      // env vars. The `options.verifierLog` arg must take precedence
      // over the env-var fallback.
      const prev = process.env.KODAX_VERIFIER_LOG;
      process.env.KODAX_VERIFIER_LOG = "1";
      try {
        const items = buildManagedTaskTranscriptItems(
          baseSidecarAcceptResult() as any,
          { verifierLog: false },
        );
        const transcript = items.join("\n\n");
        expect(transcript).not.toContain("[Evaluator]");
      } finally {
        if (prev === undefined) delete process.env.KODAX_VERIFIER_LOG;
        else process.env.KODAX_VERIFIER_LOG = prev;
      }
    });
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
  it("persists the canonical sidecar between Worker attempts", () => {
    const history = appendPersistedUiHistorySnapshot([], [
      { type: "assistant", text: "Worker attempt 1", timestamp: 1_000 },
      {
        type: "sidecar",
        text: "Please perform the requested implementation.",
        verdict: "revise",
        timestamp: 2_000,
      },
      { type: "assistant", text: "Worker attempt 2", timestamp: 3_000 },
    ]);

    expect(history).toEqual([
      { type: "assistant", text: "Worker attempt 1", timestamp: 1_000 },
      {
        type: "sidecar",
        text: "Please perform the requested implementation.",
        icon: "revise",
        timestamp: 2_000,
      },
      { type: "assistant", text: "Worker attempt 2", timestamp: 3_000 },
    ]);
  });

  it("preserves distinct event timestamps across persistence", () => {
    const history = appendPersistedUiHistorySnapshot([], [
      { type: "assistant", text: "first reply", timestamp: 1_000 },
      {
        type: "tool_group",
        timestamp: 2_000,
        tools: [{
          id: "tool-1",
          name: "read",
          status: ToolCallStatus.Success,
          startTime: 1_900,
        }],
      },
      { type: "assistant", text: "second reply", timestamp: 3_000 },
    ]);

    expect(history.map((item) => item.timestamp)).toEqual([1_000, 2_000, 3_000]);
  });

  it("accumulates back-to-back persisted additions on the latest snapshot", () => {
    const afterFirstAppend = appendPersistedUiHistorySnapshot([], [
      { type: "info", text: "> AMA Routing - Routing ready" },
    ]);
    const afterSecondAppend = appendPersistedUiHistorySnapshot(afterFirstAppend, [
      { type: "info", text: "> AMA - Starting refinement round 2" },
    ]);

    expect(afterSecondAppend).toEqual([
      { type: "info", text: "> AMA Routing - Routing ready" },
      { type: "info", text: "> AMA - Starting refinement round 2" },
    ]);
  });

  it("keeps terminal tool groups when a round later adds only tool output", () => {
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
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-2",
            name: "changed_diff",
            status: "success",
            input: {
              preview: "{\"path\":\"packages/repl/src/ui/InkREPL.tsx\"}",
            },
            startTime: 100,
          },
        ],
      },
    ]);
  });

  it("normalizes in-flight tool groups before persisting", () => {
    const history = appendPersistedUiHistorySnapshot([], [
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-running",
            name: "bash",
            status: ToolCallStatus.Executing,
            input: {
              command: "npm test",
              apiKey: "secret-value",
            },
            preview: "running npm test",
            progress: 50,
            progressLines: ["halfway"],
            startTime: 100,
          },
        ],
      },
    ]);

    expect(history).toEqual([
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-running",
            name: "bash",
            status: "cancelled",
            input: {
              command: "npm test",
              apiKey: "[redacted]",
            },
            preview: "running npm test",
            error: "Session ended before the tool completed.",
            startTime: 100,
          },
        ],
      },
    ]);
  });

  it("does not recurse forever on cyclic tool inputs while persisting", () => {
    const input: Record<string, unknown> = { command: "npm test" };
    input.self = input;

    const history = appendPersistedUiHistorySnapshot([], [
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-cyclic",
            name: "bash",
            status: ToolCallStatus.Success,
            input,
            startTime: 100,
          },
        ],
      },
    ]);

    expect(history).toEqual([
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-cyclic",
            name: "bash",
            status: "success",
            input: {
              command: "npm test",
              self: "[truncated]",
            },
            startTime: 100,
          },
        ],
      },
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

describe("restoreHistoryItemsFromSession", () => {
  it("enriches old text-only uiHistory with tool groups from canonical messages", () => {
    const messages: KodaXMessage[] = [
      { role: "user", content: "Inspect README" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need to read the file first." },
          { type: "tool_use", id: "tool-1", name: "read", input: { path: "README.md" } },
          { type: "text", text: "I found the answer." },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "README contents" },
        ],
      },
    ];

    expect(restoreHistoryItemsFromSession({
      messages,
      uiHistory: [
        { type: "user", text: "Inspect README" },
        { type: "thinking", text: "Need to read the file first." },
        { type: "assistant", text: "I found the answer." },
      ],
    })).toEqual([
      { type: "user", text: "Inspect README" },
      { type: "thinking", text: "Need to read the file first." },
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-1",
            name: "read",
            status: ToolCallStatus.Success,
            input: { path: "README.md" },
            output: "README contents",
            startTime: expect.any(Number),
          },
        ],
      },
      { type: "assistant", text: "I found the answer." },
    ]);
  });

  it("restores persisted tool groups without deriving duplicates", () => {
    expect(restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [
        {
          type: "tool_group",
          tools: [
            {
              id: "tool-1",
              name: "grep",
              status: "error",
              error: "grep failed",
            },
          ],
        },
      ],
    })).toEqual([
      {
        type: "tool_group",
        isSessionUiOnly: true,
        tools: [
          {
            id: "tool-1",
            name: "grep",
            status: ToolCallStatus.Error,
            error: "grep failed",
            startTime: expect.any(Number),
          },
        ],
      },
    ]);
  });

  it("enriches only text-only rounds when persisted history mixes old and new tool formats", () => {
    const messages: KodaXMessage[] = [
      { role: "user", content: "Inspect README" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "read", input: { path: "README.md" } },
          { type: "text", text: "First answer." },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "README contents" }],
      },
      { role: "user", content: "Search TODOs" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-2", name: "grep", input: { pattern: "TODO" } },
          { type: "text", text: "Second answer." },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-2", content: "TODO list" }],
      },
    ];

    expect(restoreHistoryItemsFromSession({
      messages,
      uiHistory: [
        { type: "user", text: "Inspect README" },
        { type: "assistant", text: "First answer." },
        { type: "user", text: "Search TODOs" },
        {
          type: "tool_group",
          tools: [
            {
              id: "tool-2",
              name: "grep",
              status: "success",
              input: { pattern: "TODO" },
              output: "TODO list",
            },
          ],
        },
        { type: "assistant", text: "Second answer." },
      ],
    })).toEqual([
      { type: "user", text: "Inspect README" },
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-1",
            name: "read",
            status: ToolCallStatus.Success,
            input: { path: "README.md" },
            output: "README contents",
            startTime: expect.any(Number),
          },
        ],
      },
      { type: "assistant", text: "First answer." },
      { type: "user", text: "Search TODOs" },
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-2",
            name: "grep",
            status: ToolCallStatus.Success,
            input: { pattern: "TODO" },
            output: "TODO list",
            startTime: expect.any(Number),
          },
        ],
      },
      { type: "assistant", text: "Second answer." },
    ]);
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

describe("managed foreground assistant text guards", () => {
  it("persists the visible managed answer before a terminal runner failure", () => {
    const foregroundItems: HistoryItem[] = [
      {
        id: "answer",
        type: "assistant",
        text: "好的，本轮作罢。这里是完整实验汇总。",
        timestamp: 10,
      },
      {
        id: "sidecar",
        type: "sidecar",
        text: "Sidecar Verifier blocked the run.",
        verdict: "blocked",
        timestamp: 11,
      },
      {
        id: "terminal-error",
        type: "error",
        text: "The managed runtime failed after verification.",
        timestamp: 12,
      },
    ];

    const additions = buildFailedManagedForegroundPersistenceItems(foregroundItems);
    const persisted = appendPersistedUiHistorySnapshot([], additions);

    expect(persisted).toEqual([
      {
        type: "assistant",
        text: "好的，本轮作罢。这里是完整实验汇总。",
        timestamp: 10,
        presentationOnly: true,
      },
      {
        type: "sidecar",
        text: "Sidecar Verifier blocked the run.",
        icon: "blocked",
        timestamp: 11,
        presentationOnly: true,
      },
      {
        type: "error",
        text: "The managed runtime failed after verification.",
        timestamp: 12,
        presentationOnly: true,
      },
    ]);

    expect(restoreHistoryItemsFromSession({
      messages: [{ role: "user", content: "run the experiment" }],
      uiHistory: persisted,
    })).toEqual([
      { type: "user", text: "run the experiment" },
      {
        type: "assistant",
        text: "好的，本轮作罢。这里是完整实验汇总。",
        timestamp: 10,
        isSessionUiOnly: true,
      },
      {
        type: "sidecar",
        text: "Sidecar Verifier blocked the run.",
        verdict: "blocked",
        timestamp: 11,
        isSessionUiOnly: true,
      },
      {
        type: "error",
        text: "The managed runtime failed after verification.",
        timestamp: 12,
        isSessionUiOnly: true,
      },
    ]);
  });

  it("persists a first-turn failure with UI history but no canonical messages", () => {
    expect(shouldPersistSessionSnapshot(0, 3)).toBe(true);
    expect(shouldPersistSessionSnapshot(0, 0)).toBe(false);
  });

  it("commits a completed verifier ledger even after its foreground owner is cleared", () => {
    expect(shouldCommitFailedManagedForeground(undefined, 2)).toBe(true);
    expect(shouldCommitFailedManagedForeground("Worker", 0)).toBe(true);
    expect(shouldCommitFailedManagedForeground(undefined, 0)).toBe(false);
  });

  it("moves the failed ledger into the staged snapshot before awaiting persistence", async () => {
    const calls: string[] = [];
    const items: HistoryItem[] = [{
      id: "summary",
      type: "assistant",
      text: "Summary before recovery.",
      timestamp: 1,
    }];

    let releasePersistence: (() => void) | undefined;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const committed = commitFailedManagedForegroundLedger({
      finalizeOrphanedTools: () => { calls.push("finalize"); },
      flushText: () => { calls.push("flush"); },
      readItems: () => items,
      markUserItemsCommitted: () => { calls.push("mark"); },
      persist: async (persisted) => {
        calls.push("persist");
        expect(persisted).toEqual([{
          type: "assistant",
          text: "Summary before recovery.",
          timestamp: 1,
          isSessionUiOnly: true,
        }]);
        await persistence;
        calls.push("persisted");
      },
      clear: () => { calls.push("clear"); },
    });
    expect(calls).toEqual(["finalize", "flush", "mark", "clear", "persist"]);
    releasePersistence?.();
    await expect(committed).resolves.toBe(true);
    expect(calls).toEqual(["finalize", "flush", "mark", "clear", "persist", "persisted"]);
  });

  it("retries failed-ledger persistence without staging the transcript twice", async () => {
    const calls: string[] = [];
    let persistAttempts = 0;
    const commit = createFailedManagedForegroundCommitter({
      finalizeOrphanedTools: () => { calls.push("finalize"); },
      flushText: () => { calls.push("flush"); },
      readItems: () => [{
        id: "summary",
        type: "assistant",
        text: "Summary before recovery.",
        timestamp: 1,
      }],
      markUserItemsCommitted: () => { calls.push("mark"); },
      stage: (items) => {
        calls.push("stage");
        return appendPersistedUiHistorySnapshot([], items);
      },
      persist: async () => {
        persistAttempts += 1;
        calls.push(`persist-${persistAttempts}`);
        if (persistAttempts === 1) throw new Error("transient persistence failure");
      },
      clear: () => { calls.push("clear"); },
    });

    await expect(commit()).rejects.toThrow("transient persistence failure");
    await expect(commit()).resolves.toBe(true);
    expect(calls).toEqual([
      "finalize",
      "flush",
      "mark",
      "stage",
      "clear",
      "persist-1",
      "persist-2",
    ]);
  });

  it("does not re-append a twice-rejected failed turn on the next submit", async () => {
    let foregroundItems: HistoryItem[] = [
      {
        id: "first-answer",
        type: "assistant",
        text: "First partial answer.",
        timestamp: 1,
      },
      {
        id: "first-error",
        type: "error",
        text: "First turn failed.",
        timestamp: 2,
      },
    ];
    let snapshot = appendPersistedUiHistorySnapshot([], []);
    const persistedSnapshots: Array<typeof snapshot> = [];
    let persistenceAttempts = 0;
    const stage = (items: Parameters<typeof appendPersistedUiHistorySnapshot>[1]) => {
      snapshot = appendPersistedUiHistorySnapshot(snapshot, items);
      return snapshot;
    };
    const firstCommit = createFailedManagedForegroundCommitter({
      finalizeOrphanedTools: () => undefined,
      flushText: () => undefined,
      readItems: () => foregroundItems,
      markUserItemsCommitted: () => undefined,
      stage,
      persist: async (staged) => {
        persistenceAttempts += 1;
        persistedSnapshots.push(staged);
        throw new Error(`persistence failure ${persistenceAttempts}`);
      },
      clear: () => { foregroundItems = []; },
    });

    await expect(firstCommit()).rejects.toThrow("persistence failure 1");
    await expect(firstCommit()).rejects.toThrow("persistence failure 2");

    foregroundItems.push(
      {
        id: "second-answer",
        type: "assistant",
        text: "Second answer.",
        timestamp: 3,
      },
      {
        id: "second-error",
        type: "error",
        text: "Second turn failed.",
        timestamp: 4,
      },
    );
    const nextSubmitCommit = createFailedManagedForegroundCommitter({
      finalizeOrphanedTools: () => undefined,
      flushText: () => undefined,
      readItems: () => foregroundItems,
      markUserItemsCommitted: () => undefined,
      stage,
      persist: async (staged) => {
        persistenceAttempts += 1;
        persistedSnapshots.push(staged);
      },
      clear: () => { foregroundItems = []; },
    });

    await expect(nextSubmitCommit()).resolves.toBe(true);
    expect(persistenceAttempts).toBe(3);
    expect(persistedSnapshots[0]).toBe(persistedSnapshots[1]);
    expect(snapshot).toEqual([
      {
        type: "assistant",
        text: "First partial answer.",
        timestamp: 1,
        presentationOnly: true,
      },
      {
        type: "error",
        text: "First turn failed.",
        timestamp: 2,
        presentationOnly: true,
      },
      {
        type: "assistant",
        text: "Second answer.",
        timestamp: 3,
        presentationOnly: true,
      },
      {
        type: "error",
        text: "Second turn failed.",
        timestamp: 4,
        presentationOnly: true,
      },
    ]);
  });

  it("keeps a twice-rejected failed turn staged for the exit retry", async () => {
    let foregroundItems: HistoryItem[] = [
      {
        id: "answer",
        type: "assistant",
        text: "Partial answer before exit.",
        timestamp: 10,
      },
      {
        id: "error",
        type: "error",
        text: "Turn failed before exit.",
        timestamp: 11,
      },
    ];
    let snapshot = appendPersistedUiHistorySnapshot([], []);
    const persistedSnapshots: Array<typeof snapshot> = [];
    const commit = createFailedManagedForegroundCommitter({
      finalizeOrphanedTools: () => undefined,
      flushText: () => undefined,
      readItems: () => foregroundItems,
      markUserItemsCommitted: () => undefined,
      stage: (items) => {
        snapshot = appendPersistedUiHistorySnapshot(snapshot, items);
        return snapshot;
      },
      persist: async (staged) => {
        persistedSnapshots.push(staged);
        throw new Error("persistence unavailable");
      },
      clear: () => { foregroundItems = []; },
    });

    await expect(commit()).rejects.toThrow("persistence unavailable");
    await expect(commit()).rejects.toThrow("persistence unavailable");
    persistedSnapshots.push(snapshot);

    expect(foregroundItems).toEqual([]);
    expect(persistedSnapshots).toHaveLength(3);
    expect(persistedSnapshots[0]).toBe(persistedSnapshots[1]);
    expect(persistedSnapshots[2]).toEqual([
      {
        type: "assistant",
        text: "Partial answer before exit.",
        timestamp: 10,
        presentationOnly: true,
      },
      {
        type: "error",
        text: "Turn failed before exit.",
        timestamp: 11,
        presentationOnly: true,
      },
    ]);
  });

  it("runs terminal UI cleanup even when the final failed-ledger commit rejects", async () => {
    const cleanup = vi.fn();
    await expect(commitFailedManagedForegroundBeforeCleanup({
      commit: async () => { throw new Error("persistence stayed unavailable"); },
      cleanup,
    })).rejects.toThrow("persistence stayed unavailable");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves terminal partial provider output until a replacement segment starts", () => {
    let response = "partial answer";
    let thinkingContent = "partial reasoning";
    let thinkingActive = true;
    let toolInput = "partial tool input";
    let currentTool: string | undefined = "Read";
    let liveToolCalls = 1;
    let liveActivityLabel: string | undefined = "Reading";

    applyProviderRecoveryTransientReset({
      clearResponse: () => {
        response = "";
      },
      clearThinkingContent: () => {
        thinkingContent = "";
      },
      stopThinking: () => {
        thinkingActive = false;
      },
      clearToolInputContent: () => {
        toolInput = "";
      },
      clearCurrentTool: () => {
        currentTool = undefined;
      },
      resetLiveToolCalls: () => {
        liveToolCalls = 0;
      },
      clearLiveActivityLabel: () => {
        liveActivityLabel = undefined;
      },
    });

    expect({ response, thinkingContent }).toEqual({
      response: "partial answer",
      thinkingContent: "partial reasoning",
    });
    expect({ thinkingActive, toolInput, currentTool, liveToolCalls, liveActivityLabel }).toEqual({
      thinkingActive: false,
      toolInput: "",
      currentTool: undefined,
      liveToolCalls: 0,
      liveActivityLabel: undefined,
    });
  });

  it("does not repeat managed UI side effects for a duplicate segment start", () => {
    const started = {
      responseId: "response-1",
      providerRequestId: "request-1",
      mode: "replace" as const,
    };
    let projection = createOutputSegmentProjection();
    projection = reduceOutputSegmentProjection(projection, {
      type: "segment.started",
      ...started,
    }).state;
    const applyUiStart = vi.fn();
    const replacement = {
      responseId: started.responseId,
      providerRequestId: "request-2",
      mode: "replace" as const,
    };
    projection = applyDistinctOutputSegmentStart(projection, replacement, applyUiStart);
    projection = reduceOutputSegmentProjection(projection, {
      type: "assistant.delta",
      providerRequestId: replacement.providerRequestId,
      text: "visible partial",
    }).state;

    const duplicate = applyDistinctOutputSegmentStart(projection, replacement, applyUiStart);

    expect(duplicate).toBe(projection);
    expect(applyUiStart).toHaveBeenCalledTimes(1);
  });

  it("drops only the abandoned provider segment on replacement", () => {
    const items = [
      { id: "stable", type: "assistant", text: "stable " },
      { id: "recovery", type: "info", text: "retrying" },
      { id: "abandoned-thinking", type: "thinking", text: "old thought" },
      { id: "abandoned-answer", type: "assistant", text: "abandoned" },
    ] as HistoryItem[];

    expect(discardReplacedOutputSegmentItems(
      items,
      ["abandoned-thinking", "abandoned-answer"],
      "replace",
    )).toEqual([items[0], items[1]]);
    expect(discardReplacedOutputSegmentItems(
      items,
      ["abandoned-thinking", "abandoned-answer"],
      "append",
    )).toEqual(items);
  });

  it("does not treat the worker prefix alone as substantive assistant text", () => {
    expect(hasSubstantiveManagedAssistantText("[Worker] ", "Worker")).toBe(false);
    expect(hasSubstantiveManagedAssistantText("[Worker] hello", "Worker")).toBe(true);
    expect(hasSubstantiveManagedAssistantText("plain answer", "Worker")).toBe(true);
  });

  it("does not open a new assistant block for leading whitespace deltas", () => {
    expect(shouldAppendManagedAssistantTextDelta(" \n\t", false)).toBe(false);
    expect(shouldAppendManagedAssistantTextDelta(" \n\t", true)).toBe(true);
    expect(shouldAppendManagedAssistantTextDelta("hello", false)).toBe(true);
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
