import { describe, expect, it } from "vitest";
import {
  buildTranscriptBrowseHint,
  createTranscriptDisplayState,
  enterTranscriptHistory,
  exitTranscriptHistory,
  shouldPauseLiveTranscript,
  shouldWindowTranscript,
  supportsTranscriptMouseHistory,
  toggleTranscriptVerbosityState,
} from "./transcript-state.js";

describe("transcript-state", () => {
  it("creates a live owned transcript state for native VT hosts", () => {
    const state = createTranscriptDisplayState("native_vt");

    expect(state.verbosity).toBe("compact");
    expect(state.followMode).toBe("follow-bottom");
    expect(state.buffering).toBe("live");
    expect(state.ownsViewportByDefault).toBe(true);
  });

  it("creates a buffered fallback state for degraded hosts", () => {
    const state = createTranscriptDisplayState("degraded_vt");

    expect(state.buffering).toBe("buffered-fallback");
    expect(state.ownsViewportByDefault).toBe(false);
    expect(shouldWindowTranscript(state)).toBe(false);
  });

  it("toggles verbosity without changing follow mode", () => {
    const initial = createTranscriptDisplayState("native_vt");
    const next = toggleTranscriptVerbosityState(initial);

    expect(next.verbosity).toBe("verbose");
    expect(next.followMode).toBe("follow-bottom");
  });

  it("enters and exits transcript history independently from verbosity", () => {
    const initial = toggleTranscriptVerbosityState(createTranscriptDisplayState("native_vt"));
    const browsing = enterTranscriptHistory(initial);
    const resumed = exitTranscriptHistory(browsing);

    expect(browsing.followMode).toBe("browsing-history");
    expect(browsing.verbosity).toBe("verbose");
    expect(shouldPauseLiveTranscript(browsing)).toBe(true);
    expect(resumed.followMode).toBe("follow-bottom");
    expect(resumed.verbosity).toBe("verbose");
  });

  it("only enables mouse history scrolling when the host supports it and history is active", () => {
    const degraded = enterTranscriptHistory(createTranscriptDisplayState("degraded_vt"));
    const native = enterTranscriptHistory(createTranscriptDisplayState("native_vt"));

    expect(supportsTranscriptMouseHistory(degraded)).toBe(false);
    expect(supportsTranscriptMouseHistory(native)).toBe(true);
  });

  it("builds a browsing hint only while transcript history is active", () => {
    const active = enterTranscriptHistory(createTranscriptDisplayState("xtermjs_host"));

    expect(buildTranscriptBrowseHint(active)).toContain("Browsing transcript history");
    expect(buildTranscriptBrowseHint(createTranscriptDisplayState("xtermjs_host"))).toBeUndefined();
  });
});
