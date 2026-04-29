/**
 * Frame and Diff types for the cell-level renderer (FEATURE_057 Track F).
 *
 * `Frame` is what the React reconciler produces each render pass; the
 * renderer compares two frames and emits a `Diff` (an instruction list)
 * that the engine writes to the terminal stream.
 *
 * Architecturally aligned with `claudecode/src/ink/frame.ts`. Phase 1
 * intentionally omits CC-specific fields (`damage`, `scrollDrainPending`,
 * `FrameEvent.phases`) per the design doc out-of-scope list — those exist
 * to support optimizations Track F has explicitly deferred.
 */

import { createScreen, type Screen } from "./cell-screen.js";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Cursor {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
}

/**
 * A frame is the renderer's snapshot of the React tree's terminal
 * projection at a given commit. It carries:
 * - the rendered cell grid (`screen`)
 * - the terminal viewport that grid lives in (`viewport`)
 * - the logical cursor position the next interactive render should leave
 *   the real terminal cursor at (`cursor`)
 *
 * Frames are immutable — they are observed by the renderer's diff loop and
 * never mutated in place.
 *
 * **Track F design-vs-impl note**: the v0.7.30 design doc lists
 * `Frame = { screen, cursor, viewport, scrollHint }` but also explicitly
 * marks DECSTBM hardware-scroll optimization (the `scrollHint` consumer)
 * as out-of-scope for Track F. KodaX's `Frame` therefore omits
 * `scrollHint` and `scrollDrainPending` (CC's `claudecode/src/ink/frame.ts`
 * fields). When the DECSTBM optimization is later scheduled, both fields
 * land here as `readonly scrollHint?: ScrollHint | null` and
 * `readonly scrollDrainPending?: boolean` — adding optional fields is a
 * non-breaking change.
 */
export interface Frame {
  readonly screen: Screen;
  readonly viewport: Size;
  readonly cursor: Cursor;
}

/**
 * Convenience constructor: an empty frame sized to the given viewport.
 * Used as the seed `prev` value at instance startup so the first
 * `render(prev, next)` call has a typed predecessor.
 *
 * **Parameter order is `(rows, columns)`** — deliberately rows-first to
 * match terminal `stdout.{rows, columns}` access convention. This is
 * asymmetric with `createScreen(width, height)` (columns-first); callers
 * that pass the same dimensions to both functions in one scope MUST NOT
 * transpose. If this asymmetry causes confusion at a call site, prefer
 * destructuring from a `Size` object before forwarding.
 */
export function emptyFrame(rows: number, columns: number): Frame {
  return {
    screen: createScreen(0, 0),
    viewport: { width: columns, height: rows },
    cursor: { x: 0, y: 0, visible: true },
  };
}

/**
 * A single output instruction the engine emits to the terminal stream.
 *
 * Phase 1 deliberately keeps this list small — Phase 2 will add
 * `cursorMove` / `cursorTo` / `clearTerminal` etc. as the diff loop
 * starts emitting them. Adding new variants is a non-breaking change.
 */
export type Patch =
  | { readonly type: "stdout"; readonly content: string }
  | { readonly type: "carriageReturn" }
  | { readonly type: "cursorHide" }
  | { readonly type: "cursorShow" }
  | { readonly type: "cursorMove"; readonly x: number; readonly y: number }
  | { readonly type: "cursorTo"; readonly col: number }
  | { readonly type: "clear"; readonly count: number }
  | {
      readonly type: "clearTerminal";
      readonly reason: FlickerReason;
    }
  | { readonly type: "hyperlink"; readonly uri: string };

export type Diff = ReadonlyArray<Patch>;

/**
 * Why a frame triggered a full clear instead of an incremental diff. Used
 * by the renderer's flicker-mitigation logic and surfaced for diagnostic
 * logging.
 *
 * - `"resize"` — viewport dimensions changed; emitted by `shouldClearScreen`
 * - `"offscreen"` — a frame's `screen.height` exceeds the viewport; emitted
 *   by `shouldClearScreen`
 * - `"clear"` — reserved for Phase 3's explicit-clear `Patch` emission path
 *   (e.g., when `cellsAt` indicates a scroll fall-off that the diff loop
 *   prefers to surface as a tagged `clearTerminal` instruction rather than
 *   a string of cell rewrites). Phase 1's `shouldClearScreen` does not emit
 *   this variant.
 */
export type FlickerReason = "resize" | "offscreen" | "clear";

/**
 * Decide whether the screen should be cleared between `prevFrame` and
 * `frame`. Returns a `FlickerReason` when a clear is warranted, undefined
 * otherwise.
 *
 * Triggers (mirrors the CC reference contract — Track F must keep this
 * decision identical to avoid divergent flicker behavior):
 *   1. Viewport dimension change → 'resize'
 *   2. Either frame's screen height >= viewport height → 'offscreen'
 */
export function shouldClearScreen(
  prevFrame: Frame,
  frame: Frame,
): FlickerReason | undefined {
  const didResize =
    frame.viewport.height !== prevFrame.viewport.height ||
    frame.viewport.width !== prevFrame.viewport.width;
  if (didResize) return "resize";

  const currentOverflows = frame.screen.height >= frame.viewport.height;
  const previousOverflowed = prevFrame.screen.height >= prevFrame.viewport.height;
  if (currentOverflows || previousOverflowed) return "offscreen";

  return undefined;
}
