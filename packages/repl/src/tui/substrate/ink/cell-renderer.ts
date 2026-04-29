/**
 * Cell-level diff renderer entry point (FEATURE_057 Track F).
 *
 * This file holds the **`LogUpdate` orchestrator + Phase 3c incremental
 * loop**. The Phase 1-3a primitives (`renderFullFrame`, `VirtualScreen`,
 * `writeCellWithStyleStr`, `moveCursorTo`, `renderFrameSlice`, `readLine`,
 * `fullResetSequence_CAUSES_FLICKER`, style/hyperlink transitions, width
 * compensation, `CARRIAGE_RETURN` / `NEWLINE` constants) live in
 * `cell-renderer-primitives.ts`. The split keeps both files under KodaX's
 * 800-line cap; the import edge runs one way only (this file imports
 * primitives, primitives import nothing back) to avoid the circular
 * dependency forbidden by KodaX `CLAUDE.md`.
 *
 * Phase 6 (v0.7.30) made the cell renderer the sole render path; the
 * legacy `log-update.js` factory and the `KODAX_TRACK_F` opt-out gate are
 * gone. This file no longer carries a flag check — all callers route here
 * unconditionally.
 *
 * Architecturally aligned with `claudecode/src/ink/log-update.ts:LogUpdate`
 * (CC reference at `C:/Works/claudecode/src/ink/log-update.ts:43`).
 */

import { diffEach } from "./cell-screen.js";
import type { Diff, Frame, Patch } from "./frame.js";
import {
  CARRIAGE_RETURN,
  NEWLINE,
  VirtualScreen,
  fullResetSequence_CAUSES_FLICKER,
  moveCursorTo,
  readLine,
  renderFrameSlice,
  renderFullFrame,
  transitionHyperlink,
  transitionStyle,
  transitionStyleStr,
  writeCellWithStyleStr,
} from "./cell-renderer-primitives.js";
import {
  computeViewportState,
  shouldFullReset,
  shouldSkipDiff,
} from "./viewport-state.js";

// Re-export the primitives surface so existing consumers (and tests) that
// import from `./cell-renderer.js` continue to work without churning their
// import paths. Phase 4/5/6 may revisit if a tighter import boundary is
// preferred.
export {
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
  type HyperlinkTransition,
  type StyleTransition,
} from "./cell-renderer-primitives.js";

export interface LogUpdateOptions {
  readonly isTTY: boolean;
}

export class LogUpdate {
  constructor(private readonly options: LogUpdateOptions) {}

  /**
   * Compute the terminal diff between `prev` and `next`.
   *
   * Routing:
   *   - **Non-TTY**: full-frame paint of `next` (parity with CC's
   *     `if (!this.options.isTTY) return this.renderFullFrame(next)` at
   *     `claudecode/src/ink/log-update.ts:129`).
   *   - **Reset cases** (resize, scrollback collisions, oversized shrinks):
   *     emit `clearTerminal` + fresh full render via
   *     `fullResetSequence_CAUSES_FLICKER`. Detection logic is the pure
   *     `shouldFullReset` decision function (Phase 3b).
   *   - **Incremental** (Phase 3c): walk `diffEach`, emit per-cell patches
   *     using Phase 3a primitives + Phase 3b skip predicates, then
   *     restore the cursor to `next.cursor` for the next render. **First
   *     render** (`prev.screen.height === 0`) flows through this path: the
   *     diff loop skips per-cell paints (every coordinate falls in the
   *     "growing, y >= prev.screen.height" branch), `renderFrameSlice`
   *     paints all rows with `\r\n` separators, and `restoreCursor` is a
   *     no-op when `next.cursor.y === next.screen.height`. Mirrors CC's
   *     `claudecode/src/ink/log-update.ts:199-466` — KodaX previously had
   *     a `prev.screen.height === 0` short-circuit through `renderFullFrame`
   *     here, but that path emitted content joined by `\n` (without
   *     trailing newline) and left the cursor mid-row, drifting subsequent
   *     incremental moves. The CC-aligned path leaves the cursor at
   *     `(0, screen.height)` deterministically.
   */
  render(prev: Frame, next: Frame): Diff {
    if (!this.options.isTTY) {
      return renderFullFrame(next);
    }

    // Reset short-circuit. Decision logic is in `shouldFullReset` (Phase 3b)
    // — see `viewport-state.ts` for the four-case taxonomy. `readLine` is
    // passed as a callback to break the would-be circular dependency
    // (viewport-state needs line read-back for trigger debug; the read-back
    // helper lives in `cell-renderer-primitives.ts` next to the other
    // rendering primitives).
    const decision = shouldFullReset(prev, next, readLine);
    if (decision.reset) {
      return fullResetSequence_CAUSES_FLICKER(next, decision.reason);
    }

    return renderIncremental(prev, next);
  }

  /**
   * Re-seed internal state when the process resumes from suspension
   * (SIGCONT) so the next `render()` doesn't rely on stale output state
   * the terminal has since clobbered. Phase 2 carries no state to clear;
   * Phase 5 re-introduces a `previousOutput` field when the legacy diff
   * needs string-level continuity across resume.
   */
  reset(): void {
    // Phase 2 no-op; method shape preserved for engine integration.
  }
}

/**
 * Helper: emit a sequence of patches through `screen.txn` with zero
 * cursor delta. Used for style/hyperlink transition patches that don't
 * advance the virtual cursor on their own.
 *
 * TODO(Phase 6): inline these into a single txn closure for the hot
 * path. Phase 3 prioritizes correctness clarity (one txn per patch);
 * profiling will tell whether the closure-allocation cost matters.
 */
function emitPatches(
  screen: VirtualScreen,
  patches: ReadonlyArray<Patch>,
): void {
  for (const patch of patches) {
    screen.txn(() => [[patch], { dx: 0, dy: 0 }]);
  }
}

/**
 * Reset both style and hyperlink trackers + emit the corresponding patches.
 * Used at end-of-row, before grow rows, and before clearing a removed cell.
 * Returns the new (empty) tracker tuple.
 */
function resetStyleAndHyperlink(
  screen: VirtualScreen,
  currentStyle: string,
  currentHyperlink: string | undefined,
): { style: string; hyperlink: string | undefined } {
  if (currentStyle !== "") {
    const result = transitionStyle(currentStyle, "");
    emitPatches(screen, result.patches);
  }
  if (currentHyperlink !== undefined) {
    const result = transitionHyperlink(currentHyperlink, undefined);
    emitPatches(screen, result.patches);
  }
  return { style: "", hyperlink: undefined };
}

/**
 * Apply the shrink-emission step of `renderIncremental`.
 *
 * Emits `[clear(linesToClear), cursorMove(0, -1)]` atomically — the clear
 * lands the cursor at column 0 of the new bottom row's `eraseLines`
 * landing position, and the cursorMove(0, -1) walks one more row up
 * to the new bottom of content. CC reference lines 273-282.
 */
function applyShrink(screen: VirtualScreen, prev: Frame, next: Frame): void {
  const linesToClear = prev.screen.height - next.screen.height;
  screen.txn((prevCursor) => [
    [
      { type: "clear", count: linesToClear },
      { type: "cursorMove", x: 0, y: -1 },
    ],
    { dx: -prevCursor.x, dy: -linesToClear },
  ]);
}

interface DiffPassResult {
  readonly currentStyle: string;
  readonly currentHyperlink: string | undefined;
  readonly needsFullReset: boolean;
}

/**
 * Walk `diffEach` over existing rows and emit per-cell paints / clears.
 *
 * Returns trackers + the early-exit flag. Phase 3b's `shouldSkipDiff`
 * handles spacer / empty-no-removed skip cases. Cell changes at
 * `y < viewportY` (scrollback) abort the incremental path with a flag.
 */
function diffPass(
  screen: VirtualScreen,
  prev: Frame,
  next: Frame,
  state: { readonly growing: boolean; readonly viewportY: number },
): DiffPassResult {
  let currentStyle = "";
  let currentHyperlink: string | undefined = undefined;
  let needsFullReset = false;

  for (const change of diffEach(prev.screen, next.screen)) {
    const { x, y, prev: removed, next: added } = change;

    // Skip new rows — `renderFrameSlice` handles those after this pass.
    if (state.growing && y >= prev.screen.height) continue;

    const isEmptyAdded = !!(
      added &&
      added.char === " " &&
      added.style === "" &&
      added.hyperlink === undefined
    );
    if (shouldSkipDiff(removed, added, isEmptyAdded)) continue;

    if (y < state.viewportY) {
      needsFullReset = true;
      break;
    }

    moveCursorTo(screen, x, y);

    if (added) {
      const linkResult = transitionHyperlink(currentHyperlink, added.hyperlink);
      emitPatches(screen, linkResult.patches);
      currentHyperlink = linkResult.current;

      const styleFlat = transitionStyleStr(currentStyle, added.style);
      if (writeCellWithStyleStr(screen, added, styleFlat.str)) {
        currentStyle = styleFlat.current;
      }
    } else if (removed) {
      // Cleared cell inherits no style — reset both trackers first.
      const reset = resetStyleAndHyperlink(screen, currentStyle, currentHyperlink);
      currentStyle = reset.style;
      currentHyperlink = reset.hyperlink;
      screen.txn(() => [
        [{ type: "stdout", content: " " }],
        { dx: 1, dy: 0 },
      ]);
    }
  }

  return { currentStyle, currentHyperlink, needsFullReset };
}

/**
 * Restore the terminal cursor to `next.cursor` for the next render's
 * relative-move starting point.
 *
 * Two branches (CC lines 423-451):
 *   - **Cursor past last content row** (`next.cursor.y >= next.screen.height`):
 *     CSI cursor-down cannot create new rows, so emit `\r + (\n × rowsToCreate)`
 *     to scroll the terminal. When `rowsToCreate <= 0` (cursor already at
 *     or past the target row), fall back to `\r + cursorMove`.
 *   - **Cursor within content** (`next.cursor.y < next.screen.height`):
 *     a plain `moveCursorTo` is sufficient since the row already exists.
 */
function restoreCursor(screen: VirtualScreen, next: Frame): void {
  if (next.cursor.y >= next.screen.height) {
    screen.txn((prev) => {
      const rowsToCreate = next.cursor.y - prev.y;
      if (rowsToCreate > 0) {
        const patches: Patch[] = new Array<Patch>(1 + rowsToCreate);
        patches[0] = CARRIAGE_RETURN;
        for (let i = 0; i < rowsToCreate; i++) {
          patches[1 + i] = NEWLINE;
        }
        return [patches, { dx: -prev.x, dy: rowsToCreate }];
      }
      const dy = next.cursor.y - prev.y;
      if (dy !== 0 || prev.x !== next.cursor.x) {
        return [
          [CARRIAGE_RETURN, { type: "cursorMove", x: next.cursor.x, y: dy }],
          { dx: next.cursor.x - prev.x, dy },
        ];
      }
      return [[], { dx: 0, dy: 0 }];
    });
  } else {
    moveCursorTo(screen, next.cursor.x, next.cursor.y);
  }
}

/**
 * Phase 3c: main incremental render loop. Composes Phase 3a primitives
 * (`writeCellWithStyleStr` / `moveCursorTo` / `renderFrameSlice`) with
 * Phase 3b decisions (`computeViewportState` / `shouldSkipDiff`) into the
 * algorithm CC reference describes at `claudecode/src/ink/log-update.ts:199-466`.
 *
 * Caller MUST have already short-circuited the reset cases via
 * `shouldFullReset` — this function assumes the incremental path is safe.
 *
 * Decomposed into sub-functions to keep each piece under the 50-line rule:
 *   - `applyShrink` — clear + cursorMove for shrinking case
 *   - `diffPass` — walk diffEach and paint per-cell
 *   - `renderFrameSlice` — render new rows in the grow region
 *   - `restoreCursor` — move cursor to next.cursor for next render
 */
function renderIncremental(prev: Frame, next: Frame): Diff {
  const state = computeViewportState(prev, next);
  const screen = new VirtualScreen(prev.cursor, next.viewport.width);

  if (state.shrinking) {
    applyShrink(screen, prev, next);
  }

  const passResult = diffPass(screen, prev, next, state);
  if (passResult.needsFullReset) {
    return fullResetSequence_CAUSES_FLICKER(next, "offscreen");
  }

  // Reset open trackers before grow rows take over the row state.
  resetStyleAndHyperlink(screen, passResult.currentStyle, passResult.currentHyperlink);

  if (state.growing) {
    renderFrameSlice(screen, next, prev.screen.height, next.screen.height);
  }

  restoreCursor(screen, next);

  return screen.diff;
}

