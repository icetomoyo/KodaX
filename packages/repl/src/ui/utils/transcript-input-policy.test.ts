import { describe, expect, it } from "vitest";
import {
  hasTranscriptInputActivity,
  resolveTranscriptPointerAction,
  resolveTranscriptCopyKeyAction,
  resolveStreamingInterruptAction,
  shouldDeferInterruptToTranscriptSelectionCopy,
  shouldHandleManagedTranscriptMouse,
  shouldHandleManagedTranscriptWheel,
} from "./transcript-input-policy.js";

describe("transcript-input-policy", () => {
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
      pendingInputCount: 0,
      hasTranscriptTextSelection: true,
      timeSinceLastEscapeMs: 0,
      doubleEscapeIntervalMs: 500,
    })).toEqual({ kind: "none" });

    expect(resolveStreamingInterruptAction({
      keyName: "c",
      ctrl: true,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      pendingInputCount: 0,
      hasTranscriptTextSelection: false,
      timeSinceLastEscapeMs: 0,
      doubleEscapeIntervalMs: 500,
    })).toEqual({ kind: "interrupt" });

    expect(resolveStreamingInterruptAction({
      keyName: "escape",
      ctrl: false,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      pendingInputCount: 1,
      hasTranscriptTextSelection: false,
      timeSinceLastEscapeMs: 0,
      doubleEscapeIntervalMs: 500,
    })).toEqual({ kind: "pop-pending-input" });

    expect(resolveStreamingInterruptAction({
      keyName: "escape",
      ctrl: false,
      isTranscriptMode: false,
      isAwaitingUserInteraction: false,
      isInputEmpty: true,
      pendingInputCount: 0,
      hasTranscriptTextSelection: false,
      timeSinceLastEscapeMs: 700,
      doubleEscapeIntervalMs: 500,
    })).toEqual({ kind: "arm-double-escape" });
  });
});
