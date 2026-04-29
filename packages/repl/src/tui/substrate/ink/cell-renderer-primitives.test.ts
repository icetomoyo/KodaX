import { describe, it, expect } from "vitest";
import {
  type Cell,
  CellWidth,
  EMPTY_CELL,
  createScreen,
  setCellAt,
} from "./cell-screen.js";
import { SGR_RESET } from "./csi.js";
import { emptyFrame, type Frame } from "./frame.js";
import { LINK_END, link } from "./osc.js";
import {
  CARRIAGE_RETURN,
  NEWLINE,
  VirtualScreen,
  fullResetSequence_CAUSES_FLICKER,
  moveCursorTo,
  needsWidthCompensation,
  readLine,
  renderFrameSlice,
  renderFullFrame,
  transitionHyperlink,
  transitionStyle,
  transitionStyleStr,
  writeCellWithStyleStr,
} from "./cell-renderer-primitives.js";

function makeCell(
  char: string,
  opts: { width?: CellWidth; style?: string; hyperlink?: string } = {},
): Cell {
  return {
    char,
    width: opts.width ?? CellWidth.Single,
    style: opts.style ?? "",
    hyperlink: opts.hyperlink,
  };
}

function frameWithScreen(
  width: number,
  height: number,
  fill: (s: ReturnType<typeof createScreen>) => ReturnType<typeof createScreen>,
): Frame {
  return {
    screen: fill(createScreen(width, height)),
    viewport: { width: 80, height: 24 },
    cursor: { x: 0, y: 0, visible: true },
  };
}

describe("substrate/ink/cell-renderer-primitives (FEATURE_057 Track F, Phase 1-3a)", () => {
  describe("renderFullFrame", () => {
    it("returns empty diff for empty screen (width or height === 0)", () => {
      expect(renderFullFrame(emptyFrame(24, 80))).toEqual([]);
      const wide0 = frameWithScreen(0, 5, (s) => s);
      expect(renderFullFrame(wide0)).toEqual([]);
      const tall0 = frameWithScreen(5, 0, (s) => s);
      expect(renderFullFrame(tall0)).toEqual([]);
    });

    it("paints a single ASCII line", () => {
      const f = frameWithScreen(5, 1, (s) => {
        let next = s;
        const chars = ["h", "e", "l", "l", "o"];
        for (let x = 0; x < chars.length; x++) {
          next = setCellAt(next, x, 0, makeCell(chars[x]!));
        }
        return next;
      });
      expect(renderFullFrame(f)).toEqual([{ type: "stdout", content: "hello" }]);
    });

    it("trims trailing whitespace per line (matches CC line.trimEnd())", () => {
      const f = frameWithScreen(5, 1, (s) =>
        setCellAt(setCellAt(s, 0, 0, makeCell("h")), 1, 0, makeCell("i")),
      );
      // Cells 2-4 are EMPTY_CELL (space). line.trimEnd() strips them.
      expect(renderFullFrame(f)).toEqual([{ type: "stdout", content: "hi" }]);
    });

    it("joins multiple rows with \\n", () => {
      const f = frameWithScreen(2, 3, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("a"));
        n = setCellAt(n, 1, 0, makeCell("b"));
        n = setCellAt(n, 0, 1, makeCell("c"));
        n = setCellAt(n, 1, 1, makeCell("d"));
        n = setCellAt(n, 0, 2, makeCell("e"));
        n = setCellAt(n, 1, 2, makeCell("f"));
        return n;
      });
      expect(renderFullFrame(f)).toEqual([{ type: "stdout", content: "ab\ncd\nef" }]);
    });

    it("skips SpacerTail cells (wide CJK char auto-advance)", () => {
      // Layout: [中(Wide)][SpacerTail][!]
      const f = frameWithScreen(3, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("中", { width: CellWidth.Wide }));
        n = setCellAt(n, 1, 0, makeCell("", { width: CellWidth.SpacerTail }));
        n = setCellAt(n, 2, 0, makeCell("!"));
        return n;
      });
      expect(renderFullFrame(f)).toEqual([{ type: "stdout", content: "中!" }]);
    });

    it("emits style transition: open (no prior), apply mid-row, reset at end of line", () => {
      const RED = "\x1b[31m";
      const f = frameWithScreen(3, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("a"));
        n = setCellAt(n, 1, 0, makeCell("b", { style: RED }));
        n = setCellAt(n, 2, 0, makeCell("c", { style: RED }));
        return n;
      });
      // Expected: "a" + RED + "bc" + SGR_RESET (end-of-line reset for non-empty trailing style)
      const diff = renderFullFrame(f);
      expect(diff).toEqual([{ type: "stdout", content: `a${RED}bc${SGR_RESET}` }]);
    });

    it("emits style reset between styles (no diff/optimization in Phase 2)", () => {
      const RED = "\x1b[31m";
      const BLUE = "\x1b[34m";
      const f = frameWithScreen(2, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("a", { style: RED }));
        n = setCellAt(n, 1, 0, makeCell("b", { style: BLUE }));
        return n;
      });
      const diff = renderFullFrame(f);
      expect(diff).toEqual([
        { type: "stdout", content: `${RED}a${SGR_RESET}${BLUE}b${SGR_RESET}` },
      ]);
    });

    it("emits hyperlink open/close around link cells", () => {
      const URL = "https://kodax.example/";
      const f = frameWithScreen(3, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("("));
        n = setCellAt(n, 1, 0, makeCell("L", { hyperlink: URL }));
        n = setCellAt(n, 2, 0, makeCell(")"));
        return n;
      });
      const expected = `(${link(URL)}L${LINK_END})`;
      expect(renderFullFrame(f)).toEqual([{ type: "stdout", content: expected }]);
    });

    // H1: trailing empty cells after a styled cell — verifies the
    // EOL-reset-then-trim ordering survives `String.prototype.trimEnd`.
    // SGR_RESET (\x1b[0m) and LINK_END contain no Unicode whitespace, so
    // trimEnd strips only the trailing space cells, not the reset bytes.
    it("trailing empty cells after a styled cell: emits style + char + reset, no trailing space", () => {
      const RED = "\x1b[31m";
      // Row: ["b" styled RED, EMPTY, EMPTY] (EMPTY_CELL is " " with style "")
      const f = frameWithScreen(3, 1, (s) =>
        setCellAt(s, 0, 0, makeCell("b", { style: RED })),
      );
      const diff = renderFullFrame(f);
      // Walk: cell 0 → open RED, char "b". Cell 1 (EMPTY) → style "" causes
      // SGR_RESET, char " ". Cell 2 (EMPTY) → style still "", no reset, char " ".
      // EOL: hyperlink undef, style "" — neither needs reset.
      // line = RED + "b" + SGR_RESET + "  ", trimEnd strips the 2 spaces.
      expect(diff).toEqual([
        { type: "stdout", content: `${RED}b${SGR_RESET}` },
      ]);
    });

    // M2: hyperlink active across SpacerTail. The loop continues past
    // SpacerTail without touching currentHyperlink, so the link state must
    // survive the skip and the next cell must NOT re-open the link.
    it("hyperlink active across SpacerTail: state survives skip, no spurious re-open", () => {
      const URL = "https://kodax.example/";
      // Row: [中(Wide, link)][SpacerTail][!(link)] — same link spans both
      // visible cells, SpacerTail is the skipped middle.
      const f = frameWithScreen(3, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("中", { width: CellWidth.Wide, hyperlink: URL }));
        n = setCellAt(n, 1, 0, makeCell("", { width: CellWidth.SpacerTail, hyperlink: URL }));
        n = setCellAt(n, 2, 0, makeCell("!", { hyperlink: URL }));
        return n;
      });
      const diff = renderFullFrame(f);
      // Expected: link open + "中" + "!" + LINK_END at EOL.
      // NO link-close-then-reopen between "中" and "!".
      expect(diff).toEqual([
        { type: "stdout", content: `${link(URL)}中!${LINK_END}` },
      ]);
    });

    // M2: style active across SpacerTail.
    it("style active across SpacerTail: state survives skip", () => {
      const RED = "\x1b[31m";
      const f = frameWithScreen(3, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("中", { width: CellWidth.Wide, style: RED }));
        n = setCellAt(n, 1, 0, makeCell("", { width: CellWidth.SpacerTail, style: RED }));
        n = setCellAt(n, 2, 0, makeCell("!", { style: RED }));
        return n;
      });
      const diff = renderFullFrame(f);
      expect(diff).toEqual([
        { type: "stdout", content: `${RED}中!${SGR_RESET}` },
      ]);
    });

    // M3: combined style + hyperlink — verifies the open ordering
    // (link first, then style) and the close ordering (style reset first
    // at EOL, then LINK_END). Currently `renderFullFrame` emits hyperlink
    // transition BEFORE style transition in the per-cell loop and at EOL
    // emits hyperlink LINK_END BEFORE style SGR_RESET.
    it("combined style + hyperlink: link opens first, style second; EOL close pairs", () => {
      const RED = "\x1b[31m";
      const URL = "https://kodax.example/";
      const f = frameWithScreen(2, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("a", { style: RED, hyperlink: URL }));
        n = setCellAt(n, 1, 0, makeCell("b", { style: RED, hyperlink: URL }));
        return n;
      });
      const diff = renderFullFrame(f);
      // Per-cell open ordering:    link(URL) + RED + "a" + "b"
      // EOL ordering:               LINK_END + SGR_RESET
      expect(diff).toEqual([
        { type: "stdout", content: `${link(URL)}${RED}ab${LINK_END}${SGR_RESET}` },
      ]);
    });
  });

  describe("transitionStyle (pure helper, returns { patches, current })", () => {
    it("no-op when current === next", () => {
      const result = transitionStyle("\x1b[31m", "\x1b[31m");
      expect(result.patches).toEqual([]);
      expect(result.current).toBe("\x1b[31m");
    });

    it("opens new style when transitioning from empty", () => {
      const result = transitionStyle("", "\x1b[31m");
      expect(result.patches).toEqual([{ type: "stdout", content: "\x1b[31m" }]);
      expect(result.current).toBe("\x1b[31m");
    });

    it("emits SGR_RESET + new when transitioning between non-empty styles", () => {
      const result = transitionStyle("\x1b[31m", "\x1b[34m");
      expect(result.patches).toEqual([
        { type: "stdout", content: SGR_RESET },
        { type: "stdout", content: "\x1b[34m" },
      ]);
      expect(result.current).toBe("\x1b[34m");
    });

    it("emits SGR_RESET only when transitioning to empty", () => {
      const result = transitionStyle("\x1b[31m", "");
      expect(result.patches).toEqual([{ type: "stdout", content: SGR_RESET }]);
      expect(result.current).toBe("");
    });

    it("does not mutate the caller's array (pure-function contract)", () => {
      const before = transitionStyle("", "\x1b[31m").patches;
      const next = transitionStyle("\x1b[31m", "\x1b[34m").patches;
      // Two separate calls return two separate arrays — `before` is unaffected
      // by `next`. (Trivially true for pure functions; explicit assertion
      // pins the immutability contract for future maintainers.)
      expect(before).not.toBe(next);
      expect(before).toEqual([{ type: "stdout", content: "\x1b[31m" }]);
    });
  });

  describe("transitionHyperlink (pure helper)", () => {
    it("no-op when current === next", () => {
      const result = transitionHyperlink("https://a.example/", "https://a.example/");
      expect(result.patches).toEqual([]);
    });

    it("opens link when transitioning from undefined", () => {
      const result = transitionHyperlink(undefined, "https://a.example/");
      expect(result.patches).toEqual([
        { type: "stdout", content: link("https://a.example/") },
      ]);
      expect(result.current).toBe("https://a.example/");
    });

    it("emits LINK_END + new link when transitioning between hyperlinks", () => {
      const result = transitionHyperlink("https://a.example/", "https://b.example/");
      expect(result.patches).toEqual([
        { type: "stdout", content: LINK_END },
        { type: "stdout", content: link("https://b.example/") },
      ]);
      expect(result.current).toBe("https://b.example/");
    });

    it("emits LINK_END only when transitioning to undefined", () => {
      const result = transitionHyperlink("https://a.example/", undefined);
      expect(result.patches).toEqual([{ type: "stdout", content: LINK_END }]);
      expect(result.current).toBeUndefined();
    });
  });

  describe("needsWidthCompensation", () => {
    it("returns false for plain ASCII", () => {
      expect(needsWidthCompensation("a")).toBe(false);
      expect(needsWidthCompensation(" ")).toBe(false);
    });

    it("returns false for plain CJK (no VS16, in standard wcwidth tables)", () => {
      expect(needsWidthCompensation("中")).toBe(false);
      expect(needsWidthCompensation("文")).toBe(false);
    });

    it("returns true for Symbols-and-Pictographs-Extended-A block (U+1FA70-U+1FAFF)", () => {
      expect(needsWidthCompensation("\u{1FA70}")).toBe(true);
      expect(needsWidthCompensation("\u{1FAFF}")).toBe(true);
    });

    it("returns true for Symbols-for-Legacy-Computing block (U+1FB00-U+1FBFF)", () => {
      expect(needsWidthCompensation("\u{1FB00}")).toBe(true);
      expect(needsWidthCompensation("\u{1FBFF}")).toBe(true);
    });

    it("returns true for text-by-default emoji + VS16 (U+FE0F)", () => {
      expect(needsWidthCompensation("⚔️")).toBe(true);
      expect(needsWidthCompensation("☠️")).toBe(true);
      expect(needsWidthCompensation("❤️")).toBe(true);
    });

    it("returns false for the same base codepoints WITHOUT VS16", () => {
      expect(needsWidthCompensation("⚔")).toBe(false);
      expect(needsWidthCompensation("☠")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(needsWidthCompensation("")).toBe(false);
    });
  });

  describe("VirtualScreen (Phase 3 skeleton)", () => {
    it("constructor seeds cursor from origin and exposes viewportWidth", () => {
      const vs = new VirtualScreen({ x: 5, y: 3 }, 80);
      expect(vs.cursor).toEqual({ x: 5, y: 3 });
      expect(vs.viewportWidth).toBe(80);
      expect(vs.diff).toEqual([]);
    });

    it("constructor copies origin (does not alias)", () => {
      const origin = { x: 1, y: 2 };
      const vs = new VirtualScreen(origin, 80);
      // Mutating origin must NOT affect the cursor.
      // (origin is { x, y } — not Readonly; we only need to verify aliasing
      // semantics. Using an explicit mutable cast makes intent clear.)
      (origin as { x: number; y: number }).x = 99;
      expect(vs.cursor.x).toBe(1);
    });

    it("txn pushes patches and applies delta to cursor", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      vs.txn(() => [
        [{ type: "stdout", content: "abc" }],
        { dx: 3, dy: 0 },
      ]);
      expect(vs.diff).toEqual([{ type: "stdout", content: "abc" }]);
      expect(vs.cursor).toEqual({ x: 3, y: 0 });
    });

    it("txn callback observes cursor BEFORE applying its delta", () => {
      const vs = new VirtualScreen({ x: 5, y: 0 }, 80);
      let observed: { x: number; y: number } | null = null;
      vs.txn((prev) => {
        observed = { x: prev.x, y: prev.y };
        return [[], { dx: 10, dy: 1 }];
      });
      expect(observed).toEqual({ x: 5, y: 0 });
      expect(vs.cursor).toEqual({ x: 15, y: 1 });
    });

    it("multiple txn calls accumulate patches in order", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      vs.txn(() => [[{ type: "stdout", content: "a" }], { dx: 1, dy: 0 }]);
      vs.txn(() => [[{ type: "stdout", content: "b" }], { dx: 1, dy: 0 }]);
      expect(vs.diff.map((p) => (p as { content: string }).content)).toEqual(["a", "b"]);
      expect(vs.cursor).toEqual({ x: 2, y: 0 });
    });
  });

  describe("writeCellWithStyleStr (Phase 3a)", () => {
    it("writes a Single-width ASCII cell and advances cursor by 1", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      const written = writeCellWithStyleStr(vs, makeCell("a"), "");
      expect(written).toBe(true);
      expect(vs.diff).toEqual([{ type: "stdout", content: "a" }]);
      expect(vs.cursor).toEqual({ x: 1, y: 0 });
    });

    it("writes a Wide CJK cell and advances cursor by 2", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      const cell = makeCell("中", { width: CellWidth.Wide });
      writeCellWithStyleStr(vs, cell, "");
      expect(vs.diff).toEqual([{ type: "stdout", content: "中" }]);
      expect(vs.cursor).toEqual({ x: 2, y: 0 });
    });

    it("emits styleStr before char when styleStr non-empty", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      writeCellWithStyleStr(vs, makeCell("a"), "\x1b[31m");
      expect(vs.diff).toEqual([
        { type: "stdout", content: "\x1b[31m" },
        { type: "stdout", content: "a" },
      ]);
    });

    it("skips wide cell at the viewport right edge — returns false, no patches, no advance", () => {
      // Single-codepoint wide char threshold is vw + 1 — char at vw - 1
      // would advance to vw + 1 which IS == threshold, so skip.
      const vs = new VirtualScreen({ x: 79, y: 0 }, 80);
      const cell = makeCell("中", { width: CellWidth.Wide });
      const written = writeCellWithStyleStr(vs, cell, "");
      expect(written).toBe(false);
      expect(vs.diff).toEqual([]);
      expect(vs.cursor).toEqual({ x: 79, y: 0 });
    });

    it("multi-codepoint grapheme uses stricter threshold (vw, not vw+1)", () => {
      const vs = new VirtualScreen({ x: 78, y: 0 }, 80);
      // Multi-codepoint grapheme (length > 2) at column 78 with vw=80:
      // threshold = vw = 80, px + 2 = 80 >= 80 → skip.
      const cell = makeCell("👨‍👩", { width: CellWidth.Wide });
      const written = writeCellWithStyleStr(vs, cell, "");
      expect(written).toBe(false);
    });

    it("wide-char compensation: pre-paints space at x+1 + post-emits cursorTo to fix wcwidth drift", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      // ⚔️ is U+2694 + U+FE0F (VS16) — text-by-default + emoji presentation,
      // length 2 so still uses single-codepoint-wide threshold.
      const cell = makeCell("⚔️", { width: CellWidth.Wide });
      writeCellWithStyleStr(vs, cell, "");
      expect(vs.diff).toEqual([
        { type: "cursorTo", col: 2 },        // pre-paint at column x+1 (1-based: 2)
        { type: "stdout", content: " " },
        { type: "cursorTo", col: 1 },        // back to x (1-based: 1)
        { type: "stdout", content: "⚔️" },
        { type: "cursorTo", col: 3 },        // pin to post-glyph column (1-based: x+cellWidth+1 = 3)
      ]);
    });

    it("pending-wrap state: cursor.x >= viewport advances to (cellWidth, y+1)", () => {
      // Cursor was at column 80 in a 80-wide viewport — pending-wrap state.
      // The next write triggers terminal wrap; virtual cursor lands at
      // (1, y+1) for a Single cell.
      const vs = new VirtualScreen({ x: 80, y: 5 }, 80);
      writeCellWithStyleStr(vs, makeCell("x"), "");
      expect(vs.cursor).toEqual({ x: 1, y: 6 });
    });
  });

  describe("moveCursorTo (Phase 3a)", () => {
    it("same-row move: emits one cursorMove patch with relative dx", () => {
      const vs = new VirtualScreen({ x: 5, y: 0 }, 80);
      moveCursorTo(vs, 10, 0);
      expect(vs.diff).toEqual([{ type: "cursorMove", x: 5, y: 0 }]);
      expect(vs.cursor).toEqual({ x: 10, y: 0 });
    });

    it("cross-row move: emits CR + cursorMove(targetX, dy)", () => {
      const vs = new VirtualScreen({ x: 5, y: 2 }, 80);
      moveCursorTo(vs, 3, 4);
      expect(vs.diff).toEqual([
        { type: "carriageReturn" },
        { type: "cursorMove", x: 3, y: 2 },
      ]);
      expect(vs.cursor).toEqual({ x: 3, y: 4 });
    });

    it("pending-wrap state: emits CR + cursorMove(targetX, dy) even when dy=0", () => {
      const vs = new VirtualScreen({ x: 80, y: 5 }, 80);
      moveCursorTo(vs, 10, 5);
      expect(vs.diff).toEqual([
        { type: "carriageReturn" },
        { type: "cursorMove", x: 10, y: 0 },
      ]);
      expect(vs.cursor).toEqual({ x: 10, y: 5 });
    });
  });

  describe("renderFrameSlice (Phase 3a)", () => {
    it("renders a single-row slice with one ASCII char (cursor lands at y=1 after row-final \\r\\n)", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      const f = frameWithScreen(3, 1, (s) =>
        setCellAt(setCellAt(s, 0, 0, makeCell("h")), 1, 0, makeCell("i")),
      );
      renderFrameSlice(vs, f, 0, 1);
      const stdout = vs.diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      expect(stdout).toContain("h");
      expect(stdout).toContain("i");
      // Row-final \r\n is emitted unconditionally (matches CC reference);
      // cursor advances to y=1 after the slice.
      expect(vs.cursor.y).toBe(1);
    });

    it("multi-row slice: advances rows via \\r\\n between (and after) rows", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      const f = frameWithScreen(1, 2, (s) =>
        setCellAt(setCellAt(s, 0, 0, makeCell("a")), 0, 1, makeCell("b")),
      );
      renderFrameSlice(vs, f, 0, 2);
      // 2 rows × row-final CR+NL = 2 CR + 2 NL.
      const carriageReturns = vs.diff.filter((p) => p.type === "carriageReturn").length;
      const newlines = vs.diff.filter(
        (p) => p.type === "stdout" && (p as { content: string }).content === "\n",
      ).length;
      expect(carriageReturns).toBeGreaterThanOrEqual(2);
      expect(newlines).toBeGreaterThanOrEqual(2);
      expect(vs.cursor.y).toBe(2);
    });

    it("skips unstyled empty cells (no spurious space painting)", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      // Row: ["a", EMPTY, EMPTY, "b"] — only "a" and "b" should be painted.
      const f = frameWithScreen(4, 1, (s) =>
        setCellAt(setCellAt(s, 0, 0, makeCell("a")), 3, 0, makeCell("b")),
      );
      renderFrameSlice(vs, f, 0, 1);
      const stdout = vs.diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      expect(stdout).not.toContain("  ");
      expect(stdout).toContain("a");
      expect(stdout).toContain("b");
    });

    it("skips SpacerTail cells", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      // Row: [中(Wide)][SpacerTail][!] — SpacerTail must not be painted.
      const f = frameWithScreen(3, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("中", { width: CellWidth.Wide }));
        n = setCellAt(n, 1, 0, makeCell("", { width: CellWidth.SpacerTail }));
        n = setCellAt(n, 2, 0, makeCell("!"));
        return n;
      });
      renderFrameSlice(vs, f, 0, 1);
      const stdout = vs.diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      expect(stdout).toContain("中");
      expect(stdout).toContain("!");
    });

    // M2 (Phase 3a review): style + hyperlink transitions inside a row —
    // verify ordering: link patches go BEFORE the cell write (so link
    // open/close brackets the glyph), style flows through the styleStr
    // parameter into writeCellWithStyleStr (gated on cell-write success).
    it("style + hyperlink transitions within a row: ordering preserved", () => {
      const vs = new VirtualScreen({ x: 0, y: 0 }, 80);
      const RED = "\x1b[31m";
      const BLUE = "\x1b[34m";
      // Use a URL whose ASCII set doesn't include the cell chars below,
      // so `indexOf("?")` / `indexOf("+")` only find the cell glyphs and
      // not letters inside the URL.
      const URL = "https://kodax.example/";
      const CHAR_FIRST = "?";  // not in URL
      const CHAR_SECOND = "+"; // not in URL
      const f = frameWithScreen(2, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell(CHAR_FIRST, { style: RED, hyperlink: URL }));
        n = setCellAt(n, 1, 0, makeCell(CHAR_SECOND, { style: BLUE, hyperlink: URL }));
        return n;
      });
      renderFrameSlice(vs, f, 0, 1);

      // Concatenate all stdout content in emission order — assertion
      // focuses on substring ordering rather than exact byte sequence.
      const stdoutBytes = vs.diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");

      // RED must appear before the first cell glyph; BLUE before the second.
      expect(stdoutBytes.indexOf(RED)).toBeLessThan(stdoutBytes.indexOf(CHAR_FIRST));
      expect(stdoutBytes.indexOf(BLUE)).toBeLessThan(stdoutBytes.indexOf(CHAR_SECOND));
      // Hyperlink open must appear before the first cell glyph too.
      const linkOpenIndex = stdoutBytes.indexOf("\x1b]8;id=");
      expect(linkOpenIndex).toBeGreaterThanOrEqual(0);
      expect(linkOpenIndex).toBeLessThan(stdoutBytes.indexOf(CHAR_FIRST));
      // EOL closes the open style and link: SGR_RESET + LINK_END appear
      // after the last cell char.
      expect(stdoutBytes.lastIndexOf("\x1b[0m")).toBeGreaterThan(stdoutBytes.lastIndexOf(CHAR_SECOND));
    });
  });

  describe("readLine (Phase 3a)", () => {
    it("reads a single-row line with trailing-whitespace trim", () => {
      let s = createScreen(5, 1);
      s = setCellAt(s, 0, 0, makeCell("h"));
      s = setCellAt(s, 1, 0, makeCell("i"));
      // Cells 2-4 are EMPTY_CELL (char " ") — trimmed by readLine.
      expect(readLine(s, 0)).toBe("hi");
    });

    it("returns empty string for an out-of-bounds row", () => {
      const s = createScreen(5, 2);
      // Row 5 is out-of-bounds — every cellAt returns undefined → ?? " ".
      // After trimEnd, all spaces → "".
      expect(readLine(s, 5)).toBe("");
    });

    it("preserves wide chars and skips SpacerTail (cell.char === '')", () => {
      let s = createScreen(3, 1);
      s = setCellAt(s, 0, 0, makeCell("中", { width: CellWidth.Wide }));
      s = setCellAt(s, 1, 0, makeCell("", { width: CellWidth.SpacerTail }));
      s = setCellAt(s, 2, 0, makeCell("!"));
      // Walk: "中" + "" + "!" = "中!" trimEnd = "中!".
      expect(readLine(s, 0)).toBe("中!");
    });
  });

  describe("fullResetSequence_CAUSES_FLICKER (Phase 3a)", () => {
    it("emits clearTerminal patch first, then full-frame paint contents", () => {
      const f = frameWithScreen(2, 1, (s) =>
        setCellAt(setCellAt(s, 0, 0, makeCell("a")), 1, 0, makeCell("b")),
      );
      const diff = fullResetSequence_CAUSES_FLICKER(f, "resize");
      expect(diff[0]).toEqual({ type: "clearTerminal", reason: "resize" });
      // Tail must contain at least the painted chars.
      const stdoutTail = diff
        .slice(1)
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      expect(stdoutTail).toContain("a");
      expect(stdoutTail).toContain("b");
    });

    it("threads the FlickerReason through to the clearTerminal patch", () => {
      const f = frameWithScreen(1, 1, (s) => setCellAt(s, 0, 0, makeCell("x")));
      expect(fullResetSequence_CAUSES_FLICKER(f, "offscreen")[0]).toEqual({
        type: "clearTerminal",
        reason: "offscreen",
      });
    });

    // M3 (Phase 3a review): empty-frame full reset returns ONLY the
    // clearTerminal patch — renderFrameSlice with startY===endY===0 emits
    // no row patches.
    it("empty frame (height 0): returns just the clearTerminal patch", () => {
      const empty = frameWithScreen(80, 0, (s) => s);
      expect(fullResetSequence_CAUSES_FLICKER(empty, "clear")).toEqual([
        { type: "clearTerminal", reason: "clear" },
      ]);
    });
  });

  describe("transitionStyleStr (Phase 3a — flattened for writeCellWithStyleStr)", () => {
    it("returns empty string when no transition", () => {
      const RED = "\x1b[31m";
      expect(transitionStyleStr(RED, RED)).toEqual({ str: "", current: RED });
    });

    it("flattens open-from-empty into the new style string", () => {
      const RED = "\x1b[31m";
      expect(transitionStyleStr("", RED)).toEqual({ str: RED, current: RED });
    });

    it("flattens reset+apply into SGR_RESET + new style", () => {
      const RED = "\x1b[31m";
      const BLUE = "\x1b[34m";
      const result = transitionStyleStr(RED, BLUE);
      expect(result.str).toBe(`\x1b[0m${BLUE}`);
      expect(result.current).toBe(BLUE);
    });

    it("flattens close-to-empty into SGR_RESET only", () => {
      const RED = "\x1b[31m";
      expect(transitionStyleStr(RED, "")).toEqual({ str: "\x1b[0m", current: "" });
    });
  });

  describe("CARRIAGE_RETURN / NEWLINE constants", () => {
    it("are exported singletons matching the documented Patch shapes", () => {
      expect(CARRIAGE_RETURN).toEqual({ type: "carriageReturn" });
      expect(NEWLINE).toEqual({ type: "stdout", content: "\n" });
    });
  });
});

// Silence "unused" warnings for symbols only used for type assertions in tests.
void EMPTY_CELL;
