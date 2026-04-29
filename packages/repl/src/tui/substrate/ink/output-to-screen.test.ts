import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- vendored .js file with no .d.ts
import Output from "./output.js";
import { outputToScreen } from "./output-to-screen.js";
import { CellWidth, cellAt } from "./cell-screen.js";
import { LINK_END, link } from "./osc.js";

describe("substrate/ink/output-to-screen (FEATURE_057 Track F, Phase 4a)", () => {
  it("empty Output (no operations): screen is all empty cells matching width/height", () => {
    const output = new Output({ width: 3, height: 2 });
    const screen = outputToScreen(output);
    expect(screen.width).toBe(3);
    expect(screen.height).toBe(2);
    // Every cell is the empty default (char " ", no style, no link).
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 3; x++) {
        const cell = cellAt(screen, x, y);
        expect(cell?.char).toBe(" ");
        expect(cell?.style).toBe("");
        expect(cell?.hyperlink).toBeUndefined();
      }
    }
  });

  it("plain ASCII write: cells carry the chars at the right coordinates", () => {
    const output = new Output({ width: 5, height: 1 });
    output.write(0, 0, "hi", { transformers: [] });
    const screen = outputToScreen(output);
    expect(cellAt(screen, 0, 0)?.char).toBe("h");
    expect(cellAt(screen, 1, 0)?.char).toBe("i");
    expect(cellAt(screen, 2, 0)?.char).toBe(" ");
  });

  it("multi-row write (\\n): rows are populated independently", () => {
    const output = new Output({ width: 2, height: 2 });
    output.write(0, 0, "a\nb", { transformers: [] });
    const screen = outputToScreen(output);
    expect(cellAt(screen, 0, 0)?.char).toBe("a");
    expect(cellAt(screen, 0, 1)?.char).toBe("b");
  });

  it("offset write: cells before x are still the empty default", () => {
    const output = new Output({ width: 5, height: 1 });
    output.write(2, 0, "ab", { transformers: [] });
    const screen = outputToScreen(output);
    expect(cellAt(screen, 0, 0)?.char).toBe(" ");
    expect(cellAt(screen, 1, 0)?.char).toBe(" ");
    expect(cellAt(screen, 2, 0)?.char).toBe("a");
    expect(cellAt(screen, 3, 0)?.char).toBe("b");
  });

  it("style: SGR codes from the styles array land in cell.style as full open-bytes", () => {
    const output = new Output({ width: 4, height: 1 });
    // ansi-tokenize will produce StyledChar entries with styles=[{code: "\\x1b[31m", endCode: "\\x1b[39m"}]
    // for each char inside the RED region.
    output.write(0, 0, "\x1b[31mab\x1b[0m", { transformers: [] });
    const screen = outputToScreen(output);
    const a = cellAt(screen, 0, 0);
    const b = cellAt(screen, 1, 0);
    expect(a?.char).toBe("a");
    expect(a?.style).toBe("\x1b[31m");
    expect(b?.char).toBe("b");
    expect(b?.style).toBe("\x1b[31m");
  });

  it("wide CJK char: produces Wide cell + SpacerTail in next column", () => {
    const output = new Output({ width: 3, height: 1 });
    output.write(0, 0, "中!", { transformers: [] });
    const screen = outputToScreen(output);
    const wide = cellAt(screen, 0, 0);
    const spacer = cellAt(screen, 1, 0);
    const tail = cellAt(screen, 2, 0);
    expect(wide?.char).toBe("中");
    expect(wide?.width).toBe(CellWidth.Wide);
    // SpacerTail: char === "" and width is SpacerTail.
    expect(spacer?.char).toBe("");
    expect(spacer?.width).toBe(CellWidth.SpacerTail);
    expect(tail?.char).toBe("!");
    expect(tail?.width).toBe(CellWidth.Single);
  });

  it("hyperlink (OSC 8): extracted into cell.hyperlink, NOT included in cell.style", () => {
    const output = new Output({ width: 3, height: 1 });
    const URL = "https://kodax.example/";
    // ansi-tokenize uses BEL-terminated OSC 8 by default (\x07);
    // both BEL and ESC \\ terminators are valid per the OSC spec and our
    // converter strips either.
    output.write(0, 0, `\x1b]8;;${URL}\x07L\x1b]8;;\x07`, { transformers: [] });
    const screen = outputToScreen(output);
    const l = cellAt(screen, 0, 0);
    expect(l?.char).toBe("L");
    expect(l?.hyperlink).toBe(URL);
    // The OSC 8 open code must NOT bleed into cell.style — `style` is for
    // SGR codes only; KodaX's `transitionHyperlink` handles OSC 8 emission.
    expect(l?.style).toBe("");
  });

  it("hyperlink + style combined: both fields populated independently", () => {
    const output = new Output({ width: 2, height: 1 });
    const URL = "https://kodax.example/";
    output.write(0, 0, `\x1b[31m\x1b]8;;${URL}\x07a\x1b]8;;\x07\x1b[0m`, {
      transformers: [],
    });
    const screen = outputToScreen(output);
    const a = cellAt(screen, 0, 0);
    expect(a?.char).toBe("a");
    expect(a?.style).toBe("\x1b[31m");
    expect(a?.hyperlink).toBe(URL);
  });

  // Note on terminators: `@alcalzone/ansi-tokenize`'s `parseLinkCode`
  // only recognizes BEL (\x07) terminators. KodaX's `osc.ts:link()`
  // emits BEL-terminated OSC 8 to stay compatible. The converter's
  // `stripOsc8Terminator` correspondingly strips only BEL — ESC-\\ is
  // NOT yet handled. If a future tokenizer change starts producing
  // ESC-\\-terminated codes, extend `stripOsc8Terminator` to recognize
  // the ST terminator before the converter will accept them; until
  // then, ESC-\\-terminated input would silently retain the two-byte
  // suffix in `cell.hyperlink`, yielding a malformed URL.

  it("no regression: legacy Output.get() still produces the same string after the refactor", () => {
    // Sanity check that the getGrid()/get() refactor preserved behavior —
    // get() must still return the same string it did before Phase 4a.
    const output = new Output({ width: 3, height: 1 });
    output.write(0, 0, "\x1b[31mhi\x1b[0m", { transformers: [] });
    const result = output.get();
    // ansi-tokenize collapses adjacent same-style chars; RED stays open
    // through "hi" and resets at the end. The exact reset bytes depend
    // on ansi-styles' definitions — assert structure rather than exact match.
    expect(result.output.startsWith("\x1b[31mhi")).toBe(true);
    expect(result.output).toContain("hi");
    expect(result.height).toBe(1);
  });

  it("integration with the cell-renderer KodaX path: link() + LINK_END round-trips through OSC 8 conversion", () => {
    // What `link("url")` from osc.ts emits is what would land in stdout.
    // If a downstream reads that back via Output (e.g., via a transformer
    // writing the result of `link()` into the grid), the converter must
    // reproduce the URL exactly. Documents the round-trip invariant.
    const output = new Output({ width: 1, height: 1 });
    const URL = "https://kodax.example/";
    output.write(0, 0, `${link(URL)}Z${LINK_END}`, { transformers: [] });
    const screen = outputToScreen(output);
    const z = cellAt(screen, 0, 0);
    expect(z?.char).toBe("Z");
    expect(z?.hyperlink).toBe(URL);
  });

  it("v0.7.30 hotfix: write that overflows the right edge does NOT throw — adapter clamps to output.width", () => {
    // Regression for the production crash:
    //   RangeError: setCellAt out of bounds: (148, 6) on 148x15
    //   at outputToScreen (output-to-screen.ts) → setCellAt (cell-screen.ts)
    // Root cause: Output.getGrid() does not clamp writes to `width`; long
    // lines (status bars, padding, wrapped content) leave the row array
    // longer than width. The legacy `Output.get()` path tolerated this via
    // `filter(undefined).trimEnd()`. The cell-renderer adapter must apply
    // the equivalent clamp at its boundary.
    const output = new Output({ width: 5, height: 1 });
    // 8-char write into a 5-cell screen: chars 5..7 spill past the right
    // edge. Without the adapter clamp, setCellAt(5, 0, ...) throws.
    output.write(0, 0, "abcdefgh", { transformers: [] });
    expect(() => outputToScreen(output)).not.toThrow();
    const screen = outputToScreen(output);
    expect(screen.width).toBe(5);
    // Cells 0..4 carry the in-bounds slice; cells beyond width are
    // discarded (they would not be visible anyway).
    expect(cellAt(screen, 0, 0)?.char).toBe("a");
    expect(cellAt(screen, 4, 0)?.char).toBe("e");
  });

  it("v0.7.30 hotfix: row arrays longer than width never produce out-of-bounds setCellAt calls", () => {
    // Direct repro using a fake grid (mirrors what Output.getGrid() returns
    // when overflow occurs): a row whose length exceeds width.
    const fakeGrid = [
      [
        { type: "char" as const, value: "a", fullWidth: false, styles: [] },
        { type: "char" as const, value: "b", fullWidth: false, styles: [] },
        { type: "char" as const, value: "c", fullWidth: false, styles: [] },
        // Index 3, but width is 3 → index 3 is out of bounds. Without the
        // adapter clamp, this would call setCellAt(3, 0, ...) → throws.
        { type: "char" as const, value: "X", fullWidth: false, styles: [] },
      ],
    ];
    const fakeOutput = {
      width: 3,
      height: 1,
      getGrid: () => fakeGrid,
    };
    expect(() => outputToScreen(fakeOutput)).not.toThrow();
    const screen = outputToScreen(fakeOutput);
    expect(cellAt(screen, 0, 0)?.char).toBe("a");
    expect(cellAt(screen, 2, 0)?.char).toBe("c");
    // Cell at x=3 doesn't exist — screen is 3 wide.
    expect(cellAt(screen, 3, 0)).toBeUndefined();
  });
});
