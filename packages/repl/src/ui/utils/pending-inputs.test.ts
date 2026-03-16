import { describe, expect, it } from "vitest";
import { formatPendingInputsSummary } from "./pending-inputs.js";

describe("pending-inputs", () => {
  it("returns undefined when there are no queued inputs", () => {
    expect(formatPendingInputsSummary([])).toBeUndefined();
  });

  it("formats a single queued input", () => {
    expect(formatPendingInputsSummary(["check tests too"])).toBe(
      "Queued 1 follow-up: check tests too (Esc removes it)"
    );
  });

  it("formats multiple queued inputs using the latest preview", () => {
    expect(formatPendingInputsSummary(["one", "two"])).toBe(
      "Queued 2 follow-ups. Latest: two (Esc removes latest)"
    );
  });

  it("normalizes whitespace and truncates long previews", () => {
    const summary = formatPendingInputsSummary([
      "one",
      "  this is a very long   queued input that should be trimmed and normalized before display because it keeps going  ",
    ]);

    expect(summary).toContain("Queued 2 follow-ups. Latest:");
    expect(summary).toContain("...");
  });
});
