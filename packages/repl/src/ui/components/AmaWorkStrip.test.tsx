import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { AmaWorkStrip, formatAmaWorkStripText } from "./AmaWorkStrip.js";

describe("AmaWorkStrip", () => {
  it("formats finding validation work with counts", () => {
    expect(formatAmaWorkStripText("finding-validation", 3)).toBe("Validating 3 findings");
  });

  it("formats module triage work with singular nouns", () => {
    expect(formatAmaWorkStripText("module-triage", 1)).toBe("Scanning 1 module");
  });

  it("returns undefined when no active fan-out class is present", () => {
    expect(formatAmaWorkStripText(undefined, 2)).toBeUndefined();
  });

  it("returns undefined when the live active count is zero", () => {
    expect(formatAmaWorkStripText("finding-validation", 0)).toBeUndefined();
  });

  it("renders the strip as a single user-facing line", () => {
    const { lastFrame } = render(<AmaWorkStrip text="Parallel evidence pass (2)" />);

    expect(lastFrame()).toContain("Parallel evidence pass (2)");
  });
});
