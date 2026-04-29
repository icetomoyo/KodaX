import { describe, it, expect } from "vitest";
import { applyDiff, patchToBytes } from "./apply-diff.js";
import type { Patch } from "./frame.js";
import { CURSOR_HOME, eraseLines, cursorMove, cursorTo, SGR_RESET } from "./csi.js";
import { link } from "./osc.js";

function mockStream(): { write: (chunk: string) => unknown; written: string[] } {
  const written: string[] = [];
  return {
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    written,
  };
}

describe("substrate/ink/apply-diff (FEATURE_057 Track F, Phase 4a)", () => {
  describe("patchToBytes — per-Patch byte serialization", () => {
    it("stdout: returns content unchanged", () => {
      expect(patchToBytes({ type: "stdout", content: "hello" })).toBe("hello");
      expect(patchToBytes({ type: "stdout", content: "" })).toBe("");
      expect(patchToBytes({ type: "stdout", content: "\x1b[31m" })).toBe("\x1b[31m");
    });

    it("carriageReturn: returns single \\r byte", () => {
      expect(patchToBytes({ type: "carriageReturn" })).toBe("\r");
    });

    it("cursorHide: returns DECTCEM hide sequence (CSI ?25 l)", () => {
      expect(patchToBytes({ type: "cursorHide" })).toBe("\x1b[?25l");
    });

    it("cursorShow: returns DECTCEM show sequence (CSI ?25 h)", () => {
      expect(patchToBytes({ type: "cursorShow" })).toBe("\x1b[?25h");
    });

    it("cursorMove: composes via csi.cursorMove (relative)", () => {
      // dx=3, dy=2 → forward 3, down 2
      expect(patchToBytes({ type: "cursorMove", x: 3, y: 2 })).toBe(cursorMove(3, 2));
      // dx=-2, dy=-1 → back 2, up 1
      expect(patchToBytes({ type: "cursorMove", x: -2, y: -1 })).toBe(cursorMove(-2, -1));
      // zero delta: empty string
      expect(patchToBytes({ type: "cursorMove", x: 0, y: 0 })).toBe("");
    });

    it("cursorTo: emits CSI G with the 1-based column", () => {
      expect(patchToBytes({ type: "cursorTo", col: 5 })).toBe(cursorTo(5));
      expect(patchToBytes({ type: "cursorTo", col: 1 })).toBe(cursorTo(1));
    });

    it("clear: emits eraseLines(count)", () => {
      expect(patchToBytes({ type: "clear", count: 3 })).toBe(eraseLines(3));
      // Zero count → empty string (eraseLines guards)
      expect(patchToBytes({ type: "clear", count: 0 })).toBe("");
    });

    it("clearTerminal: emits CSI 2 J + CSI H (full clear + home)", () => {
      // Reason field is for diagnostics; bytes are the same regardless.
      expect(patchToBytes({ type: "clearTerminal", reason: "resize" })).toBe(
        `\x1b[2J${CURSOR_HOME}`,
      );
      expect(patchToBytes({ type: "clearTerminal", reason: "offscreen" })).toBe(
        `\x1b[2J${CURSOR_HOME}`,
      );
      expect(patchToBytes({ type: "clearTerminal", reason: "clear" })).toBe(
        `\x1b[2J${CURSOR_HOME}`,
      );
    });

    it("hyperlink: emits OSC 8 link sequence with deterministic id", () => {
      const uri = "https://kodax.example/";
      expect(patchToBytes({ type: "hyperlink", uri })).toBe(link(uri));
    });
  });

  describe("applyDiff — write all patch bytes to stream in one call", () => {
    it("empty diff: does NOT call stream.write (avoid spurious flush)", () => {
      const s = mockStream();
      applyDiff(s, []);
      expect(s.written).toEqual([]);
    });

    it("single stdout patch: writes the content", () => {
      const s = mockStream();
      applyDiff(s, [{ type: "stdout", content: "hello" }]);
      expect(s.written).toEqual(["hello"]);
    });

    it("multi-patch diff: concatenates all patches into a single stream.write", () => {
      // Verify the "one syscall per diff" invariant — minimizes flush latency
      // on slow terminals (SSH, FEATURE_096 motivation).
      const s = mockStream();
      const diff: ReadonlyArray<Patch> = [
        { type: "carriageReturn" },
        { type: "stdout", content: "abc" },
        { type: "cursorMove", x: 2, y: 0 },
        { type: "stdout", content: "def" },
      ];
      applyDiff(s, diff);
      expect(s.written.length).toBe(1);
      expect(s.written[0]).toBe(`\rabc${cursorMove(2, 0)}def`);
    });

    it("preserves byte ordering: patches written in array order", () => {
      const s = mockStream();
      applyDiff(s, [
        { type: "stdout", content: "1" },
        { type: "stdout", content: "2" },
        { type: "stdout", content: "3" },
      ]);
      expect(s.written[0]).toBe("123");
    });

    it("clearTerminal followed by repaint: bytes ordered correctly", () => {
      const s = mockStream();
      applyDiff(s, [
        { type: "clearTerminal", reason: "resize" },
        { type: "stdout", content: "fresh" },
      ]);
      expect(s.written[0]).toBe(`\x1b[2J${CURSOR_HOME}fresh`);
    });

    it("zero-cost passes: cursorMove(0,0) and clear(0) and stdout('') concatenate to empty, no write fired", () => {
      const s = mockStream();
      applyDiff(s, [
        { type: "cursorMove", x: 0, y: 0 },
        { type: "clear", count: 0 },
        { type: "stdout", content: "" },
      ]);
      // Total buffer is empty — no write fired.
      expect(s.written).toEqual([]);
    });

    it("mix of style + char + cursor: full incremental diff path", () => {
      // Mirrors what a real Phase 3c diffPass would emit: open style, paint
      // char, move cursor, close style.
      const s = mockStream();
      const diff: ReadonlyArray<Patch> = [
        { type: "stdout", content: "\x1b[31m" }, // open RED
        { type: "stdout", content: "x" },
        { type: "cursorMove", x: 1, y: 0 },
        { type: "stdout", content: SGR_RESET },
      ];
      applyDiff(s, diff);
      expect(s.written[0]).toBe(`\x1b[31mx${cursorMove(1, 0)}${SGR_RESET}`);
    });
  });
});
