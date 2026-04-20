import { describe, expect, it, vi } from "vitest";
import type { HistoryItem } from "../types.js";
import {
  dumpTranscriptToNativeScrollback,
  serializeTranscriptForScrollback,
} from "./transcript-scrollback-dump.js";

function makeUser(text: string, id = "u1"): HistoryItem {
  return { id, type: "user", timestamp: 0, text };
}

function makeAssistant(text: string, id = "a1"): HistoryItem {
  return { id, type: "assistant", timestamp: 0, text };
}

describe("transcript-scrollback-dump/serializeTranscriptForScrollback", () => {
  it("emits role tag + text for user and assistant items", () => {
    const out = serializeTranscriptForScrollback([
      makeUser("hello"),
      makeAssistant("hi there"),
    ]);
    expect(out).toContain("user:");
    expect(out).toContain("hello");
    expect(out).toContain("assistant:");
    expect(out).toContain("hi there");
  });

  it("separates items with blank lines", () => {
    const out = serializeTranscriptForScrollback([
      makeUser("Q1"),
      makeAssistant("A1"),
      makeUser("Q2", "u2"),
    ]);
    expect(out.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });

  it("strips ANSI escape sequences from text", () => {
    // Red text with ANSI; should not bleed into scrollback.
    const withAnsi = `\u001b[31mred text\u001b[0m normal`;
    const out = serializeTranscriptForScrollback([makeAssistant(withAnsi)]);
    expect(out).toContain("red text normal");
    expect(out).not.toContain("\u001b[31m");
    expect(out).not.toContain("\u001b[0m");
  });

  it("summarizes tool groups as a single line per call", () => {
    const items: HistoryItem[] = [{
      id: "tg1",
      type: "tool_group",
      timestamp: 0,
      tools: [
        { id: "c1", name: "read_file", status: "completed" } as never,
        { id: "c2", name: "grep", status: "completed" } as never,
      ],
    }];
    const out = serializeTranscriptForScrollback(items);
    expect(out).toContain("tool: read_file");
    expect(out).toContain("tool: grep");
  });

  it("skips thinking items (internal, not user-facing)", () => {
    const items: HistoryItem[] = [{
      id: "t1",
      type: "thinking",
      timestamp: 0,
      text: "internal reasoning",
    }, makeAssistant("final answer")];
    const out = serializeTranscriptForScrollback(items);
    expect(out).not.toContain("internal reasoning");
    expect(out).toContain("final answer");
  });

  it("returns empty string for empty input", () => {
    expect(serializeTranscriptForScrollback([])).toBe("");
  });

  it("does not include raw ANSI cursor positioning sequences", () => {
    // Cursor-move escapes the renderer sometimes inserts; must be stripped.
    const cursorMove = `\u001b[2J\u001b[H`;
    const out = serializeTranscriptForScrollback([
      makeAssistant(`${cursorMove}visible content`),
    ]);
    expect(out).toContain("visible content");
    expect(out).not.toMatch(/\u001b\[\d*[A-Za-z]/);
  });

  it("emits system/info/error/event/hint with role tag", () => {
    const items: HistoryItem[] = [
      { id: "s", type: "system", timestamp: 0, text: "system msg" },
      { id: "i", type: "info", timestamp: 0, text: "info msg" },
      { id: "e", type: "error", timestamp: 0, text: "error msg" },
      { id: "v", type: "event", timestamp: 0, text: "event msg" },
      { id: "h", type: "hint", timestamp: 0, text: "hint msg" },
    ];
    const out = serializeTranscriptForScrollback(items);
    expect(out).toContain("system msg");
    expect(out).toContain("info msg");
    expect(out).toContain("error msg");
    expect(out).toContain("event msg");
    expect(out).toContain("hint msg");
  });
});

describe("transcript-scrollback-dump/dumpTranscriptToNativeScrollback", () => {
  it("executes exit -> write -> enter in strict order", () => {
    const calls: string[] = [];
    dumpTranscriptToNativeScrollback({
      items: [makeUser("hi"), makeAssistant("hello")],
      exitAltScreen: () => calls.push("exit"),
      writeToScrollback: () => calls.push("write"),
      enterAltScreen: () => calls.push("enter"),
    });
    expect(calls).toEqual(["exit", "write", "enter"]);
  });

  it("writes serialized transcript with trailing newline", () => {
    const writeToScrollback = vi.fn();
    dumpTranscriptToNativeScrollback({
      items: [makeUser("question")],
      exitAltScreen: () => {},
      writeToScrollback,
      enterAltScreen: () => {},
    });
    expect(writeToScrollback).toHaveBeenCalledOnce();
    const arg = writeToScrollback.mock.calls[0][0] as string;
    expect(arg.endsWith("\n")).toBe(true);
    expect(arg).toContain("question");
  });

  it("still toggles alt-screen for empty transcript but skips write", () => {
    const writeToScrollback = vi.fn();
    const exitAltScreen = vi.fn();
    const enterAltScreen = vi.fn();
    dumpTranscriptToNativeScrollback({
      items: [],
      writeToScrollback,
      exitAltScreen,
      enterAltScreen,
    });
    expect(exitAltScreen).toHaveBeenCalledOnce();
    expect(enterAltScreen).toHaveBeenCalledOnce();
    expect(writeToScrollback).not.toHaveBeenCalled();
  });
});
