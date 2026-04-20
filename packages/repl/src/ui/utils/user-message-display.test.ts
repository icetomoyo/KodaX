import { describe, expect, it } from "vitest";
import { truncateUserMessageForDisplay } from "./user-message-display.js";

describe("truncateUserMessageForDisplay", () => {
  it("returns the input unchanged when below max", () => {
    const small = "hello world";
    expect(truncateUserMessageForDisplay(small)).toBe(small);
  });

  it("returns unchanged text at the exact threshold boundary", () => {
    const text = "x".repeat(10_000);
    expect(truncateUserMessageForDisplay(text)).toBe(text);
  });

  it("collapses overlong text to head + tail + hidden line summary", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line${i}-${"a".repeat(50)}`);
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(10_000);

    const out = truncateUserMessageForDisplay(text);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toMatch(/^line0-a+/);
    expect(out).toMatch(/line499-a+$/);
    expect(out).toMatch(/\n… \+\d+ lines …\n/);
  });

  it("respects custom head/tail/max overrides", () => {
    const text = "a".repeat(100);
    const out = truncateUserMessageForDisplay(text, {
      maxChars: 30,
      headChars: 10,
      tailChars: 10,
    });
    expect(out).toContain("a".repeat(10));
    expect(out).toContain("… +0 lines …");
    expect(out.length).toBeLessThan(text.length);
  });

  it("is idempotent for already-truncated output", () => {
    const text = "x".repeat(15_000);
    const first = truncateUserMessageForDisplay(text);
    const second = truncateUserMessageForDisplay(first);
    // second pass is a no-op since first is already under threshold
    expect(second).toBe(first);
  });
});
