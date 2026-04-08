import { describe, expect, it } from "vitest";
import {
  createTranscriptDisplayState,
  enterTranscriptMode,
  ownsTranscriptSelectionPath,
  resolveTranscriptSelectedItemId,
  supportsPassiveTranscriptCopyOnSelect,
} from "./transcript-state.js";

describe("transcript-state selection capabilities", () => {
  it("keeps the owned selection path host-driven instead of transcript-mode gated", () => {
    const liveNative = createTranscriptDisplayState("native_vt");
    const transcriptNative = enterTranscriptMode(liveNative);

    expect(ownsTranscriptSelectionPath(liveNative)).toBe(true);
    expect(ownsTranscriptSelectionPath(transcriptNative)).toBe(true);
  });

  it("limits passive copy-on-select to hosts that allow it", () => {
    const nativeTranscript = enterTranscriptMode(
      createTranscriptDisplayState("native_vt"),
    );
    const xtermTranscript = enterTranscriptMode(
      createTranscriptDisplayState("xtermjs_host"),
    );
    const degradedTranscript = enterTranscriptMode(
      createTranscriptDisplayState("degraded_vt"),
    );

    expect(supportsPassiveTranscriptCopyOnSelect(nativeTranscript)).toBe(false);
    expect(supportsPassiveTranscriptCopyOnSelect(xtermTranscript)).toBe(false);
    expect(supportsPassiveTranscriptCopyOnSelect(degradedTranscript)).toBe(false);
  });

  it("only keeps selected ids that remain valid while selection is supported", () => {
    const transcriptNative = enterTranscriptMode(
      createTranscriptDisplayState("native_vt"),
    );
    const liveNative = createTranscriptDisplayState("native_vt");

    expect(resolveTranscriptSelectedItemId(
      transcriptNative,
      ["assistant-1", "tool-1"],
      "tool-1",
    )).toBe("tool-1");
    expect(resolveTranscriptSelectedItemId(
      transcriptNative,
      ["assistant-1", "tool-1"],
      "missing",
    )).toBeUndefined();
    expect(resolveTranscriptSelectedItemId(
      liveNative,
      ["assistant-1", "tool-1"],
      "tool-1",
    )).toBe("tool-1");
  });
});
