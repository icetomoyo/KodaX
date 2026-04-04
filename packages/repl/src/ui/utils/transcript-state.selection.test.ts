import { describe, expect, it } from "vitest";
import {
  createTranscriptDisplayState,
  enterTranscriptHistory,
  ownsTranscriptSelectionPath,
  supportsPassiveTranscriptCopyOnSelect,
} from "./transcript-state.js";

describe("transcript-state selection capabilities", () => {
  it("only enables the owned selection path while browsing history", () => {
    const liveNative = createTranscriptDisplayState("native_vt");
    const browsingNative = enterTranscriptHistory(liveNative);

    expect(ownsTranscriptSelectionPath(liveNative)).toBe(false);
    expect(ownsTranscriptSelectionPath(browsingNative)).toBe(true);
  });

  it("limits passive copy-on-select to hosts that allow it", () => {
    const nativeBrowsing = enterTranscriptHistory(
      createTranscriptDisplayState("native_vt"),
    );
    const xtermBrowsing = enterTranscriptHistory(
      createTranscriptDisplayState("xtermjs_host"),
    );
    const degradedBrowsing = enterTranscriptHistory(
      createTranscriptDisplayState("degraded_vt"),
    );

    expect(supportsPassiveTranscriptCopyOnSelect(nativeBrowsing)).toBe(true);
    expect(supportsPassiveTranscriptCopyOnSelect(xtermBrowsing)).toBe(false);
    expect(supportsPassiveTranscriptCopyOnSelect(degradedBrowsing)).toBe(false);
  });
});
