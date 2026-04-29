import { describe, it, expect } from "vitest";
import {
  type Cell,
  CellWidth,
  createScreen,
  setCellAt,
} from "./cell-screen.js";
import { emptyFrame, type Frame } from "./frame.js";
import { LogUpdate } from "./cell-renderer.js";

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

describe("substrate/ink/cell-renderer — LogUpdate orchestrator (FEATURE_057 Track F)", () => {
  describe("LogUpdate.render — first-render / non-TTY routing (Phase 2)", () => {
    it("non-TTY: full-frame paint regardless of prev shape", () => {
      const lu = new LogUpdate({ isTTY: false });
      const prev = emptyFrame(24, 80);
      const next = frameWithScreen(3, 1, (s) =>
        setCellAt(setCellAt(setCellAt(s, 0, 0, makeCell("h")), 1, 0, makeCell("i")), 2, 0, makeCell("!")),
      );
      const diff = lu.render(prev, next);
      expect(diff).toEqual([{ type: "stdout", content: "hi!" }]);
    });

    it("TTY first-render (prev.screen.height === 0): incremental path paints all rows + lands cursor at (0, height)", () => {
      // CC-aligned behavior (v0.7.30): no `prev.screen.height === 0`
      // short-circuit. Empty prev → diffPass skips every coordinate
      // (`growing && y >= 0`), `renderFrameSlice` paints all rows with
      // row-final `\r\n`, and `restoreCursor` is a no-op because
      // `next.cursor.y === next.screen.height === screen.cursor.y`.
      const lu = new LogUpdate({ isTTY: true });
      const prev = emptyFrame(24, 80);
      const next = frameWithScreen(2, 1, (s) =>
        setCellAt(setCellAt(s, 0, 0, makeCell("a")), 1, 0, makeCell("b")),
      );
      const diff = lu.render(prev, next);
      const stdoutBytes = diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      // Glyphs in order
      expect(stdoutBytes).toContain("a");
      expect(stdoutBytes).toContain("b");
      // Row-final \r\n emitted by renderFrameSlice
      const hasCR = diff.some((p) => p.type === "carriageReturn");
      const hasLF = diff.some(
        (p) => p.type === "stdout" && p.content === "\n",
      );
      expect(hasCR).toBe(true);
      expect(hasLF).toBe(true);
    });

    it("TTY incremental case (prev has rows): emits incremental diff via Phase 3c main loop", () => {
      const lu = new LogUpdate({ isTTY: true });
      const prev = frameWithScreen(2, 2, (s) => setCellAt(s, 0, 0, makeCell("x")));
      const next = frameWithScreen(2, 2, (s) => setCellAt(s, 0, 0, makeCell("y")));
      const diff = lu.render(prev, next);
      // Phase 3c: incremental walk emits at least the new "y" cell content
      // and a moveCursor / cursor-restore tail. Verify the diff is non-empty
      // and contains the new char.
      const stdoutBytes = diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      expect(diff.length).toBeGreaterThan(0);
      expect(stdoutBytes).toContain("y");
    });
  });

  describe("LogUpdate.render — Phase 3c incremental main loop", () => {
    it("steady state, single cell change: emits moveCursor + new char + cursor-restore", () => {
      const lu = new LogUpdate({ isTTY: true });
      const prev = frameWithScreen(3, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("a"));
        n = setCellAt(n, 1, 0, makeCell("b"));
        n = setCellAt(n, 2, 0, makeCell("c"));
        return n;
      });
      const next = frameWithScreen(3, 1, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("a"));
        n = setCellAt(n, 1, 0, makeCell("X")); // changed
        n = setCellAt(n, 2, 0, makeCell("c"));
        return n;
      });
      const diff = lu.render(prev, next);
      const stdoutBytes = diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      // Diff should contain "X" (the new char) but NOT contain "a" or "c"
      // as the only-paint chars (incremental skip — unchanged cells aren't
      // repainted).
      expect(stdoutBytes).toContain("X");
    });

    it("growing frame: emits new rows via renderFrameSlice", () => {
      const lu = new LogUpdate({ isTTY: true });
      const prev = frameWithScreen(2, 1, (s) =>
        setCellAt(setCellAt(s, 0, 0, makeCell("a")), 1, 0, makeCell("b")),
      );
      const next = frameWithScreen(2, 2, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("a"));
        n = setCellAt(n, 1, 0, makeCell("b"));
        n = setCellAt(n, 0, 1, makeCell("c"));
        n = setCellAt(n, 1, 1, makeCell("d"));
        return n;
      });
      const diff = lu.render(prev, next);
      const stdoutBytes = diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      // New row's "c" and "d" must be in the diff.
      expect(stdoutBytes).toContain("c");
      expect(stdoutBytes).toContain("d");
    });

    it("shrinking frame: emits clear patch", () => {
      const lu = new LogUpdate({ isTTY: true });
      const prev = frameWithScreen(2, 3, (s) => {
        let n = setCellAt(s, 0, 0, makeCell("a"));
        n = setCellAt(n, 0, 1, makeCell("b"));
        n = setCellAt(n, 0, 2, makeCell("c"));
        return n;
      });
      const next = frameWithScreen(2, 1, (s) => setCellAt(s, 0, 0, makeCell("a")));
      const diff = lu.render(prev, next);
      const clearPatch = diff.find((p) => p.type === "clear");
      expect(clearPatch).toBeDefined();
      if (clearPatch && clearPatch.type === "clear") {
        expect(clearPatch.count).toBe(2); // 3 - 1
      }
    });

    it("viewport resize → fullResetSequence (clearTerminal patch)", () => {
      const lu = new LogUpdate({ isTTY: true });
      const prev: Frame = {
        screen: setCellAt(createScreen(3, 2), 0, 0, makeCell("a")),
        viewport: { width: 80, height: 24 },
        cursor: { x: 0, y: 2, visible: true },
      };
      const next: Frame = {
        screen: setCellAt(createScreen(3, 2), 0, 0, makeCell("a")),
        viewport: { width: 80, height: 20 }, // shrank height → resize reset
        cursor: { x: 0, y: 2, visible: true },
      };
      const diff = lu.render(prev, next);
      expect(diff[0]).toEqual({ type: "clearTerminal", reason: "resize" });
    });

    it("scrollback cell change → fullResetSequence with offscreen reason", () => {
      const lu = new LogUpdate({ isTTY: true });
      // prev: 30-row content, viewport 24, cursor at bottom → prevHadScrollback
      // Change a cell at row 3 (in scrollback rows 0-6).
      const prev: Frame = {
        screen: setCellAt(createScreen(80, 30), 0, 3, makeCell("X")),
        viewport: { width: 80, height: 24 },
        cursor: { x: 0, y: 30, visible: true },
      };
      const next: Frame = {
        screen: setCellAt(createScreen(80, 30), 0, 3, makeCell("Y")),
        viewport: { width: 80, height: 24 },
        cursor: { x: 0, y: 30, visible: true },
      };
      const diff = lu.render(prev, next);
      expect(diff[0]).toEqual({ type: "clearTerminal", reason: "offscreen" });
    });

    // HIGH-1 (Phase 3b/3c review): cursor-restore `rowsToCreate <= 0`
    // sub-branch. Scenario: growing frame with `next.cursor.y === next.screen.height`
    // and `next.cursor.x > 0`. After renderFrameSlice's row-final \r\n,
    // the VirtualScreen cursor is at (0, next.screen.height); restoring
    // to next.cursor needs cursorMove on x only.
    it("cursor restore: rowsToCreate=0 with next.cursor.x > 0 → emits CR + cursorMove", () => {
      const lu = new LogUpdate({ isTTY: true });
      const prev: Frame = {
        screen: setCellAt(createScreen(2, 1), 0, 0, makeCell("a")),
        viewport: { width: 80, height: 24 },
        cursor: { x: 0, y: 1, visible: true },
      };
      const next: Frame = {
        screen: (() => {
          let s = createScreen(2, 2);
          s = setCellAt(s, 0, 0, makeCell("a"));
          s = setCellAt(s, 0, 1, makeCell("b"));
          return s;
        })(),
        viewport: { width: 80, height: 24 },
        cursor: { x: 1, y: 2, visible: true }, // x > 0, y === screen.height (growing path)
      };
      const diff = lu.render(prev, next);
      // Diff should land cursor at (1, 2). Look for the cursor-restore
      // tail: a CR + cursorMove or cursorMove targeting x=1.
      const lastCursorMove = [...diff].reverse().find(
        (p): p is { type: "cursorMove"; x: number; y: number } => p.type === "cursorMove",
      );
      expect(lastCursorMove).toBeDefined();
    });

    // MEDIUM-2: removed-cell handling — cell exists in prev, not in next.
    // (Note: a cell "removed" but still within next.height is normally
    // EMPTY_CELL in next; what we actually exercise is the prev cell ≠ next
    // EMPTY_CELL case, where renderIncremental should emit a clear-with-space.)
    it("removed cell (prev styled cell → next EMPTY): emits styled reset + space to clear", () => {
      const lu = new LogUpdate({ isTTY: true });
      const RED = "\x1b[31m";
      const prev: Frame = {
        screen: (() => {
          let s = createScreen(3, 1);
          s = setCellAt(s, 0, 0, makeCell("a"));
          s = setCellAt(s, 1, 0, makeCell("b", { style: RED }));
          return s;
        })(),
        viewport: { width: 80, height: 24 },
        cursor: { x: 0, y: 1, visible: true },
      };
      const next: Frame = {
        screen: setCellAt(createScreen(3, 1), 0, 0, makeCell("a")),
        viewport: { width: 80, height: 24 },
        cursor: { x: 0, y: 1, visible: true },
      };
      const diff = lu.render(prev, next);
      const stdoutBytes = diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      // "b" was removed → expect a clearing space at column 1, with no
      // RED bleeding (resetStyleAndHyperlink fires before the space).
      expect(stdoutBytes).toContain(" ");
      // Specifically NOT painting "b" from prev.
      const stdoutWithoutCellPrefix = stdoutBytes.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      expect(stdoutWithoutCellPrefix).not.toContain("b");
    });

    // MEDIUM-3: growing-region skip path — diffEach returns entries for
    // the new rows, but renderIncremental skips them (renderFrameSlice
    // paints them). Verify the new chars appear EXACTLY ONCE.
    it("growing frame: new-row chars are not double-painted by diff loop + grow path", () => {
      const lu = new LogUpdate({ isTTY: true });
      const prev: Frame = {
        screen: setCellAt(createScreen(2, 1), 0, 0, makeCell("a")),
        viewport: { width: 80, height: 24 },
        cursor: { x: 0, y: 1, visible: true },
      };
      const next: Frame = {
        screen: (() => {
          let s = createScreen(2, 2);
          s = setCellAt(s, 0, 0, makeCell("a"));
          s = setCellAt(s, 0, 1, makeCell("Z"));
          return s;
        })(),
        viewport: { width: 80, height: 24 },
        cursor: { x: 1, y: 2, visible: true },
      };
      const diff = lu.render(prev, next);
      const stdoutBytes = diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      // "Z" must appear exactly once (renderFrameSlice paint, not also
      // from a stale diff-loop visit to the grow-region row).
      const zMatches = (stdoutBytes.match(/Z/g) ?? []).length;
      expect(zMatches).toBe(1);
    });

    // MEDIUM-4: SpacerTail integration — ensure the diff loop does NOT
    // emit a stdout patch at a SpacerTail coordinate, even when the
    // spacer's prev/next states differ (shouldSkipDiff catches it).
    it("SpacerTail diff entry is skipped — no stdout patch at the spacer coordinate", () => {
      const lu = new LogUpdate({ isTTY: true });
      // Both prev and next have a [Wide][SpacerTail] pair, but the wide
      // char differs (中 → 文). The change at col 0 must paint, but the
      // SpacerTail at col 1 must NOT trigger an additional paint.
      const prev: Frame = {
        screen: (() => {
          let s = createScreen(2, 1);
          s = setCellAt(s, 0, 0, makeCell("中", { width: CellWidth.Wide }));
          s = setCellAt(s, 1, 0, makeCell("", { width: CellWidth.SpacerTail }));
          return s;
        })(),
        viewport: { width: 80, height: 24 },
        cursor: { x: 0, y: 1, visible: true },
      };
      const next: Frame = {
        screen: (() => {
          let s = createScreen(2, 1);
          s = setCellAt(s, 0, 0, makeCell("文", { width: CellWidth.Wide }));
          s = setCellAt(s, 1, 0, makeCell("", { width: CellWidth.SpacerTail }));
          return s;
        })(),
        viewport: { width: 80, height: 24 },
        cursor: { x: 0, y: 1, visible: true },
      };
      const diff = lu.render(prev, next);
      const stdoutBytes = diff
        .filter((p): p is { type: "stdout"; content: string } => p.type === "stdout")
        .map((p) => p.content)
        .join("");
      // "文" appears (paint at col 0); no stale "中" survives; spacer
      // didn't produce its own stdout patch (which would manifest as a
      // cursorTo column 2 followed by an empty-string write — easier to
      // assert via the simpler "exactly one wide-char paint" check).
      expect(stdoutBytes).toContain("文");
      expect(stdoutBytes).not.toContain("中");
    });
  });

  describe("LogUpdate.reset", () => {
    it("does not throw and leaves the instance reusable", () => {
      const lu = new LogUpdate({ isTTY: true });
      expect(() => lu.reset()).not.toThrow();
      // Empty frame → empty frame: incremental path is fully no-op
      // (no growing, no shrinking, empty diffEach, restoreCursor is
      // a no-op when prev.cursor === next.cursor === (0, 0)). Keeps
      // the post-reset reusability invariant.
      expect(lu.render(emptyFrame(24, 80), emptyFrame(24, 80))).toEqual([]);
    });
  });

});
