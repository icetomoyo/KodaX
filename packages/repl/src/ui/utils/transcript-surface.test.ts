import { describe, expect, it } from "vitest";
import {
  buildPromptSurfaceItems,
  captureTranscriptSnapshot,
  countPendingTranscriptUpdates,
  resolveTranscriptInteractionPolicy,
  resolveTranscriptSurfaceItems,
  resolveFullscreenShellMode,
  shouldOwnTranscriptViewport,
  shouldUseAlternateScreenShell,
  shouldUseManagedMainScreenMouseTracking,
  shouldUseRendererViewportShell,
} from "./transcript-surface.js";
import { ToolCallStatus } from "../types.js";

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

  it("builds a compact prompt surface item list with compact thinking, events, and without hint rows", () => {
    const promptItems = buildPromptSurfaceItems([
      {
        id: "user-1",
        type: "user",
        timestamp: 1,
        text: "hello",
      },
      {
        id: "thinking-1",
        type: "thinking",
        timestamp: 2,
        text: "internal reasoning",
      },
      {
        id: "tools-1",
        type: "tool_group",
        timestamp: 3,
        tools: [
          { id: "tool-1", name: "read_file", status: ToolCallStatus.Success },
          { id: "tool-2", name: "read_file", status: ToolCallStatus.Success },
          { id: "tool-3", name: "search_code", status: ToolCallStatus.Success },
        ] as any,
      },
      {
        id: "event-1",
        type: "event",
        timestamp: 4.5,
        text: "Planner completed: full detail",
        compactText: "Planner completed: compact detail",
      },
      {
        id: "assistant-1",
        type: "assistant",
        timestamp: 5,
        text: "done",
      },
      {
        id: "info-1",
        type: "info",
        timestamp: 6,
        text: "Using Scout",
      },
    ] as any);

    expect(promptItems).toEqual([
      {
        id: "user-1",
        type: "user",
        timestamp: 1,
        text: "hello",
      },
      {
        id: "thinking-1",
        type: "thinking",
        timestamp: 2,
        text: "internal reasoning",
      },
      {
        id: "tools-1",
        type: "tool_group",
        timestamp: 3,
        tools: [
          { id: "tool-1", name: "read_file", status: ToolCallStatus.Success },
          { id: "tool-2", name: "read_file", status: ToolCallStatus.Success },
          { id: "tool-3", name: "search_code", status: ToolCallStatus.Success },
        ],
      },
      {
        id: "event-1",
        type: "event",
        timestamp: 4.5,
        text: "Planner completed: full detail",
        compactText: "Planner completed: compact detail",
      },
      {
        id: "assistant-1",
        type: "assistant",
        timestamp: 5,
        text: "done",
      },
      {
        id: "info-1",
        type: "info",
        timestamp: 6,
        text: "Using Scout",
      },
    ]);
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
      transcriptShell: "virtual",
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
      transcriptShell: "main-screen",
      mouseWheel: false,
      mouseClicks: false,
      streamingPreview: false,
      transcriptSpinnerAnimation: false,
    } as const;

    expect(resolveFullscreenShellMode(virtualPrompt, "prompt")).toBe("virtual");
    expect(resolveFullscreenShellMode(virtualPrompt, "transcript")).toBe("virtual");
    expect(resolveFullscreenShellMode(mainScreenPrompt, "prompt")).toBe("main-screen");
    expect(resolveFullscreenShellMode(disabled, "prompt")).toBe("main-screen");

    expect(shouldUseAlternateScreenShell(virtualPrompt, "prompt")).toBe(true);
    expect(shouldUseAlternateScreenShell(virtualPrompt, "transcript")).toBe(true);
    expect(shouldUseAlternateScreenShell(mainScreenPrompt, "prompt")).toBe(false);
    expect(shouldUseAlternateScreenShell(disabled, "prompt")).toBe(false);
  });

  it("keeps main-screen shells on native terminal mouse behavior and only virtualizes the prompt shell", () => {
    const virtualPrompt = {
      enabled: true,
      promptShell: "virtual",
      transcriptShell: "virtual",
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
    expect(shouldUseRendererViewportShell(virtualPrompt, "transcript")).toBe(true);
    expect(shouldUseRendererViewportShell(mainScreenPrompt, "prompt")).toBe(false);

    expect(resolveTranscriptInteractionPolicy(virtualPrompt, "prompt")).toEqual({
      shellMode: "virtual",
      usesAlternateScreenShell: true,
      usesRendererViewportShell: true,
      usesRendererMouseTracking: true,
      usesManagedMouseClicks: true,
      usesManagedMouseWheel: true,
      usesManagedSelection: true,
      usesManagedWheelHistory: true,
      usesNativeMainScreenScrollback: false,
    });
    expect(resolveTranscriptInteractionPolicy(virtualPrompt, "transcript")).toEqual({
      shellMode: "virtual",
      usesAlternateScreenShell: true,
      usesRendererViewportShell: true,
      usesRendererMouseTracking: true,
      usesManagedMouseClicks: true,
      usesManagedMouseWheel: true,
      usesManagedSelection: true,
      usesManagedWheelHistory: true,
      usesNativeMainScreenScrollback: false,
    });
    expect(resolveTranscriptInteractionPolicy(mainScreenPrompt, "prompt")).toEqual({
      shellMode: "main-screen",
      usesAlternateScreenShell: false,
      usesRendererViewportShell: false,
      usesRendererMouseTracking: false,
      usesManagedMouseClicks: false,
      usesManagedMouseWheel: false,
      usesManagedSelection: false,
      usesManagedWheelHistory: false,
      usesNativeMainScreenScrollback: true,
    });
  });

  it("lets transcript own the viewport whenever its shell is virtual, even on hosts whose prompt defaults to main-screen", () => {
    const mixedShellPolicy = {
      enabled: true,
      promptShell: "main-screen",
      transcriptShell: "virtual",
      mouseWheel: true,
      mouseClicks: true,
      streamingPreview: true,
      transcriptSpinnerAnimation: true,
    } as const;

    expect(shouldOwnTranscriptViewport(mixedShellPolicy, "prompt", false)).toBe(false);
    expect(shouldOwnTranscriptViewport(mixedShellPolicy, "prompt", true)).toBe(false);
    expect(shouldOwnTranscriptViewport(mixedShellPolicy, "transcript", false)).toBe(true);
  });
});
