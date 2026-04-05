import { describe, expect, it } from "vitest";
import { buildAlternateScreenEnterSequence, buildAlternateScreenExitSequence } from "./termio.js";

describe("alternate screen termio helpers", () => {
  it("homes the cursor without forcing a clear by default", () => {
    expect(buildAlternateScreenEnterSequence()).toBe("\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1006h");
  });

  it("can opt into a full clear and disable mouse tracking", () => {
    expect(buildAlternateScreenEnterSequence({ clearOnEnter: true, mouseTracking: false })).toBe("\x1b[?1049h\x1b[2J\x1b[H");
    expect(buildAlternateScreenExitSequence({ mouseTracking: false })).toBe("\x1b[?1049l");
  });
});
