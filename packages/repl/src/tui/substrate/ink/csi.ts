/**
 * CSI primitives for the cell-level renderer (FEATURE_057 Track F, Phase 1).
 *
 * Pure string-returning functions. No stream writes. No process state.
 * Architecturally aligned with `claudecode/src/ink/termio/csi.ts` but stripped
 * to the subset Track F's renderer needs.
 *
 * Naming: this file lives at `substrate/ink/csi.ts` rather than under a
 * `termio/` sub-dir to avoid confusion with `tui/core/termio.ts` which owns
 * alt-screen and mouse-tracking sequences at a different layer.
 */

const ESC = "\x1b";
const CSI_PREFIX = ESC + "[";

function csi(...args: (string | number)[]): string {
  if (args.length === 0) return CSI_PREFIX;
  if (args.length === 1) return `${CSI_PREFIX}${args[0]}`;
  const params = args.slice(0, -1);
  const final = args[args.length - 1];
  return `${CSI_PREFIX}${params.join(";")}${final}`;
}

/** Move cursor up n lines (CSI n A). */
export function cursorUp(n = 1): string {
  return n === 0 ? "" : csi(n, "A");
}

/** Move cursor down n lines (CSI n B). */
export function cursorDown(n = 1): string {
  return n === 0 ? "" : csi(n, "B");
}

/** Move cursor forward n columns (CSI n C). */
export function cursorForward(n = 1): string {
  return n === 0 ? "" : csi(n, "C");
}

/** Move cursor back n columns (CSI n D). */
export function cursorBack(n = 1): string {
  return n === 0 ? "" : csi(n, "D");
}

/** Move cursor to column n (1-indexed) (CSI n G). */
export function cursorTo(col: number): string {
  return csi(col, "G");
}

/**
 * Move cursor to column 1 (CSI G — Cursor Character Absolute with the
 * parameter omitted, which the VT100 / ECMA-48 spec defines as column 1).
 *
 * Name kept for parity with the Claude Code reference, but note this is
 * NOT a relative left move (`CSI D` would be that — see `cursorBack`).
 * Equivalent to `cursorTo(1)`; the bareform saves one parameter byte per
 * emit and matches CC's `CURSOR_LEFT` byte sequence.
 */
export const CURSOR_LEFT = csi("G");

/** Move cursor to home position (CSI H). */
export const CURSOR_HOME = csi("H");

/**
 * Move cursor relative to current position.
 * Positive x = right, negative x = left.
 * Positive y = down, negative y = up.
 *
 * Horizontal first (matches the ansi-escapes package's behavior so existing
 * downstream consumers don't see ordering surprises during the migration).
 */
export function cursorMove(x: number, y: number): string {
  let result = "";
  if (x < 0) {
    result += cursorBack(-x);
  } else if (x > 0) {
    result += cursorForward(x);
  }
  if (y < 0) {
    result += cursorUp(-y);
  } else if (y > 0) {
    result += cursorDown(y);
  }
  return result;
}

/** Erase entire line (CSI 2 K). */
export const ERASE_LINE = csi(2, "K");

/**
 * Erase n lines starting from the cursor line, moving the cursor up.
 * Each line is erased and the cursor moves up; final position is column 1.
 */
export function eraseLines(n: number): string {
  if (n <= 0) return "";
  let result = "";
  for (let i = 0; i < n; i++) {
    result += ERASE_LINE;
    if (i < n - 1) {
      result += cursorUp(1);
    }
  }
  result += CURSOR_LEFT;
  return result;
}

/** Reset scroll region to full screen (DECSTBM, CSI r). Homes the cursor. */
export const RESET_SCROLL_REGION = csi("r");

/**
 * SGR reset — clears all active graphical attributes (color, bold, inverse,
 * underline, etc.) and returns the terminal to its default rendition.
 * Phase 2 emits this between style transitions because KodaX's `Cell.style`
 * is a complete escape-sequence string (no `@alcalzone/ansi-tokenize`-based
 * diffing yet); resetting before applying the next style keeps emitted
 * sequences additive-only and avoids accumulated SGR state across cells.
 */
export const SGR_RESET = csi(0, "m");

/** @internal — exposed for unit-test isolation only. */
export const _internals = { csi, ESC, CSI_PREFIX };
