/**
 * Cell-level diff renderer primitives (FEATURE_057 Track F, Phases 1-3a).
 *
 * Extracted from `cell-renderer.ts` to keep both files under KodaX's
 * 800-line cap. This file holds the **pure / cell-level / frame-slice**
 * primitives — `cell-renderer.ts` retains the `LogUpdate` orchestrator
 * + Phase 3c incremental loop + flag gate.
 *
 * Direction of the import edge:
 *   cell-renderer.ts ──imports──> cell-renderer-primitives.ts
 *
 * No reverse import: this file MUST NOT import from `cell-renderer.ts`
 * (would re-introduce a circular dependency, forbidden by KodaX
 * `CLAUDE.md`). The Phase 3c block in `cell-renderer.ts` composes these
 * primitives but the primitives themselves know nothing about the
 * orchestrator.
 *
 * Architecturally aligned with `claudecode/src/ink/log-update.ts`. KodaX
 * deviations from the CC reference (intentional):
 *   - No `StylePool` interning — `Cell.style` is an inline escape-sequence
 *     string. Style transitions emit `SGR_RESET + newStyle` rather than
 *     `diffAnsiCodes` minimal-diff. Optimization deferred until profiling.
 *   - No `CharPool` / `HyperlinkPool` — strings stored inline.
 *   - `transition*` helpers are pure functions returning `{ patches, current }`
 *     rather than CC's accumulator-style mutation, to uphold KodaX's
 *     CRITICAL immutability rule.
 */

import { SGR_RESET } from "./csi.js";
import { CellWidth, cellAt, type Cell, type Screen } from "./cell-screen.js";
import type { Diff, FlickerReason, Frame, Patch, Point } from "./frame.js";
import { LINK_END, link } from "./osc.js";

/**
 * Render a full frame as a single `stdout` patch.
 *
 * Walks the cell grid row-by-row, skipping `SpacerTail` cells (the
 * terminal naturally advances past them when the wide cell at column-1 is
 * written). Emits hyperlink open/close pairs and SGR style transitions
 * inline. Lines are joined by `\n`; each line's trailing whitespace is
 * trimmed (matches CC `claudecode/src/ink/log-update.ts:105`'s
 * `lines.push(line.trimEnd())`).
 *
 * Returns an empty diff for empty screens (`width === 0 || height === 0`)
 * — the engine sees no patches and emits nothing.
 */
export function renderFullFrame(frame: Frame): Diff {
  const { screen } = frame;
  if (screen.width === 0 || screen.height === 0) {
    return [];
  }

  const lines: string[] = [];
  let currentStyle = "";
  let currentHyperlink: string | undefined = undefined;

  for (let y = 0; y < screen.height; y++) {
    let line = "";
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y);
      if (!cell || cell.width === CellWidth.SpacerTail) continue;

      // Hyperlink transition (close old, open new)
      if (cell.hyperlink !== currentHyperlink) {
        if (currentHyperlink !== undefined) line += LINK_END;
        if (cell.hyperlink !== undefined) line += link(cell.hyperlink);
        currentHyperlink = cell.hyperlink;
      }

      // Style transition: reset prior, then apply new. Inline-string style
      // model (no AnsiCode diffing) — see file-level "KodaX simplifications"
      // note for the rationale.
      if (cell.style !== currentStyle) {
        if (currentStyle !== "") line += SGR_RESET;
        if (cell.style !== "") line += cell.style;
        currentStyle = cell.style;
      }

      line += cell.char;
    }

    // End of line: close any open hyperlink, reset any active style. The
    // `line.trimEnd()` below would otherwise leave trailing ESC bytes
    // dangling at the end of a trimmed-whitespace tail.
    if (currentHyperlink !== undefined) {
      line += LINK_END;
      currentHyperlink = undefined;
    }
    if (currentStyle !== "") {
      line += SGR_RESET;
      currentStyle = "";
    }

    lines.push(line.trimEnd());
  }

  return [{ type: "stdout", content: lines.join("\n") }];
}

/**
 * Result of a style or hyperlink transition: the patches to emit and the
 * new "current" tracker value the caller should hold for the next cell.
 *
 * Returning a fresh array (rather than mutating a caller-supplied buffer)
 * upholds the project's CRITICAL immutability rule. Phase 3's diff loop
 * accumulates these per-row using spread; row-level allocation is
 * negligible compared to the cell-level work the loop already does.
 */
export interface StyleTransition {
  readonly patches: ReadonlyArray<Patch>;
  readonly current: string;
}

export interface HyperlinkTransition {
  readonly patches: ReadonlyArray<Patch>;
  readonly current: string | undefined;
}

const NO_TRANSITION_STYLE: ReadonlyArray<Patch> = Object.freeze([]);
const NO_TRANSITION_LINK: ReadonlyArray<Patch> = Object.freeze([]);

/**
 * SGR style transition helper used by the Phase 3 incremental diff loop.
 *
 * Returns `{ patches, current }` describing the patches the caller should
 * emit and the new `currentStyle` tracker value. Pure function — does NOT
 * mutate any caller-supplied state. Mirrors CC's `transitionStyle` semantics
 * (reset prior, apply new) but expressed as a returned tuple rather than an
 * accumulator-style mutation.
 */
export function transitionStyle(
  currentStyle: string,
  nextStyle: string,
): StyleTransition {
  if (currentStyle === nextStyle) {
    return { patches: NO_TRANSITION_STYLE, current: currentStyle };
  }
  const patches: Patch[] = [];
  if (currentStyle !== "") {
    patches.push({ type: "stdout", content: SGR_RESET });
  }
  if (nextStyle !== "") {
    patches.push({ type: "stdout", content: nextStyle });
  }
  return { patches, current: nextStyle };
}

/**
 * Flattened style transition for `writeCellWithStyleStr`'s `styleStr`
 * parameter. Same semantics as `transitionStyle` but returns the patches
 * concatenated into a single escape-sequence string.
 *
 * **Why a separate helper**: `writeCellWithStyleStr` only emits its
 * `styleStr` argument when the cell actually writes (i.e., not skipped
 * at viewport edge). Pre-emitting style patches into the diff before
 * calling `writeCellWithStyleStr` desyncs the diff (which has the new
 * SGR bytes) from the caller's `currentStyle` tracker (which can't be
 * updated until we know the write succeeded). Passing the flattened
 * string into `writeCellWithStyleStr` lets it gate emission on the same
 * skip condition that gates the cell char emission, keeping diff and
 * tracker synchronized.
 */
export function transitionStyleStr(
  currentStyle: string,
  nextStyle: string,
): { readonly str: string; readonly current: string } {
  const result = transitionStyle(currentStyle, nextStyle);
  let str = "";
  for (const patch of result.patches) {
    if (patch.type === "stdout") str += patch.content;
  }
  return { str, current: result.current };
}

/**
 * OSC 8 hyperlink transition helper used by the Phase 3 incremental diff
 * loop. Returns `{ patches, current }` — pure function, no mutation.
 */
export function transitionHyperlink(
  currentHyperlink: string | undefined,
  nextHyperlink: string | undefined,
): HyperlinkTransition {
  if (currentHyperlink === nextHyperlink) {
    return { patches: NO_TRANSITION_LINK, current: currentHyperlink };
  }
  const patches: Patch[] = [];
  if (currentHyperlink !== undefined) {
    patches.push({ type: "stdout", content: LINK_END });
  }
  if (nextHyperlink !== undefined) {
    patches.push({ type: "stdout", content: link(nextHyperlink) });
  }
  return { patches, current: nextHyperlink };
}

/**
 * Identify emoji where the terminal's wcwidth may disagree with Unicode.
 * On terminals with correct tables this triggers a harmless cursor-position
 * correction; on terminals with stale wcwidth tables it prevents the
 * cursor from drifting one column behind the painted glyph.
 *
 * Two categories (matches `claudecode/src/ink/log-update.ts:733-749`):
 *   1. Newer emoji (Unicode 12.0+) missing from older wcwidth tables —
 *      U+1FA70-1FAFF (Symbols and Pictographs Extended-A) and
 *      U+1FB00-1FBFF (Symbols for Legacy Computing).
 *   2. Text-by-default emoji + VS16 (U+FE0F): the base codepoint is
 *      width 1 in wcwidth, but VS16 triggers emoji presentation making it
 *      width 2. Examples: ⚔️ (U+2694), ☠️ (U+2620), ❤️ (U+2764).
 *
 * Phase 2 implements as a pure helper. Phase 3's `writeCellWithStyleStr`
 * calls it to emit a `cursorTo` correction after painting a wide cell.
 */
export function needsWidthCompensation(char: string): boolean {
  const cp = char.codePointAt(0);
  if (cp === undefined) return false;

  // Category 1: newer emoji blocks
  if ((cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x1fb00 && cp <= 0x1fbff)) {
    return true;
  }

  // Category 2: multi-codepoint grapheme containing VS16 (0xFE0F).
  // Single-codepoint chars (length 1) and surrogate pairs without VS16 skip
  // this check. VS16 cannot collide with surrogate halves (0xD800-0xDFFF).
  if (char.length >= 2) {
    for (let i = 0; i < char.length; i++) {
      if (char.charCodeAt(i) === 0xfe0f) return true;
    }
  }

  return false;
}

/**
 * Phase 3 cursor-state machine. Phase 2 ships the constructor + `txn`
 * pattern only — Phase 3's diff loop drives the cursor through `txn` calls
 * that yield patches and a delta.
 *
 * `cursor` is typed `Readonly<Point>` for external observers; Phase 3's
 * hot path inside this file mutates it via the `_cursorMut` internal
 * accessor to avoid `Point` allocation per cell. The mutation is
 * deliberately encapsulated — all writes go through `txn()` or
 * `_cursorMut`, never direct field assignment from outside the class.
 *
 * Mirrors `claudecode/src/ink/log-update.ts:752-773`.
 */
export class VirtualScreen {
  /** Cursor position; observers must treat as read-only. */
  readonly cursor: Readonly<Point>;
  /** Accumulated patches; observers may iterate but not mutate. */
  readonly diff: ReadonlyArray<Patch>;

  /** @internal hot-path mutable handle for in-file writers. */
  private readonly _cursorMut: { x: number; y: number };
  /** @internal hot-path mutable handle for in-file writers. */
  private readonly _diffMut: Patch[] = [];

  constructor(
    origin: Point,
    readonly viewportWidth: number,
  ) {
    this._cursorMut = { x: origin.x, y: origin.y };
    this.cursor = this._cursorMut;
    this.diff = this._diffMut;
  }

  /**
   * Atomic cursor mutation: callback receives the current cursor and
   * returns `[patches, delta]`. Patches push onto the diff in order, and
   * the cursor advances by `delta` afterward.
   */
  txn(
    fn: (prev: Readonly<Point>) => [patches: ReadonlyArray<Patch>, next: { dx: number; dy: number }],
  ): void {
    const [patches, next] = fn(this.cursor);
    for (const patch of patches) {
      this._diffMut.push(patch);
    }
    this._cursorMut.x += next.dx;
    this._cursorMut.y += next.dy;
  }
}

/**
 * Phase 3a primitives — cell write, cursor positioning, frame slice, line
 * read-back, full-reset fallback. Each is unit-testable in isolation; the
 * main incremental render loop in `cell-renderer.ts` (Phase 3c) composes
 * them into the scrollback-aware diff algorithm.
 */

/**
 * Patch sentinels exported so consumers building patch sequences outside
 * `renderFrameSlice` can reference the same singletons (avoids silent
 * structural divergence if a Phase 3b/4 caller redeclares `\r` patches).
 */
export const CARRIAGE_RETURN: Patch = { type: "carriageReturn" };
export const NEWLINE: Patch = { type: "stdout", content: "\n" };

/**
 * Write one cell to the renderer's diff. Handles:
 *
 *   - **Viewport-edge wide-char skip**: a wide cell whose right half would
 *     fall outside the viewport is skipped (returns false). The CC reference
 *     uses `vw` for single-codepoint wide chars and `vw + 1` for
 *     multi-codepoint graphemes (flags, ZWJ emoji); we mirror that.
 *   - **Wide-char wcwidth compensation**: when `needsWidthCompensation` is
 *     true, pre-paints a styled space at column x+1 (handles old wcwidth
 *     tables that report width 1 but the glyph paints width 2) and emits a
 *     post-write `cursorTo` that pins the terminal cursor to the correct
 *     post-glyph column regardless of the terminal's wcwidth opinion.
 *   - **Pending-wrap state**: when the cursor is already past the viewport
 *     (`px >= viewportWidth`, "pending wrap" terminal state), the next cell
 *     write wraps to the next row with cursor.x = cellWidth and cursor.y++.
 *
 * Returns `true` when the cell was written, `false` when skipped at the
 * viewport edge. Callers MUST gate `currentStyleId` updates on the return
 * value — when skipped, no style transition was emitted and the terminal's
 * style state is unchanged. Updating the virtual style tracker anyway would
 * desync it from the terminal and corrupt the next transition's diff.
 *
 * Mirrors `claudecode/src/ink/log-update.ts:638-691`.
 */
export function writeCellWithStyleStr(
  screen: VirtualScreen,
  cell: Cell,
  styleStr: string,
): boolean {
  const cellWidth = cell.width === CellWidth.Wide ? 2 : 1;
  const vw = screen.viewportWidth;
  let written = false;

  screen.txn((prev) => {
    const px = prev.x;

    // Viewport-edge wide-char skip. Single-codepoint wide chars (CJK) at
    // column vw-2 (1-based) are safe; multi-codepoint graphemes (flags,
    // ZWJ emoji) need stricter threshold (vw, not vw+1).
    //
    // The `px < vw` guard intentionally only fires in non-pending-wrap
    // state. When `px >= vw` (pending-wrap), the edge check is bypassed
    // because pending-wrap semantics take over: the cell will wrap to the
    // next row, landing at column `cellWidth` of `y+1`. The wrap consumes
    // the would-be edge collision rather than producing one.
    if (cellWidth === 2 && px < vw) {
      const threshold = cell.char.length > 2 ? vw : vw + 1;
      if (px + 2 >= threshold) {
        return [[], { dx: 0, dy: 0 }];
      }
    }

    const patches: Patch[] = [];
    if (styleStr.length > 0) {
      patches.push({ type: "stdout", content: styleStr });
    }

    const needsComp = cellWidth === 2 && needsWidthCompensation(cell.char);

    // Pre-paint a styled space at column px+1 for compensated emojis.
    // CHA is 1-based, so column px+1 (0-based) is CHA target px+2.
    if (needsComp && px + 1 < vw) {
      patches.push({ type: "cursorTo", col: px + 2 });
      patches.push({ type: "stdout", content: " " });
      patches.push({ type: "cursorTo", col: px + 1 });
    }

    patches.push({ type: "stdout", content: cell.char });

    // Force terminal cursor to the correct post-glyph column. CHA is
    // 1-based; px + cellWidth (0-based) is CHA target px + cellWidth + 1.
    if (needsComp) {
      patches.push({ type: "cursorTo", col: px + cellWidth + 1 });
    }

    written = true;

    if (px >= vw) {
      // Pending-wrap: cursor was at or past viewport-end waiting for the
      // next char to wrap. After this write, terminal wraps to next row
      // with the cell at column cellWidth.
      return [patches, { dx: cellWidth - px, dy: 1 }];
    }
    return [patches, { dx: cellWidth, dy: 0 }];
  });

  return written;
}

/**
 * Move the renderer's virtual cursor (and the patches that drive the real
 * terminal cursor) to (`targetX`, `targetY`).
 *
 * Three cases:
 *   - **Pending-wrap state** (`prev.x >= viewportWidth`): emit `\r` first
 *     to reset the terminal cursor to column 0 without advancing to the
 *     next line, then `cursorMove(targetX, dy)`. Without `\r`, a same-line
 *     cursor-move from pending-wrap state lands one row below where we
 *     intended (the next char would have triggered the wrap).
 *   - **Different row** (`dy !== 0`): same `\r + cursorMove` pattern. CR
 *     handles any column-state ambiguity; then a relative move advances dy
 *     rows and lands at column targetX.
 *   - **Same row, different column**: emit `cursorMove(dx, 0)` directly.
 *     No CR needed — column state is unambiguous.
 *
 * Mirrors `claudecode/src/ink/log-update.ts:693-721`.
 */
export function moveCursorTo(
  screen: VirtualScreen,
  targetX: number,
  targetY: number,
): void {
  screen.txn((prev) => {
    const dx = targetX - prev.x;
    const dy = targetY - prev.y;
    const inPendingWrap = prev.x >= screen.viewportWidth;

    if (inPendingWrap) {
      return [
        [CARRIAGE_RETURN, { type: "cursorMove", x: targetX, y: dy }],
        { dx, dy },
      ];
    }
    if (dy !== 0) {
      return [
        [CARRIAGE_RETURN, { type: "cursorMove", x: targetX, y: dy }],
        { dx, dy },
      ];
    }
    return [[{ type: "cursorMove", x: dx, y: dy }], { dx, dy }];
  });
}

/**
 * Render rows [`startY`, `endY`) of `frame.screen` into `screen`'s diff.
 *
 * Each row begins with cursor advancement (LF, not CSI CUD): "CSI CUD
 * stops at the viewport bottom margin and cannot scroll, but LF scrolls
 * the viewport to create new lines." Cells walked via `cellAt`; per-cell
 * style/hyperlink transitions go through the pure helpers + the
 * `writeCellWithStyleStr` write path. End-of-row resets style + hyperlink
 * before the row-final `\r\n` so background colors don't bleed into the
 * next line if the terminal scrolls.
 *
 * Skips empty unstyled cells without painting a space — `line.trimEnd()`
 * downstream and the natural cursor advance via newline handle the
 * trailing-whitespace case.
 *
 * Mirrors `claudecode/src/ink/log-update.ts:527-623` (without the
 * StylePool / CharPool / fg-only optimization branches that don't apply
 * to KodaX's inline-string Cell model).
 */
export function renderFrameSlice(
  screen: VirtualScreen,
  frame: Frame,
  startY: number,
  endY: number,
): void {
  let currentStyle = "";
  let currentHyperlink: string | undefined = undefined;

  for (let y = startY; y < endY; y++) {
    // Advance to row y via LF (not CSI CUD — see comment above).
    if (screen.cursor.y < y) {
      const rowsToAdvance = y - screen.cursor.y;
      screen.txn((prev) => {
        const patches: Patch[] = new Array<Patch>(1 + rowsToAdvance);
        patches[0] = CARRIAGE_RETURN;
        for (let i = 0; i < rowsToAdvance; i++) {
          patches[1 + i] = NEWLINE;
        }
        return [patches, { dx: -prev.x, dy: rowsToAdvance }];
      });
    }

    for (let x = 0; x < frame.screen.width; x++) {
      const cell = cellAt(frame.screen, x, y);
      if (!cell || cell.width === CellWidth.SpacerTail) continue;

      // Skip unstyled empty cells — the cursor's natural advance via the
      // next painted cell or end-of-row newline handles the gap.
      if (cell.char === " " && cell.style === "" && cell.hyperlink === undefined) {
        continue;
      }

      moveCursorTo(screen, x, y);

      // Hyperlink transition emits unconditionally before the cell write.
      // Matches CC reference at `claudecode/src/ink/log-update.ts:354-359`:
      // even if the subsequent cell write skips at viewport edge, the
      // link tracker is treated as "moved past the previous cell" — the
      // next non-skipped cell continues seamlessly. Hyperlink open/close
      // around an empty region is harmless on conformant terminals.
      //
      // TODO(Phase 6): batch per-cell transition patches into a single
      // txn closure to amortize the closure-tuple-delta allocation cost.
      // Phase 3a uses one txn per patch for correctness clarity; the
      // optimization is deferred until profiling shows allocation cost
      // dominates the hot path (estimated worst case ~7680 closures per
      // frame at 24 rows × 80 cols × 4 transition patches per cell).
      const linkResult = transitionHyperlink(currentHyperlink, cell.hyperlink);
      for (const patch of linkResult.patches) {
        screen.txn(() => [[patch], { dx: 0, dy: 0 }]);
      }
      currentHyperlink = linkResult.current;

      // Style transition is FLATTENED into a string and passed to
      // `writeCellWithStyleStr` so the bytes are gated on the same skip
      // condition that gates the cell char emission. If the cell skips
      // at the viewport edge, NEITHER the style bytes nor the tracker
      // change — they stay synchronized. (Pre-emitting the style patches
      // into the diff and gating only the tracker on the write result
      // would desync the two: diff has new SGR bytes, tracker still
      // holds old style → next cell emits a spurious double-transition.)
      const styleFlat = transitionStyleStr(currentStyle, cell.style);
      if (writeCellWithStyleStr(screen, cell, styleFlat.str)) {
        currentStyle = styleFlat.current;
      }
    }

    // End-of-row: reset style + hyperlink before the row-final \r\n so
    // background colors don't bleed into the next line if the terminal
    // scrolls.
    const styleEol = transitionStyle(currentStyle, "");
    for (const patch of styleEol.patches) {
      screen.txn(() => [[patch], { dx: 0, dy: 0 }]);
    }
    currentStyle = styleEol.current;

    const linkEol = transitionHyperlink(currentHyperlink, undefined);
    for (const patch of linkEol.patches) {
      screen.txn(() => [[patch], { dx: 0, dy: 0 }]);
    }
    currentHyperlink = linkEol.current;

    // Row-final \r\n. Emitted unconditionally for EVERY row (including
    // the last) — matches CC `claudecode/src/ink/log-update.ts:615`.
    // Phase 3b's main loop assumes the post-slice cursor is at
    // (0, endY); suppressing on the last row would leave the cursor
    // mid-row at the last painted cell, drifting Phase 3b's cursor
    // accounting on every subsequent diff move.
    screen.txn((prev) => [
      [CARRIAGE_RETURN, NEWLINE],
      { dx: -prev.x, dy: 1 },
    ]);
  }

  // Slice-level post-loop safety net: if the row-loop ran zero iterations
  // (startY === endY) or the per-row reset above was skipped on a path
  // we haven't anticipated, ensure no style/hyperlink stays open at the
  // slice boundary. Mirrors CC `claudecode/src/ink/log-update.ts:619-620`.
  if (currentStyle !== "" || currentHyperlink !== undefined) {
    const styleSlice = transitionStyle(currentStyle, "");
    for (const patch of styleSlice.patches) {
      screen.txn(() => [[patch], { dx: 0, dy: 0 }]);
    }
    const linkSlice = transitionHyperlink(currentHyperlink, undefined);
    for (const patch of linkSlice.patches) {
      screen.txn(() => [[patch], { dx: 0, dy: 0 }]);
    }
  }
}

/**
 * Read the visible content of row `y` from `screen` for diagnostic
 * messages (e.g., `triggerY` / `prevLine` / `nextLine` in the
 * `clearTerminal` patch). Skips SpacerTail cells via the empty-string
 * `cell.char` they carry; out-of-bounds reads substitute a space so
 * comparing prev vs next lines stays meaningful when one is shorter.
 *
 * Mirrors `claudecode/src/ink/log-update.ts:495-501`.
 */
export function readLine(screen: Screen, y: number): string {
  let line = "";
  for (let x = 0; x < screen.width; x++) {
    const cell = cellAt(screen, x, y);
    // Nullish-coalesce: out-of-bounds (cell undefined) → " ", empty
    // SpacerTail (cell.char === "") stays empty so the wide cell at x-1
    // isn't double-padded.
    line += cell?.char ?? " ";
  }
  return line.trimEnd();
}

/**
 * Full-screen reset fallback. Emits a `clearTerminal` patch followed by
 * a fresh full render of `frame` from a (0, 0) cursor origin. Called when
 * the incremental diff loop detects a scenario it cannot service:
 *
 *   - **'resize'** — viewport dimension change invalidates layout.
 *   - **'offscreen'** — content rows that should now be visible are in
 *     scrollback (terminal clear can't bring them back), or a cell change
 *     targets a row already in scrollback (cursor can't reach it).
 *   - **'clear'** — Phase 3b reserved for explicit-clear paths.
 *
 * Name kept deliberately alarming (matches CC reference) so call sites
 * are visible in `grep` output and new flicker-causing call sites are
 * discouraged.
 *
 * Mirrors `claudecode/src/ink/log-update.ts:503-513`.
 */
export function fullResetSequence_CAUSES_FLICKER(
  frame: Frame,
  reason: FlickerReason,
): Diff {
  const screen = new VirtualScreen({ x: 0, y: 0 }, frame.viewport.width);
  renderFrameSlice(screen, frame, 0, frame.screen.height);
  const patches: Patch[] = [{ type: "clearTerminal", reason }];
  for (const p of screen.diff) patches.push(p);
  return patches;
}
