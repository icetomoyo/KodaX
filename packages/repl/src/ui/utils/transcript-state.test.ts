import { describe, expect, it } from "vitest";
import {
  buildTranscriptBrowseHint,
  closeTranscriptSearch,
  createTranscriptDisplayState,
  enterTranscriptHistory,
  exitTranscriptHistory,
  openTranscriptSearch,
  setTranscriptSearchAnchor,
  setTranscriptSearchMatchIndex,
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
    expect(state.ownsViewportByDefault).toBe(true);
    expect(shouldWindowTranscript(state)).toBe(true);
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

    expect(supportsTranscriptMouseHistory(degraded)).toBe(true);
    expect(supportsTranscriptMouseHistory(native)).toBe(true);
  });

  it("builds a browsing hint only while transcript history is active", () => {
    const active = enterTranscriptHistory(createTranscriptDisplayState("xtermjs_host"));

    expect(buildTranscriptBrowseHint(active)).toContain("Browsing transcript history");
    expect(buildTranscriptBrowseHint(createTranscriptDisplayState("xtermjs_host"))).toBeUndefined();
  });

  it("restores live follow when transcript search is cancelled from follow-bottom", () => {
    const initial = createTranscriptDisplayState("native_vt");
    const searching = openTranscriptSearch(initial);
    const closed = closeTranscriptSearch(searching, { restoreFollowMode: true });

    expect(searching.followMode).toBe("browsing-history");
    expect(searching.searchMode).toBe("history");
    expect(closed.followMode).toBe("follow-bottom");
    expect(closed.searchMode).toBe("closed");
    expect(closed.selectedItemId).toBeUndefined();
  });

  it("preserves history browsing when transcript search closes after opening in history mode", () => {
    const browsing = enterTranscriptHistory(createTranscriptDisplayState("native_vt"));
    const searching = openTranscriptSearch(browsing);
    const closed = closeTranscriptSearch(searching, { restoreFollowMode: true });

    expect(closed.followMode).toBe("browsing-history");
    expect(closed.searchMode).toBe("closed");
  });

  it("tracks transcript search anchor and current match separately from follow mode", () => {
    const initial = createTranscriptDisplayState("native_vt");
    const anchored = setTranscriptSearchAnchor(initial, "assistant-1");
    const indexed = setTranscriptSearchMatchIndex(anchored, 3);
    const searching = openTranscriptSearch(indexed, { anchorItemId: "assistant-1", initialMatchIndex: 3 });

    expect(searching.searchAnchorItemId).toBe("assistant-1");
    expect(searching.currentMatchIndex).toBe(3);
    expect(searching.followMode).toBe("browsing-history");
  });

  it("allows transcript search to keep the query active while clearing the current match", () => {
    const initial = createTranscriptDisplayState("native_vt");
    const searching = setTranscriptSearchMatchIndex(openTranscriptSearch(initial), -1);

    expect(searching.currentMatchIndex).toBe(-1);
  });
});
