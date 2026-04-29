/**
 * Cell-level screen buffer (FEATURE_057 Track F, Phase 1).
 *
 * This is the cell-grid data structure that backs the new diff renderer.
 * It is intentionally NAMED `cell-screen.ts` (not `screen.ts`) because
 * `tui/core/screen.ts` already owns `TranscriptScreenBuffer` at the
 * transcript-row layer — those two screens live at different layers and
 * must not collide.
 *
 * Phase 1 scope: types and pure operations only. No StylePool / CharPool /
 * HyperlinkPool interning yet — Phase 2 layers those in if profiling shows
 * they pay off. Per the design doc out-of-scope list, the `damage` field
 * from the CC reference is also deliberately omitted here.
 */

/**
 * A cell occupies one or two terminal columns. Wide CJK characters and
 * many emojis paint as a Wide cell at column x followed by a SpacerTail
 * cell at column x+1; that spacer carries no glyph and the diff loop
 * MUST skip it when emitting output.
 */
export const CellWidth = {
  Single: 0,
  Wide: 1,
  SpacerTail: 2,
} as const;
export type CellWidth = (typeof CellWidth)[keyof typeof CellWidth];

/**
 * One terminal cell. `style` and `hyperlink` are kept inline as strings in
 * Phase 1 — Phase 2 may replace them with pool-interned ids if profiling
 * shows allocation cost dominates.
 */
export interface Cell {
  readonly char: string;
  readonly width: CellWidth;
  readonly style: string;
  readonly hyperlink: string | undefined;
}

export const EMPTY_CELL: Cell = {
  char: " ",
  width: CellWidth.Single,
  style: "",
  hyperlink: undefined,
};

/**
 * Row-major cell grid. Cells are accessed via `cellAt(screen, x, y)` rather
 * than indexed directly to keep the storage shape an implementation detail.
 */
export interface Screen {
  readonly width: number;
  readonly height: number;
  /** Row-major: cells[y * width + x]. Length = width * height. */
  readonly cells: ReadonlyArray<Cell>;
}

/**
 * Construct an empty screen of the given dimensions.
 *
 * Phase 1 returns an actual filled grid so unit tests can verify the
 * row-major addressing without needing any pool plumbing.
 */
export function createScreen(width: number, height: number): Screen {
  if (width < 0 || height < 0) {
    throw new RangeError(
      `Screen dimensions must be non-negative (got width=${width}, height=${height})`,
    );
  }
  const cells = new Array<Cell>(width * height).fill(EMPTY_CELL);
  return { width, height, cells };
}

/**
 * Read the cell at (x, y). Returns `undefined` when out of bounds rather
 * than throwing — Phase 2's diff loop intentionally probes the previous
 * frame's coordinates that may not exist after a shrink and treats `undefined`
 * as "needs paint".
 */
export function cellAt(screen: Screen, x: number, y: number): Cell | undefined {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    return undefined;
  }
  return screen.cells[y * screen.width + x];
}

/**
 * Write a cell at (x, y). Returns a new Screen — Screens are treated as
 * immutable from the caller's perspective (consistent with `coding-style:
 * immutability`). Out-of-bounds writes throw to surface bugs early.
 */
export function setCellAt(
  screen: Screen,
  x: number,
  y: number,
  cell: Cell,
): Screen {
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    throw new RangeError(
      `setCellAt out of bounds: (${x}, ${y}) on ${screen.width}x${screen.height}`,
    );
  }
  const nextCells = screen.cells.slice();
  nextCells[y * screen.width + x] = cell;
  return { ...screen, cells: nextCells };
}

/**
 * Phase 1 stub: walks every cell and yields (x, y, prev, next) where the
 * cells differ. Phase 3 replaces this with the row-aware two-pass loop
 * (existing rows then growth rows) that the CC reference uses.
 */
export function* diffEach(
  prev: Screen,
  next: Screen,
): Generator<{ x: number; y: number; prev: Cell | undefined; next: Cell | undefined }> {
  const width = Math.max(prev.width, next.width);
  const height = Math.max(prev.height, next.height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = cellAt(prev, x, y);
      const b = cellAt(next, x, y);
      if (cellsEqual(a, b)) continue;
      yield { x, y, prev: a, next: b };
    }
  }
}

/**
 * Phase 1 stub: scrolling helper that returns a screen whose rows have
 * been shifted by `n` (positive shifts content up, negative shifts down).
 * Phase 3 wires this into `render()`'s scrollback detection branch; for
 * now it exists as a typed pure function so callers can be sketched.
 */
export function shiftRows(screen: Screen, n: number): Screen {
  if (n === 0 || screen.height === 0) return screen;
  if (Math.abs(n) >= screen.height) return createScreen(screen.width, screen.height);
  const next = new Array<Cell>(screen.cells.length).fill(EMPTY_CELL);
  if (n > 0) {
    for (let y = 0; y < screen.height - n; y++) {
      for (let x = 0; x < screen.width; x++) {
        next[y * screen.width + x] = screen.cells[(y + n) * screen.width + x] ?? EMPTY_CELL;
      }
    }
  } else {
    for (let y = -n; y < screen.height; y++) {
      for (let x = 0; x < screen.width; x++) {
        next[y * screen.width + x] = screen.cells[(y + n) * screen.width + x] ?? EMPTY_CELL;
      }
    }
  }
  return { ...screen, cells: next };
}

function cellsEqual(a: Cell | undefined, b: Cell | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.char === b.char &&
    a.width === b.width &&
    a.style === b.style &&
    a.hyperlink === b.hyperlink
  );
}
