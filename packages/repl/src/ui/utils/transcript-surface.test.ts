import { describe, expect, it } from "vitest";
import {
  captureTranscriptSnapshot,
  countPendingTranscriptUpdates,
  resolveTranscriptSurfaceItems,
  resolveFullscreenShellMode,
  shouldUseAlternateScreenShell,
  shouldUseManagedMainScreenMouseTracking,
  shouldUseRendererViewportShell,
} from "./transcript-surface.js";

describe("transcript-surface", () => {
  it("captures the full transcript items for transcript mode snapshots", () => {
    const items = [
      { type: "user", text: "Round 1 prompt" },
      { type: "assistant", text: "Round 1 answer" },
      { type: "user", text: "Round 2 prompt" },
      { type: "assistant", text: "Round 2 answer" },
    ] as any[];

    const snapshot = captureTranscriptSnapshot({
      items,
      isLoading: false,
      isThinking: false,
      thinkingCharCount: 0,
      thinkingContent: "",
      currentResponse: "",
      currentTool: undefined,
      activeToolCalls: [],
      toolInputCharCount: 0,
      toolInputContent: "",
      lastLiveActivityLabel: undefined,
      workStripText: undefined,
      iterationHistory: [],
      currentIteration: 0,
      isCompacting: false,
    });

    expect(snapshot.items).toEqual(items);
    expect(snapshot.items).not.toBe(items);
  });

  it("uses the full transcript items rather than the prompt slice in transcript mode", () => {
    const promptItems = [
      { type: "assistant", text: "Most recent answer" },
    ] as any[];
    const transcriptItems = [
      { type: "user", text: "Old prompt" },
      { type: "assistant", text: "Old answer" },
      ...promptItems,
    ] as any[];

    expect(resolveTranscriptSurfaceItems({
      surface: "prompt",
      snapshot: null,
      promptItems,
      transcriptItems,
    })).toEqual(promptItems);

    expect(resolveTranscriptSurfaceItems({
      surface: "transcript",
      snapshot: null,
      promptItems,
      transcriptItems,
    })).toEqual(transcriptItems);
  });

  it("counts pending transcript updates against the full transcript snapshot", () => {
    const snapshot = captureTranscriptSnapshot({
      items: [
        { type: "user", text: "Round 1 prompt" },
        { type: "assistant", text: "Round 1 answer" },
      ] as any[],
      isLoading: false,
      isThinking: false,
      thinkingCharCount: 0,
      thinkingContent: "",
      currentResponse: "",
      currentTool: undefined,
      activeToolCalls: [],
      toolInputCharCount: 0,
      toolInputContent: "",
      lastLiveActivityLabel: undefined,
      workStripText: undefined,
      iterationHistory: [],
      currentIteration: 0,
      isCompacting: false,
    });

    expect(countPendingTranscriptUpdates({
      isTranscriptMode: true,
      snapshot,
      currentItemsLength: 4,
      isLoading: false,
      currentResponse: "",
      thinkingContent: "",
      activeToolCallsLength: 0,
    })).toBe(2);
  });

  it("uses the alternate screen only for the live prompt surface", () => {
    const virtualPrompt = {
      enabled: true,
      promptShell: "virtual",
      mouseWheel: true,
      mouseClicks: true,
      streamingPreview: true,
      transcriptSpinnerAnimation: true,
    } as const;
    const mainScreenPrompt = {
      ...virtualPrompt,
      promptShell: "main-screen",
    } as const;
    const disabled = {
      ...virtualPrompt,
      enabled: false,
      promptShell: "main-screen",
      mouseWheel: false,
      mouseClicks: false,
      streamingPreview: false,
      transcriptSpinnerAnimation: false,
    } as const;

    expect(resolveFullscreenShellMode(virtualPrompt, "prompt")).toBe("virtual");
    expect(resolveFullscreenShellMode(virtualPrompt, "transcript")).toBe("main-screen");
    expect(resolveFullscreenShellMode(mainScreenPrompt, "prompt")).toBe("main-screen");
    expect(resolveFullscreenShellMode(disabled, "prompt")).toBe("main-screen");

    expect(shouldUseAlternateScreenShell(virtualPrompt, "prompt")).toBe(true);
    expect(shouldUseAlternateScreenShell(virtualPrompt, "transcript")).toBe(false);
    expect(shouldUseAlternateScreenShell(mainScreenPrompt, "prompt")).toBe(false);
    expect(shouldUseAlternateScreenShell(disabled, "prompt")).toBe(false);
  });

  it("keeps main-screen shells on native terminal mouse behavior and only virtualizes the prompt shell", () => {
    const virtualPrompt = {
      enabled: true,
      promptShell: "virtual",
      mouseWheel: true,
      mouseClicks: true,
      streamingPreview: true,
      transcriptSpinnerAnimation: true,
    } as const;
    const mainScreenPrompt = {
      ...virtualPrompt,
      promptShell: "main-screen",
    } as const;

    expect(shouldUseManagedMainScreenMouseTracking(virtualPrompt, "prompt")).toBe(false);
    expect(shouldUseManagedMainScreenMouseTracking(mainScreenPrompt, "prompt")).toBe(false);
    expect(shouldUseManagedMainScreenMouseTracking(virtualPrompt, "transcript")).toBe(false);

    expect(shouldUseRendererViewportShell(virtualPrompt, "prompt")).toBe(true);
    expect(shouldUseRendererViewportShell(virtualPrompt, "transcript")).toBe(false);
    expect(shouldUseRendererViewportShell(mainScreenPrompt, "prompt")).toBe(false);
  });
});
