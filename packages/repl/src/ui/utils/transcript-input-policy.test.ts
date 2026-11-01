import { describe, expect, it } from "vitest";
import {
  hasTranscriptInputActivity,
  resolveTranscriptPointerAction,
  resolveTranscriptCopyKeyAction,
  resolveStreamingInterruptAction,
  shouldDeferInterruptToTranscriptSelectionCopy,
  shouldHandleManagedTranscriptMouse,
  shouldHandleManagedTranscriptWheel,
  shouldStopWorkflowFromInterruptKey,
} from "./transcript-input-policy.js";

describe("transcript-input-policy", () => {
  it.each([
    [0, true, { kind: 'scroll-by', delta: -4 }],
    [0, false, { kind: 'consume' }],
    [4, true, { kind: 'scroll-by', delta: -4 }],
    [4, false, { kind: 'scroll-by', delta: -4 }],
  ] as const)('keeps wheel navigation live at offset %s while isBrowsingHistory=%s', (historyScrollOffset, isBrowsingHistory, expected) => {
    expect(resolveTranscriptPointerAction({ keyName: 'wheeldown', hasTranscript: true, historyScrollOffset, isBrowsingHistory,
      reviewPageSize: 18, reviewWheelStep: 4, hasMouse: false, usesManagedMouseClicks: false, supportsMouseTracking: false,
      usesRendererMouseTracking: false, usesManagedMouseWheel: true, supportsWheelHistory: true })).toEqual(expected);
  });
  it("detects transcript activity from rows or live streaming state", () => {
    expect(hasTranscriptInputActivity({
      itemsLength: 0,
      currentResponse: "",
      thinkingContent: "",
      activeToolCallsLength: 0,
    })).toBe(false);

    expect(hasTranscriptInputActivity({
      itemsLength: 1,
      currentResponse: "",
      thinkingContent: "",
      activeToolCallsLength: 0,
    })).toBe(true);

    expect(hasTranscriptInputActivity({
      itemsLength: 0,
      currentResponse: "partial",
      thinkingContent: "",
      activeToolCallsLength: 0,
    })).toBe(true);
  });

  it("only handles managed mouse selection when renderer-owned mouse tracking is active", () => {
    expect(shouldHandleManagedTranscriptMouse({
      keyName: "mouse",
      hasMouse: true,
      usesManagedMouseClicks: true,
      supportsMouseTracking: true,
      usesRendererMouseTracking: true,
    })).toBe(true);

    expect(shouldHandleManagedTranscriptMouse({
      keyName: "mouse",
      hasMouse: true,
      usesManagedMouseClicks: false,
      supportsMouseTracking: true,
      usesRendererMouseTracking: true,
    })).toBe(false);
  });

  it("only handles managed wheel history when the virtual shell owns wheel behavior", () => {
    expect(shouldHandleManagedTranscriptWheel({
      usesManagedMouseWheel: true,
      supportsWheelHistory: true,
      hasTranscript: true,
    })).toBe(true);

    expect(shouldHandleManagedTranscriptWheel({
      usesManagedMouseWheel: false,
      supportsWheelHistory: true,
      hasTranscript: true,
    })).toBe(false);
  });

  it("resolves pointer input into semantic transcript actions", () => {
    expect(resolveTranscriptPointerAction({
      keyName: "pageup",
      hasTranscript: false,
      historyScrollOffset: 0,
      reviewPageSize: 18,
      reviewWheelStep: 4,
      hasMouse: false,
      usesManagedMouseClicks: false,
      supportsMouseTracking: false,
      usesRendererMouseTracking: false,
      usesManagedMouseWheel: false,
      supportsWheelHistory: false,
    })).toEqual({ kind: "consume" });

    expect(resolveTranscriptPointerAction({
      keyName: "wheelup",
      hasTranscript: true,
      historyScrollOffset: 0,
      reviewPageSize: 18,
      reviewWheelStep: 4,
      hasMouse: false,
      usesManagedMouseClicks: false,
      supportsMouseTracking: false,
      usesRendererMouseTracking: false,
      usesManagedMouseWheel: true,
      supportsWheelHistory: true,
    })).toEqual({ kind: "scroll-by", delta: 4 });

    expect(resolveTranscriptPointerAction({
      keyName: "wheeldown",
      hasTranscript: true,
      historyScrollOffset: 0,
      reviewPageSize: 18,
      reviewWheelStep: 4,
      hasMouse: false,
      usesManagedMouseClicks: false,
      supportsMouseTracking: false,
      usesRendererMouseTracking: false,
      usesManagedMouseWheel: true,
      supportsWheelHistory: true,
    })).toEqual({ kind: "consume" });

    expect(resolveTranscriptPointerAction({
      keyName: "mouse",
      hasTranscript: true,
      historyScrollOffset: 0,
      reviewPageSize: 18,
      reviewWheelStep: 4,
      hasMouse: true,
      mouseButton: "left",
      mouseAction: "drag",
      usesManagedMouseClicks: true,
      supportsMouseTracking: true,
      usesRendererMouseTracking: true,
      usesManagedMouseWheel: false,
      supportsWheelHistory: false,
    })).toEqual({ kind: "mouse-phase", phase: "drag" });
  });

  it("prefers copying text selection over message item copying", () => {
    expect(resolveTranscriptCopyKeyAction({
      hasTextSelection: true,
      canCopySelectedItem: true,
    })).toBe("selection");

    expect(resolveTranscriptCopyKeyAction({
      hasTextSelection: false,
      canCopySelectedItem: true,
    })).toBe("item");

    expect(resolveTranscriptCopyKeyAction({
      hasTextSelection: false,
      canCopySelectedItem: false,
    })).toBe("none");
  });

  it("lets transcript selection copy win over prompt interrupt semantics", () => {
    expect(shouldDeferInterruptToTranscriptSelectionCopy({
      isTranscriptMode: true,
      hasTextSelection: true,
    })).toBe(true);

    expect(shouldDeferInterruptToTranscriptSelectionCopy({
      isTranscriptMode: false,
      hasTextSelection: true,
    })).toBe(false);
  });

  it("resolves streaming interrupt priority without relying on InkREPL condition chains", () => {
    expect(resolveStreamingInterruptAction({
      keyName: "c",
      ctrl: true,
      isTranscriptMode: true,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      isDoubleEscape: false,
      pendingInputCount: 0,
      hasTranscriptTextSelection: true,
    })).toEqual({ kind: "none" });

    expect(resolveStreamingInterruptAction({
      keyName: "c",
      ctrl: true,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      isDoubleEscape: false,
      pendingInputCount: 0,
      hasTranscriptTextSelection: false,
    })).toEqual({ kind: "interrupt" });

    expect(resolveStreamingInterruptAction({
      keyName: "escape",
      ctrl: false,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      isDoubleEscape: false,
      pendingInputCount: 1,
      hasTranscriptTextSelection: false,
    })).toEqual({ kind: "pop-pending-input" });

    expect(resolveStreamingInterruptAction({
      keyName: "escape",
      ctrl: false,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      isDoubleEscape: false,
      pendingInputCount: 0,
      hasTranscriptTextSelection: false,
    })).toEqual({ kind: "none" });

    expect(resolveStreamingInterruptAction({
      keyName: "escape",
      ctrl: false,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      isDoubleEscape: true,
      pendingInputCount: 0,
      hasTranscriptTextSelection: false,
    })).toEqual({ kind: "interrupt" });
  });

  it("routes double Esc and Ctrl+C to an active background workflow without waiting for foreground loading", () => {
    expect(shouldStopWorkflowFromInterruptKey({
      keyName: "escape",
      ctrl: false,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      isDoubleEscape: true,
      pendingInputCount: 0,
      hasTranscriptTextSelection: false,
      hasActiveWorkflow: true,
    })).toBe(true);

    expect(shouldStopWorkflowFromInterruptKey({
      keyName: "c",
      ctrl: true,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      isDoubleEscape: false,
      pendingInputCount: 0,
      hasTranscriptTextSelection: false,
      hasActiveWorkflow: true,
    })).toBe(true);
  });

  it("keeps workflow interrupt keys out of text editing, pending input, and transcript selection", () => {
    expect(shouldStopWorkflowFromInterruptKey({
      keyName: "escape",
      ctrl: false,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: false,
      isDoubleEscape: true,
      pendingInputCount: 0,
      hasTranscriptTextSelection: false,
      hasActiveWorkflow: true,
    })).toBe(false);

    expect(shouldStopWorkflowFromInterruptKey({
      keyName: "escape",
      ctrl: false,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      isDoubleEscape: false,
      pendingInputCount: 0,
      hasTranscriptTextSelection: false,
      hasActiveWorkflow: true,
    })).toBe(false);

    expect(shouldStopWorkflowFromInterruptKey({
      keyName: "escape",
      ctrl: false,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      isDoubleEscape: true,
      pendingInputCount: 1,
      hasTranscriptTextSelection: false,
      hasActiveWorkflow: true,
    })).toBe(false);

    expect(shouldStopWorkflowFromInterruptKey({
      keyName: "c",
      ctrl: true,
      isTranscriptMode: true,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      isDoubleEscape: false,
      pendingInputCount: 0,
      hasTranscriptTextSelection: true,
      hasActiveWorkflow: true,
    })).toBe(false);
  });
});
