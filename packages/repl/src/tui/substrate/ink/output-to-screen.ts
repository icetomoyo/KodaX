/**
 * `Output` (vendored ink internal grid) → KodaX `Screen` converter
 * (FEATURE_057 Track F).
 *
 * The render path (post-Phase 6, v0.7.30):
 *
 *   React tree → ink reconciler DOM → renderNodeToOutput(Output) → outputToScreen(Screen) → LogUpdate.render(Frame, Frame) → Diff → applyDiff(stream)
 *
 * This module owns the (Output → Screen) conversion. `Output.getGrid()` is
 * the canonical grid emitter (extracted from `Output.get()` in Phase 4a so
 * both paths could share the same operation-replay logic). `Output.get()`
 * survives in renderer.js for the legacy `output` / `outputHeight` /
 * `staticOutput` fields engine.js's bookkeeping still consumes.
 *
 * Layer rule: this file imports only from `cell-screen.js` (peer in the
 * same directory) and the vendored `output.js`. It MUST NOT import from
 * `cell-renderer.ts` / `cell-renderer-primitives.ts` — keeping the import
 * direction one-way preserves the no-cycle rule from `CLAUDE.md`.
 */

import {
  CellWidth,
  EMPTY_CELL,
  createScreen,
  setCellAt,
  type Cell,
  type Screen,
} from "./cell-screen.js";

/**
 * Shape of the vendored `Output.getGrid()` row entry. Mirrors
 * `@alcalzone/ansi-tokenize`'s `StyledChar` (`build/styledChars.d.ts`),
 * inlined here so this file does not depend on the tokenize package's
 * .d.ts at TypeScript level — the .js import path is what matters at
 * runtime.
 *
 * `type` is widened from the upstream `"char"` literal to `string`
 * because `Output.getGrid()`'s .js source emits the `type` field as
 * an unconstrained string. We treat it as char-only at runtime (the
 * vendored `Output` class only ever populates the grid with char
 * entries, never anything else) but the type system can't infer that
 * from a .js file.
 */
interface StyledCharLike {
  readonly type: string;
  readonly value: string;
  readonly fullWidth: boolean;
  readonly styles: ReadonlyArray<{
    readonly type: string;
    readonly code: string;
    readonly endCode: string;
  }>;
}

/**
 * Duck-typed shape of the vendored `Output` class that `outputToScreen`
 * actually depends on. KodaX has TWO copies of the Output class —
 * `substrate/ink/output.js` (used by `substrate/ink/renderer.js`) and
 * `core/internals/output.js` (used by `core/internals/renderer.js`).
 * Both expose identical `width` / `height` / `getGrid()` shapes (they
 * came from the same upstream ink source and share the same vendored
 * `@alcalzone/ansi-tokenize` package), but their .js imports resolve
 * to two distinct .js files — there's no single Output type to import.
 *
 * `OutputLike` captures the contract both implementations satisfy.
 * Phase 5c review MEDIUM-1 fix: previously the parameter type pointed
 * at `substrate/ink/output.js`'s class via `// @ts-ignore` import,
 * which silently accepted the engine-side Output without TS noticing
 * that the types didn't match. Using the duck-typed `OutputLike`
 * eliminates that lie and lets either Output flow through cleanly.
 */
export interface OutputLike {
  readonly width: number;
  readonly height: number;
  getGrid(): ReadonlyArray<ReadonlyArray<StyledCharLike>>;
}

/**
 * OSC 8 hyperlink open prefix — both BEL-terminated (ansi-tokenize
 * default) and ESC\\-terminated (KodaX `link()` emit form, ECMA-48 ST)
 * codes start with this prefix. Detection is case-sensitive byte-match.
 */
const OSC8_PREFIX = "\x1b]8;";

/**
 * Strip the OSC 8 terminator from a code string. `@alcalzone/ansi-tokenize`'s
 * `parseLinkCode` recognizes only BEL (`\x07`) terminators, and KodaX's
 * `osc.ts:link()` emits BEL-terminated OSC 8 to stay compatible — so in
 * practice the only terminator we ever see here is BEL. If a future
 * tokenizer change starts producing ESC-\\ terminated codes, extend this
 * helper before the converter will accept them.
 */
function stripOsc8Terminator(s: string): string {
  if (s.endsWith("\x07")) return s.slice(0, -1);
  return s;
}

/**
 * Extract the URL from an OSC 8 open code. Format:
 *   `\x1B]8;{params};{url}{terminator}`
 * Returns `undefined` if the code is malformed or the URL is empty
 * (which is the OSC 8 close convention — `\x1B]8;;{terminator}`).
 */
function parseOsc8Url(code: string): string | undefined {
  if (!code.startsWith(OSC8_PREFIX)) return undefined;
  const afterPrefix = code.slice(OSC8_PREFIX.length);
  const semicolonIdx = afterPrefix.indexOf(";");
  if (semicolonIdx < 0) return undefined;
  const urlAndTerm = afterPrefix.slice(semicolonIdx + 1);
  const url = stripOsc8Terminator(urlAndTerm);
  return url.length > 0 ? url : undefined;
}

/**
 * Convert a single `StyledChar` to a KodaX `Cell`.
 *
 * - SGR codes (color, bold, etc.): concatenated into `cell.style` as the
 *   open-bytes string. KodaX's `transitionStyle` will diff these between
 *   adjacent cells and emit `SGR_RESET + new` between non-empty styles.
 * - OSC 8 link codes: extracted into `cell.hyperlink` as the bare URL.
 *   KodaX's `transitionHyperlink` handles OSC 8 emission via `link()` /
 *   `LINK_END` from `osc.ts`.
 * - SpacerTail: a `StyledChar` whose `value === ""` marks the column
 *   immediately after a wide cell (Output's replay loop emits this);
 *   we reproduce it as `Cell { char: "", width: SpacerTail }`.
 */
function styledCharToCell(sc: StyledCharLike): Cell {
  // SpacerTail marker: empty value (Output emits this for the column
  // following a wide char). char is "" + width is SpacerTail by KodaX
  // convention.
  if (sc.value === "") {
    return {
      char: "",
      width: CellWidth.SpacerTail,
      style: "",
      hyperlink: undefined,
    };
  }

  let style = "";
  let hyperlink: string | undefined = undefined;

  for (const code of sc.styles) {
    if (code.code.startsWith(OSC8_PREFIX)) {
      const url = parseOsc8Url(code.code);
      // Last-write-wins if multiple OSC 8 opens stack in `styles`. In
      // practice Output's tokenizer collapses to one open code per cell.
      if (url !== undefined) hyperlink = url;
    } else {
      style += code.code;
    }
  }

  return {
    char: sc.value,
    width: sc.fullWidth ? CellWidth.Wide : CellWidth.Single,
    style,
    hyperlink,
  };
}

/**
 * Build a KodaX `Screen` from an `Output`'s replayed grid.
 *
 * Width / height are taken from `Output`'s constructor parameters
 * (which themselves come from the Yoga-computed root node dimensions),
 * keeping the cell grid dimensionally aligned with the layout pass.
 *
 * The conversion is row-major and does not depend on prior screen state
 * — every call produces a fresh `Screen` from the current grid snapshot.
 * Empty `Output` (no operations) yields a screen of `EMPTY_CELL` matching
 * the constructor dimensions.
 */
export function outputToScreen(output: OutputLike): Screen {
  const grid = output.getGrid();
  const width: number = output.width;
  const height: number = output.height;

  let screen = createScreen(width, height);

  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      const sc = row[x];
      if (!sc) continue;
      const cell = styledCharToCell(sc);
      // Skip writes for cells that match EMPTY_CELL exactly — `createScreen`
      // already populates every coordinate with EMPTY_CELL, so re-writing
      // the same cell just allocates an identical row array. Avoiding it
      // shaves allocation cost on the hot path (idle/background frames).
      if (
        cell.char === EMPTY_CELL.char &&
        cell.width === EMPTY_CELL.width &&
        cell.style === EMPTY_CELL.style &&
        cell.hyperlink === EMPTY_CELL.hyperlink
      ) {
        continue;
      }
      screen = setCellAt(screen, x, y, cell);
    }
  }

  return screen;
}
