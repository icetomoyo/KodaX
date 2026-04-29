import { describe, it, expect } from "vitest";
import { applyCellFrame, type CellFrameState } from "./apply-cell-frame.js";
import { LogUpdate } from "./cell-renderer.js";
import { emptyFrame, type Frame } from "./frame.js";
import { createScreen, setCellAt, CellWidth } from "./cell-screen.js";

function mockStream() {
  const written: string[] = [];
  return {
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    written,
  };
}

function makeState(): CellFrameState & { stdout: ReturnType<typeof mockStream> } {
  const stdout = mockStream();
  return {
    cellLogUpdate: new LogUpdate({ isTTY: true }),
    prevFrame: emptyFrame(24, 80),
    stdout,
  };
}

function frameWithText(width: number, height: number, text: string): Frame {
  let screen = createScreen(width, height);
  for (let i = 0; i < text.length && i < width; i++) {
    screen = setCellAt(screen, i, 0, {
      char: text[i]!,
      width: CellWidth.Single,
      style: "",
      hyperlink: undefined,
    });
  }
  return {
    screen,
    viewport: { width: 80, height: 24 },
    cursor: { x: 0, y: height, visible: true },
  };
}

describe("substrate/ink/apply-cell-frame (FEATURE_057 Track F, Phase 4c)", () => {
  describe("returns false (no-op) when frame is undefined", () => {
    it("undefined frame: no bytes written, prevFrame unchanged, returns false", () => {
      const state = makeState();
      const beforePrev = state.prevFrame;
      const applied = applyCellFrame(state, undefined);
      expect(applied).toBe(false);
      expect(state.stdout.written).toEqual([]);
      expect(state.prevFrame).toBe(beforePrev);
    });
  });

  describe("first render (prev.screen.height === 0) — CC-aligned incremental path", () => {
    it("paints the frame via incremental path with row-final \\r\\n; single applyDiff write; updates prevFrame", () => {
      const state = makeState();
      const frame = frameWithText(5, 1, "hello");
      const applied = applyCellFrame(state, frame);
      expect(applied).toBe(true);
      // CC-aligned (v0.7.30): no separate trailing \n write. applyDiff
      // emits a single concatenated buffer per render — the buffer
      // contains the cell glyphs and a row-final \r\n from
      // renderFrameSlice's row terminator.
      expect(state.stdout.written).toHaveLength(1);
      const bytes = state.stdout.written[0]!;
      expect(bytes).toContain("hello");
      // Row-final \r\n: cursor lands at (0, height) so prevFrame.cursor
      // matches the physical terminal cursor for the next render.
      expect(bytes).toContain("\r\n");
      expect(state.prevFrame).toBe(frame);
    });

    it("fullscreen first render (screen.height === viewport.height): same incremental path, no special-case", () => {
      // CC-aligned: no fullscreen-fit guard needed. renderFrameSlice
      // always emits row-final \r\n for every painted row, including
      // the last; restoreCursor is a no-op when next.cursor.y matches
      // screen.cursor.y. Cursor stays consistent regardless of whether
      // the content fits, fills, or overflows the viewport.
      const state = makeState();
      const fullFrame: Frame = {
        ...frameWithText(5, 24, "abcde"),
        viewport: { width: 80, height: 24 },
      };
      const applied = applyCellFrame(state, fullFrame);
      expect(applied).toBe(true);
      expect(state.stdout.written).toHaveLength(1);
      expect(state.stdout.written[0]!.length).toBeGreaterThan(0);
    });

    it("viewport overflow (screen.height > viewport.height): same incremental path", () => {
      const state = makeState();
      const overflowFrame: Frame = {
        ...frameWithText(5, 30, "x"),
        viewport: { width: 80, height: 24 },
      };
      applyCellFrame(state, overflowFrame);
      expect(state.stdout.written).toHaveLength(1);
    });

    it("first render with empty frame (height 0): empty diff → no write, prevFrame still updated", () => {
      const state = makeState();
      const empty: Frame = {
        screen: createScreen(0, 0),
        viewport: { width: 80, height: 24 },
        cursor: { x: 0, y: 0, visible: true },
      };
      const applied = applyCellFrame(state, empty);
      expect(applied).toBe(true);
      // Incremental path on empty→empty produces an empty diff;
      // applyDiff skips the write entirely.
      expect(state.stdout.written).toEqual([]);
      expect(state.prevFrame).toBe(empty);
    });
  });

  describe("subsequent incremental render (prev.screen.height > 0)", () => {
    it("steady state same frame: empty diff → no bytes written", () => {
      const state = makeState();
      // Seed prevFrame so the next call goes the incremental path.
      const seed = frameWithText(3, 1, "abc");
      applyCellFrame(state, seed);
      state.stdout.written.length = 0; // reset for the next call
      // Identical frame again: diff is empty.
      const applied = applyCellFrame(state, seed);
      expect(applied).toBe(true);
      // Empty diff → applyDiff skips write. NO trailing \n either (we're
      // not on the first render path anymore).
      expect(state.stdout.written).toEqual([]);
    });

    it("cell change: diff includes the new char and prevFrame updates", () => {
      const state = makeState();
      const before = frameWithText(3, 1, "abc");
      applyCellFrame(state, before);
      state.stdout.written.length = 0;
      const after = frameWithText(3, 1, "aXc"); // middle cell changed
      const applied = applyCellFrame(state, after);
      expect(applied).toBe(true);
      // The diff bytes should contain "X". Asserting presence (not exact
      // sequence) since the cursor-positioning bytes around it depend on
      // the LogUpdate.renderIncremental implementation we already
      // covered in cell-renderer.test.ts.
      const allBytes = state.stdout.written.join("");
      expect(allBytes).toContain("X");
      expect(state.prevFrame).toBe(after);
    });
  });

  describe("first-render-then-incremental sequence: prev.cursor invariant holds", () => {
    it("after first render, prevFrame.cursor matches the natural post-renderFrameSlice landing position", () => {
      // CC-aligned: renderFrameSlice's row-final \r\n lands the cursor
      // at (0, height) deterministically. restoreCursor is a no-op when
      // next.cursor.y === screen.height === screen.cursor.y. The
      // incremental render's prev.cursor for the SECOND call must equal
      // (0, height) for moveCursorTo deltas to be correct. Since
      // frameWithText sets cursor = (0, height) and applyCellFrame
      // updates prevFrame = frame, this naturally holds.
      const state = makeState();
      const first = frameWithText(5, 1, "hello");
      applyCellFrame(state, first);
      expect(state.prevFrame.cursor).toEqual({ x: 0, y: 1, visible: true });
      // Physical cursor post-write: "hello" lands at (5, 0); row-final
      // \r\n from renderFrameSlice lands at (0, 1). Matches prevFrame.cursor.
    });
  });
});
