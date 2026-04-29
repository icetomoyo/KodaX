/**
 * Viewport / scrollback decision algorithm (FEATURE_057 Track F, Phase 3b).
 *
 * Pure functions extracted from the CC reference's `LogUpdate.render`
 * algorithm at `claudecode/src/ink/log-update.ts:199-300`. KodaX splits the
 * algorithm decisions out from the orchestration loop so each decision is
 * independently testable with table-driven fixtures.
 *
 * Phase 3c will compose these decisions with the Phase 3a primitives
 * (`writeCellWithStyleStr` / `moveCursorTo` / `renderFrameSlice` / etc.)
 * inside the main `LogUpdate.render` orchestrator.
 *
 * **Architect-driven discipline (paraphrased)**:
 * > Risk 1: viewportY off-by-one produces flicker (the symptom Track F
 * > exists to fix). Build a dedicated viewportY unit test fixture before
 * > implementing the branch. Cover height < viewport, height == viewport,
 * > height > viewport, and all three again after a shrink. Pin expected
 * > values against the CC reference's arithmetic before touching this code.
 *
 * Hence: every value in `ViewportState` mirrors a name in CC's algorithm,
 * and every formula in `computeViewportState` is annotated with the CC
 * line(s) it derives from.
 */

import { diffEach, type Cell, type Screen } from "./cell-screen.js";
import type { FlickerReason, Frame } from "./frame.js";

/**
 * Callback signature for line read-back. `shouldFullReset` calls this to
 * populate `trigger.prevLine / nextLine` debug fields when a scrollback
 * cell-change reset fires.
 *
 * Injected as a parameter rather than imported because `readLine` lives
 * in `cell-renderer.ts` (where it composes with the renderer's other
 * primitives) and a static import would create a circular dependency
 * (`cell-renderer.ts` already imports from `viewport-state.ts`). KodaX's
 * CLAUDE.md prohibits circular dependencies — see review of Phase 3b+3c.
 */
export type ReadLineFn = (screen: Screen, y: number) => string;

/**
 * Decomposed viewport / scrollback state used by Phase 3c's main loop.
 * Every field is a CC-reference variable name renamed only for KodaX
 * convention (camelCase already matches; structural rename only when the
 * CC name was algorithmically opaque).
 */
export interface ViewportState {
  /**
   * Rows of `prev.screen` that are NOT visible in the viewport (in
   * scrollback). The main loop's diff pass uses this to early-exit with a
   * full reset when a cell change targets a coordinate `y < viewportY`
   * (the cursor cannot reach into scrollback to repaint there).
   *
   * Formula derived from CC `claudecode/src/ink/log-update.ts:292-300`:
   *   - growing path: `max(0, prev.screen.height - prev.viewport.height + cursorRestoreScroll)`
   *   - non-growing path: `max(prev.screen.height, next.screen.height) - next.viewport.height + cursorRestoreScroll`
   */
  readonly viewportY: number;

  /**
   * True when `prev.cursor.y >= prev.screen.height` — the cursor is at or
   * below the last content row. CC line 199.
   */
  readonly cursorAtBottom: boolean;

  /** `next.screen.height > prev.screen.height` (CC line 200). */
  readonly growing: boolean;

  /** `next.screen.height < prev.screen.height` (CC line 206). */
  readonly shrinking: boolean;

  /**
   * True when the previous frame had content past the viewport bottom AND
   * the cursor was at the bottom — meaning the previous frame's
   * cursor-restore LF scrolled an additional row out of view, contributing
   * to `cursorRestoreScroll`. CC lines 204-205.
   *
   * Uses `>=` (not `>`): when content exactly fills the viewport
   * (`prev.screen.height === prev.viewport.height`) and the cursor is at
   * the bottom, the cursor-restore LF still scrolled one row into
   * scrollback.
   */
  readonly prevHadScrollback: boolean;

  /** `next.screen.height <= prev.viewport.height` (CC line 207). */
  readonly nextFitsViewport: boolean;
}

export function computeViewportState(prev: Frame, next: Frame): ViewportState {
  const cursorAtBottom = prev.cursor.y >= prev.screen.height;
  const growing = next.screen.height > prev.screen.height;
  const shrinking = next.screen.height < prev.screen.height;
  const prevHadScrollback =
    cursorAtBottom && prev.screen.height >= prev.viewport.height;
  const nextFitsViewport = next.screen.height <= prev.viewport.height;

  // CC line 292: cursorRestoreScroll is +1 when prevHadScrollback,
  // accounting for the one row pushed into scrollback by the previous
  // frame's cursor-restore LF.
  const cursorRestoreScroll = prevHadScrollback ? 1 : 0;

  // CC lines 293-300:
  //   growing: viewportY measured from prev state — new rows haven't
  //     scrolled old ones yet. clamped at 0 because for first-renders
  //     prev.screen.height === 0 and the formula would go negative.
  //   non-growing: use max(prev, next) because terminal clears (which the
  //     loop emits for shrinking) don't scroll content into the viewport
  //     either.
  const viewportY = growing
    ? Math.max(
        0,
        prev.screen.height - prev.viewport.height + cursorRestoreScroll,
      )
    : Math.max(prev.screen.height, next.screen.height) -
      next.viewport.height +
      cursorRestoreScroll;

  return {
    viewportY,
    cursorAtBottom,
    growing,
    shrinking,
    prevHadScrollback,
    nextFitsViewport,
  };
}

/**
 * Pre-incremental full-reset decision. The main loop calls this BEFORE
 * the diff pass to short-circuit cases the incremental algorithm cannot
 * service. Returns:
 *
 *   - `{ reset: false }` — proceed to the incremental diff path.
 *   - `{ reset: true, reason, trigger? }` — emit a `clearTerminal` patch
 *     followed by a fresh full render. `trigger` carries `y / prevLine /
 *     nextLine` debug info when the trigger was a specific scrollback
 *     cell change (CC's `triggerY` debug field).
 *
 * Four reset cases (CC reference lines 142-247):
 *
 *   1. **'resize'** — viewport dimension change. CC lines 142-147:
 *      shrinking viewport height OR width change always needs a full
 *      reset (predicting the post-resize layout would require reflowing
 *      the previous frame's content).
 *   2. **'offscreen' (shrink-to-fit)** — when prev had content in
 *      scrollback AND the next frame fits the viewport AND we are
 *      shrinking. Terminal clear can't bring scrollback content back
 *      into view. CC lines 214-219.
 *   3. **'offscreen' (scrollback-change)** — when in steady-state (not
 *      growing) with prev content overflowing the viewport AND the
 *      cursor at bottom AND the diff has a cell change targeting a row
 *      that's already in scrollback. CC lines 221-248.
 *   4. **'offscreen' (linesToClear-exceeds-viewport)** — `eraseLines`
 *      can only clear rows within the viewport. If shrinking by more
 *      rows than the viewport contains, some are in scrollback already.
 *      CC lines 263-271.
 */
export type FullResetDecision =
  | { readonly reset: false }
  | {
      readonly reset: true;
      readonly reason: FlickerReason;
      readonly trigger?: {
        readonly y: number;
        readonly prevLine: string;
        readonly nextLine: string;
      };
    };

export function shouldFullReset(
  prev: Frame,
  next: Frame,
  readLine: ReadLineFn,
): FullResetDecision {
  // Case 1: viewport dimension change (CC lines 142-147). The `prev.viewport.width !== 0`
  // guard avoids treating the very-first render (where prev is the seed
  // emptyFrame) as a width change.
  if (
    next.viewport.height < prev.viewport.height ||
    (prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width)
  ) {
    return { reset: true, reason: "resize" };
  }

  const state = computeViewportState(prev, next);

  // Case 2: shrink-from-above-viewport-to-fits-viewport (CC lines 214-219).
  if (state.prevHadScrollback && state.nextFitsViewport && state.shrinking) {
    return { reset: true, reason: "offscreen" };
  }

  // Case 3: cell change targets a row already in scrollback (CC 221-248).
  if (
    prev.screen.height >= prev.viewport.height &&
    prev.screen.height > 0 &&
    state.cursorAtBottom &&
    !state.growing
  ) {
    // Steady-state viewportY (no cursorRestoreScroll +1 here — the +1 is
    // for *this* frame's cursor-restore which hasn't happened yet; for
    // the SCROLLBACK CHECK we measure scrollback from prev state alone).
    const steadyViewportY = prev.screen.height - prev.viewport.height;
    // +1 to include the row pushed by the prev frame's cursor-restore LF.
    // `scrollbackRows` is used as an EXCLUSIVE upper bound below: rows
    // 0..(scrollbackRows-1) are unreachable. A change at `y < scrollbackRows`
    // (i.e., row index strictly less than the count) lives in scrollback.
    const scrollbackRows = steadyViewportY + 1;

    for (const change of diffEach(prev.screen, next.screen)) {
      if (change.y < scrollbackRows) {
        return {
          reset: true,
          reason: "offscreen",
          trigger: {
            y: change.y,
            prevLine: readLine(prev.screen, change.y),
            nextLine: readLine(next.screen, change.y),
          },
        };
      }
    }
  }

  // Case 4: shrinking by more rows than the viewport can erase (CC 263-271).
  if (state.shrinking) {
    const linesToClear = prev.screen.height - next.screen.height;
    if (linesToClear > prev.viewport.height) {
      return { reset: true, reason: "offscreen" };
    }
  }

  return { reset: false };
}

/**
 * Cell-skip predicate used by the main diff loop. CC lines 318-341:
 *
 *   - SpacerTail / SpacerHead added cells: the wide cell at column-1
 *     paints both columns; the spacer carries no glyph and a write at
 *     its coordinate would corrupt the wide cell's right half.
 *   - SpacerTail / SpacerHead removed cells without an `added`
 *     replacement: same reasoning — the spacer doesn't need an explicit
 *     "clear" because erasing the wide cell at column-1 (which would be
 *     the actual diff target) clears the spacer's column too.
 *   - Empty added cells with no removed (i.e., previously also empty):
 *     trailing-space writes at row end cause unnecessary line wrapping
 *     at the right edge.
 *
 * Returns `true` when the cell coordinate should be skipped by the diff
 * loop. Phase 3b ships this as a pure helper Phase 3c composes.
 *
 * **Note**: KodaX's `Cell` type carries no equivalent of CC's
 * `CellWidth.SpacerHead` (used by CC for the line-end position where a
 * wide char wraps to the next line). Phase 1 only modeled `Single` /
 * `Wide` / `SpacerTail`; line-end wrap-spacer is implicit in the row-row
 * cursor advance. We document this divergence here so Phase 4's DOM
 * traversal doesn't accidentally introduce a SpacerHead concept without
 * updating the skip predicate.
 */
export function shouldSkipDiff(
  removed: Cell | undefined,
  added: Cell | undefined,
  isEmptyAdded: boolean,
): boolean {
  // Spacer added — the wide cell at column-1 handles both columns.
  if (added && added.width === /* SpacerTail */ 2) {
    return true;
  }
  // Spacer removed without replacement — wide-cell erase covers it.
  if (removed && removed.width === /* SpacerTail */ 2 && !added) {
    return true;
  }
  // Empty cell added with nothing removed — no need to re-emit a space
  // at trailing row positions.
  if (added && isEmptyAdded && !removed) {
    return true;
  }
  return false;
}
