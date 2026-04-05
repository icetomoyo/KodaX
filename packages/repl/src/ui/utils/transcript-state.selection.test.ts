import { describe, expect, it } from "vitest";
import {
  createTranscriptDisplayState,
  enterTranscriptHistory,
  ownsTranscriptSelectionPath,
  resolveTranscriptSelectedItemId,
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

    expect(supportsPassiveTranscriptCopyOnSelect(nativeBrowsing)).toBe(false);
    expect(supportsPassiveTranscriptCopyOnSelect(xtermBrowsing)).toBe(false);
    expect(supportsPassiveTranscriptCopyOnSelect(degradedBrowsing)).toBe(false);
  });

  it("only keeps selected ids that remain valid inside the owned selection path", () => {
    const browsingNative = enterTranscriptHistory(
      createTranscriptDisplayState("native_vt"),
    );
    const liveNative = createTranscriptDisplayState("native_vt");

    expect(resolveTranscriptSelectedItemId(
      browsingNative,
      ["assistant-1", "tool-1"],
      "tool-1",
    )).toBe("tool-1");
    expect(resolveTranscriptSelectedItemId(
      browsingNative,
      ["assistant-1", "tool-1"],
      "missing",
    )).toBeUndefined();
    expect(resolveTranscriptSelectedItemId(
      liveNative,
      ["assistant-1", "tool-1"],
      "tool-1",
    )).toBeUndefined();
  });
});
