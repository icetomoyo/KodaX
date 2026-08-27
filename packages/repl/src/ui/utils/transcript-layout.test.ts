import { afterEach, describe, expect, it, vi } from "vitest";

// Isolate the runtime agent import that `tool-display.ts` (transitive dep of
// transcript-layout) pulls in: the real @kodax-ai/agent entry fails to collect
// under the local Vitest transform (skill-creator script chain, KNOWN_ISSUES
// #141 family). These stubs match the not-a-memory-file outcome every fixture
// in this file exercises — no test here touches memory-badge behavior.
vi.mock("@kodax-ai/agent", () => ({
  getAgentConfigPath: () => "/mock/agent-config",
  isAutoManagedMemoryFile: () => false,
  parseMemoryTypeFromFilename: () => undefined,
}));

import { ToolCallStatus, type HistoryItem } from "../types.js";
import { computeInlineLedgerStep } from "./inline-ledger-controller.js";
import { EMPTY_INLINE_SCROLLBACK_STATE, planInlineScrollback } from "../../tui/substrate/ink/inline-scrollback-ledger.js";
import {
  buildCollapsedThinkingLine,
  buildThinkingPreview,
  buildDynamicTranscriptSection,
  buildHistoryItemTranscriptSections,
  buildInlinePromptRenderModel,
  buildTranscriptHiddenDivider,
  buildTranscriptRenderModel,
  buildTranscriptRows,
  buildStaticTranscriptSections,
  buildTranscriptStaticPortion,
  buildTranscriptDynamicPortion,
  splitInlineLedgerModel,
  identifyInlineCommitSection,
  capHistoryByTranscriptRows,
  computeTranscriptCapStart,
  flattenTranscriptSections,
  getVisibleTranscriptRows,
  identifyTranscriptSection,
  isTranscriptHiddenDivider,
  materializeTranscriptRenderModel,
  sliceHistoryToRecentCanonicalItems,
  sliceHistoryToRecentRounds,
  transcriptRenderCapForHistory,
  THINKING_SHOW_ALL_HARD_CHAR_CAP,
  TRANSCRIPT_HARD_LINE_CAP,
  TRANSCRIPT_HIDDEN_DIVIDER_ID,
  TRANSCRIPT_MODE_VISIBLE_MESSAGES,
  TRANSCRIPT_RENDER_CAP,
  TRANSCRIPT_RENDER_CAP_STEP,
  type TranscriptCapAnchor,
  type TranscriptDynamicPortion,
  type TranscriptSection,
  type TranscriptStaticPortion,
} from "./transcript-layout.js";

function renderedText(model: ReturnType<typeof buildTranscriptRenderModel>): string {
  return [...model.rows, ...model.previewRows].map((row) => row.text).join("\n");
}

describe("transcript ANSI sanitization", () => {
  it("strips command color sequences before rows are wrapped or selected", () => {
    const model = buildTranscriptRenderModel({
      items: [{
        id: "ansi-info",
        type: "info",
        timestamp: 1,
        icon: "\u2713",
        text: "\u001b[36mgenerated-fast-audit\u001b[39m \u001b[2mrun-mqc5v6ys\u001b[22m - completed",
      }],
      viewportWidth: 120,
    });

    const text = renderedText(model);
    expect(text).toContain("generated-fast-audit run-mqc5v6ys - completed");
    expect(text).not.toContain("\u001b[");
  });
});

describe("splitInlineLedgerModel (FEATURE_214 bounded live + unified line commit source)", () => {
  const row = (text: string, key = `k-${text}`) => ({ key, text });
  const sec = (key: string, texts: string[]) => ({ key, rows: texts.map((t) => row(t)) });
  // splitInlineLedgerModel(finalizedSections, completedRows, previewRows, budget)

  it("within budget → all completed rows + preview live; commit source = finalized only", () => {
    const split = splitInlineLedgerModel([sec("f", ["F1", "F2"])], [row("You"), row("done")], [row("stream")], 8);
    expect(split.liveRows.map((r) => r.text)).toEqual(["You", "done", "stream"]);
    expect(split.committedSections.flatMap((s) => s.rows.map((r) => r.text))).toEqual(["F1", "F2"]);
  });

  it("over budget → older COMPLETED rows overflow; finalized + overflow commit (positional)", () => {
    const completed = ["You", "t1", "t2", "t3"].map((t) => row(t)); // 4 completed rows
    const split = splitInlineLedgerModel([sec("f", ["F1"])], completed, [row("live")], 2);
    // budget 2 − preview 1 = 1 completed row stays live (t3); You,t1,t2 overflow.
    expect(split.liveRows.map((r) => r.text)).toEqual(["t3", "live"]);
    expect(split.committedSections.map((s) => s.key)).toEqual(["il-0", "il-1", "il-2", "il-3"]);
    expect(split.committedSections.flatMap((s) => s.rows.map((r) => r.text))).toEqual(["F1", "You", "t1", "t2"]);
    // row keys are normalised to positional so the fingerprint is position+text only.
    expect(split.committedSections.flatMap((s) => s.rows.map((r) => r.key))).toEqual(["il-0", "il-1", "il-2", "il-3"]);
  });

  it("HARD CAP: a long streaming preview is bounded — liveRows ≤ budget, overflow committed", () => {
    // The unbounded-preview bug: previewRows=30, messageRows=5 must NOT leave 30 rows live.
    const preview = Array.from({ length: 30 }, (_, i) => row(`s${i}`));
    const split = splitInlineLedgerModel([sec("f", ["F"])], [], preview, 5);
    expect(split.liveRows.length).toBe(5); // bounded — NOT 30
    expect(split.liveRows.map((r) => r.text)).toEqual(["s25", "s26", "s27", "s28", "s29"]);
    // the older 25 stable preview lines spilled into the commit source (after finalized F).
    expect(split.committedSections.length).toBe(1 + 25);
    expect(split.committedSections[0].rows[0].text).toBe("F");
    expect(split.committedSections.at(-1)!.rows[0].text).toBe("s24");
  });

  it("a mutable SPINNER row is NEVER committed — dropped from the overflow", () => {
    const spinner = { key: "spin", text: "Worker", spinner: true };
    // active = [You, s0, <spinner>, s1, s2]; budget 2 → live = last 2 = [s1,s2];
    // overflow [You, s0, spinner] → spinner filtered → committed [You, s0].
    const split = splitInlineLedgerModel([], [row("You")], [row("s0"), spinner, row("s1"), row("s2")], 2);
    expect(split.committedSections.some((s) => s.rows.some((r) => r.spinner))).toBe(false);
    expect(split.committedSections.flatMap((s) => s.rows.map((r) => r.text))).toEqual(["You", "s0"]);
    expect(split.liveRows.length).toBeLessThanOrEqual(2);
  });

  it("a SPINNER at the TOP cannot inflate live (Codex review): spinner + 30 rows, budget 5 → live 5", () => {
    const spinner = { key: "spin", text: "Worker", spinner: true };
    const rows30 = Array.from({ length: 30 }, (_, i) => row(`r${i}`));
    const split = splitInlineLedgerModel([], [], [spinner, ...rows30], 5);
    expect(split.liveRows.length).toBe(5); // NOT 31 — the hard cap holds regardless of spinner position
    expect(split.committedSections.some((s) => s.rows.some((r) => r.spinner))).toBe(false); // spinner dropped, never frozen
  });

  it("commit source is TRANSCRIPT-ONLY — exactly finalized + active overflow, nothing injected", () => {
    const split = splitInlineLedgerModel([sec("f", ["history"])], [row("You"), row("answer")], [], 1);
    expect(split.committedSections.flatMap((s) => s.rows.map((r) => r.text))).toEqual(["history", "You"]);
    expect(split.liveRows.map((r) => r.text)).toEqual(["answer"]);
  });

  it("BLACKLIST: commit source injects NOTHING — it is a subset of the passed transcript rows", () => {
    // The input/footer/status/separator are SEPARATE React nodes in InkREPL (rendered
    // below MessageList), never part of the transcript render model passed to split — so
    // they can never reach the commit source. split only ever commits rows drawn from
    // finalizedSections + completedRows + previewRows, all transcript. (The end-to-end
    // "no UI row in TerminalModel scrollback" is asserted by the engine UNBOUNDED test.)
    const finalized = [sec("f", ["history line"])];
    const completed = [row("You"), row("answer a"), row("answer b")];
    const preview = [row("Assistant"), row("streaming line")];
    const split = splitInlineLedgerModel(finalized, completed, preview, 2);
    const passed = new Set([
      ...finalized.flatMap((s) => s.rows.map((r) => r.text)),
      ...completed.map((r) => r.text),
      ...preview.map((r) => r.text),
    ]);
    for (const s of split.committedSections) {
      for (const r of s.rows) expect(passed.has(r.text)).toBe(true); // nothing injected
    }
    const committedText = split.committedSections.flatMap((s) => s.rows.map((r) => r.text)).join("\n");
    for (const banned of ["Queue a follow-up", "Type a message", "KodaX -", "────"]) {
      expect(committedText.includes(banned)).toBe(false);
    }
  });

  it("FINALIZE ALIGNMENT across DIFFERENT row keys (Codex review): finalize APPENDS, never rebuilds", () => {
    // Frame 1 — streaming: active completed rows carry their ACTIVE keys; budget 1 + no
    // preview ⇒ You overflows + commits, t1 stays live.
    const f1 = splitInlineLedgerModel(
      [],
      [row("You", "active-you"), row("t1", "active-t1")],
      [],
      1,
    );
    const step1 = computeInlineLedgerStep({
      active: true, hasCommitHandle: true, wasActive: true, forceRebuild: false,
      prior: EMPTY_INLINE_SCROLLBACK_STATE,
      finalizedSections: f1.committedSections, bannerSection: undefined, width: 80,
    });
    if (step1.kind !== "commit") throw new Error(`expected commit, got ${step1.kind}`);
    expect(step1.sections.flatMap((s) => s.rows.map((r) => r.text))).toEqual(["You"]);

    // Frame 2 — finalized: SAME text but DIFFERENT raw keys (final-*). Because split
    // normalises keys to positional, the fingerprint is position+text → prefix match →
    // APPEND the previously-live tail [t1], NOT a full rebuild.
    const f2 = splitInlineLedgerModel(
      [{ key: "round", rows: [row("You", "final-you"), row("t1", "final-t1")] }],
      [],
      [],
      1,
    );
    const step2 = computeInlineLedgerStep({
      active: true, hasCommitHandle: true, wasActive: true, forceRebuild: false,
      prior: step1.nextState,
      finalizedSections: f2.committedSections, bannerSection: undefined, width: 80,
    });
    if (step2.kind !== "commit") throw new Error(`expected commit, got ${step2.kind}`);
    expect(step2.mode).toBe("append"); // NOT "rebuild"
    expect(step2.sections.flatMap((s) => s.rows.map((r) => r.text))).toEqual(["t1"]);
  });

  it("FINALIZE ALIGNMENT across the Assistant header TIMESTAMP (streaming vs finalized text)", () => {
    // Frame 1 — streaming: the preview header is `Assistant` (no timestamp); it overflows
    // + commits. (completed empty, preview = header+body, budget 1.)
    const f1 = splitInlineLedgerModel([], [], [row("Assistant"), row("body")], 1);
    const step1 = computeInlineLedgerStep({
      active: true, hasCommitHandle: true, wasActive: true, forceRebuild: false,
      prior: EMPTY_INLINE_SCROLLBACK_STATE,
      finalizedSections: f1.committedSections, bannerSection: undefined, width: 80,
      identify: identifyInlineCommitSection,
    });
    if (step1.kind !== "commit") throw new Error(`expected commit, got ${step1.kind}`);
    expect(step1.sections.flatMap((s) => s.rows.map((r) => r.text))).toEqual(["Assistant"]);

    // Frame 2 — finalized: header is now `Assistant [02:24 PM]` (timestamp added). With the
    // timestamp-insensitive identify it fingerprints the same as `Assistant` → prefix match
    // → APPEND [body], NOT a full rebuild. (Without the identify this would rebuild.)
    const f2 = splitInlineLedgerModel(
      [{ key: "a", rows: [row("Assistant [02:24 PM]"), row("body")] }],
      [],
      [],
      1,
    );
    const step2 = computeInlineLedgerStep({
      active: true, hasCommitHandle: true, wasActive: true, forceRebuild: false,
      prior: step1.nextState,
      finalizedSections: f2.committedSections, bannerSection: undefined, width: 80,
      identify: identifyInlineCommitSection,
    });
    if (step2.kind !== "commit") throw new Error(`expected commit, got ${step2.kind}`);
    expect(step2.mode).toBe("append"); // NOT "rebuild"
    expect(step2.sections.flatMap((s) => s.rows.map((r) => r.text))).toEqual(["body"]);
  });

  it("BANNER: the ledger commits the banner ONCE (folded above the source), never re-sent", () => {
    // Under inline mixed policy the banner only reaches scrollback via the ledger's
    // bannerSection param — assert it commits first and is not re-committed next frame.
    const banner = { key: "banner", rows: [row("KODAX"), row("v0.7.46")] };
    const f1 = splitInlineLedgerModel([sec("f", ["F1"])], [row("You")], [], 5);
    const step1 = computeInlineLedgerStep({
      active: true, hasCommitHandle: true, wasActive: true, forceRebuild: false,
      prior: EMPTY_INLINE_SCROLLBACK_STATE,
      finalizedSections: f1.committedSections, bannerSection: banner, width: 80,
      identify: identifyInlineCommitSection,
    });
    if (step1.kind !== "commit") throw new Error(`expected commit, got ${step1.kind}`);
    const committed1 = step1.sections.flatMap((s) => s.rows.map((r) => r.text));
    expect(committed1.slice(0, 2)).toEqual(["KODAX", "v0.7.46"]); // banner folded in first
    expect(committed1).toContain("F1");
    expect(committed1).not.toContain("You"); // You is the live tail, not committed

    // Next frame: banner unchanged, a completed row overflows → APPEND only it; banner not re-sent.
    const f2 = splitInlineLedgerModel([sec("f", ["F1"])], [row("You"), row("t1")], [], 1);
    const step2 = computeInlineLedgerStep({
      active: true, hasCommitHandle: true, wasActive: true, forceRebuild: false,
      prior: step1.nextState,
      finalizedSections: f2.committedSections, bannerSection: banner, width: 80,
      identify: identifyInlineCommitSection,
    });
    if (step2.kind !== "commit") throw new Error(`expected commit, got ${step2.kind}`);
    expect(step2.mode).toBe("append");
    const committed2 = step2.sections.flatMap((s) => s.rows.map((r) => r.text));
    expect(committed2).not.toContain("KODAX"); // banner already committed, not re-sent
    expect(committed2).toContain("You");
  });

  it("identifyInlineCommitSection strips the timestamp ONLY from full header rows", () => {
    const fp = (text: string) =>
      identifyInlineCommitSection({ key: "il-0", rows: [{ key: "il-0", text }] }).fingerprint;
    // header rows: streaming `Assistant` and finalized `Assistant [02:24 PM]` align.
    expect(fp("Assistant [02:24 PM]")).toBe(fp("Assistant"));
    expect(fp("You [02:24 PM]")).toBe(fp("You"));
    expect(fp("Assistant [02:24 PM]")).not.toBe(fp("different"));
    // a BODY line that merely ENDS in a time is NOT a header → NOT stripped (stays distinct).
    expect(fp("see you at [02:24 PM]")).not.toBe(fp("see you at"));
    expect(fp("see you at [02:24 PM]")).not.toBe(fp("Assistant"));
  });
});

function assistant(text: string): HistoryItem {
  return {
    id: "assistant-1",
    type: "assistant",
    text,
    timestamp: Date.now(),
  };
}

function user(id: string, text: string): HistoryItem {
  return {
    id,
    type: "user",
    text,
    timestamp: Date.now(),
  };
}

function info(id: string, text: string, icon = "\u23F3"): HistoryItem {
  return {
    id,
    type: "info",
    text,
    icon,
    timestamp: Date.now(),
  };
}

describe("transcript-layout", () => {
  it("collapses a trailing newline so only the fixed spacer separates the answer from the next block", () => {
    // Models frequently end their output with a trailing newline. Without
    // normalization `wrapText` turns it into an empty body row, which stacks
    // on top of the fixed `-blank` spacer → two blank lines between the
    // answer and the next tool/assistant block instead of one.
    const rows = buildTranscriptRows({
      items: [assistant("answer body\n")],
      viewportWidth: 80,
    });

    const bodyRows = rows.filter((row) => row.key.startsWith("assistant-1-body"));
    expect(bodyRows).toHaveLength(1);
    expect(bodyRows[0]?.text).toBe("answer body");
    expect(bodyRows.some((row) => row.text.trim() === "")).toBe(false);
    expect(rows.filter((row) => row.key === "assistant-1-blank")).toHaveLength(1);
  });

  it("preserves internal paragraph breaks while trimming the outer trailing newline", () => {
    const rows = buildTranscriptRows({
      items: [assistant("para one\n\npara two\n")],
      viewportWidth: 80,
    });

    const bodyText = rows
      .filter((row) => row.key.startsWith("assistant-1-body"))
      .map((row) => row.text);
    expect(bodyText).toEqual(["para one", "", "para two"]);
  });

  it("preserves the final assistant line without a trailing newline", () => {
    const rows = buildTranscriptRows({
      items: [assistant("## Verify\n\n```bash\nmysql -h 127.0.0.1 -P 13306\n```\n\nFinal line must stay visible")],
      viewportWidth: 80,
    });

    expect(rows.some((row) => row.text.includes("Final line must stay visible"))).toBe(true);
  });

  it("keeps persisted assistant output intact even when compact maxLines is small", () => {
    const rows = buildTranscriptRows({
      items: [assistant(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"))],
      viewportWidth: 80,
      maxLines: 5,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("line 8");
    expect(text).not.toContain("more lines");
  });

  it("keeps the latest rows when slicing a transcript viewport", () => {
    const rows = buildTranscriptRows({
      items: [assistant(["one", "two", "three", "four", "five", "tail line"].join("\n"))],
      viewportWidth: 80,
    });

    const visible = getVisibleTranscriptRows(rows, 3);
    const text = visible.map((row) => row.text).join("\n");

    expect(text).toContain("tail line");
    expect(text).not.toContain("one");
  });

  it("supports scrolling upward from the bottom with an explicit offset", () => {
    const rows = buildTranscriptRows({
      items: [assistant(["one", "two", "three", "four", "five", "tail line"].join("\n"))],
      viewportWidth: 80,
    });

    const visible = getVisibleTranscriptRows(rows, 3, 3);
    const text = visible.map((row) => row.text).join("\n");

    expect(text).toContain("three");
    expect(text).not.toContain("tail line");
  });

  it("renders info items in a compact single-line-first format", () => {
    const rows = buildTranscriptRows({
      items: [info("info-1", "Stream stalled · retry 1/3 in 2s")],
      viewportWidth: 80,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("\u23F3 Stream stalled · retry 1/3 in 2s");
    expect(text).not.toContain("Info");
  });

  it("keeps compact info text by default but expands full info content in transcript show-all mode", () => {
    const item: HistoryItem = {
      id: "info-detail-1",
      type: "info",
      text: "AMA Planner - Planner completed: compact summary\n\nFull planner detail line 1\nFull planner detail line 2",
      compactText: "AMA Planner - Planner completed: compact summary",
      icon: ">",
      timestamp: Date.now(),
    };

    const compactRows = buildTranscriptRows({
      items: [item],
      viewportWidth: 80,
    });
    const compactText = compactRows.map((row) => row.text).join("\n");
    expect(compactText).toContain("> AMA Planner - Planner completed: compact summary");
    expect(compactText).not.toContain("Full planner detail line 2");

    const expandedRows = buildTranscriptRows({
      items: [item],
      viewportWidth: 80,
      showAllContent: true,
    });
    const expandedText = expandedRows.map((row) => row.text).join("\n");
    expect(expandedText).toContain("Full planner detail line 1");
    expect(expandedText).toContain("Full planner detail line 2");
  });

  it("keeps the icon on the same row as the message when an info item has a leading blank line", () => {
    // Slash-command output captured into an info item keeps its leading
    // newline (e.g. console.log(chalk.cyan("\n[Switched ...]"))). The icon
    // must not end up alone on its own row.
    const esc = String.fromCharCode(27);
    const item: HistoryItem = {
      id: "info-leading-blank",
      type: "info",
      text: `${esc}[36m\n[Switched to minimax-coding/MiniMax-M3] (saved)${esc}[39m`,
      timestamp: Date.now(),
    };

    const rows = buildTranscriptRows({ items: [item], viewportWidth: 80 });
    const bodyRows = rows.filter(
      (row) => row.itemId === "info-leading-blank" && row.text.trim() !== "",
    );

    // Exactly one content row, and it carries BOTH the icon and the message.
    expect(bodyRows).toHaveLength(1);
    expect(bodyRows[0].text).toContain("ℹ");
    expect(bodyRows[0].text).toContain("[Switched to minimax-coding/MiniMax-M3] (saved)");
  });

  it("includes streaming and loading rows in a single transcript", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 60,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
      thinkingContent: "thinking details",
      // FEATURE_149 (v0.7.38) line-buffered streaming: trailing newline so
      // the "partial response" line is treated as a COMPLETE line and
      // surfaces in the render. A token stream without a trailing newline
      // is intentionally suppressed (mirrors Claude Code's REPL.tsx:1473).
      streamingResponse: "partial response\n",
      currentIteration: 2,
      iterationHistory: [
        {
          iteration: 1,
          thinkingSummary: "summary",
          thinkingLength: 120,
          response: "response snippet",
          toolsUsed: ["read_file"],
        },
      ],
      currentTool: "read_file",
      toolInputCharCount: 12,
      toolInputContent: "path/to/file",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("Round 1");
    expect(text).toContain("thinking details");
    expect(text).toContain("partial response");
    expect(text).toContain("read_file");
    expect(text).toContain("* tools: read_file");
  });

  it("renders copyable live status lines when live progress rows are enabled", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      liveStatusLines: [
        "workflow feature-audit (run-123) - 1/2 active",
        "Plan 1/3 completed",
      ],
      showLiveProgressRows: true,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("Live status");
    expect(text).toContain("workflow feature-audit");
    expect(text).toContain("Plan 1/3 completed");
  });

  it("does not render live status lines when live progress rows are disabled", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      liveStatusLines: ["Plan 1/3 completed"],
      showLiveProgressRows: false,
    });

    expect(rows.map((row) => row.text).join("\n")).not.toContain("Plan 1/3 completed");
  });

  // FEATURE_149 (v0.7.38) — activeForm-driven spinner. Mirrors CC's
  // Spinner.tsx:169 `currentTodo?.activeForm` lookup. When the todo store
  // has an in_progress item with `activeForm`, the spinner shows that
  // verb in place of the generic fallback / currentTool / isThinking.
  describe("activeForm-driven spinner (FEATURE_149 C4)", () => {
    it("uses currentTodoActiveForm in the spinner line when supplied", () => {
      const rows = buildTranscriptRows({
        items: [],
        viewportWidth: 80,
        isLoading: true,
        currentTodoActiveForm: "Running failing tests",
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("Running failing tests");
      expect(text).toContain("[Plan]");
    });

    it("activeForm preempts the generic currentTool fallback", () => {
      const rows = buildTranscriptRows({
        items: [],
        viewportWidth: 80,
        isLoading: true,
        currentTool: "read",
        toolInputContent: "/path/to/file",
        toolInputCharCount: 12,
        currentTodoActiveForm: "Refactoring auth module",
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("Refactoring auth module");
      // The generic [Tool] read prefix should NOT win when activeForm wins.
      expect(text).not.toMatch(/\[Tool\]\s+read/);
    });

    it("falls back to currentTool when no activeForm provided", () => {
      const rows = buildTranscriptRows({
        items: [],
        viewportWidth: 80,
        isLoading: true,
        currentTool: "read",
        toolInputContent: "/path/to/file",
        toolInputCharCount: 12,
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("[Tool]");
    });

    it("compacting still beats activeForm (top-priority preserved)", () => {
      const rows = buildTranscriptRows({
        items: [],
        viewportWidth: 80,
        isLoading: true,
        isCompacting: true,
        currentTodoActiveForm: "Should not appear while compacting",
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("Compacting");
      expect(text).not.toContain("Should not appear");
    });
  });

  // FEATURE_149 (v0.7.38) — line-buffered streaming. Mirrors Claude Code's
  // REPL.tsx:1473 `streamingText.substring(0, lastIndexOf('\n')+1)`. While
  // a token stream is in flight, only complete lines (those ending in `\n`)
  // are shown so the in-progress line doesn't flicker character by character.
  describe("line-buffered streaming render", () => {
    it("hides streamingResponse with no newline (in-flight line suppressed)", () => {
      const rows = buildTranscriptRows({
        items: [],
        viewportWidth: 60,
        isLoading: true,
        streamingResponse: "still typing without newline",
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).not.toContain("still typing without newline");
      // Header should also be suppressed when there's nothing visible to show.
      expect(text).not.toContain("Assistant");
    });

    it("renders ONLY the complete-line prefix of streamingResponse", () => {
      const rows = buildTranscriptRows({
        items: [],
        viewportWidth: 80,
        isLoading: true,
        streamingResponse: "first complete line\nsecond complete line\nthird in pro",
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("first complete line");
      expect(text).toContain("second complete line");
      // The in-progress trailing line is suppressed until its `\n` arrives.
      expect(text).not.toContain("third in pro");
    });

    it("renders all lines once streamingResponse ends with a newline", () => {
      const rows = buildTranscriptRows({
        items: [],
        viewportWidth: 80,
        isLoading: true,
        streamingResponse: "alpha\nbeta\ngamma\n",
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
      expect(text).toContain("gamma");
    });
  });

  it("keeps managed live events out of transcript live render models while preserving actual streaming content", () => {
    const model = buildTranscriptRenderModel({
      items: [assistant("Previous review round finished.")],
      managedLiveEvents: [
        {
          id: "managed-event-1",
          type: "event",
          timestamp: Date.now(),
          icon: ">",
          text: "Generator isolated two suspicious call sites.\nDetailed call-site notes remain available for expansion.",
          compactText: "Generator isolated two suspicious call sites.",
        },
      ],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 84,
      thinkingContent: "Verifying that the live transcript keeps progress events and final review text visible together.",
      // FEATURE_149 line-buffered streaming — \n required for the line to surface.
      streamingResponse: "Found 2 must-fix issues.\n",
      showFullThinking: true,
      showLiveProgressRows: true,
    });

    const text = renderedText(model);
    expect(text).toContain("Previous review round finished.");
    expect(text).toContain("Verifying that the live transcript keeps progress events");
    expect(text).toContain("Found 2 must-fix issues.");
    expect(text).not.toContain("Generator isolated two suspicious call sites.");
  });

  it("ignores managed live thinking and assistant summaries in compact transcript mode", () => {
    const model = buildTranscriptRenderModel({
      items: [assistant("Previous review round finished.")],
      managedLiveEvents: [
        {
          id: "managed-thinking-1",
          type: "thinking",
          timestamp: Date.now(),
          text: "Scout thinking: full hidden reasoning detail that should stay out of compact transcript mode.",
          compactText: "Scout thinking: tracing the protocol fallback path.",
        },
        {
          id: "managed-assistant-1",
          type: "assistant",
          timestamp: Date.now(),
          text: "Planner: full hidden worker summary detail that should stay out of compact transcript mode.",
          compactText: "Planner: narrowed the diff review to task-engine.ts and InkREPL.tsx.",
        },
      ] as any,
      viewportWidth: 80,
      isLoading: false,
      showLiveProgressRows: true,
    });

    const text = renderedText(model);
    expect(text).toContain("Previous review round finished.");
    expect(text).not.toContain("Scout thinking: tracing the protocol fallback path.");
    expect(text).not.toContain("Planner: narrowed the diff review to task-engine.ts and InkREPL.tsx.");
    expect(text).not.toContain("full hidden worker summary detail");
  });

  it("can suppress prompt-surface live progress rows while keeping streamed content", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 60,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
      thinkingContent: "thinking details",
      // FEATURE_149 line-buffered streaming — \n required.
      streamingResponse: "partial response\n",
      currentIteration: 2,
      iterationHistory: [
        {
          iteration: 1,
          thinkingSummary: "summary",
          thinkingLength: 120,
          response: "response snippet",
          toolsUsed: ["read_file"],
        },
      ],
      currentTool: "read_file",
      activeToolCalls: [
        {
          id: "tool-1",
          name: "read_file",
          status: ToolCallStatus.Executing,
          input: { path: "path/to/file" },
          startTime: Date.now(),
        },
      ],
      toolInputCharCount: 12,
      toolInputContent: "path/to/file",
      showLiveProgressRows: false,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("partial response");
    expect(text).toContain("thinking details");
    expect(text).toContain("read_file - path/to/file");
    expect(text).not.toContain("Round 1");
    expect(text).not.toContain("* tools: read_file");
  });

  it("shows thinking char counts while the model is still thinking", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 60,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[Thinking] 42 chars...");
  });

  it("truncates live thinking to a 400 character preview", () => {
    const thinking = "A".repeat(450);
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingContent: thinking,
      thinkingCharCount: thinking.length,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("thinking truncated; press Ctrl+O to inspect full reasoning");
    expect(text).not.toContain("A".repeat(430));
  });

  it("shows full thinking in transcript mode", () => {
    const thinking = "B".repeat(450);
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingContent: thinking,
      thinkingCharCount: thinking.length,
      showFullThinking: true,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text.replace(/\n/g, "")).toContain("B".repeat(430));
    expect(text).not.toContain("thinking truncated; press Ctrl+O to inspect full reasoning");
  });

  it("shows full thinking when transcript show-all mode is active", () => {
    const thinking = "C".repeat(450);
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingContent: thinking,
      thinkingCharCount: thinking.length,
      showAllContent: true,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text.replace(/\n/g, "")).toContain("C".repeat(430));
    expect(text).not.toContain("thinking truncated; press Ctrl+O to inspect full reasoning");
  });

  it("truncates persisted thinking blocks in compact mode using transcript maxLines (collapse disabled)", () => {
    // FEATURE_220: the default now collapses a multi-line finalized thinking block
    // to a single summary line. This test pins the LEGACY multi-line preview path,
    // reachable via KODAX_THINKING_COLLAPSE=0.
    vi.stubEnv("KODAX_THINKING_COLLAPSE", "0");
    try {
      const rows = buildTranscriptRows({
        items: [
          {
            id: "thinking-1",
            type: "thinking",
            text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
            timestamp: Date.now(),
          },
        ],
        viewportWidth: 80,
        maxLines: 5,
      });

      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("line 1");
      expect(text).toContain("line 5");
      expect(text).toContain("thinking truncated; press Ctrl+O to inspect full reasoning");
      expect(text).not.toContain("line 6");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not truncate persisted thinking blocks when full thinking is enabled", () => {
    const rows = buildTranscriptRows({
      items: [
        {
          id: "thinking-2",
          type: "thinking",
          text: Array.from({ length: 8 }, (_, index) => `detail ${index + 1}`).join("\n"),
          timestamp: Date.now(),
        },
      ],
      viewportWidth: 80,
      maxLines: 5,
      showFullThinking: true,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("detail 8");
    expect(text).not.toContain("thinking truncated; press Ctrl+O to inspect full reasoning");
  });

  it("does not truncate tool output when transcript show-all mode is active", () => {
    const output = Array.from({ length: 12 }, (_, index) => `output ${index + 1}`).join("\n");
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-1",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "tool-1",
              name: "bash",
              status: ToolCallStatus.Success,
              input: { command: "echo test" },
              output,
              startTime: Date.now(),
            },
          ],
        },
      ],
      viewportWidth: 80,
      showDetailedTools: true,
      showAllContent: true,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("output 12");
    expect(text).not.toContain("more lines");
  });

  it("renders a colored inline diff for edit results by default (no show-all)", () => {
    const output = [
      "Active file changed on disk: /repo/src/foo.ts",
      "File edited: /repo/src/foo.ts (1 replacements)",
      "  (+2 lines, -1 lines)",
      "",
      "--- /repo/src/foo.ts",
      "+++ /repo/src/foo.ts",
      "@@ -42,3 +42,4 @@",
      "  function processInput(input) {",
      "- return input.toLowerCase();",
      "+ if (!input) return '';",
      "+ return input.trim();",
      "  }",
    ].join("\n");
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-edit",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "edit-1",
              name: "edit",
              status: ToolCallStatus.Success,
              input: { file_path: "/repo/src/foo.ts" },
              output,
              startTime: Date.now(),
            },
          ],
        },
      ],
      viewportWidth: 80,
      // Crucially NOT showDetailedTools — diff must show by default.
    });

    const added = rows.find((r) => r.text.includes("return input.trim();"));
    const removed = rows.find((r) => r.text.includes("return input.toLowerCase();"));
    expect(added?.color).toBe("success");
    expect(removed?.color).toBe("error");
    // Diff rows carry background bars for the renderer to resolve.
    expect(added?.bg).toBe("diffAdd");
    expect(removed?.bg).toBe("diffRemove");
    const context = rows.find((r) => r.text.includes("function processInput"));
    // Context rows have no band and must stay legible solo: muted prose gray,
    // never "dim" (the renderer stacks dimColor on "dim" → unreadable).
    expect(context?.color).toBe("thinking");
    expect(context?.bg).toBeUndefined();
    // Gutter line numbers are derived from the @@ header (new side for
    // added, old side for removed) — @@ -42,3 +42,4 @@ puts the removal
    // at old 43 and the last addition at new 44.
    expect(added?.text.startsWith("44 │ +")).toBe(true);
    expect(removed?.text.startsWith("43 │ -")).toBe(true);
    // Banner/note rows stay intentionally quiet: "dim" is fine here because
    // notes are never banded (no dimColor-on-bg readability trap).
    const note = rows.find((r) => r.text.includes("changed on disk"));
    expect(note?.color).toBe("dim");
    expect(note?.bg).toBeUndefined();
    // The redundant `--- ` / `+++ ` file headers are dropped.
    expect(rows.some((r) => r.text.startsWith("--- "))).toBe(false);
    expect(rows.some((r) => r.text.startsWith("+++ "))).toBe(false);
  });

  it("does not render diff rows for a write that creates a new file (no diff)", () => {
    const output = "File created: /repo/src/new.ts\n  (12 lines written)";
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-write",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "write-1",
              name: "write",
              status: ToolCallStatus.Success,
              input: { file_path: "/repo/src/new.ts" },
              output,
              startTime: Date.now(),
            },
          ],
        },
      ],
      viewportWidth: 80,
    });

    // No +/- diff content → pushDiffRows bails and emits no diff body. (The
    // `✓ write` main status row is legitimately success-colored, so we assert
    // on the diff-row keys rather than on color.)
    expect(rows.some((r) => r.key.includes("-diff-"))).toBe(false);
  });

  it("does not color-diff non-mutation tool output content", () => {
    const output = "- a normal bullet\n+ another bullet";
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-bash",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "bash-1",
              name: "bash",
              status: ToolCallStatus.Success,
              input: { command: "echo hi" },
              output,
              startTime: Date.now(),
            },
          ],
        },
      ],
      viewportWidth: 80,
      showDetailedTools: true,
    });

    // bash is not a mutation tool: its output lines render as plain dim text,
    // never tinted success/error like a diff would be. (The `✓ bash` status
    // row is legitimately success-colored — assert on the content rows.)
    const bulletRows = rows.filter((r) => r.text.includes("bullet"));
    expect(bulletRows.length).toBeGreaterThan(0);
    expect(bulletRows.every((r) => r.color === "dim")).toBe(true);
  });

  it("shows AMA active worker in the live thinking row", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
      managedRound: 2,
      managedMaxRounds: 6,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Planner] 42 chars round 2/6...");
    expect(text).not.toContain("[AMA H2");
  });

  it("uses a neutral Scout prefix during preflight instead of leaking the final harness", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
      managedAgentMode: "ama",
      managedPhase: "preflight",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Scout",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Scout] 42 chars...");
    expect(text).not.toContain("[AMA H2");
  });

  it("uses [AMA Worker] preflight prefix on V2 (managedWorkerTitle === 'Worker')", () => {
    // FEATURE_114 v0.7.38 Slice 7 — Worker is the V2 entry agent and
    // the runner emits `activeWorkerTitle: 'Worker'` on preflight.
    // The transcript spinner must reflect that instead of falling
    // back to the V1 hardcoded 'Scout'.
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
      managedAgentMode: "ama",
      managedPhase: "preflight",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Worker",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Worker] 42 chars...");
    expect(text).not.toContain("[AMA Scout");
  });

  it("uses a neutral routing prefix before Scout confirms the final harness", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 100,
      isLoading: true,
      currentTool: "changed_scope",
      managedAgentMode: "ama",
      managedPhase: "routing",
      managedHarnessProfile: "H1_EXECUTE_EVAL",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Routing] [Tools] changed_scope...");
    expect(text).not.toContain("[AMA H1");
  });

  it("renders a Verifying prefix while the sidecar verifier is running (FEATURE_184 D.3)", () => {
    // While the Sidecar Verifier Stop hook awaits its LLM call, the
    // observer emits `phase: 'verifying'`. The spinner row must not
    // misattribute the wait to the Worker — it should render
    // `[AMA Verifying] checking agent output...` even when the
    // harnessProfile + workerTitle from the prior turn are still set.
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 100,
      isLoading: true,
      managedAgentMode: "ama",
      managedPhase: "verifying",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Worker",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Verifying] checking agent output...");
    expect(text).not.toContain("[AMA H2");
    expect(text).not.toContain("Worker");
  });

  it("does NOT render any Verifying row when isLoading is false (FEATURE_184 D.3 precondition)", () => {
    // The sidecar window always implies an active spinner — when
    // `isLoading` is false the spinner cascade is gated off entirely
    // (`if (isLoading)` at the top of the live-rows block). This pin
    // catches a future regression where someone moves the `verifying`
    // branch outside the `isLoading` gate and accidentally bleeds a
    // stale `[AMA Verifying]` prefix into a non-spinner row.
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 100,
      isLoading: false,
      managedAgentMode: "ama",
      managedPhase: "verifying",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Worker",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).not.toContain("Verifying");
    expect(text).not.toContain("checking agent output");
  });

  it("does not leak round 1/2 in the initial AMA live thinking row", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      thinkingCharCount: 42,
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
      managedRound: 1,
      managedMaxRounds: 2,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Planner] 42 chars...");
    expect(text).not.toContain("[AMA H2");
    expect(text).not.toContain("round 1/2");
  });

  it("falls back to the last live activity label when thinking has no visible chars yet", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      isThinking: true,
      lastLiveActivityLabel: "[Planner] changed_diff_bundle",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[Thinking] [Planner] changed_diff_bundle...");
  });

  it("shows AMA active worker in the live tool row", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 80,
      isLoading: true,
      currentTool: "changed_diff",
      toolInputCharCount: 18,
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Planner] [Tools] changed_diff (18 chars)...");
    expect(text).not.toContain("[AMA H2");
  });

  it("formats tool rows with progress for active tools", () => {
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-1",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "tool-1",
              name: "write_file",
              status: ToolCallStatus.Executing,
              startTime: Date.now(),
              progress: 50,
              error: "denied",
            },
          ],
        },
      ],
      viewportWidth: 80,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("write_file (running - 50%)");
    expect(text).toContain("Progress: 50% complete");
  });

  it("adds a compact waiting explanation for approval-blocked tools", () => {
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-awaiting",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "tool-awaiting",
              name: "write_file",
              status: ToolCallStatus.AwaitingApproval,
              startTime: Date.now(),
            },
          ],
        },
      ],
      viewportWidth: 80,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("write_file (awaiting approval)");
    expect(text).toContain("Waiting: approval required before execution");
  });

  it("adds compact last-output context for failed tools without opening detailed review", () => {
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-3",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "tool-3",
              name: "bash",
              status: ToolCallStatus.Error,
              startTime: Date.now(),
              error: "permission denied",
              output: "fatal: permission denied\nstack trace line 2",
            },
          ],
        },
      ],
      viewportWidth: 80,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("bash (failed)");
    expect(text).toContain("Error: permission denied");
    expect(text).toContain("Last output: fatal: permission denied");
  });

  it("formats tool summaries from structured preview text in tool groups", () => {
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-2",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "tool-2",
              name: "[Planner] changed_diff_bundle",
              status: ToolCallStatus.Success,
              startTime: 1_000,
              endTime: 1_010,
              input: {
                preview: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
              },
            },
          ],
        },
      ],
      viewportWidth: 100,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[Planner] changed_diff_bundle");
    expect(text).toContain("packages/coding/src/task-engine.ts");
    expect(text).toContain("limit=120");
    expect(text).toContain("(10ms)");
  });

  it("shows detailed tool output only when transcript mode is enabled", () => {
    const baseTool = {
      id: "tool-3",
      name: "[Lead] changed_diff",
      status: ToolCallStatus.Success,
      startTime: 1_000,
      endTime: 1_010,
      input: {
        preview: "{\"path\":\"packages/coding/src/task-engine.ts\",\"offset\":1171,\"limit\":120}",
      },
      output: "Changed diff for packages/coding/src/task-engine.ts\nShowing diff lines 1171-1320 of 3096\n+ const example = true;",
    };

    const normalRows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-3",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [baseTool],
        },
      ],
      viewportWidth: 100,
    });

    const reviewRows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-4",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [baseTool],
        },
      ],
      viewportWidth: 100,
      showDetailedTools: true,
    });

    const normalText = normalRows.map((row) => row.text).join("\n");
    expect(normalText).toContain("Diff range: 1171-1320 of 3096");
    expect(normalText).toContain("Preview: + const example = true;");
    expect(normalText).not.toContain("Showing diff lines 1171-1320 of 3096");
    expect(reviewRows.map((row) => row.text).join("\n")).toContain("Showing diff lines 1171-1320 of 3096");
  });

  it("shows compact bundle explanations for successful diff bundles", () => {
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-bundle",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "tool-bundle-1",
              name: "[Planner] changed_diff_bundle",
              status: ToolCallStatus.Success,
              startTime: 1_000,
              endTime: 1_010,
              input: {
                preview: "{\"paths\":[\"packages/a.ts\",\"packages/b.ts\"],\"limit_per_path\":120}",
              },
              output: [
                "Changed diff bundle for 2 file(s)",
                "=== packages/a.ts ===",
                "+ const a = 1;",
              ].join("\n"),
            },
          ],
        },
      ],
      viewportWidth: 100,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("Bundle: 2 files");
    expect(text).toContain("First file: packages/a.ts");
  });

  it("shows detailed tool input previews when the transcript is expanded", () => {
    const rows = buildTranscriptRows({
      items: [
        {
          id: "tool-group-input",
          type: "tool_group",
          timestamp: Date.now(),
          tools: [
            {
              id: "tool-input-1",
              name: "changed_diff",
              status: ToolCallStatus.Success,
              startTime: 1_000,
              endTime: 1_010,
              input: {
                path: "packages/repl/src/ui/InkREPL.tsx",
                offset: 42,
                limit: 80,
              },
            },
          ],
        },
      ],
      viewportWidth: 100,
      showDetailedTools: true,
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("input:");
    expect(text).toContain("\"path\": \"packages/repl/src/ui/InkREPL.tsx\"");
  });

  it("shows compact live tool summaries when tool input preview is available", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 100,
      isLoading: true,
      currentTool: "changed_diff_bundle",
      toolInputContent: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Planner] [Tools] changed_diff_bundle - packages/coding/src/task-engine.ts - limit=120...");
    expect(text).not.toContain("[AMA H2");
  });

  it("renders a live multi-tool block for concurrent tools", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 140,
      isLoading: true,
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Scout",
      activeToolCalls: [
        {
          id: "tool-1",
          name: "[Scout] changed_scope",
          status: ToolCallStatus.Success,
          startTime: 100,
          endTime: 184,
          input: { paths: ["packages/coding/src"] },
        },
        {
          id: "tool-2",
          name: "[Scout] repo_overview",
          status: ToolCallStatus.Executing,
          startTime: 120,
          input: { path: "packages/coding/src" },
        },
        {
          id: "tool-3",
          name: "[Scout] read",
          status: ToolCallStatus.Executing,
          startTime: 130,
          input: {
            path: "packages/coding/src/task-engine.ts",
            offset: 3160,
            limit: 80,
          },
        },
      ],
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[AMA Scout] [Tools] 2 running, 1 done");
    expect(text).not.toContain("[AMA H2");
    expect(text).toContain("[Scout] changed_scope - packages/coding/src (84ms)");
    expect(text).toContain("[Scout] repo_overview - packages/coding/src");
    expect(text).toContain("[Scout] read - packages/coding/src/task-engine.ts - offset=3160 - limit=80");
    expect(text).toContain("Running: waiting for tool output");
  });

  it("keeps the completed live tool block visible until the response starts", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 140,
      isLoading: true,
      activeToolCalls: [
        {
          id: "tool-1",
          name: "[Scout] changed_scope",
          status: ToolCallStatus.Success,
          startTime: 100,
          endTime: 184,
          input: { paths: ["packages/coding/src"] },
        },
        {
          id: "tool-2",
          name: "[Scout] read",
          status: ToolCallStatus.Success,
          startTime: 120,
          endTime: 210,
          input: {
            path: "packages/coding/src/task-engine.ts",
            offset: 3160,
            limit: 80,
          },
        },
      ],
      lastLiveActivityLabel: "[Tools] [Scout] read - packages/coding/src/task-engine.ts - offset=3160 - limit=80 (90ms)",
    });

    const text = rows.map((row) => row.text).join("\n");
    expect(text).toContain("[Tools] 2 done");
    expect(text).toContain("[Scout] changed_scope - packages/coding/src (84ms)");
    expect(text).toContain("[Scout] read - packages/coding/src/task-engine.ts - offset=3160 - limit=80 (90ms)");
  });

  it("prefers the last live tool activity label while a tool is active", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 140,
      isLoading: true,
      currentTool: "changed_diff_bundle",
      toolInputContent: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
      lastLiveActivityLabel: "[Tools] [Planner] changed_diff_bundle - 4 files - packages/repl/src/ui/utils/message-utils.ts (107ms)",
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    const text = rows.map((row) => row.text).join("\n").replace(/\n/g, " ");
    expect(text).toContain("[AMA Planner] [Tools] changed_diff_bundle - 4 files - packages/repl/src/ui/utils/message-utils.ts (107ms)...");
    expect(text).not.toContain("[AMA Planner] [Tools] [Planner]");
    expect(text).not.toContain("[AMA H2");
  });

  it("does not repeat the active worker in AMA live tool labels", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 140,
      isLoading: true,
      currentTool: "changed_diff",
      lastLiveActivityLabel: "[Tools] [Generator] changed_diff - packages/coding/src/task-engine.ts - offset=1775 - limit=480",
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Generator",
    });

    const text = rows.map((row) => row.text).join("\n").replace(/\n/g, " ");
    expect(text).toContain("[AMA Generator] [Tools] changed_diff - packages/coding/src/task-engine.ts - offset=1775 - limit=480...");
    expect(text).not.toContain("[AMA Generator] [Tools] [Generator]");
    expect(text).not.toContain("[AMA H2");
  });

  it("does not repeat the active worker in AMA live thinking labels", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 120,
      isLoading: true,
      isThinking: true,
      lastLiveActivityLabel: "[Thinking] [Planner]",
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    const text = rows.map((row) => row.text).join("\n").replace(/\n/g, " ");
    expect(text).toContain("[AMA Planner] [Thinking]...");
    expect(text).not.toContain("[AMA Planner] [Thinking] [Planner]");
    expect(text).not.toContain("[AMA H2");
  });

  it("normalizes lowercase thinking activity labels to [Thinking]", () => {
    const rows = buildTranscriptRows({
      items: [],
      viewportWidth: 120,
      isLoading: true,
      isThinking: true,
      lastLiveActivityLabel: "[Planner] thinking",
      managedAgentMode: "ama",
      managedHarnessProfile: "H2_PLAN_EXECUTE_EVAL",
      managedWorkerTitle: "Planner",
    });

    const text = rows.map((row) => row.text).join("\n").replace(/\n/g, " ");
    expect(text).toContain("[AMA Planner] [Thinking]...");
    expect(text).not.toContain("[AMA Planner] thinking...");
    expect(text).not.toContain("[AMA H2");
  });

  it("builds transcript sections that preserve row order when flattened", () => {
    const staticSections = buildStaticTranscriptSections(
      [
        {
          id: "user-1",
          type: "user",
          text: "prompt",
          timestamp: Date.now(),
        },
      ],
      80
    );
    const activeSection = buildDynamicTranscriptSection("active", {
      items: [assistant("answer")],
      viewportWidth: 80,
    });

    const rows = flattenTranscriptSections([...staticSections, activeSection]);
    const text = rows.map((row) => row.text).join("\n");

    expect(staticSections).toHaveLength(1);
    expect(activeSection.rows.length).toBeGreaterThan(0);
    expect(text.indexOf("prompt")).toBeLessThan(text.indexOf("answer"));
  });

  it("creates one transcript section per history item", () => {
    const sections = buildHistoryItemTranscriptSections(
      [
        {
          id: "user-1",
          type: "user",
          text: "prompt",
          timestamp: Date.now(),
        },
        {
          id: "assistant-1",
          type: "assistant",
          text: "answer",
          timestamp: Date.now(),
        },
      ],
      80
    );

    expect(sections).toHaveLength(2);
    expect(sections[0]?.key).toBe("user-1");
    expect(sections[1]?.key).toBe("assistant-1");
    expect(sections[0]?.rows.some((row) => row.text.includes("prompt"))).toBe(true);
    expect(sections[1]?.rows.some((row) => row.text.includes("answer"))).toBe(true);
  });

  it("builds a windowed transcript render model with rows owned outside MessageList", () => {
    const model = buildTranscriptRenderModel({
      items: [
        {
          id: "user-1",
          type: "user",
          text: "prompt",
          timestamp: Date.now(),
        },
        {
          id: "assistant-1",
          type: "assistant",
          text: "answer",
          timestamp: Date.now(),
        },
      ],
      viewportWidth: 80,
      windowed: true,
    });

    const text = model.rows.map((row) => row.text).join("\n");
    expect(model.staticSections).toHaveLength(0);
    expect(text).toContain("prompt");
    expect(text).toContain("answer");
  });

  it("materializes static transcript sections into inline rows for main-screen transcript surfaces", () => {
    const model = buildTranscriptRenderModel({
      items: [
        user("user-1", "first prompt"),
        assistant("first answer"),
        user("user-2", "second prompt"),
        assistant("second answer"),
      ],
      viewportWidth: 80,
      windowed: false,
      showDetailedTools: true,
    });

    expect(model.staticSections.length).toBeGreaterThan(0);

    const materialized = materializeTranscriptRenderModel(model);
    const text = materialized.rows.map((row) => row.text).join("\n");

    expect(materialized.staticSections).toHaveLength(0);
    expect(text).toContain("first prompt");
    expect(text).toContain("first answer");
    expect(text).toContain("second prompt");
    expect(text).toContain("second answer");
  });

  it("keeps only the most recent user-defined rounds", () => {
    const items: HistoryItem[] = [
      user("user-1", "round 1"),
      assistant("answer 1"),
      user("user-2", "round 2"),
      assistant("answer 2"),
      user("user-3", "round 3"),
      assistant("answer 3"),
    ];

    const visible = sliceHistoryToRecentRounds(items, 2);
    const text = visible.map((item) => ("text" in item ? item.text : "")).join("\n");

    expect(text).toContain("round 2");
    expect(text).toContain("round 3");
    expect(text).not.toContain("round 1");
  });

  it("does not count restored UI-only user commands as visible conversation rounds", () => {
    const canonical = [
      user("user-1", "round 1"),
      assistant("answer 1"),
      user("user-2", "round 2"),
      assistant("answer 2"),
    ];
    const commands = Array.from({ length: 25 }, (_, index): HistoryItem => ({
      ...user(`quit-${index}`, "/quit"),
      isSessionUiOnly: true,
    }));

    const visible = sliceHistoryToRecentRounds([...canonical, ...commands], 2);

    expect(visible.some((item) => item.id === "user-1")).toBe(true);
    expect(visible.filter((item) => item.isSessionUiOnly)).toHaveLength(25);
  });

  it("preserves UI-only tails in addition to the transcript-mode canonical item cap", () => {
    const canonical = Array.from({ length: 40 }, (_, index) => assistant(`answer-${index}`));
    const commands = Array.from({ length: 25 }, (_, index): HistoryItem => ({
      ...user(`quit-${index}`, "/quit"),
      isSessionUiOnly: true,
    }));

    const visible = sliceHistoryToRecentCanonicalItems([...canonical, ...commands], 30);

    expect(visible.filter((item) => !item.isSessionUiOnly)).toHaveLength(30);
    expect(visible.filter((item) => item.isSessionUiOnly)).toHaveLength(25);
  });

  it("adds UI-only entries to the static transcript cap instead of charging canonical capacity", () => {
    const canonical = Array.from({ length: 150 }, (_, index) => assistant(`answer-${index}`));
    const commands = Array.from({ length: 50 }, (_, index): HistoryItem => ({
      ...user(`quit-${index}`, "/quit"),
      isSessionUiOnly: true,
    }));

    expect(transcriptRenderCapForHistory([...canonical, ...commands])).toBe(250);
  });

  it("caps review history by transcript row budget", () => {
    const items: HistoryItem[] = [
      assistant(["line 1", "line 2", "line 3"].join("\n")),
      assistant(["line 4", "line 5", "line 6"].join("\n")),
      assistant(["line 7", "line 8", "tail"].join("\n")),
    ];

    const visible = capHistoryByTranscriptRows(items, 80, 8);
    const text = visible.map((item) => ("text" in item ? item.text : "")).join("\n");

    expect(text).toContain("tail");
    expect(text).not.toContain("line 1");
  });

  describe("FEATURE_060 Track 3: bounded transcript materialization", () => {
    it("exports finite hard-cap constants suitable for replacing POSITIVE_INFINITY", () => {
      // Sanity: these constants are real numbers, not Infinity / NaN — the
      // whole point of the FEATURE_060 Tier 1 fix is that the show-all
      // budget is a finite ceiling.
      expect(Number.isFinite(TRANSCRIPT_HARD_LINE_CAP)).toBe(true);
      expect(Number.isFinite(THINKING_SHOW_ALL_HARD_CHAR_CAP)).toBe(true);
      expect(TRANSCRIPT_HARD_LINE_CAP).toBeGreaterThan(0);
      expect(THINKING_SHOW_ALL_HARD_CHAR_CAP).toBeGreaterThan(0);
    });

    it("under showAllContent, an oversized thinking block is truncated at THINKING_SHOW_ALL_HARD_CHAR_CAP with a hint", () => {
      // Build a thinking item with text larger than the show-all cap.
      const oversize = "a".repeat(THINKING_SHOW_ALL_HARD_CHAR_CAP + 5_000);
      const flat = buildThinkingPreview(
        oversize,
        TRANSCRIPT_HARD_LINE_CAP,
        true,
        // showAllContent=true is the show-all transcript-mode signal that
        // legacy code combined with `transcriptMaxLines = POSITIVE_INFINITY`
        // Tier 1 still caps individual blocks via the hard char cap.
        true,
      );
      // Must contain the truncation hint, must NOT contain the full
      // (uncapped) "a" sequence — the body was sliced.
      expect(flat).toMatch(/show-all truncated/i);
      // The cap is a CHAR cap; verify the materialized "a" run is at
      // most cap-sized (the hint adds chars but they are not "a").
      const aRun = flat.match(/a+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
      expect(aRun).toBeLessThanOrEqual(THINKING_SHOW_ALL_HARD_CHAR_CAP);
    });

    it("under showAllContent, a thinking block under the cap is rendered in full (no truncation hint)", () => {
      // Stay well under the cap.
      const text = "a".repeat(1_000);
      const flat = buildThinkingPreview(
        text,
        TRANSCRIPT_HARD_LINE_CAP,
        true,
        true,
      );
      expect(flat).not.toMatch(/show-all truncated/i);
    });
  });
});

describe("computeTranscriptCapStart — FEATURE_060 Tier 2 (UUID-anchored 200-cap)", () => {
  function items(count: number, prefix = "i"): Array<{ id: string }> {
    return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` }));
  }

  it("under cap: start = 0 and anchor seeded from items[0]", () => {
    const list = items(50);
    const ref = { current: null as TranscriptCapAnchor };
    const start = computeTranscriptCapStart(list, ref);
    expect(start).toBe(0);
    expect(ref.current).toEqual({ id: "i-0", idx: 0 });
  });

  it("at cap: start still 0 — advancement only triggers past cap+step", () => {
    const list = items(TRANSCRIPT_RENDER_CAP);
    const ref = { current: null as TranscriptCapAnchor };
    const start = computeTranscriptCapStart(list, ref);
    expect(start).toBe(0);
    expect(list.length - start).toBe(TRANSCRIPT_RENDER_CAP);
  });

  it("at cap+step (250 with cap=200, step=50): still 0 — boundary is strictly greater than cap+step", () => {
    const list = items(TRANSCRIPT_RENDER_CAP + TRANSCRIPT_RENDER_CAP_STEP);
    const ref = { current: null as TranscriptCapAnchor };
    const start = computeTranscriptCapStart(list, ref);
    expect(start).toBe(0);
  });

  it("past cap+step (251): advances to length - cap and anchors there", () => {
    const list = items(TRANSCRIPT_RENDER_CAP + TRANSCRIPT_RENDER_CAP_STEP + 1);
    const ref = { current: null as TranscriptCapAnchor };
    const start = computeTranscriptCapStart(list, ref);
    expect(start).toBe(list.length - TRANSCRIPT_RENDER_CAP);
    expect(ref.current?.id).toBe(list[start].id);
  });

  it("appends within cap+step window do NOT shift start (CC-941: no scrollback churn)", () => {
    const list = items(TRANSCRIPT_RENDER_CAP + TRANSCRIPT_RENDER_CAP_STEP + 1);
    const ref = { current: null as TranscriptCapAnchor };
    const firstStart = computeTranscriptCapStart(list, ref);
    expect(firstStart).toBe(list.length - TRANSCRIPT_RENDER_CAP);
    const anchorIdAfterFirst = ref.current?.id;
    // Append 10 more — total length grows but length - start = cap + 10,
    // still <= cap + step, so anchor stays put.
    const grown = list.concat(items(10, "j"));
    const secondStart = computeTranscriptCapStart(grown, ref);
    expect(secondStart).toBe(firstStart);
    expect(ref.current?.id).toBe(anchorIdAfterFirst);
  });

  it("anchor id vanishes with list > cap: fallback clamps stored idx against length - cap (CC-1174)", () => {
    // 250 items (> cap=200), anchor at idx=100 with a vanished id (e.g.,
    // collapseToolCalls shuffled merged-summary ids). CC's fallback uses
    // `min(anchor.idx, length - cap)` so when the stored idx is *deeper*
    // into the history than the cap allows, it clamps to length - cap (50)
    // instead of returning 0 — which would yank the entire 200-item static
    // block into a re-paint.
    const list = items(250);
    const ref = {
      current: { id: "vanished", idx: 100 } as TranscriptCapAnchor,
    };
    const start = computeTranscriptCapStart(list, ref);
    expect(start).toBe(50); // min(100, 250 - 200) = 50
    // Anchor refreshed to live id at the new start.
    expect(ref.current?.id).toBe(list[50].id);
    expect(ref.current?.idx).toBe(50);
  });

  it("anchor id vanishes with list ≤ cap: fallback returns 0 (correct full view)", () => {
    // Length below the cap → no slicing needed; fallback to 0 is the
    // correct "show everything" semantic.
    const list = items(50);
    const ref = {
      current: { id: "vanished", idx: 10 } as TranscriptCapAnchor,
    };
    const start = computeTranscriptCapStart(list, ref);
    expect(start).toBe(0);
    // Anchor refreshed to items[0].
    expect(ref.current?.id).toBe(list[0].id);
    expect(ref.current?.idx).toBe(0);
  });

  it("anchor stored idx clamped on shrunk list (length < cap): start = 0", () => {
    // 30 items, stale anchor idx=500. min(500, max(0, 30-200)) = 0.
    const list = items(30);
    const ref = {
      current: { id: "vanished", idx: 500 } as TranscriptCapAnchor,
    };
    const start = computeTranscriptCapStart(list, ref);
    expect(start).toBe(0);
  });

  it("empty list with stale anchor: start = 0, anchor cleared", () => {
    const list: Array<{ id: string }> = [];
    const ref = {
      current: { id: "old", idx: 5 } as TranscriptCapAnchor,
    };
    const start = computeTranscriptCapStart(list, ref);
    expect(start).toBe(0);
    expect(ref.current).toBeNull();
  });

  it("cap is exported as 200, step as 50 (CC parity)", () => {
    expect(TRANSCRIPT_RENDER_CAP).toBe(200);
    expect(TRANSCRIPT_RENDER_CAP_STEP).toBe(50);
  });

  it("transcript-mode visible message constant is 30 (CC parity)", () => {
    expect(TRANSCRIPT_MODE_VISIBLE_MESSAGES).toBe(30);
  });
});

describe("transcript-layout/transcript-hidden-divider", () => {
  it("builds a synthetic info item with stable id, count, and shortcut hint", () => {
    const divider = buildTranscriptHiddenDivider(142, 1_700_000_000_000);

    expect(divider.id).toBe(TRANSCRIPT_HIDDEN_DIVIDER_ID);
    expect(divider.type).toBe("info");
    expect(divider.timestamp).toBe(1_699_999_999_999);
    expect(divider.text).toContain("142 earlier messages hidden");
    expect(divider.text).toContain("Ctrl+E");
    expect(divider.icon).toBe("↑");
  });

  it("uses singular noun when exactly one message is hidden", () => {
    const divider = buildTranscriptHiddenDivider(1);
    expect(divider.text).toContain("1 earlier message hidden");
    expect(divider.text).not.toContain("messages");
  });

  it("falls back to timestamp 0 when no anchor is supplied", () => {
    const divider = buildTranscriptHiddenDivider(5);
    expect(divider.timestamp).toBe(0);
  });

  it("isTranscriptHiddenDivider recognises only the sentinel id", () => {
    expect(isTranscriptHiddenDivider(buildTranscriptHiddenDivider(3))).toBe(true);

    const realUser: HistoryItem = {
      id: "user-1",
      type: "user",
      text: "hi",
      timestamp: Date.now(),
    };
    expect(isTranscriptHiddenDivider(realUser)).toBe(false);
  });

  it("renders as an info row through buildTranscriptRows without throwing", () => {
    const divider = buildTranscriptHiddenDivider(7, 1_000);
    const rows = buildTranscriptRows({
      items: [divider],
      viewportWidth: 80,
    });
    const flat = rows.map((row) => row.text).join("\n");
    expect(flat).toContain("7 earlier messages hidden");
    expect(flat).toContain("Ctrl+E");
    expect(flat).toContain("↑");
  });
});

describe("buildInlinePromptRenderModel (FEATURE_214 Phase 2b)", () => {
  const section = (key: string, ...texts: string[]): TranscriptSection => ({
    key,
    rows: texts.map((text, i) => ({ key: `${key}-r${i}`, text })),
  });
  const staticPortion = (sections: TranscriptSection[]): TranscriptStaticPortion => ({
    staticSections: sections,
    activeItems: [],
  });
  const dynamicPortion = (sections: TranscriptSection[]): TranscriptDynamicPortion => ({
    sections,
    previewSections: [],
  });

  const finalized = section("final", "history line 1", "history line 2");
  const dynamic = section("live", "streaming…");
  const banner = section("banner", "KodaX");

  it("keeps finalized history in staticSections and OUT of the live rows", () => {
    const model = buildInlinePromptRenderModel(
      staticPortion([finalized]),
      dynamicPortion([dynamic]),
      undefined,
    );
    // finalized → staticSections (committed once via <Static>), NOT in the live cell-frame rows
    expect(model.staticSections).toEqual([finalized]);
    expect(model.rows).toEqual(dynamic.rows);
    const liveText = model.rows.map((r) => r.text).join("\n");
    expect(liveText).not.toContain("history line 1");
    expect(liveText).toContain("streaming…");
  });

  it("prepends the banner as the FIRST staticSection (commits to scrollback once, not the live frame)", () => {
    const model = buildInlinePromptRenderModel(
      staticPortion([finalized]),
      dynamicPortion([dynamic]),
      banner,
    );
    expect(model.staticSections).toEqual([banner, finalized]);
    expect(model.rows.map((r) => r.text).join("\n")).not.toContain("KodaX");
  });

  it("CONTRAST: materialize floods the live rows with finalized history (the duplication root the inline prompt avoids)", () => {
    const composed = buildInlinePromptRenderModel(
      staticPortion([finalized]),
      dynamicPortion([dynamic]),
      undefined,
    );
    const materialized = materializeTranscriptRenderModel(composed);
    // materialize empties staticSections and pours finalized into rows — exactly what
    // the inline prompt must NOT do (finalized would re-paint in the live cell-frame).
    expect(materialized.staticSections).toEqual([]);
    expect(materialized.rows.map((r) => r.text)).toContain("history line 1");
    // buildInlinePromptRenderModel keeps them apart:
    expect(composed.staticSections).not.toEqual([]);
    expect(composed.rows.map((r) => r.text)).not.toContain("history line 1");
  });
});

describe("identifyTranscriptSection (FEATURE_214 ledger identity)", () => {
  const sec = (key: string, ...texts: string[]): TranscriptSection => ({
    key,
    rows: texts.map((text, i) => ({ key: `${key}-r${i}`, text })),
  });

  it("is stable for identical sections", () => {
    expect(identifyTranscriptSection(sec("a", "x", "y"))).toEqual(
      identifyTranscriptSection(sec("a", "x", "y")),
    );
  });

  it("preserves the section key", () => {
    expect(identifyTranscriptSection(sec("msg-7", "hi")).key).toBe("msg-7");
  });

  it("fingerprint changes on in-place text edit (→ ledger rebuild)", () => {
    expect(identifyTranscriptSection(sec("a", "hello")).fingerprint).not.toBe(
      identifyTranscriptSection(sec("a", "HELLO")).fingerprint,
    );
  });

  it("fingerprint changes when row count changes", () => {
    expect(identifyTranscriptSection(sec("a", "x")).fingerprint).not.toBe(
      identifyTranscriptSection(sec("a", "x", "y")).fingerprint,
    );
  });

  it("fingerprint changes when rows are reordered", () => {
    expect(identifyTranscriptSection(sec("a", "x", "y")).fingerprint).not.toBe(
      identifyTranscriptSection(sec("a", "y", "x")).fingerprint,
    );
  });
});

describe("FEATURE_220 — finalized thinking collapse", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const TS = 1_000_000;
  const thinkingItem = (id: string, text: string): HistoryItem => ({
    id,
    type: "thinking",
    text,
    timestamp: TS,
  });

  describe("buildCollapsedThinkingLine", () => {
    it("flags multi-line reasoning as having more, summarizing the first non-empty line", () => {
      const { summary, hasMore } = buildCollapsedThinkingLine(
        "First, inspect the auth module.\nThen trace the token refresh path.",
      );
      expect(hasMore).toBe(true);
      expect(summary).toBe("First, inspect the auth module.");
    });

    it("flags an over-long single line as having more and truncates with an ellipsis", () => {
      const longLine = "A".repeat(200);
      const { summary, hasMore } = buildCollapsedThinkingLine(longLine);
      expect(hasMore).toBe(true);
      expect(summary.endsWith("…")).toBe(true);
      expect(summary.length).toBeLessThan(longLine.length);
    });

    it("does not flag a short single line as having more", () => {
      const { summary, hasMore } = buildCollapsedThinkingLine("Quick check of the config.");
      expect(hasMore).toBe(false);
      expect(summary).toBe("Quick check of the config.");
    });

    it("skips leading blank lines when picking the summary", () => {
      const { summary, hasMore } = buildCollapsedThinkingLine("\n\n  Real reasoning here.\nmore");
      expect(hasMore).toBe(true);
      expect(summary).toBe("Real reasoning here.");
    });

    it("returns an empty, non-expandable summary for empty/whitespace-only text", () => {
      for (const text of ["", "   ", "\n\n  \n"]) {
        const { summary, hasMore } = buildCollapsedThinkingLine(text);
        expect(summary).toBe("");
        // hasMore=false → renderer falls through to the legacy preview path,
        // so no dangling "Ctrl+O to expand" hint on an empty thinking block.
        expect(hasMore).toBe(false);
      }
    });
  });

  describe("thinking item rendering", () => {
    const multiLine = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

    it("collapses a multi-line finalized thinking block to one summary line with an expand hint", () => {
      const rows = buildTranscriptRows({
        items: [thinkingItem("th-1", multiLine)],
        viewportWidth: 80,
        maxLines: 1000,
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("Thinking");
      expect(text).toContain("line 1");
      expect(text).toContain("Ctrl+O to expand");
      expect(text).not.toContain("line 2");
      expect(text).not.toContain("line 5");
    });

    it("renders a short single-line thinking block verbatim with no expand hint", () => {
      const rows = buildTranscriptRows({
        items: [thinkingItem("th-2", "I'll start by examining the existing structure.")],
        viewportWidth: 80,
        maxLines: 1000,
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("I'll start by examining the existing structure.");
      expect(text).not.toContain("Ctrl+O to expand");
    });

    it("expands fully when showFullThinking is on (collapse bypassed)", () => {
      const rows = buildTranscriptRows({
        items: [thinkingItem("th-3", multiLine)],
        viewportWidth: 80,
        maxLines: 1000,
        showFullThinking: true,
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("line 20");
      expect(text).not.toContain("Ctrl+O to expand");
    });

    it("expands fully when showAllContent is on (collapse bypassed)", () => {
      const rows = buildTranscriptRows({
        items: [thinkingItem("th-4", multiLine)],
        viewportWidth: 80,
        maxLines: 1000,
        showAllContent: true,
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("line 20");
      expect(text).not.toContain("Ctrl+O to expand");
    });

    it("restores the legacy multi-line preview when KODAX_THINKING_COLLAPSE=0", () => {
      vi.stubEnv("KODAX_THINKING_COLLAPSE", "0");
      const rows = buildTranscriptRows({
        items: [thinkingItem("th-5", multiLine)],
        viewportWidth: 80,
        maxLines: 5,
      });
      const text = rows.map((row) => row.text).join("\n");
      expect(text).toContain("line 5");
      expect(text).toContain("thinking truncated; press Ctrl+O to inspect full reasoning");
      expect(text).not.toContain("Ctrl+O to expand");
    });
  });
});

describe("FEATURE_220 — tight-spacing run (consecutive thinking/tool_group)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const TS = 1_000_000;
  const thinking = (id: string): HistoryItem => ({ id, type: "thinking", text: `reason ${id}`, timestamp: TS });
  const toolGroup = (id: string): HistoryItem => ({
    id,
    type: "tool_group",
    tools: [{ id: `${id}-c`, name: "grep", status: ToolCallStatus.Success, startTime: TS, endTime: TS + 1, output: "ok" }],
    timestamp: TS,
  });
  const assistant = (id: string): HistoryItem => ({ id, type: "assistant", text: `answer ${id}`, timestamp: TS });
  const user = (id: string): HistoryItem => ({ id, type: "user", text: `q ${id}`, timestamp: TS });

  const endsWithBlank = (section: { rows: { key: string; text: string }[] }): boolean => {
    const last = section.rows[section.rows.length - 1];
    return !!last && last.text === " " && last.key.endsWith("-blank");
  };

  it("drops the trailing blank between consecutive thinking and tool_group items", () => {
    const items = [thinking("th"), toolGroup("tg"), assistant("a")];
    const sections = buildHistoryItemTranscriptSections(items, 80);
    // thinking is followed by tool_group (both run members) → blank suppressed
    expect(endsWithBlank(sections[0]!)).toBe(false);
    // tool_group is followed by assistant (not a run member) → keep blank
    expect(endsWithBlank(sections[1]!)).toBe(true);
  });

  it("keeps the blank on the last member of a run, suppresses internal ones", () => {
    const items = [thinking("th1"), thinking("th2"), assistant("a")];
    const sections = buildHistoryItemTranscriptSections(items, 80);
    expect(endsWithBlank(sections[0]!)).toBe(false); // followed by thinking
    expect(endsWithBlank(sections[1]!)).toBe(true); // followed by assistant
  });

  it("does not suppress when a tool_group is followed by a user turn", () => {
    const items = [toolGroup("tg"), user("u")];
    const sections = buildHistoryItemTranscriptSections(items, 80);
    expect(endsWithBlank(sections[0]!)).toBe(true);
  });

  it("does not suppress an assistant blank even when followed by thinking", () => {
    const items = [assistant("a"), thinking("th")];
    const sections = buildHistoryItemTranscriptSections(items, 80);
    expect(endsWithBlank(sections[0]!)).toBe(true);
  });

  it("restores all blanks when KODAX_TRANSCRIPT_TIGHT=0", () => {
    vi.stubEnv("KODAX_TRANSCRIPT_TIGHT", "0");
    const items = [thinking("th"), toolGroup("tg"), assistant("a")];
    const sections = buildHistoryItemTranscriptSections(items, 80);
    expect(endsWithBlank(sections[0]!)).toBe(true);
    expect(endsWithBlank(sections[1]!)).toBe(true);
  });
});

describe("FEATURE_220 — tight-spacing cache invariant", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const TS = 1_000_000;
  const thinking = (id: string): HistoryItem => ({ id, type: "thinking", text: `reason ${id}`, timestamp: TS });
  const toolGroup = (id: string): HistoryItem => ({
    id,
    type: "tool_group",
    tools: [{ id: `${id}-c`, name: "grep", status: ToolCallStatus.Success, startTime: TS, endTime: TS + 1, output: "ok" }],
    timestamp: TS,
  });
  const assistant = (id: string): HistoryItem => ({ id, type: "assistant", text: `answer ${id}`, timestamp: TS });
  const endsWithBlank = (section: { rows: { key: string; text: string }[] }): boolean => {
    const last = section.rows[section.rows.length - 1];
    return !!last && last.text === " " && last.key.endsWith("-blank");
  };

  it("applies suppression post-cache: same item objects give per-call results across tight on/off", () => {
    // The per-item section cache stores UNSUPPRESSED sections; suppression is a
    // post-cache pass. So reusing the same item references with the env flag
    // toggled must still honour the current flag, not a cached suppressed result.
    const items = [thinking("th"), toolGroup("tg"), assistant("a")];
    const first = buildHistoryItemTranscriptSections(items, 80);
    expect(endsWithBlank(first[0]!)).toBe(false);

    vi.stubEnv("KODAX_TRANSCRIPT_TIGHT", "0");
    const second = buildHistoryItemTranscriptSections(items, 80);
    expect(endsWithBlank(second[0]!)).toBe(true);
  });
});

describe("FEATURE_220 — finalized thinking expand reaches the section render path", () => {
  const TS = 1_000_000;
  const multiThinking = (id: string): HistoryItem => ({
    id,
    type: "thinking",
    text: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
    timestamp: TS,
  });
  const flat = (sections: { rows: { text: string }[] }[]): string =>
    sections.flatMap((s) => s.rows.map((r) => r.text)).join("\n");

  it("collapses by default through buildHistoryItemTranscriptSections", () => {
    const sections = buildHistoryItemTranscriptSections([multiThinking("th")], 80);
    const text = flat(sections);
    expect(text).toContain("Ctrl+O to expand");
    expect(text).not.toContain("line 20");
  });

  it("expands fully when showFullThinking is threaded through (Ctrl+O / transcript mode)", () => {
    // (items, viewportWidth, maxLines, showDetailedTools, expandedItemKeys, showAllContent, showFullThinking)
    const sections = buildHistoryItemTranscriptSections([multiThinking("th")], 80, 1000, false, undefined, false, true);
    const text = flat(sections);
    expect(text).toContain("line 20");
    expect(text).not.toContain("Ctrl+O to expand");
  });

  it("transcript static portion expands finalized thinking (showFullThinking wired end-to-end)", () => {
    const portion = buildTranscriptStaticPortion({
      items: [multiThinking("th"), { id: "u", type: "user", text: "next", timestamp: TS }],
      viewportWidth: 80,
      maxLines: 1000,
      showFullThinking: true,
    });
    const text = flat(portion.staticSections);
    expect(text).toContain("line 20");
    expect(text).not.toContain("Ctrl+O to expand");
  });

  it("dynamic portion's LIVE pending thinking honours showFullThinking (P1 closure)", () => {
    const longThinking = "Z".repeat(450);
    const previewText = (showFullThinking: boolean): string => {
      const { previewSections } = buildTranscriptDynamicPortion({
        activeItems: [],
        viewportWidth: 80,
        maxLines: 1000,
        isLoading: true,
        isThinking: true,
        thinkingContent: longThinking,
        thinkingCharCount: longThinking.length,
        showFullThinking,
      });
      return flat(previewSections);
    };
    // compact (inline) → truncated preview
    expect(previewText(false)).toContain("thinking truncated; press Ctrl+O to inspect full reasoning");
    // transcript mode (showFullThinking) → full live reasoning, no truncation hint
    const full = previewText(true).replace(/\n/g, "");
    expect(full).toContain("Z".repeat(430));
    expect(previewText(true)).not.toContain("thinking truncated; press Ctrl+O to inspect full reasoning");
  });
});

describe("FEATURE_220 — inline scrollback stability (keystone regression)", () => {
  const TS = 1_000_000;
  const user = (id: string): HistoryItem => ({ id, type: "user", text: `q ${id}`, timestamp: TS });
  const assistant = (id: string): HistoryItem => ({ id, type: "assistant", text: `answer ${id}`, timestamp: TS });
  const thinking = (id: string): HistoryItem => ({
    id,
    type: "thinking",
    text: Array.from({ length: 12 }, (_, i) => `reason ${id} line ${i + 1}`).join("\n"),
    timestamp: TS,
  });
  const readCall = (name: string, i: number) => ({
    id: `${name}-${i}-c`,
    name,
    status: ToolCallStatus.Success,
    startTime: TS,
    endTime: TS + 1,
    output: "ok",
  });
  const readGroup = (id: string, name: string): HistoryItem => ({
    id,
    type: "tool_group",
    tools: [readCall(name, 1)],
    timestamp: TS,
  });

  // A realistic round exercising all three transforms: collapsed thinking,
  // tight-spaced think->tool, and a gathered-context read-only run.
  const round = (n: number): HistoryItem[] => [
    user(`u${n}`),
    thinking(`th${n}`),
    readGroup(`r${n}a`, "read"),
    readGroup(`r${n}b`, "grep"),
    assistant(`a${n}`),
  ];

  // Finalize a full items array into positional committed sections, exactly as
  // the inline prompt path does (all finalized, nothing live).
  const committedOf = (items: HistoryItem[]) =>
    splitInlineLedgerModel(buildHistoryItemTranscriptSections(items, 80), [], [], 4096).committedSections;

  const plan = (
    items: HistoryItem[],
    prior: Parameters<typeof planInlineScrollback>[2],
  ) =>
    planInlineScrollback(
      { bannerSection: null, finalizedSections: committedOf(items), width: 80 },
      identifyInlineCommitSection,
      prior,
    );

  it("identical frames re-commit nothing (no rebuild churn) for collapsed/tight/gathered content", () => {
    const items = round(1);
    const first = plan(items, EMPTY_INLINE_SCROLLBACK_STATE);
    expect(first.plan.kind).toBe("append"); // initial commit
    const second = plan(items, first.nextState);
    expect(second.plan.kind).toBe("none"); // stable fingerprints → nothing to do
  });

  it("appending a new round APPENDS the new tail, never rebuilds the committed prefix", () => {
    const r1 = round(1);
    const firstCommit = plan(r1, EMPTY_INLINE_SCROLLBACK_STATE);
    const r1r2 = [...round(1), ...round(2)];
    const next = plan(r1r2, firstCommit.nextState);
    expect(next.plan.kind).toBe("append");
    if (next.plan.kind !== "append") throw new Error("expected append");
    // the appended rows must all belong to round 2 (round 1's prefix untouched)
    const appendedText = next.plan.sections
      .flatMap((s) => s.rows.map((r) => r.text))
      .join("\n");
    expect(appendedText).toContain("answer a2");
    expect(appendedText).not.toContain("answer a1");
  });

  it("renders identically across distinct equal item arrays (no time/streaming state)", () => {
    const flatten = (items: HistoryItem[]) =>
      committedOf(items).flatMap((s) => s.rows.map((r) => `${r.key}:${r.text}`));
    // distinct object identities, equal content → bypasses the per-item ref cache
    expect(flatten(round(1))).toEqual(flatten(round(1)));
  });
});

describe("sidecar verifier rendering", () => {
  function sidecarItem(
    opts: { verdict?: "revise" | "blocked"; delivery?: "budget-exhausted"; text?: string } = {},
  ): HistoryItem {
    return {
      id: "sc-1",
      type: "sidecar",
      text: opts.text ?? "The output is incomplete.",
      timestamp: 0,
      ...(opts.verdict ? { verdict: opts.verdict } : {}),
      ...(opts.delivery ? { delivery: opts.delivery } : {}),
    };
  }

  it("renders a distinct header containing 'Sidecar Verifier' for verdict=revise", () => {
    const rows = buildTranscriptRows({
      items: [sidecarItem({ verdict: "revise" })],
      viewportWidth: 120,
    });
    const headerRows = rows.filter((r) => r.key.startsWith("sc-1-header"));
    expect(headerRows.length).toBeGreaterThan(0);
    const headerText = headerRows.map((r) => r.text).join(" ");
    expect(headerText).toContain("Sidecar Verifier");
    expect(headerText).toContain("revise");
  });

  it("renders 'blocked' label for verdict=blocked", () => {
    const rows = buildTranscriptRows({
      items: [sidecarItem({ verdict: "blocked" })],
      viewportWidth: 120,
    });
    const headerText = rows
      .filter((r) => r.key.startsWith("sc-1-header"))
      .map((r) => r.text)
      .join(" ");
    expect(headerText).toContain("blocked");
  });

  it("renders 'budget exhausted' label for delivery=budget-exhausted", () => {
    const rows = buildTranscriptRows({
      items: [sidecarItem({ delivery: "budget-exhausted" })],
      viewportWidth: 120,
    });
    const headerText = rows
      .filter((r) => r.key.startsWith("sc-1-header"))
      .map((r) => r.text)
      .join(" ");
    expect(headerText).toContain("budget exhausted");
  });

  it("renders body text indented under the header", () => {
    const bodyText = "Please add error handling for the edge case.";
    const rows = buildTranscriptRows({
      items: [sidecarItem({ verdict: "revise", text: bodyText })],
      viewportWidth: 120,
    });
    const bodyRows = rows.filter((r) => r.key.startsWith("sc-1-body"));
    expect(bodyRows.length).toBeGreaterThan(0);
    expect(bodyRows.map((r) => r.text).join(" ")).toContain(bodyText);
  });

  it("emits a trailing blank spacer row", () => {
    const rows = buildTranscriptRows({
      items: [sidecarItem({ verdict: "revise" })],
      viewportWidth: 120,
    });
    expect(rows.some((r) => r.key === "sc-1-blank")).toBe(true);
  });

  it("uses warning color for the header (not info color)", () => {
    const rows = buildTranscriptRows({
      items: [sidecarItem({ verdict: "revise" })],
      viewportWidth: 120,
    });
    const header = rows.find((r) => r.key.startsWith("sc-1-header"));
    expect(header?.color).toBe("warning");
  });

  it("header color is distinct from info-type items", () => {
    const rows = buildTranscriptRows({
      items: [
        sidecarItem({ verdict: "revise" }),
        info("inf-1", "just an info message"),
      ],
      viewportWidth: 120,
    });
    const sidecarHeader = rows.find((r) => r.key.startsWith("sc-1-header"));
    const infoBody = rows.find((r) => r.key.startsWith("inf-1-body"));
    expect(sidecarHeader?.color).not.toBe(infoBody?.color);
  });
});
