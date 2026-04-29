import { describe, it, expect } from "vitest";
import {
  type Cell,
  CellWidth,
  EMPTY_CELL,
  createScreen,
  setCellAt,
} from "./cell-screen.js";
import type { Frame } from "./frame.js";
import {
  computeViewportState,
  shouldFullReset,
  shouldSkipDiff,
} from "./viewport-state.js";
import { readLine } from "./cell-renderer.js";

function makeCell(char: string, opts: { width?: CellWidth } = {}): Cell {
  return {
    char,
    width: opts.width ?? CellWidth.Single,
    style: "",
    hyperlink: undefined,
  };
}

interface FrameOpts {
  /** Screen dimensions (default 80×0). */
  screenW?: number;
  screenH?: number;
  /** Viewport dimensions (default 80×24). */
  viewW?: number;
  viewH?: number;
  /** Cursor position (default x=0, y=0). */
  cursorX?: number;
  cursorY?: number;
  /** Mutator to populate cells. */
  fill?: (s: ReturnType<typeof createScreen>) => ReturnType<typeof createScreen>;
}

function makeFrame(opts: FrameOpts = {}): Frame {
  const screenW = opts.screenW ?? 80;
  const screenH = opts.screenH ?? 0;
  const viewW = opts.viewW ?? 80;
  const viewH = opts.viewH ?? 24;
  let screen = createScreen(screenW, screenH);
  if (opts.fill) screen = opts.fill(screen);
  return {
    screen,
    viewport: { width: viewW, height: viewH },
    cursor: { x: opts.cursorX ?? 0, y: opts.cursorY ?? 0, visible: true },
  };
}

describe("substrate/ink/viewport-state — Phase 3b (FEATURE_057 Track F)", () => {
  describe("computeViewportState — viewportY / cursorAtBottom / growing / shrinking flags", () => {
    // Fixture rationale: every entry is hand-traced against the CC reference
    // arithmetic at `claudecode/src/ink/log-update.ts:199-300`. The "expected"
    // values are the algorithm's ground truth — change tests only after
    // re-deriving against CC.

    it("first render (prev is empty seed): cursorAtBottom=true, growing=true, viewportY=0", () => {
      const prev = makeFrame({ screenW: 0, screenH: 0, viewW: 80, viewH: 24, cursorX: 0, cursorY: 0 });
      const next = makeFrame({ screenH: 5 });
      const state = computeViewportState(prev, next);
      expect(state).toEqual({
        viewportY: 0,
        cursorAtBottom: true,         // 0 >= 0 → true
        growing: true,                // 5 > 0
        shrinking: false,
        prevHadScrollback: false,     // prev.height (0) < viewport.height (24)
        nextFitsViewport: true,       // 5 <= 24
      });
    });

    it("steady state, content fits viewport: cursorAtBottom=true, no growth, viewportY=0", () => {
      // prev = next: same content, height=5, viewport=24, cursor at bottom.
      const prev = makeFrame({ screenH: 5, cursorY: 5 });
      const next = makeFrame({ screenH: 5, cursorY: 5 });
      const state = computeViewportState(prev, next);
      expect(state).toMatchObject({
        cursorAtBottom: true,        // 5 >= 5
        growing: false,
        shrinking: false,
        prevHadScrollback: false,    // 5 < 24
        nextFitsViewport: true,
      });
      // Non-growing: viewportY = max(5, 5) - 24 + 0 = -19 (yes, negative).
      // The main loop only uses viewportY > 0 to gate scrollback rows;
      // a negative value means "no scrollback" which is correct here.
      expect(state.viewportY).toBe(-19);
    });

    it("content exactly fills viewport, cursor at bottom: prevHadScrollback=true, viewportY=1", () => {
      // prev.height === viewport.height → prevHadScrollback fires per CC's
      // >= comparison (cursor-restore LF scrolled +1 row out of view).
      const prev = makeFrame({ screenH: 24, viewH: 24, cursorY: 24 });
      const next = makeFrame({ screenH: 24, viewH: 24, cursorY: 24 });
      const state = computeViewportState(prev, next);
      expect(state).toMatchObject({
        cursorAtBottom: true,         // 24 >= 24
        growing: false,
        shrinking: false,
        prevHadScrollback: true,      // 24 >= 24
        nextFitsViewport: true,
      });
      // cursorRestoreScroll = 1 (because prevHadScrollback)
      // non-growing path: viewportY = max(24, 24) - 24 + 1 = 1
      expect(state.viewportY).toBe(1);
    });

    it("content overflows viewport, cursor at bottom: prevHadScrollback=true, viewportY=overflow+1", () => {
      // prev.height = 30, viewport.height = 24 — 6 rows in scrollback.
      // Plus the cursor-restore LF = 7 total.
      const prev = makeFrame({ screenH: 30, viewH: 24, cursorY: 30 });
      const next = makeFrame({ screenH: 30, viewH: 24, cursorY: 30 });
      const state = computeViewportState(prev, next);
      expect(state).toMatchObject({
        cursorAtBottom: true,        // 30 >= 30
        growing: false,
        shrinking: false,
        prevHadScrollback: true,
        nextFitsViewport: false,     // 30 > 24
      });
      // non-growing: max(30, 30) - 24 + 1 = 7
      expect(state.viewportY).toBe(7);
    });

    it("growing from in-viewport to in-viewport: viewportY=0 (no scrollback yet)", () => {
      const prev = makeFrame({ screenH: 5, viewH: 24, cursorY: 5 });
      const next = makeFrame({ screenH: 10, viewH: 24, cursorY: 10 });
      const state = computeViewportState(prev, next);
      expect(state.growing).toBe(true);
      // growing path: max(0, 5 - 24 + 0) = 0
      expect(state.viewportY).toBe(0);
    });

    it("growing from at-viewport to overflow: viewportY counts prev scrollback +1 from cursor-restore", () => {
      // prev.height = 24, viewport.height = 24, cursor at bottom →
      // prevHadScrollback. next.height = 30 (growing).
      const prev = makeFrame({ screenH: 24, viewH: 24, cursorY: 24 });
      const next = makeFrame({ screenH: 30, viewH: 24, cursorY: 30 });
      const state = computeViewportState(prev, next);
      expect(state.growing).toBe(true);
      expect(state.prevHadScrollback).toBe(true);
      // growing path: max(0, 24 - 24 + 1) = 1
      expect(state.viewportY).toBe(1);
    });

    it("shrinking from overflow to in-viewport: cursorAtBottom + prevHadScrollback hold against prev state", () => {
      const prev = makeFrame({ screenH: 30, viewH: 24, cursorY: 30 });
      const next = makeFrame({ screenH: 10, viewH: 24, cursorY: 10 });
      const state = computeViewportState(prev, next);
      expect(state).toMatchObject({
        shrinking: true,
        cursorAtBottom: true,         // measured against PREV
        prevHadScrollback: true,      // 30 >= 24 + cursor at bottom
        nextFitsViewport: true,
      });
      // non-growing: max(30, 10) - 24 + 1 = 7
      expect(state.viewportY).toBe(7);
    });

    it("cursor not at bottom (e.g., still typing): cursorAtBottom=false, prevHadScrollback=false even on overflow", () => {
      // Content overflows but cursor is mid-content (not at bottom) — no
      // cursor-restore LF was emitted last frame, so no extra scrollback row.
      const prev = makeFrame({ screenH: 30, viewH: 24, cursorY: 5 });
      const next = makeFrame({ screenH: 30, viewH: 24, cursorY: 5 });
      const state = computeViewportState(prev, next);
      expect(state).toMatchObject({
        cursorAtBottom: false,       // 5 < 30
        prevHadScrollback: false,    // gated on cursorAtBottom
        growing: false,
      });
      // No cursorRestoreScroll: max(30, 30) - 24 + 0 = 6
      expect(state.viewportY).toBe(6);
    });
  });

  describe("shouldFullReset — 4 reset cases", () => {
    describe("Case 1: 'resize'", () => {
      it("viewport height shrinks → resize reset", () => {
        const prev = makeFrame({ viewH: 24, screenH: 5, cursorY: 5 });
        const next = makeFrame({ viewH: 20, screenH: 5, cursorY: 5 });
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: true, reason: "resize" });
      });

      it("viewport width changes → resize reset", () => {
        // Use prev.viewW=80, prev.screenW=80 so prev isn't the empty seed.
        const prev = makeFrame({ screenW: 80, viewW: 80, screenH: 5, cursorY: 5 });
        const next = makeFrame({ screenW: 80, viewW: 100, screenH: 5, cursorY: 5 });
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: true, reason: "resize" });
      });

      it("first render with prev.viewport.width === 0: width change is not flagged as resize", () => {
        // prev.viewport.width === 0 is the empty-seed signal — we should
        // NOT trigger a 'resize' reset for the first real render.
        const prev = makeFrame({ screenW: 0, screenH: 0, viewW: 0, viewH: 24, cursorX: 0, cursorY: 0 });
        const next = makeFrame({ screenH: 5 });
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: false });
      });

      it("viewport height grows: NO resize (only shrinking heights flag resize)", () => {
        const prev = makeFrame({ viewH: 20, screenH: 5, cursorY: 5 });
        const next = makeFrame({ viewH: 24, screenH: 5, cursorY: 5 });
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: false });
      });
    });

    describe("Case 2: shrink-from-above-viewport-to-fits-viewport ('offscreen')", () => {
      it("prev had scrollback, next fits viewport, shrinking → offscreen reset", () => {
        const prev = makeFrame({ screenH: 30, viewH: 24, cursorY: 30 });
        const next = makeFrame({ screenH: 10, viewH: 24, cursorY: 10 });
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: true, reason: "offscreen" });
      });

      it("prev had scrollback, next still overflows: NOT this case (Case 3 may still fire)", () => {
        // Both overflow, shrinking — Case 2 needs nextFitsViewport.
        const prev = makeFrame({ screenH: 30, viewH: 24, cursorY: 30, fill: (s) => setCellAt(s, 0, 0, makeCell("a")) });
        const next = makeFrame({ screenH: 25, viewH: 24, cursorY: 25, fill: (s) => setCellAt(s, 0, 0, makeCell("a")) });
        // No cell change in scrollback rows (both have "a" at row 0; prev had scrollback rows 0-6 + cursorRestoreLF row 7).
        // Actually: prev.height=30, viewportY = 6, scrollbackRows=7. Row 0 differs? Both are "a" → no change at row 0.
        // But cells at rows >= 25 in prev exist but not in next → those are diff entries (non-skipped).
        // Row 25 in prev is undefined-cell-vs-empty? Actually setCellAt(s, 0, 0, "a") only sets cell at (0,0).
        // Other cells of prev are EMPTY_CELL since createScreen fills with EMPTY_CELL; but createScreen creates only
        // width × height cells, so (0, 25)-(0, 29) for prev exist as EMPTY_CELL, but for next they don't (next.height=25).
        // diffEach walks max(width, width) × max(prev.height=30, next.height=25) = 80 × 30. So diff entries exist
        // at (x, 25) through (x, 29) where prev is EMPTY_CELL and next is undefined.
        // Row 25 < scrollbackRows (=7)? No, 25 > 7. So Case 3 doesn't fire.
        // Case 4: linesToClear = 30 - 25 = 5. 5 > 24? No. So Case 4 doesn't fire.
        // → reset: false.
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: false });
      });
    });

    describe("Case 3: cell change in scrollback ('offscreen' with debug trigger)", () => {
      it("non-growing, cursor at bottom, prev overflows, change at scrollback row → offscreen reset with trigger", () => {
        // prev.height=30, viewport=24, cursor at 30. viewportY (steady) = 6, scrollbackRows = 7.
        // Change a cell at row 3 (which is < 7 → scrollback).
        const prev = makeFrame({
          screenH: 30, viewH: 24, cursorY: 30,
          fill: (s) => setCellAt(s, 0, 3, makeCell("X")),
        });
        const next = makeFrame({
          screenH: 30, viewH: 24, cursorY: 30,
          fill: (s) => setCellAt(s, 0, 3, makeCell("Y")),
        });
        const decision = shouldFullReset(prev, next, readLine);
        expect(decision.reset).toBe(true);
        if (decision.reset) {
          expect(decision.reason).toBe("offscreen");
          expect(decision.trigger?.y).toBe(3);
          expect(decision.trigger?.prevLine).toBe("X");
          expect(decision.trigger?.nextLine).toBe("Y");
        }
      });

      it("non-growing, cursor NOT at bottom: Case 3 doesn't fire (prevHadScrollback short-circuit)", () => {
        const prev = makeFrame({
          screenH: 30, viewH: 24, cursorY: 5,
          fill: (s) => setCellAt(s, 0, 3, makeCell("X")),
        });
        const next = makeFrame({
          screenH: 30, viewH: 24, cursorY: 5,
          fill: (s) => setCellAt(s, 0, 3, makeCell("Y")),
        });
        // cursorAtBottom = 5 >= 30 = false → Case 3 guard fails.
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: false });
      });

      it("growing: Case 3 doesn't fire even with scrollback", () => {
        // CC reference: Case 3 only fires in steady state (!isGrowing).
        // Growing rows haven't scrolled old ones out yet, so the
        // viewportY calculation in the growing branch handles it.
        const prev = makeFrame({
          screenH: 30, viewH: 24, cursorY: 30,
          fill: (s) => setCellAt(s, 0, 3, makeCell("X")),
        });
        const next = makeFrame({
          screenH: 35, viewH: 24, cursorY: 35,
          fill: (s) => setCellAt(s, 0, 3, makeCell("Y")),
        });
        const decision = shouldFullReset(prev, next, readLine);
        expect(decision.reset).toBe(false);
      });

      it("change at row >= scrollbackRows (visible): Case 3 doesn't fire", () => {
        const prev = makeFrame({
          screenH: 30, viewH: 24, cursorY: 30,
          fill: (s) => setCellAt(s, 0, 15, makeCell("X")),
        });
        const next = makeFrame({
          screenH: 30, viewH: 24, cursorY: 30,
          fill: (s) => setCellAt(s, 0, 15, makeCell("Y")),
        });
        // Row 15 >= scrollbackRows (=7) → visible, not triggering Case 3.
        const decision = shouldFullReset(prev, next, readLine);
        expect(decision.reset).toBe(false);
      });
    });

    describe("Case 4: linesToClear > viewport ('offscreen')", () => {
      it("shrinking by more rows than viewport → offscreen reset", () => {
        // prev=30, next=5, viewport=24. linesToClear=25 > 24.
        const prev = makeFrame({ screenH: 30, viewH: 24, cursorY: 30 });
        const next = makeFrame({ screenH: 5, viewH: 24, cursorY: 5 });
        // BUT Case 2 fires first (prevHadScrollback + nextFitsViewport + shrinking).
        // We expect Case 2's offscreen, so Case 4 is logically masked. The
        // public contract is just "reset: true, reason: offscreen" — both
        // cases produce the same external result. Verify the result.
        expect(shouldFullReset(prev, next, readLine)).toMatchObject({ reset: true, reason: "offscreen" });
      });

      it("shrinking from in-viewport to smaller in-viewport: NO Case 4 (linesToClear < viewport)", () => {
        const prev = makeFrame({ screenH: 10, viewH: 24, cursorY: 10 });
        const next = makeFrame({ screenH: 5, viewH: 24, cursorY: 5 });
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: false });
      });
    });

    describe("Negative cases (no reset)", () => {
      it("simple cell change in steady visible state: no reset", () => {
        const prev = makeFrame({
          screenH: 5, viewH: 24, cursorY: 5,
          fill: (s) => setCellAt(s, 0, 0, makeCell("a")),
        });
        const next = makeFrame({
          screenH: 5, viewH: 24, cursorY: 5,
          fill: (s) => setCellAt(s, 0, 0, makeCell("b")),
        });
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: false });
      });

      it("growing in viewport: no reset", () => {
        const prev = makeFrame({ screenH: 5, viewH: 24, cursorY: 5 });
        const next = makeFrame({ screenH: 10, viewH: 24, cursorY: 10 });
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: false });
      });

      it("equal frames: no reset", () => {
        const prev = makeFrame({ screenH: 5, viewH: 24, cursorY: 5 });
        const next = makeFrame({ screenH: 5, viewH: 24, cursorY: 5 });
        expect(shouldFullReset(prev, next, readLine)).toEqual({ reset: false });
      });
    });
  });

  describe("shouldSkipDiff — cell-skip predicate", () => {
    const wide = makeCell("中", { width: CellWidth.Wide });
    const spacerTail: Cell = { char: "", width: CellWidth.SpacerTail, style: "", hyperlink: undefined };
    const ascii = makeCell("a");

    it("added SpacerTail with no removed: skip", () => {
      expect(shouldSkipDiff(undefined, spacerTail, false)).toBe(true);
    });

    it("added SpacerTail with removed: skip", () => {
      expect(shouldSkipDiff(EMPTY_CELL, spacerTail, false)).toBe(true);
    });

    it("removed SpacerTail with no added: skip (wide-cell erase covers it)", () => {
      expect(shouldSkipDiff(spacerTail, undefined, false)).toBe(true);
    });

    it("removed SpacerTail with added replacement: NO skip (wide-cell erase no longer covers)", () => {
      // Spacer was removed AND a new cell is going in its place — must
      // paint the new cell. (CC line 326-333: removed-spacer skip is
      // gated on `!added`.)
      expect(shouldSkipDiff(spacerTail, ascii, false)).toBe(false);
    });

    it("empty added with no removed: skip (avoids trailing-space wrap at row edge)", () => {
      expect(shouldSkipDiff(undefined, EMPTY_CELL, true)).toBe(true);
    });

    it("empty added with removed: NO skip (must clear the previous content)", () => {
      expect(shouldSkipDiff(ascii, EMPTY_CELL, true)).toBe(false);
    });

    it("non-empty cells: no skip", () => {
      expect(shouldSkipDiff(EMPTY_CELL, ascii, false)).toBe(false);
      expect(shouldSkipDiff(ascii, EMPTY_CELL, false)).toBe(false);
    });

    it("undefined removed + non-empty added: no skip", () => {
      expect(shouldSkipDiff(undefined, ascii, false)).toBe(false);
    });

    it("non-empty removed + undefined added: no skip", () => {
      expect(shouldSkipDiff(ascii, undefined, false)).toBe(false);
    });
  });
});
