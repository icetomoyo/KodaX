/**
 * Stateful cell-level frame applicator (FEATURE_057 Track F, Phase 4c).
 *
 * Wraps the per-Ink-instance state needed to drive the cell-level
 * renderer through `LogUpdate.render(prev, next)`:
 *
 *   - `cellLogUpdate` — the `LogUpdate` instance (TTY-aware, holds no
 *     persistent state Phase 5 may revisit).
 *   - `prevFrame` — the most recently applied frame, used as `prev` for
 *     the next `render(prev, next)` call.
 *   - `stdout` — the write stream the diff bytes flush to (a single
 *     `stream.write(buf)` per applied frame, see `applyDiff`).
 *
 * Lives in its own module so `ink.js`'s onRender hot path is one
 * function call, and so unit tests can drive the cell path without
 * spinning up the React reconciler. Layer rule: imports only from
 * peer files (`cell-renderer.js`, `apply-diff.js`, `frame.js`); no
 * imports from `ink.js` / `renderer.js` / `output.js` etc.
 */

import { applyDiff, type StreamLike } from "./apply-diff.js";
import { LogUpdate } from "./cell-renderer.js";
import type { Frame } from "./frame.js";

/**
 * Mutable state carried per Ink instance for the cell-level path. The
 * `prevFrame` field is reassigned on every successful `applyCellFrame`
 * call — by design, since `LogUpdate.render` is a pure function and the
 * "previous frame" is intrinsically per-instance state.
 */
export interface CellFrameState {
  readonly cellLogUpdate: LogUpdate;
  prevFrame: Frame;
  readonly stdout: StreamLike;
}

/**
 * Apply a frame to the terminal via the cell-level diff renderer.
 *
 * Returns `true` when the frame was applied (caller should consider the
 * render done), `false` when the frame was undefined (caller should
 * fall through to its legacy path). `applyCellFrame` mutates `state.prevFrame`
 * to the just-applied frame so the next call sees it as `prev`.
 *
 * First render (`state.prevFrame.screen.height === 0`) is delegated to
 * `LogUpdate.render`'s incremental path, which paints every row through
 * `renderFrameSlice` with row-final `\r\n` separators and a no-op
 * `restoreCursor` (cursor naturally lands at `(0, screen.height)`). No
 * post-write byte stitching needed at this layer — mirrors CC reference.
 */
export function applyCellFrame(
  state: CellFrameState,
  frame: Frame | undefined,
): boolean {
  if (frame === undefined) return false;
  const diff = state.cellLogUpdate.render(state.prevFrame, frame);
  applyDiff(state.stdout, diff);
  state.prevFrame = frame;
  return true;
}
