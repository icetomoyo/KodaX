import { describe, expect, it } from "vitest";
import type { KodaXSessionUiHistoryItem } from "@kodax-ai/agent";
import {
  restoreHistoryItemsFromSession,
  trimPersistedUiHistorySnapshot,
} from "./restore-history.js";

// Minimal sidecar persisted items — icon slot carries encoded verdict/delivery.
function persistedSidecar(
  text: string,
  icon: string,
): Exclude<KodaXSessionUiHistoryItem, { type: "tool_group" }> {
  return { type: "sidecar", text, icon };
}

describe("restore-history / sidecar items", () => {
  it("restores a 'revise' sidecar item with verdict=revise", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [persistedSidecar("Please add error handling.", "revise")],
    });
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item?.type).toBe("sidecar");
    if (item?.type !== "sidecar") throw new Error("expected sidecar");
    expect(item.verdict).toBe("revise");
    expect(item.text).toBe("Please add error handling.");
    expect(item.delivery).toBeUndefined();
  });

  it("restores a 'blocked' sidecar item with verdict=blocked", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [persistedSidecar("Output was unsafe.", "blocked")],
    });
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item?.type).toBe("sidecar");
    if (item?.type !== "sidecar") throw new Error("expected sidecar");
    expect(item.verdict).toBe("blocked");
    expect(item.delivery).toBeUndefined();
  });

  it("restores a budget-exhausted sidecar item with delivery=budget-exhausted", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [persistedSidecar("Verifier ran out of budget.", "budget-exhausted")],
    });
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item?.type).toBe("sidecar");
    if (item?.type !== "sidecar") throw new Error("expected sidecar");
    expect(item.delivery).toBe("budget-exhausted");
    expect(item.verdict).toBeUndefined();
  });

  it("treats unknown icon values as revise (safe default)", () => {
    // Unrecognized icon value → falls back to revise verdict.
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [persistedSidecar("Some text.", "unknown-value")],
    });
    const item = result[0];
    expect(item?.type).toBe("sidecar");
    if (item?.type !== "sidecar") throw new Error("expected sidecar");
    expect(item.verdict).toBe("revise");
  });

  it("preserves sidecar items alongside other history item types after restore", () => {
    const uiHistory: KodaXSessionUiHistoryItem[] = [
      { type: "assistant", text: "Worker round 1" },
      persistedSidecar("Please fix the output.", "revise"),
      { type: "assistant", text: "Worker round 2" },
    ];
    const result = restoreHistoryItemsFromSession({ messages: [], uiHistory });
    expect(result.map((item) => item.type)).toEqual([
      "assistant",
      "sidecar",
      "assistant",
    ]);
    expect(result.map((item) => "text" in item ? item.text : "")).toEqual([
      "Worker round 1",
      "Please fix the output.",
      "Worker round 2",
    ]);
  });
});

describe("restore-history / timestamps", () => {
  it("preserves timestamps already stored in uiHistory", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [
        { type: "assistant", text: "first", timestamp: 1_000 },
        { type: "assistant", text: "second", timestamp: 2_000 },
      ],
    });

    expect(result.map((item) => item.timestamp)).toEqual([1_000, 2_000]);
  });

  it("recovers timestamps for legacy uiHistory from canonical messages", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "review", timestamp: "2026-07-18T03:00:13.337Z" },
        { role: "assistant", content: "first", timestamp: "2026-07-18T03:00:26.766Z" },
        { role: "assistant", content: "second", timestamp: "2026-07-18T03:00:47.838Z" },
      ],
      uiHistory: [
        { type: "user", text: "review" },
        { type: "assistant", text: "[Worker] first" },
        { type: "assistant", text: "[Worker] second" },
      ],
    });

    expect(result.map((item) => item.timestamp)).toEqual([
      Date.parse("2026-07-18T03:00:13.337Z"),
      Date.parse("2026-07-18T03:00:26.766Z"),
      Date.parse("2026-07-18T03:00:47.838Z"),
    ]);
  });

  it("drops unrelated persisted text instead of treating it as canonical", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "assistant", content: "foobar", timestamp: "2026-07-18T03:00:26.766Z" },
      ],
      uiHistory: [
        { type: "assistant", text: "bar" },
        { type: "assistant", text: "foobar" },
      ],
    });

    expect(result).toEqual([{
      type: "assistant",
      text: "foobar",
      timestamp: Date.parse("2026-07-18T03:00:26.766Z"),
    }]);
  });

  it("uses persisted display metadata without replacing canonical text", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "assistant", content: "canonical answer", timestamp: "2026-07-18T03:00:26.766Z" },
      ],
      uiHistory: [
        {
          type: "assistant",
          text: "[Worker] canonical answer",
          compactText: "short answer",
          timestamp: 9_000,
        },
      ],
    });

    expect(result).toEqual([{
      type: "assistant",
      text: "canonical answer",
      compactText: "short answer",
      timestamp: 9_000,
    }]);
  });
});

describe("restore-history / canonical transcript authority", () => {
  it("keeps canonical conversation when the persisted projection only contains /quit", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "What changed?" },
        { role: "assistant", content: "The restore contract changed." },
      ],
      uiHistory: [{ type: "user", text: "/quit" }],
    });

    expect(result.map((item) => item.type === "tool_group"
      ? "tool_group"
      : `${item.type}:${item.text}`)).toEqual([
      "user:What changed?",
      "assistant:The restore contract changed.",
      "user:/quit",
    ]);
  });

  it("keeps the bounded canonical baseline when uiHistory is only a matching suffix", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
      ],
      uiHistory: [
        { type: "user", text: "second question" },
        { type: "assistant", text: "second answer" },
        { type: "user", text: "/quit" },
      ],
    });

    expect(result.map((item) => item.type === "tool_group"
      ? "tool_group"
      : `${item.type}:${item.text}`)).toEqual([
      "user:first question",
      "assistant:first answer",
      "user:second question",
      "assistant:second answer",
      "user:/quit",
    ]);
  });

  it("places an unmatched persisted tail after canonical items omitted from the cache", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ],
      uiHistory: [
        { type: "user", text: "question" },
        { type: "user", text: "/quit" },
      ],
    });

    expect(result.map((item) => item.type === "tool_group"
      ? "tool_group"
      : `${item.type}:${item.text}`)).toEqual([
      "user:question",
      "assistant:answer",
      "user:/quit",
    ]);
  });

  it("trims the canonical baseline before appending a sparse UI-only tail", () => {
    const messages = Array.from({ length: 60 }, (_, index) => {
      const toolId = `tool-${index}`;
      return [
        { role: "user" as const, content: `question-${index}` },
        {
          role: "assistant" as const,
          content: [
            { type: "tool_use" as const, id: toolId, name: "read", input: {} },
            { type: "text" as const, text: `answer-${index}` },
          ],
        },
        {
          role: "user" as const,
          content: [{ type: "tool_result" as const, tool_use_id: toolId, content: `output-${index}` }],
        },
      ];
    }).flat();
    const uiHistory: KodaXSessionUiHistoryItem[] = Array.from(
      { length: 4 },
      () => ({ type: "user", text: "/quit" }),
    );

    const result = restoreHistoryItemsFromSession({ messages, uiHistory });

    expect(result).toHaveLength(154);
    expect(result[0]).toMatchObject({ type: "user", text: "question-10" });
    expect(result.slice(-4).map((item) => item.type === "tool_group" ? "tool" : item.text))
      .toEqual(["/quit", "/quit", "/quit", "/quit"]);
  });

  it("does not resurrect canonical text that is outside the bounded window", () => {
    const messages = Array.from({ length: 60 }, (_, index) => [
      { role: "user" as const, content: `question-${index}` },
      { role: "assistant" as const, content: `answer-${index}` },
    ]).flat();

    const result = restoreHistoryItemsFromSession({
      messages,
      uiHistory: [
        { type: "user", text: "question-0" },
        { type: "assistant", text: "answer-0" },
        { type: "user", text: "/quit" },
      ],
    });

    expect(result).toHaveLength(101);
    expect(result[0]).toMatchObject({ type: "user", text: "question-10" });
    expect(result.some((item) => item.type !== "tool_group" && item.text === "question-0"))
      .toBe(false);
    expect(result.at(-1)).toMatchObject({ type: "user", text: "/quit" });
  });

  it("drops unmatched ordinary text from a stale non-empty projection", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "canonical answer" },
      ],
      uiHistory: [{ type: "assistant", text: "stale answer" }],
    });

    expect(result.map((item) => item.type === "tool_group"
      ? "tool_group"
      : `${item.type}:${item.text}`)).toEqual([
      "user:question",
      "assistant:canonical answer",
    ]);
  });

  it("restores an explicitly presentation-only failed-turn tail in exact order", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [{ role: "user", content: "run the experiment" }],
      uiHistory: [
        {
          type: "assistant",
          text: "Complete experiment summary before verification.",
          presentationOnly: true,
        },
        {
          type: "sidecar",
          text: "The verifier blocked the run.",
          icon: "blocked",
          presentationOnly: true,
        },
        {
          type: "error",
          text: "The managed runtime failed after verification.",
          presentationOnly: true,
        },
      ],
    });

    expect(result).toEqual([
      { type: "user", text: "run the experiment" },
      {
        type: "assistant",
        text: "Complete experiment summary before verification.",
        isSessionUiOnly: true,
      },
      {
        type: "sidecar",
        text: "The verifier blocked the run.",
        verdict: "blocked",
        isSessionUiOnly: true,
      },
      {
        type: "error",
        text: "The managed runtime failed after verification.",
        isSessionUiOnly: true,
      },
    ]);
  });

  it("does not revive ordinary text when non-empty messages yield no visible seeds", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [{ role: "system", content: "internal scaffolding" }],
      uiHistory: [{ type: "assistant", text: "stale answer" }],
    });

    expect(result).toEqual([]);
  });
});

describe("restore-history / tool identity", () => {
  const canonicalMessages = [
    { role: "user" as const, content: "review" },
    {
      role: "assistant" as const,
      content: [
        { type: "tool_use" as const, id: "tool-1", name: "read", input: { path: "README.md" } },
        { type: "text" as const, text: "first answer" },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: "tool-1", content: "one" }],
    },
    { role: "user" as const, content: "continue" },
    {
      role: "assistant" as const,
      content: [
        { type: "tool_use" as const, id: "tool-2", name: "grep", input: { pattern: "TODO" } },
        { type: "text" as const, text: "second answer" },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: "tool-2", content: "two" }],
    },
  ];

  it("repairs tool groups duplicated after a UI-only quit round and stays idempotent", () => {
    const uiHistory: KodaXSessionUiHistoryItem[] = [
      { type: "user", text: "review" },
      {
        type: "tool_group",
        tools: [{ id: "tool-1", name: "read", status: "success", output: "one" }],
      },
      { type: "assistant", text: "first answer" },
      { type: "user", text: "continue" },
      {
        type: "tool_group",
        tools: [{ id: "tool-2", name: "grep", status: "success", output: "two" }],
      },
      { type: "assistant", text: "second answer" },
      { type: "user", text: "/quit" },
      {
        type: "tool_group",
        tools: [{ id: "tool-1", name: "read", status: "success", output: "one" }],
      },
      {
        type: "tool_group",
        tools: [{ id: "tool-2", name: "grep", status: "success", output: "two" }],
      },
    ];

    const restored = restoreHistoryItemsFromSession({ messages: canonicalMessages, uiHistory });
    const toolIds = restored.flatMap((item) => item.type === "tool_group"
      ? item.tools.map((tool) => tool.id)
      : []);
    expect(toolIds).toEqual(["tool-1", "tool-2"]);
    expect(restored.at(-1)).toMatchObject({ type: "user", text: "/quit" });

    const repairedUiHistory: KodaXSessionUiHistoryItem[] = restored.map((item) => {
      if (item.type === "tool_group") {
        return {
          type: "tool_group",
          tools: item.tools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            status: tool.status,
            input: tool.input,
            output: tool.output,
            error: tool.error,
          })),
        };
      }
      return { type: item.type, text: item.text } as KodaXSessionUiHistoryItem;
    });
    const restoredAgain = restoreHistoryItemsFromSession({
      messages: canonicalMessages,
      uiHistory: repairedUiHistory,
    });
    expect(restoredAgain.flatMap((item) => item.type === "tool_group"
      ? item.tools.map((tool) => tool.id)
      : [])).toEqual(["tool-1", "tool-2"]);
    expect(restoredAgain.map((item) => item.type === "tool_group"
      ? item.tools.map((tool) => tool.id).join(",")
      : `${item.type}:${item.text}`)).toEqual(restored.map((item) => item.type === "tool_group"
      ? item.tools.map((tool) => tool.id).join(",")
      : `${item.type}:${item.text}`));
  });

  it("anchors a persisted suffix to the latest repeated canonical round without dropping older rounds", () => {
    const messages = [
      { role: "user" as const, content: "continue" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "old-tool", name: "read", input: {} },
          { type: "text" as const, text: "same answer" },
        ],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "old-tool", content: "old" }],
      },
      { role: "user" as const, content: "continue" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "new-tool", name: "grep", input: {} },
          { type: "text" as const, text: "same answer" },
        ],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "new-tool", content: "new" }],
      },
    ];
    const uiHistory: KodaXSessionUiHistoryItem[] = [
      { type: "user", text: "continue" },
      {
        type: "tool_group",
        tools: [{ id: "new-tool", name: "grep", status: "success", output: "new" }],
      },
      { type: "assistant", text: "same answer" },
    ];

    const restored = restoreHistoryItemsFromSession({ messages, uiHistory });

    expect(restored.map((item) => item.type === "tool_group"
      ? item.tools.map((tool) => tool.id).join(",")
      : `${item.type}:${item.text}`)).toEqual([
      "user:continue",
      "old-tool",
      "assistant:same answer",
      "user:continue",
      "new-tool",
      "assistant:same answer",
    ]);
  });

  it("moves a uniquely persisted canonical tool group out of a polluted quit suffix", () => {
    const restored = restoreHistoryItemsFromSession({
      messages: canonicalMessages,
      uiHistory: [
        { type: "user", text: "review" },
        {
          type: "tool_group",
          tools: [{ id: "tool-1", name: "read", status: "success", output: "one" }],
        },
        { type: "assistant", text: "first answer" },
        { type: "user", text: "continue" },
        { type: "assistant", text: "second answer" },
        { type: "user", text: "/quit" },
        {
          type: "tool_group",
          tools: [{ id: "tool-2", name: "grep", status: "success", output: "two" }],
        },
      ],
    });

    expect(restored.at(-1)).toMatchObject({ type: "user", text: "/quit" });
    expect(restored.map((item) => item.type === "tool_group"
      ? item.tools.map((tool) => tool.id).join(",")
      : `${item.type}:${item.text}`)).toEqual([
      "user:review",
      "tool-1",
      "assistant:first answer",
      "user:continue",
      "tool-2",
      "assistant:second answer",
      "user:/quit",
    ]);
  });

  it("replaces an unanchored legacy tool summary with the canonical tool group", () => {
    const restored = restoreHistoryItemsFromSession({
      messages: canonicalMessages.slice(0, 3),
      uiHistory: [
        { type: "user", text: "review" },
        { type: "event", text: "⚙ read(README.md)", icon: "tool" },
        { type: "assistant", text: "first answer" },
      ],
    });

    expect(restored.map((item) => item.type)).toEqual(["user", "tool_group", "assistant"]);
  });

  it("filters duplicate members inside a mixed tool group without dropping new tools", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [
        {
          type: "tool_group",
          tools: [{ id: "tool-1", name: "read", status: "success" }],
        },
        {
          type: "tool_group",
          tools: [
            { id: "tool-1", name: "read", status: "success" },
            { id: "tool-2", name: "grep", status: "success" },
          ],
        },
      ],
    });

    expect(result.flatMap((item) => item.type === "tool_group"
      ? item.tools.map((tool) => tool.id)
      : [])).toEqual(["tool-1", "tool-2"]);
  });

  it("deduplicates repeated canonical tool ids before applying persisted overlays", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "same-tool", name: "read", input: { path: "a" } },
            { type: "text", text: "first answer" },
          ],
        },
        { role: "user", content: "second" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "same-tool", name: "read", input: { path: "b" } },
            { type: "text", text: "second answer" },
          ],
        },
      ],
      uiHistory: [{
        type: "tool_group",
        tools: [{ id: "same-tool", name: "read", status: "success", output: "persisted" }],
      }],
    });

    expect(result.flatMap((item) => item.type === "tool_group"
      ? item.tools.map((tool) => tool.id)
      : [])).toEqual(["same-tool"]);
    expect(result.filter((item) => item.type === "assistant")).toHaveLength(2);
  });

  it("deduplicates canonical tool ids inside the bounded window, not before it", () => {
    const messages = Array.from({ length: 60 }, (_, index) => [
      { role: "user" as const, content: `question-${index}` },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "same-tool", name: "read", input: { index } },
          { type: "text" as const, text: `answer-${index}` },
        ],
      },
    ]).flat();

    const result = restoreHistoryItemsFromSession({ messages });

    expect(result[0]).toMatchObject({ type: "user", text: "question-10" });
    expect(result.flatMap((item) => item.type === "tool_group"
      ? item.tools.map((tool) => tool.id)
      : [])).toEqual(["same-tool"]);
  });

  it("keeps an unmatched legacy-looking event that does not name a canonical tool", () => {
    const result = restoreHistoryItemsFromSession({
      messages: canonicalMessages.slice(0, 3),
      uiHistory: [
        { type: "user", text: "review" },
        { type: "event", text: "⚙ background status", icon: "tool" },
        { type: "assistant", text: "first answer" },
      ],
    });

    expect(result.map((item) => item.type)).toEqual([
      "user",
      "event",
      "tool_group",
      "assistant",
    ]);
  });

  it("keeps a same-name legacy-looking event outside the canonical tool's round", () => {
    const result = restoreHistoryItemsFromSession({
      messages: canonicalMessages,
      uiHistory: [
        { type: "user", text: "review" },
        { type: "assistant", text: "first answer" },
        { type: "user", text: "continue" },
        { type: "event", text: "⚙ read(background status)", icon: "tool" },
        { type: "assistant", text: "second answer" },
      ],
    });

    expect(result.filter((item) => item.type === "event"
      && item.text === "⚙ read(background status)")).toHaveLength(1);
  });

  it("keeps a same-name legacy-looking event when no text anchors establish its round", () => {
    const result = restoreHistoryItemsFromSession({
      messages: canonicalMessages.slice(0, 3),
      uiHistory: [{ type: "event", text: "⚙ read(background status)", icon: "tool" }],
    });

    expect(result.filter((item) => item.type === "event"
      && item.text === "⚙ read(background status)")).toHaveLength(1);
  });

  it("keeps canonical tool groups outside a trimmed persisted window", () => {
    const result = restoreHistoryItemsFromSession({
      messages: canonicalMessages,
      uiHistory: [
        { type: "user", text: "continue" },
        { type: "assistant", text: "second answer" },
      ],
    });

    expect(result.flatMap((item) => item.type === "tool_group"
      ? item.tools.map((tool) => tool.id)
      : [])).toEqual(["tool-1", "tool-2"]);
  });
});

describe("restore-history / task-completed recovery (GOAL 1)", () => {
  const taskCompletedMsg = {
    role: "user" as const,
    _synthetic: true,
    _source: "task-completed",
    content: '<task-completed task_id="run-x">report body</task-completed>',
  };
  const hasReportBody = (i: { type: string; text?: string }): boolean =>
    i.type === "event" && typeof i.text === "string" && i.text.includes("report body");

  it("headless (no uiHistory): recovers the task-completed banner as one event item at its transcript position", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "please review" },
        { role: "assistant", content: "running workflow…" },
        taskCompletedMsg,
      ],
    });
    // Recovered exactly once, as an event (NOT a user bubble — that would corrupt
    // splitCreatableHistoryRounds round boundaries), at its transcript position.
    expect(result.map((i) => i.type)).toEqual(["user", "assistant", "event"]);
    expect(result.filter((i) => hasReportBody(i))).toHaveLength(1);
  });

  it("CLI does not synthesize an agent-completed presentation event missing from uiHistory", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "please review" },
        { role: "assistant", content: "review complete" },
        {
          role: "user",
          _synthetic: true,
          _source: "agent-completed",
          content: '<agent-completed id="child">large child report</agent-completed>',
        },
      ],
      uiHistory: [{ type: "user", text: "/quit" }],
    });

    expect(result.map((item) => item.type === "tool_group"
      ? "tool_group"
      : `${item.type}:${item.text}`)).toEqual([
      "user:please review",
      "assistant:review complete",
      "user:/quit",
    ]);
  });

  it("CLI (uiHistory present): leaves task-completed presentation ownership to uiHistory", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "please review" },
        taskCompletedMsg,
      ],
      uiHistory: [
        { type: "user", text: "please review" },
        { type: "assistant", text: "workflow result already shown via uiHistory" },
      ],
    });
    // Canonical messages own ordinary conversation. Presentation-only task
    // completion events are reconstructed only for headless/no-cache hosts.
    expect(result.filter((i) => hasReportBody(i))).toHaveLength(0);
    expect(result.map((i) => i.type)).toEqual(["user"]);
  });

  it("CLI retains a task-completed event explicitly recorded in uiHistory", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "please review" },
        taskCompletedMsg,
      ],
      uiHistory: [
        { type: "user", text: "please review" },
        { type: "event", text: taskCompletedMsg.content, icon: "tool" },
      ],
    });

    expect(result.filter((i) => hasReportBody(i))).toHaveLength(1);
    expect(result.at(-1)).toMatchObject({
      type: "event",
      text: taskCompletedMsg.content,
      isSessionUiOnly: true,
    });
  });

  it("other synthetic messages stay dropped on the headless path (only _source:'task-completed' is recovered)", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "hi" },
        { role: "user", _synthetic: true, content: "please continue" },
      ],
    });
    expect(result.map((i) => i.type)).toEqual(["user"]);
  });
});

describe("trimPersistedUiHistorySnapshot / sidecar items are retained in trim window", () => {
  it("retains sidecar items within the normal item count window", () => {
    const items: KodaXSessionUiHistoryItem[] = [
      { type: "user", text: "q" },
      persistedSidecar("feedback text", "revise"),
      { type: "assistant", text: "a" },
    ];
    const trimmed = trimPersistedUiHistorySnapshot(items);
    expect(trimmed.some((item) => item.type === "sidecar")).toBe(true);
  });
});
