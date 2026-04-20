import { beforeEach, describe, expect, it } from "vitest";
import {
  PasteStore,
  PASTE_PLACEHOLDER_CHAR_THRESHOLD,
  PASTE_PLACEHOLDER_LINE_THRESHOLD,
  LARGE_INPUT_TRUNCATE_THRESHOLD,
  __resetPasteStoreForTesting,
  expandPastedTextRefs,
  findPlaceholderAfterCursor,
  findPlaceholderBeforeCursor,
  formatPastedTextRef,
  formatTruncatedTextRef,
  getActivePasteStore,
  getOrCreateModulePasteStore,
  getPastedTextRefNumLines,
  maybeTruncateLongInput,
  parseReferences,
  shouldReplacePasteWithPlaceholder,
} from "./paste-store.js";

describe("getPastedTextRefNumLines", () => {
  it("counts line separators (Claude Code semantics)", () => {
    expect(getPastedTextRefNumLines("")).toBe(0);
    expect(getPastedTextRefNumLines("single")).toBe(0);
    expect(getPastedTextRefNumLines("line1\nline2\nline3")).toBe(2);
    expect(getPastedTextRefNumLines("line1\r\nline2")).toBe(1);
    expect(getPastedTextRefNumLines("line1\rline2")).toBe(1);
  });
});

describe("formatPastedTextRef", () => {
  it("omits line count when zero", () => {
    expect(formatPastedTextRef(1, 0)).toBe("[Pasted text #1]");
  });
  it("includes line count when nonzero", () => {
    expect(formatPastedTextRef(7, 42)).toBe("[Pasted text #7 +42 lines]");
  });
});

describe("formatTruncatedTextRef", () => {
  it("uses dot-dot-dot style bounds", () => {
    expect(formatTruncatedTextRef(3, 9000)).toBe(
      "[...Truncated text #3 +9000 lines...]",
    );
  });
});

describe("parseReferences", () => {
  it("parses standalone Pasted text refs", () => {
    const refs = parseReferences("hello [Pasted text #1 +5 lines] world");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ id: 1, kind: "Pasted text" });
    expect(refs[0]?.index).toBe(6);
  });

  it("parses Image and Truncated refs alongside Pasted", () => {
    const input = "[Image #1] then [Pasted text #2] plus [...Truncated text #3 +10 lines...]";
    const refs = parseReferences(input);
    expect(refs.map((r) => r.kind)).toEqual([
      "Image",
      "Pasted text",
      "...Truncated text",
    ]);
    expect(refs.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("ignores malformed / zero-id refs", () => {
    expect(parseReferences("[Pasted text #0]")).toHaveLength(0);
    expect(parseReferences("not a ref")).toHaveLength(0);
  });
});

describe("expandPastedTextRefs", () => {
  it("replaces placeholders with registered content", () => {
    const store = new PasteStore();
    const a = store.registerText("AAA");
    const b = store.registerText("BBB");
    const input = `x ${a.placeholder} y ${b.placeholder} z`;
    expect(store.expand(input)).toBe("x AAA y BBB z");
  });

  it("leaves Image refs alone", () => {
    const store = new PasteStore();
    const a = store.registerText("paste-body");
    const input = `${a.placeholder} and [Image #1] next`;
    expect(store.expand(input)).toBe("paste-body and [Image #1] next");
  });

  it("leaves unknown ids as literal", () => {
    const store = new PasteStore();
    expect(store.expand("[Pasted text #99 +3 lines]")).toBe(
      "[Pasted text #99 +3 lines]",
    );
  });

  it("accepts a plain Record<number, PastedContent>", () => {
    const input = "before [Pasted text #5] after";
    const expanded = expandPastedTextRefs(input, {
      5: { id: 5, type: "text", content: "DATA" },
    });
    expect(expanded).toBe("before DATA after");
  });

  it("handles adjacent refs without confusing indices", () => {
    const store = new PasteStore();
    const a = store.registerText("A");
    const b = store.registerText("B");
    const input = `${a.placeholder}${b.placeholder}`;
    expect(store.expand(input)).toBe("AB");
  });
});

describe("shouldReplacePasteWithPlaceholder", () => {
  it("triggers on char threshold", () => {
    const text = "a".repeat(PASTE_PLACEHOLDER_CHAR_THRESHOLD + 1);
    expect(shouldReplacePasteWithPlaceholder(text)).toBe(true);
  });

  it("triggers on line threshold with short content", () => {
    const text = Array.from(
      { length: PASTE_PLACEHOLDER_LINE_THRESHOLD + 2 },
      (_, i) => `row${i}`,
    ).join("\n");
    expect(shouldReplacePasteWithPlaceholder(text)).toBe(true);
  });

  it("does not trigger below both thresholds", () => {
    expect(shouldReplacePasteWithPlaceholder("short line")).toBe(false);
    expect(shouldReplacePasteWithPlaceholder("one\ntwo")).toBe(false);
  });
});

describe("findPlaceholderBeforeCursor / findPlaceholderAfterCursor", () => {
  it("matches placeholder ending at cursor with EOL boundary", () => {
    const text = "hello [Pasted text #1 +3 lines]";
    const found = findPlaceholderBeforeCursor(text, text.length);
    expect(found).toMatchObject({ id: 1, kind: "Pasted text" });
    expect(text.slice(found!.start, found!.end)).toBe("[Pasted text #1 +3 lines]");
  });

  it("matches placeholder ending at cursor with space boundary", () => {
    const text = "hello [Pasted text #1] world";
    const found = findPlaceholderBeforeCursor(text, "hello [Pasted text #1]".length);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(1);
  });

  it("does NOT match when cursor is not at a word boundary", () => {
    // immediately followed by another non-whitespace char — do not atomic-delete
    const text = "[Pasted text #1]X";
    const found = findPlaceholderBeforeCursor(text, "[Pasted text #1]".length);
    expect(found).toBeNull();
  });

  it("matches placeholder starting at cursor for forward delete", () => {
    const text = "[Pasted text #7 +9 lines] trailing";
    const found = findPlaceholderAfterCursor(text, 0);
    expect(found?.id).toBe(7);
    expect(found?.end).toBe("[Pasted text #7 +9 lines]".length);
  });

  it("forward delete requires boundary BEFORE cursor", () => {
    // cursor in middle of word 'hello' right before the placeholder
    const text = "hello[Pasted text #1]";
    const cursor = 5;
    const found = findPlaceholderAfterCursor(text, cursor);
    expect(found).toBeNull();
  });
});

describe("PasteStore", () => {
  it("assigns monotonic ids", () => {
    const store = new PasteStore();
    const a = store.registerText("one");
    const b = store.registerText("two");
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });

  it("preserves nextId monotonicity across restore", () => {
    const store = new PasteStore();
    store.registerText("one");
    store.registerText("two");
    const snapshot = store.snapshot();
    store.reset();
    store.restore(snapshot);
    const c = store.registerText("three");
    expect(c.id).toBe(3);
  });

  it("adopt() advances nextId past the adopted id", () => {
    const store = new PasteStore();
    store.adopt({ id: 50, type: "text", content: "legacy" });
    const next = store.registerText("fresh");
    expect(next.id).toBe(51);
    expect(store.get(50)?.content).toBe("legacy");
  });

  it("snapshot returns a defensive copy", () => {
    const store = new PasteStore();
    store.registerText("one");
    const snap = store.snapshot();
    snap.clear();
    expect(store.size()).toBe(1);
  });

  it("reset clears contents and restarts id allocation", () => {
    const store = new PasteStore();
    store.registerText("one");
    store.reset();
    expect(store.size()).toBe(0);
    expect(store.registerText("x").id).toBe(1);
  });
});

describe("module-scoped PasteStore (Issue 121 remount resilience)", () => {
  beforeEach(() => {
    __resetPasteStoreForTesting();
  });

  it("returns the same singleton across multiple getOrCreate calls", () => {
    const a = getOrCreateModulePasteStore();
    const b = getOrCreateModulePasteStore();
    expect(a).toBe(b);
  });

  it("preserves entries across remount-style recreate calls (the bug this fix targets)", () => {
    const a = getOrCreateModulePasteStore();
    a.registerText("first paste body");
    // Simulate composer unmount + remount: the new useTextBuffer hook mount
    // calls getOrCreateModulePasteStore again. It MUST return the same store.
    const afterRemount = getOrCreateModulePasteStore();
    expect(afterRemount).toBe(a);
    expect(afterRemount.size()).toBe(1);
    // nextId continues monotonically — fresh paste gets id 2, no collision
    expect(afterRemount.registerText("second").id).toBe(2);
  });

  it("getActivePasteStore returns undefined before first access", () => {
    expect(getActivePasteStore()).toBeUndefined();
  });

  it("getActivePasteStore returns the singleton after creation", () => {
    const created = getOrCreateModulePasteStore();
    expect(getActivePasteStore()).toBe(created);
  });

  it("__resetPasteStoreForTesting clears the singleton so next call builds a fresh store", () => {
    const first = getOrCreateModulePasteStore();
    first.registerText("x");
    __resetPasteStoreForTesting();
    const second = getOrCreateModulePasteStore();
    expect(second).not.toBe(first);
    expect(second.size()).toBe(0);
  });
});

describe("maybeTruncateLongInput (Layer 2)", () => {
  it("is a no-op when below threshold", () => {
    const { truncatedText, placeholderContent } = maybeTruncateLongInput(
      "short",
      1,
    );
    expect(truncatedText).toBe("short");
    expect(placeholderContent).toBe("");
  });

  it("keeps head + tail and extracts middle", () => {
    const body = "x".repeat(LARGE_INPUT_TRUNCATE_THRESHOLD + 5000);
    const { truncatedText, placeholderContent } = maybeTruncateLongInput(body, 7);
    expect(placeholderContent.length).toBeGreaterThan(0);
    expect(truncatedText).toContain("[...Truncated text #7");
    expect(truncatedText.length).toBeLessThan(body.length);
    // head + ref + tail ≈ 1000 chars + ref
    expect(truncatedText.length).toBeLessThan(LARGE_INPUT_TRUNCATE_THRESHOLD);
  });
});
