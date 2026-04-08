import { describe, expect, it } from "vitest";
import {
  buildTranscriptBrowseHint,
  closeTranscriptSearch,
  createTranscriptDisplayState,
  enterTranscriptMode,
  exitTranscriptMode,
  openTranscriptSearch,
  setTranscriptPendingLiveUpdates,
  setTranscriptScrollAnchor,
  setTranscriptSearchAnchor,
  setTranscriptSearchMatchIndex,
  shouldPauseLiveTranscript,
  shouldWindowTranscript,
  supportsTranscriptMouseHistory,
} from "./transcript-state.js";

describe("transcript-state", () => {
  it("creates a prompt-surface transcript state for native VT hosts", () => {
    const state = createTranscriptDisplayState("native_vt");

    expect(state.surface).toBe("prompt");
    expect(state.buffering).toBe("live");
    expect(state.ownsViewportByDefault).toBe(true);
    expect(state.pendingLiveUpdates).toBe(0);
  });

  it("creates an owned live transcript state for degraded hosts", () => {
    const state = createTranscriptDisplayState("degraded_vt");

    expect(state.buffering).toBe("live");
    expect(state.ownsViewportByDefault).toBe(true);
    expect(shouldWindowTranscript(state)).toBe(true);
  });

  it("enters and exits transcript mode independently from scroll anchoring", () => {
    const initial = setTranscriptScrollAnchor(createTranscriptDisplayState("native_vt"), 6);
    const transcript = enterTranscriptMode(initial);
    const resumed = exitTranscriptMode(transcript);

    expect(transcript.surface).toBe("transcript");
    expect(shouldPauseLiveTranscript(transcript)).toBe(true);
    expect(resumed.surface).toBe("prompt");
    expect(resumed.scrollAnchor).toBe(0);
  });

  it("tracks pending transcript updates only while transcript mode is active", () => {
    const prompt = setTranscriptPendingLiveUpdates(
      createTranscriptDisplayState("native_vt"),
      4,
    );
    const transcript = setTranscriptPendingLiveUpdates(
      enterTranscriptMode(createTranscriptDisplayState("native_vt")),
      4,
    );

    expect(prompt.jumpToLatestAvailable).toBe(false);
    expect(transcript.pendingLiveUpdates).toBe(4);
    expect(transcript.jumpToLatestAvailable).toBe(true);
  });

  it("keeps mouse history support host-driven instead of transcript-mode gated", () => {
    const prompt = createTranscriptDisplayState("native_vt");
    const transcript = enterTranscriptMode(createTranscriptDisplayState("native_vt"));

    expect(supportsTranscriptMouseHistory(prompt)).toBe(true);
    expect(supportsTranscriptMouseHistory(transcript)).toBe(true);
  });

  it("builds a transcript-mode hint only while transcript mode is active", () => {
    const active = enterTranscriptMode(createTranscriptDisplayState("xtermjs_host"));

    expect(buildTranscriptBrowseHint(active)).toContain("Transcript |");
    expect(buildTranscriptBrowseHint(active)).toContain("←/→ select");
    expect(buildTranscriptBrowseHint(createTranscriptDisplayState("xtermjs_host"))).toBeUndefined();
  });

  it("opens transcript search by switching to transcript mode", () => {
    const initial = createTranscriptDisplayState("native_vt");
    const searching = openTranscriptSearch(initial, { anchorItemId: "assistant-1" });
    const closed = closeTranscriptSearch(searching);

    expect(searching.surface).toBe("transcript");
    expect(searching.searchMode).toBe("history");
    expect(closed.surface).toBe("transcript");
    expect(closed.searchMode).toBe("closed");
  });

  it("tracks transcript search anchor and current match separately from transcript mode", () => {
    const initial = createTranscriptDisplayState("native_vt");
    const anchored = setTranscriptSearchAnchor(initial, "assistant-1");
    const indexed = setTranscriptSearchMatchIndex(anchored, 3);
    const searching = openTranscriptSearch(indexed, { anchorItemId: "assistant-1", initialMatchIndex: 3 });

    expect(searching.searchAnchorItemId).toBe("assistant-1");
    expect(searching.currentMatchIndex).toBe(3);
    expect(searching.surface).toBe("transcript");
  });

  it("allows transcript search to keep the query active while clearing the current match", () => {
    const initial = createTranscriptDisplayState("native_vt");
    const searching = setTranscriptSearchMatchIndex(openTranscriptSearch(initial), -1);

    expect(searching.currentMatchIndex).toBe(-1);
  });
});
