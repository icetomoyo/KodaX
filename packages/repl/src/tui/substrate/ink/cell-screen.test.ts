import { describe, it, expect } from "vitest";
import {
  Cell,
  CellWidth,
  cellAt,
  createScreen,
  diffEach,
  EMPTY_CELL,
  Screen,
  setCellAt,
  shiftRows,
} from "./cell-screen.js";

function makeCell(char: string, width: CellWidth = CellWidth.Single): Cell {
  return { char, width, style: "", hyperlink: undefined };
}

describe("substrate/ink/cell-screen (FEATURE_057 Track F Phase 1)", () => {
  describe("createScreen", () => {
    it("creates a width*height cell array filled with EMPTY_CELL", () => {
      const screen = createScreen(3, 2);
      expect(screen.width).toBe(3);
      expect(screen.height).toBe(2);
      expect(screen.cells).toHaveLength(6);
      expect(screen.cells.every((c) => c === EMPTY_CELL)).toBe(true);
    });

    it("supports zero dimensions (used by emptyFrame seed)", () => {
      const screen = createScreen(0, 0);
      expect(screen.cells).toHaveLength(0);
    });

    it("rejects negative dimensions", () => {
      expect(() => createScreen(-1, 2)).toThrow(RangeError);
      expect(() => createScreen(2, -1)).toThrow(RangeError);
    });
  });

  describe("cellAt", () => {
    it("addresses cells in row-major order", () => {
      let screen = createScreen(3, 2);
      screen = setCellAt(screen, 0, 0, makeCell("a"));
      screen = setCellAt(screen, 2, 1, makeCell("z"));
      expect(cellAt(screen, 0, 0)?.char).toBe("a");
      expect(cellAt(screen, 2, 1)?.char).toBe("z");
      expect(cellAt(screen, 1, 0)?.char).toBe(" ");
    });

    it("returns undefined for out-of-bounds reads (Phase 3 diff loop relies on this)", () => {
      const screen = createScreen(3, 2);
      expect(cellAt(screen, -1, 0)).toBeUndefined();
      expect(cellAt(screen, 0, -1)).toBeUndefined();
      expect(cellAt(screen, 3, 0)).toBeUndefined();
      expect(cellAt(screen, 0, 2)).toBeUndefined();
    });
  });

  describe("setCellAt", () => {
    it("returns a NEW screen — original is not mutated", () => {
      const original = createScreen(2, 2);
      const updated = setCellAt(original, 0, 0, makeCell("x"));
      expect(cellAt(original, 0, 0)?.char).toBe(" ");
      expect(cellAt(updated, 0, 0)?.char).toBe("x");
      expect(updated).not.toBe(original);
    });

    it("throws for out-of-bounds writes (catches bugs early)", () => {
      const screen = createScreen(2, 2);
      expect(() => setCellAt(screen, 2, 0, makeCell("x"))).toThrow(RangeError);
      expect(() => setCellAt(screen, 0, 2, makeCell("x"))).toThrow(RangeError);
      expect(() => setCellAt(screen, -1, 0, makeCell("x"))).toThrow(RangeError);
    });
  });

  describe("diffEach", () => {
    it("yields nothing when screens are identical", () => {
      const a = createScreen(2, 2);
      const b = createScreen(2, 2);
      expect(Array.from(diffEach(a, b))).toEqual([]);
    });

    it("yields each differing cell with prev/next pointers", () => {
      const a = createScreen(2, 2);
      const b = setCellAt(createScreen(2, 2), 1, 0, makeCell("X"));
      const diffs = Array.from(diffEach(a, b));
      expect(diffs).toHaveLength(1);
      expect(diffs[0]).toMatchObject({
        x: 1,
        y: 0,
        prev: EMPTY_CELL,
        next: { char: "X" },
      });
    });

    it("yields cells in growth region as next-only when next is taller", () => {
      const a = createScreen(2, 1);
      const b = createScreen(2, 2);
      const populated = setCellAt(b, 0, 1, makeCell("Y"));
      const diffs = Array.from(diffEach(a, populated));
      // Growth row produces TWO diffs: (0,1)="Y" vs undefined and (1,1)=EMPTY vs undefined.
      // Both cells exist in `next` but not in `prev` (`prev.height === 1`), so both qualify.
      expect(diffs).toHaveLength(2);
      const at01 = diffs.find((d) => d.x === 0 && d.y === 1);
      const at11 = diffs.find((d) => d.x === 1 && d.y === 1);
      expect(at01).toMatchObject({ prev: undefined, next: { char: "Y" } });
      expect(at11).toMatchObject({ prev: undefined, next: EMPTY_CELL });
    });

    it("yields cells in shrink region as prev-only when prev was taller", () => {
      const populated = setCellAt(createScreen(2, 2), 0, 1, makeCell("Z"));
      const shrunk = createScreen(2, 1);
      const diffs = Array.from(diffEach(populated, shrunk));
      // Shrink row produces TWO diffs: (0,1)="Z" vs undefined and (1,1)=EMPTY vs undefined.
      // The (1,1) EMPTY-vs-undefined diff is intentional — Phase 3 needs to know
      // the cell coordinate is being abandoned even when the prev value was empty,
      // so the renderer can clear it from the visual buffer.
      expect(diffs).toHaveLength(2);
      const at01 = diffs.find((d) => d.x === 0 && d.y === 1);
      const at11 = diffs.find((d) => d.x === 1 && d.y === 1);
      expect(at01).toMatchObject({ prev: { char: "Z" }, next: undefined });
      expect(at11).toMatchObject({ prev: EMPTY_CELL, next: undefined });
    });

    it("does not yield spurious diffs when shrink occurs in BOTH width and height", () => {
      // prev = 3x2 with content at (0,0), next = 1x1 empty.
      // Loop walks max(3, 1) x max(2, 1) = 3 x 2. Coordinates where BOTH
      // prev and next are out-of-bounds (e.g., (2,1)) must be skipped —
      // `cellsEqual(undefined, undefined) === true` (via `a === b` short-
      // circuit) prevents a spurious diff at those coordinates.
      const prev = setCellAt(createScreen(3, 2), 0, 0, makeCell("A"));
      const next = createScreen(1, 1);
      const diffs = Array.from(diffEach(prev, next));
      // Expected diffs: every (x, y) in the prev rectangle EXCEPT the
      // single coordinate (0, 0) where prev cell A ≠ next empty.
      // Coordinates: (0,0) A vs EMPTY, (1,0) EMPTY vs undefined,
      // (2,0) EMPTY vs undefined, (0,1) EMPTY vs undefined,
      // (1,1) EMPTY vs undefined, (2,1) EMPTY vs undefined.
      // That's 6 diffs. CRITICALLY no diff has prev===undefined && next===undefined.
      expect(diffs).toHaveLength(6);
      for (const d of diffs) {
        const bothUndefined = d.prev === undefined && d.next === undefined;
        expect(bothUndefined).toBe(false);
      }
      const at00 = diffs.find((d) => d.x === 0 && d.y === 0);
      expect(at00).toMatchObject({ prev: { char: "A" }, next: EMPTY_CELL });
    });
  });

  describe("shiftRows", () => {
    it("returns the same screen for n=0", () => {
      const s = createScreen(2, 2);
      expect(shiftRows(s, 0)).toBe(s);
    });

    it("shifts content up for positive n (newest content lands lower)", () => {
      let s = createScreen(2, 3);
      s = setCellAt(s, 0, 0, makeCell("A"));
      s = setCellAt(s, 0, 1, makeCell("B"));
      s = setCellAt(s, 0, 2, makeCell("C"));
      const shifted = shiftRows(s, 1);
      expect(cellAt(shifted, 0, 0)?.char).toBe("B");
      expect(cellAt(shifted, 0, 1)?.char).toBe("C");
      expect(cellAt(shifted, 0, 2)).toEqual(EMPTY_CELL);
    });

    it("shifts content down for negative n", () => {
      let s = createScreen(2, 3);
      s = setCellAt(s, 0, 0, makeCell("A"));
      s = setCellAt(s, 0, 1, makeCell("B"));
      s = setCellAt(s, 0, 2, makeCell("C"));
      const shifted = shiftRows(s, -1);
      expect(cellAt(shifted, 0, 0)).toEqual(EMPTY_CELL);
      expect(cellAt(shifted, 0, 1)?.char).toBe("A");
      expect(cellAt(shifted, 0, 2)?.char).toBe("B");
    });

    it("returns an empty screen when |n| >= height", () => {
      let s = createScreen(2, 2);
      s = setCellAt(s, 0, 0, makeCell("X"));
      const cleared = shiftRows(s, 5);
      expect(cleared.cells.every((c) => c === EMPTY_CELL)).toBe(true);
    });
  });
});
