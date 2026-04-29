/**
 * Diff → terminal-bytes serializer (FEATURE_057 Track F, Phase 4a).
 *
 * Translates a `Diff` (the `Patch[]` produced by `cell-renderer.ts`'s
 * `LogUpdate.render(prev, next)`) into the actual ANSI escape-sequence
 * bytes the terminal expects, and writes them to a stream in a single
 * `write()` call.
 *
 * Single-write invariant: every `Diff` flush hits the underlying stream
 * once. On slow / latency-sensitive transports (SSH, the `FEATURE_096`
 * motivation), batching avoids interleaving artifacts and reduces
 * round-trips. Skip the write entirely when the diff is empty so we
 * don't perturb terminal state on no-op renders.
 *
 * Pure module — no side effects on import. The only I/O is the explicit
 * `stream.write(buf)` call inside `applyDiff`.
 */

import { CURSOR_HOME, cursorMove, cursorTo, eraseLines } from "./csi.js";
import type { Diff, Patch } from "./frame.js";
import { link } from "./osc.js";

/**
 * DECTCEM hide / show — the cursor visibility toggles. Inlined here
 * (rather than in `csi.ts`) because they are private-mode sequences
 * (`?25` parameter) and `csi.ts` deliberately scopes itself to the
 * positional / erase primitives the cell renderer's hot path needs.
 */
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

/**
 * Full-screen clear: CSI 2 J (erase in display, all) + cursor home.
 * Ordering matches what every real terminal expects: clear the buffer
 * first, then move home so the next paint lands at (0, 0). Reversing
 * the order leaves the cursor in its pre-clear position momentarily,
 * which on some terminals briefly paints the wrong column.
 */
const CLEAR_TERMINAL = `\x1b[2J${CURSOR_HOME}`;

/**
 * Translate one `Patch` into terminal bytes. Pure function, total over
 * the `Patch` discriminated union — `tsc --strict` exhaustiveness check
 * pins coverage if a new variant is added.
 *
 * Exposed for unit-test isolation (verifying each variant's bytes
 * independently) and for callers that want to inspect/log the bytes
 * without committing to a stream write.
 */
export function patchToBytes(patch: Patch): string {
  switch (patch.type) {
    case "stdout":
      return patch.content;
    case "carriageReturn":
      return "\r";
    case "cursorHide":
      return CURSOR_HIDE;
    case "cursorShow":
      return CURSOR_SHOW;
    case "cursorMove":
      return cursorMove(patch.x, patch.y);
    case "cursorTo":
      return cursorTo(patch.col);
    case "clear":
      return eraseLines(patch.count);
    case "clearTerminal":
      // The `reason` field is diagnostic only — terminals don't see it.
      // Phase 4 may surface it via tracing if integration testing reveals
      // a need; for now bytes are reason-independent.
      return CLEAR_TERMINAL;
    case "hyperlink":
      return link(patch.uri);
  }
}

/**
 * Stream interface accepted by `applyDiff`. Matches `NodeJS.WriteStream`
 * (e.g., `process.stdout`) and any test mock that exposes a `write`
 * method. The return type is loose because Node streams return `boolean`
 * (backpressure signal) but the cell renderer doesn't use that signal —
 * Phase 4 keeps the signature intentionally narrow.
 */
export interface StreamLike {
  write(chunk: string): unknown;
}

/**
 * Concatenate all `patch → bytes` translations into one buffer and emit
 * a single `stream.write(buf)`. Empty buffer ⇒ no-op (skip the write
 * entirely so the stream's drain queue doesn't churn on idle frames).
 */
export function applyDiff(stream: StreamLike, diff: Diff): void {
  let buf = "";
  for (const patch of diff) {
    buf += patchToBytes(patch);
  }
  if (buf.length > 0) {
    stream.write(buf);
  }
}
