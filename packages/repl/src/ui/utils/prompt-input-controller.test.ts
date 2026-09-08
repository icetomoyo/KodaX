import React from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render } from "ink-testing-library";
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from "@kodax-ai/agent";
import type { KeyInfo } from "../types.js";
import type { SelectedCompletion } from "../hooks/useAutocomplete.js";

const mocks = vi.hoisted(() => {
  const state = {
    text: "",
    cursor: { row: 0, col: 0 },
    lines: [""],
    visible: false,
    suggestions: [] as Array<{ id: string; text: string }>,
    tabCompletion: null as SelectedCompletion | null,
    enterCompletion: null as SelectedCompletion | null,
    // Issue 121: navigate* mocks now return HistoryEntry. Tests keep the
    // original string-return shape on the state object and wrap into an
    // entry inside the mock.
    navigateUpReturn: null as string | null,
    navigateDownReturn: null as string | null,
    // FEATURE_134 v0.7.40 — paste-handler mock state.
    extractImagePathsReturn: [] as readonly string[],
    handleBracketedPasteReturn: { kind: "text", text: "" } as
      | { kind: "text"; text: string }
      | { kind: "images"; blocks: readonly { type: "image"; path: string; mediaType?: string }[] }
      | { kind: "noop" }
      | { kind: "error"; message: string },
    triggerExplicitClipboardImageReturn: { kind: "noop" } as
      | { kind: "text"; text: string }
      | { kind: "images"; blocks: readonly { type: "image"; path: string; mediaType?: string }[] }
      | { kind: "noop" }
      | { kind: "error"; message: string },
  };

  return {
    state,
    addHistoryMock: vi.fn(),
    navigateUpMock: vi.fn(() =>
      state.navigateUpReturn === null
        ? null
        : { text: state.navigateUpReturn, timestamp: 0 },
    ),
    navigateDownMock: vi.fn(() =>
      state.navigateDownReturn === null
        ? null
        : { text: state.navigateDownReturn, timestamp: 0 },
    ),
    resetHistoryMock: vi.fn(),
    saveTempInputMock: vi.fn(),
    setTextMock: vi.fn(),
    replaceRangeMock: vi.fn(),
    clearMock: vi.fn(),
    moveMock: vi.fn(),
    moveToOffsetMock: vi.fn(),
    insertMock: vi.fn(),
    backspaceMock: vi.fn(),
    newlineMock: vi.fn(),
    deleteMock: vi.fn(),
    undoMock: vi.fn(() => true),
    redoMock: vi.fn(() => true),
    killLineRightMock: vi.fn(),
    killLineLeftMock: vi.fn(),
    deleteWordLeftMock: vi.fn(),
    resetTransientStateMock: vi.fn(),
    handleInputMock: vi.fn(),
    handleTabMock: vi.fn(() => state.tabCompletion),
    handleEnterMock: vi.fn(() => state.enterCompletion),
    handleUpMock: vi.fn(),
    handleDownMock: vi.fn(),
    handleEscapeMock: vi.fn(),
    replacementMock: vi.fn(() => ({
      start: 0,
      end: state.text.length,
      replacement: "completed result",
    })),
    // Issue 121: minimal stub paste-store; tests assert on its expand()
    pasteStoreExpandMock: vi.fn((text: string) => text),
    pasteStoreGetMock: vi.fn(() => undefined),
    // FEATURE_134 v0.7.40 — paste-handler mocks.
    extractImagePathsMock: vi.fn((): readonly string[] => state.extractImagePathsReturn),
    handleBracketedPasteMock: vi.fn(async () => state.handleBracketedPasteReturn),
    triggerExplicitClipboardImageMock: vi.fn(async () => state.triggerExplicitClipboardImageReturn),
  };
});

vi.mock("../hooks/useInputHistory.js", () => ({
  useInputHistory: () => ({
    add: mocks.addHistoryMock,
    navigateUp: mocks.navigateUpMock,
    navigateDown: mocks.navigateDownMock,
    reset: mocks.resetHistoryMock,
    saveTempInput: mocks.saveTempInputMock,
  }),
}));

vi.mock("../hooks/useTextBuffer.js", () => ({
  useTextBuffer: () => ({
    buffer: { getAbsoluteOffset: () => 0, text: mocks.state.text },
    text: mocks.state.text,
    cursor: mocks.state.cursor,
    lines: mocks.state.lines,
    isPasting: false,
    editingMode: "idle",
    // Issue 121: pasteStore stub with expand() + get() so the controller's
    // submit path can request an expanded fullText.
    pasteStore: {
      expand: mocks.pasteStoreExpandMock,
      get: mocks.pasteStoreGetMock,
      peekNextId: () => 1,
      registerText: vi.fn(),
      registerTruncatedText: vi.fn(),
      adopt: vi.fn(),
    },
    setText: mocks.setTextMock,
    replaceRange: mocks.replaceRangeMock,
    clear: mocks.clearMock,
    move: mocks.moveMock,
    moveToOffset: mocks.moveToOffsetMock,
    insert: mocks.insertMock,
    backspace: mocks.backspaceMock,
    newline: mocks.newlineMock,
    delete: mocks.deleteMock,
    undo: mocks.undoMock,
    redo: mocks.redoMock,
    killLineRight: mocks.killLineRightMock,
    killLineLeft: mocks.killLineLeftMock,
    deleteWordLeft: mocks.deleteWordLeftMock,
    resetTransientState: mocks.resetTransientStateMock,
  }),
}));

vi.mock("../hooks/useAutocomplete.js", () => ({
  useAutocompleteContext: () => null,
  useAutocomplete: () => ({
    state: { visible: mocks.state.visible },
    suggestions: mocks.state.suggestions,
    handleInput: mocks.handleInputMock,
    handleTab: mocks.handleTabMock,
    handleEnter: mocks.handleEnterMock,
    handleUp: mocks.handleUpMock,
    handleDown: mocks.handleDownMock,
    handleEscape: mocks.handleEscapeMock,
  }),
}));

vi.mock("./autocomplete-replacement.js", () => ({
  buildAutocompleteReplacement: mocks.replacementMock,
}));

// FEATURE_134 v0.7.40 — mock the paste pipeline so the controller test
// doesn't need real jimp / file IO. State on `mocks.state` drives the
// per-test return shape.
vi.mock("../../paste/index.js", () => ({
  extractImagePaths: mocks.extractImagePathsMock,
  handleBracketedPaste: mocks.handleBracketedPasteMock,
  triggerExplicitClipboardImage: mocks.triggerExplicitClipboardImageMock,
}));

import {
  resolvePromptEditingCommand,
  resolvePromptEnterBehavior,
  resolvePromptEscapeBehavior,
  shouldUseHistoryNavigation,
  usePromptInputController,
} from "./prompt-input-controller.js";

function createKey(overrides: Partial<KeyInfo>): KeyInfo {
  return {
    name: "",
    sequence: "",
    ctrl: false,
    meta: false,
    shift: false,
    insertable: false,
    ...overrides,
  };
}

describe("prompt-input-controller", () => {
  beforeEach(() => {
    mocks.state.text = "";
    mocks.state.cursor = { row: 0, col: 0 };
    mocks.state.lines = [""];
    mocks.state.visible = false;
    mocks.state.suggestions = [];
    mocks.state.tabCompletion = null;
    mocks.state.enterCompletion = null;
    mocks.state.navigateUpReturn = null;
    mocks.state.navigateDownReturn = null;
    mocks.state.extractImagePathsReturn = [];
    mocks.state.handleBracketedPasteReturn = { kind: "text", text: "" };
    mocks.state.triggerExplicitClipboardImageReturn = { kind: "noop" };
    vi.clearAllMocks();
  });

  it("detects when history navigation should override cursor movement", () => {
    expect(shouldUseHistoryNavigation(0, 3, "up")).toBe(true);
    expect(shouldUseHistoryNavigation(2, 3, "down")).toBe(true);
    expect(shouldUseHistoryNavigation(1, 3, "up")).toBe(false);
  });

  it("resolves escape and enter behaviors with autocomplete-aware precedence", () => {
    expect(resolvePromptEscapeBehavior({
      isAutocompleteVisible: true,
      hasText: true,
      timeSinceLastEscapeMs: 10,
    })).toBe("cancel-autocomplete");

    expect(resolvePromptEscapeBehavior({
      isAutocompleteVisible: false,
      hasText: true,
      timeSinceLastEscapeMs: 10,
    })).toBe("clear-input");

    expect(resolvePromptEnterBehavior({
      keyName: "return",
      ctrl: false,
      shift: false,
      isAutocompleteVisible: true,
      isLineContinuation: false,
      isPasting: false,
    })).toBe("accept-completion-and-submit");

    expect(resolvePromptEnterBehavior({
      keyName: "newline",
      ctrl: false,
      shift: false,
      isAutocompleteVisible: false,
      isLineContinuation: false,
      isPasting: false,
    })).toBe("newline");

    expect(resolvePromptEditingCommand({
      name: "k",
      ctrl: true,
      meta: false,
    })).toBe("kill-line-right");
    expect(resolvePromptEditingCommand({
      name: "backspace",
      ctrl: false,
      meta: true,
    })).toBe("delete-word-left");
  });

  it("submits the accepted autocomplete completion on enter", () => {
    mocks.state.text = "comp";
    mocks.state.visible = true;
    mocks.state.suggestions = [{ id: "1", text: "completed" }];
    mocks.state.enterCompletion = { text: "completed", type: "command" };

    const submitMock = vi.fn();
    let controller: ReturnType<typeof usePromptInputController> | undefined;

    const Harness = () => {
      controller = usePromptInputController({ onSubmit: submitMock });
      return null;
    };

    render(React.createElement(Harness));
    const handled = controller?.handleKey(createKey({ name: "return" }));

    expect(handled).toBe(true);
    expect(mocks.handleEnterMock).toHaveBeenCalled();
    expect(mocks.replaceRangeMock).toHaveBeenCalled();
    // Issue 121: addHistory now takes (text, options); submit receives payload.
    expect(mocks.addHistoryMock).toHaveBeenCalledWith(
      "completed result",
      expect.objectContaining({ pastedContents: [] }),
    );
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        displayText: "completed result",
        fullText: "completed result",
        pastedContents: [],
      }),
    );
    expect(mocks.clearMock).toHaveBeenCalled();
  });

  it("treats enter as newline while paste mode is active", () => {
    expect(resolvePromptEnterBehavior({
      keyName: "return",
      ctrl: false,
      shift: false,
      isAutocompleteVisible: false,
      isLineContinuation: false,
      isPasting: true,
    })).toBe("newline");
  });

  it("uses history navigation only at the first and last logical lines", () => {
    mocks.state.text = "draft";
    mocks.state.cursor = { row: 0, col: 0 };
    mocks.state.lines = ["draft", "next line"];
    mocks.state.navigateUpReturn = "older command";

    const submitMock = vi.fn();
    let controller: ReturnType<typeof usePromptInputController> | undefined;

    const Harness = () => {
      controller = usePromptInputController({ onSubmit: submitMock });
      return null;
    };

    render(React.createElement(Harness));
    controller?.handleKey(createKey({ name: "up" }));

    expect(mocks.saveTempInputMock).toHaveBeenCalledWith("draft");
    expect(mocks.navigateUpMock).toHaveBeenCalled();
    expect(mocks.setTextMock).toHaveBeenCalledWith("older command");

    vi.clearAllMocks();
    mocks.state.cursor = { row: 1, col: 0 };
    mocks.state.navigateDownReturn = "latest draft";

    render(React.createElement(Harness));
    controller?.handleKey(createKey({ name: "down" }));

    expect(mocks.navigateDownMock).toHaveBeenCalled();
    expect(mocks.setTextMock).toHaveBeenCalledWith("latest draft");
  });

  it("falls back to history only after an asynchronous empty queue reply", async () => {
    mocks.state.navigateUpReturn = "older command";
    let resolve!: (value: string | undefined) => void;
    const pending = new Promise<string | undefined>((done) => { resolve = done; });
    let controller: ReturnType<typeof usePromptInputController> | undefined;
    const Harness = () => {
      controller = usePromptInputController({ onSubmit: vi.fn(), onPopPendingInputs: () => pending });
      return null;
    };
    render(React.createElement(Harness));
    controller?.handleKey(createKey({ name: "up" }));
    expect(mocks.navigateUpMock).not.toHaveBeenCalled();
    resolve(undefined);
    await pending;
    expect(mocks.setTextMock).toHaveBeenCalledWith("older command");
  });

  it("keeps a late queue withdrawal for the next empty-buffer recall without overwriting a new draft", async () => {
    let resolve!: (value: string | undefined) => void;
    const pending = new Promise<string | undefined>((done) => { resolve = done; });
    const pop = vi.fn(() => pending);
    let controller: ReturnType<typeof usePromptInputController> | undefined;
    const Harness = () => {
      controller = usePromptInputController({ onSubmit: vi.fn(), onPopPendingInputs: pop });
      return null;
    };
    render(React.createElement(Harness));
    controller?.handleKey(createKey({ name: "up" }));
    controller?.handleKey(createKey({ name: "x", sequence: "x", insertable: true }));
    resolve("withdrawn original");
    await pending;
    expect(mocks.setTextMock).not.toHaveBeenCalled();
    controller?.handleKey(createKey({ name: "up" }));
    expect(mocks.setTextMock).toHaveBeenCalledWith("withdrawn original");
    expect(pop).toHaveBeenCalledTimes(1);
  });

  it("retains a late withdrawal in its originating session", async () => {
    let resolve!: (value: string | undefined) => void;
    const pending = new Promise<string | undefined>((done) => { resolve = done; });
    let controller: ReturnType<typeof usePromptInputController> | undefined;
    const Harness = ({ sessionId }: { sessionId: string }) => {
      controller = usePromptInputController({ sessionId, onSubmit: vi.fn(), onPopPendingInputs: () => pending });
      return null;
    };
    const instance = render(React.createElement(Harness, { sessionId: "first" }));
    controller?.handleKey(createKey({ name: "up" }));
    instance.rerender(React.createElement(Harness, { sessionId: "second" }));
    await new Promise((done) => setTimeout(done, 10));
    resolve("first session draft");
    await pending;
    expect(mocks.setTextMock).not.toHaveBeenCalled();
    instance.rerender(React.createElement(Harness, { sessionId: "first" }));
    await new Promise((done) => setTimeout(done, 10));
    controller?.handleKey(createKey({ name: "up" }));
    expect(mocks.setTextMock).toHaveBeenCalledWith("first session draft");
  });

  it("uses double escape to clear prompt text without swallowing empty escapes", () => {
    mocks.state.text = "draft";

    const submitMock = vi.fn();
    let controller: ReturnType<typeof usePromptInputController> | undefined;

    const Harness = () => {
      controller = usePromptInputController({ onSubmit: submitMock });
      return null;
    };

    render(React.createElement(Harness));

    expect(controller?.handleKey(createKey({ name: "escape" }))).toBe(true);
    expect(mocks.clearMock).not.toHaveBeenCalled();

    expect(controller?.handleKey(createKey({ name: "escape" }))).toBe(true);
    expect(mocks.clearMock).toHaveBeenCalled();
    expect(mocks.resetHistoryMock).toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.state.text = "";
    render(React.createElement(Harness));

    expect(controller?.handleKey(createKey({ name: "escape" }))).toBe(false);
  });

  it("dismisses autocomplete when prompt focus is lost", () => {
    mocks.state.visible = true;
    mocks.state.suggestions = [{ id: "1", text: "completed" }];

    const submitMock = vi.fn();

    const Harness = ({ focus }: { focus: boolean }) => {
      usePromptInputController({ onSubmit: submitMock, focus });
      return null;
    };

    const instance = render(React.createElement(Harness, { focus: true }));
    expect(mocks.handleEscapeMock).not.toHaveBeenCalled();

    instance.rerender(React.createElement(Harness, { focus: false }));

    expect(mocks.handleEscapeMock).toHaveBeenCalledTimes(1);
    expect(mocks.resetTransientStateMock).toHaveBeenCalledTimes(1);
  });

  it("leaves unrelated ctrl shortcuts for lower-priority handlers", () => {
    let controller: ReturnType<typeof usePromptInputController> | undefined;

    const Harness = () => {
      controller = usePromptInputController({ onSubmit: vi.fn() });
      return null;
    };

    render(React.createElement(Harness));

    expect(controller?.handleKey(createKey({ name: "t", sequence: "\u0014", ctrl: true }))).toBe(false);
  });

  it("handles shell-style editing shortcuts through the prompt controller", () => {
    let controller: ReturnType<typeof usePromptInputController> | undefined;

    const Harness = () => {
      controller = usePromptInputController({ onSubmit: vi.fn() });
      return null;
    };

    render(React.createElement(Harness));

    expect(controller?.handleKey(createKey({ name: "k", sequence: "\u000b", ctrl: true }))).toBe(true);
    expect(mocks.killLineRightMock).toHaveBeenCalledTimes(1);

    expect(controller?.handleKey(createKey({ name: "u", sequence: "\u0015", ctrl: true }))).toBe(true);
    expect(mocks.killLineLeftMock).toHaveBeenCalledTimes(1);

    expect(controller?.handleKey(createKey({ name: "w", sequence: "\u0017", ctrl: true }))).toBe(true);
    expect(mocks.deleteWordLeftMock).toHaveBeenCalledTimes(1);

    expect(controller?.handleKey(createKey({ name: "backspace", sequence: "\u001b\u007f", meta: true }))).toBe(true);
    expect(mocks.deleteWordLeftMock).toHaveBeenCalledTimes(2);
  });

  // FEATURE_134 v0.7.40 — image paste pipeline integration. The controller
  // intercepts `name === "paste"` keypresses whose content matches
  // `extractImagePaths()`, kicks off `handleBracketedPaste()` async, and
  // inserts `@<path>` refs back into the input buffer once resolved.
  // Plain-text pastes (no image paths) fall through to the existing
  // Issue 121 paste-store path untouched.
  describe("FEATURE_134 image paste integration", () => {
    function makePasteKey(content: string): KeyInfo {
      return createKey({
        name: "paste",
        sequence: content,
        insertable: true,
        isPasted: true,
      });
    }

    it("intercepts an image-path paste and inserts @<path> refs via insert()", async () => {
      const imagePath = "/tmp/kodax-paste/img-abc.png";
      mocks.state.extractImagePathsReturn = [imagePath];
      mocks.state.handleBracketedPasteReturn = {
        kind: "images",
        blocks: [{ type: "image", path: imagePath, mediaType: "image/png" }],
      };

      let controller: ReturnType<typeof usePromptInputController> | undefined;
      const Harness = () => {
        controller = usePromptInputController({ onSubmit: vi.fn() });
        return null;
      };
      render(React.createElement(Harness));

      const handled = controller?.handleKey(makePasteKey(imagePath));
      expect(handled).toBe(true);
      expect(mocks.extractImagePathsMock).toHaveBeenCalledWith(imagePath);
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.handleBracketedPasteMock).toHaveBeenCalledWith(imagePath);
      expect(mocks.insertMock).toHaveBeenCalledWith(`@${imagePath} `, { paste: false });
    });

    it("falls through to the generic text-paste branch when no image paths are found", () => {
      const textPaste = "https://example.com is interesting";
      mocks.state.extractImagePathsReturn = [];

      let controller: ReturnType<typeof usePromptInputController> | undefined;
      const Harness = () => {
        controller = usePromptInputController({ onSubmit: vi.fn() });
        return null;
      };
      render(React.createElement(Harness));

      const handled = controller?.handleKey(makePasteKey(textPaste));
      expect(handled).toBe(true);
      expect(mocks.extractImagePathsMock).toHaveBeenCalledWith(textPaste);
      expect(mocks.handleBracketedPasteMock).not.toHaveBeenCalled();
      expect(mocks.insertMock).toHaveBeenCalledWith(textPaste, { paste: true });
    });

    it("inserts multiple @<path> refs joined by space when paste carries N images", async () => {
      const paths = [
        "/tmp/img-1.png",
        "/tmp/img-2.jpg",
        "/tmp/img-3.webp",
      ];
      mocks.state.extractImagePathsReturn = paths;
      mocks.state.handleBracketedPasteReturn = {
        kind: "images",
        blocks: paths.map((p) => ({ type: "image" as const, path: p })),
      };

      let controller: ReturnType<typeof usePromptInputController> | undefined;
      const Harness = () => {
        controller = usePromptInputController({ onSubmit: vi.fn() });
        return null;
      };
      render(React.createElement(Harness));

      controller?.handleKey(makePasteKey(paths.join(" ")));
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.insertMock).toHaveBeenCalledWith(
        `@${paths[0]} @${paths[1]} @${paths[2]} `,
        { paste: false },
      );
    });

    it("Ctrl+V triggers the explicit clipboard-image keybind", async () => {
      const imagePath = "/tmp/kodax-paste/clip-xyz.png";
      mocks.state.triggerExplicitClipboardImageReturn = {
        kind: "images",
        blocks: [{ type: "image", path: imagePath, mediaType: "image/png" }],
      };

      let controller: ReturnType<typeof usePromptInputController> | undefined;
      const Harness = () => {
        controller = usePromptInputController({ onSubmit: vi.fn() });
        return null;
      };
      render(React.createElement(Harness));

      const handled = controller?.handleKey(
        createKey({ name: "v", sequence: "v", ctrl: true }),
      );
      expect(handled).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.triggerExplicitClipboardImageMock).toHaveBeenCalled();
      expect(mocks.insertMock).toHaveBeenCalledWith(`@${imagePath} `, { paste: false });
    });

    it("Alt+V (meta) also triggers the explicit clipboard-image keybind", async () => {
      const imagePath = "/tmp/kodax-paste/alt-xyz.png";
      mocks.state.triggerExplicitClipboardImageReturn = {
        kind: "images",
        blocks: [{ type: "image", path: imagePath }],
      };

      let controller: ReturnType<typeof usePromptInputController> | undefined;
      const Harness = () => {
        controller = usePromptInputController({ onSubmit: vi.fn() });
        return null;
      };
      render(React.createElement(Harness));

      controller?.handleKey(
        createKey({ name: "v", sequence: "v", meta: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.triggerExplicitClipboardImageMock).toHaveBeenCalled();
      expect(mocks.insertMock).toHaveBeenCalledWith(`@${imagePath} `, { paste: false });
    });

    it("Alt+V autorepeat fires the clipboard read only once (single-flight guard)", async () => {
      // Simulates OS-level key autorepeat firing two Alt+V events within the
      // same tick before the first clipboard read settles. Without the
      // single-flight guard each event creates a separate temp file.
      let resolveClipboard: (() => void) | undefined;
      const blockedClipboardPromise = new Promise<void>((resolve) => {
        resolveClipboard = resolve;
      });
      const imagePath = "/tmp/kodax-paste/repeat-xyz.png";
      mocks.triggerExplicitClipboardImageMock.mockImplementationOnce(
        async () => {
          await blockedClipboardPromise;
          return {
            kind: "images",
            blocks: [{ type: "image", path: imagePath }],
          };
        },
      );

      let controller: ReturnType<typeof usePromptInputController> | undefined;
      const Harness = () => {
        controller = usePromptInputController({ onSubmit: vi.fn() });
        return null;
      };
      render(React.createElement(Harness));

      controller?.handleKey(createKey({ name: "v", sequence: "v", meta: true }));
      controller?.handleKey(createKey({ name: "v", sequence: "v", meta: true }));
      controller?.handleKey(createKey({ name: "v", sequence: "v", meta: true }));
      resolveClipboard?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.triggerExplicitClipboardImageMock).toHaveBeenCalledTimes(1);
      expect(mocks.insertMock).toHaveBeenCalledTimes(1);
    });

    it("clipboard noop (no image on clipboard) does not insert anything", async () => {
      mocks.state.triggerExplicitClipboardImageReturn = { kind: "noop" };

      let controller: ReturnType<typeof usePromptInputController> | undefined;
      const Harness = () => {
        controller = usePromptInputController({ onSubmit: vi.fn() });
        return null;
      };
      render(React.createElement(Harness));

      controller?.handleKey(createKey({ name: "v", sequence: "v", ctrl: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.triggerExplicitClipboardImageMock).toHaveBeenCalled();
      expect(mocks.insertMock).not.toHaveBeenCalled();
    });

    it("paste handler error restores the raw path and emits a transient notice", async () => {
      const imagePath = "/tmp/oops.png";
      mocks.state.extractImagePathsReturn = [imagePath];
      mocks.state.handleBracketedPasteReturn = {
        kind: "error",
        message: "Failed to decode pasted image",
      };
      const onPasteFallback = vi.fn();
      const onSubmit = vi.fn();

      const diagnostics: KodaXDiagnostic[] = [];
      const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
        diagnostics.push(diagnostic);
      });

      let controller: ReturnType<typeof usePromptInputController> | undefined;
      const Harness = () => {
        controller = usePromptInputController({ onSubmit, onPasteFallback });
        return null;
      };
      render(React.createElement(Harness));

      const handled = controller?.handleKey(makePasteKey(imagePath));
      expect(handled).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(diagnostics).toContainEqual(expect.objectContaining({
        source: "repl:prompt-input",
        level: "warn",
        message: expect.stringContaining("Failed to decode pasted image"),
      }));
      expect(mocks.insertMock).toHaveBeenCalledWith(imagePath, { paste: false });
      expect(onPasteFallback).toHaveBeenCalledWith(
        "Image paste failed; inserted as plain text.",
      );
      expect(onSubmit).not.toHaveBeenCalled();
      expect(mocks.addHistoryMock).not.toHaveBeenCalled();
      restoreDiagnostics();
    });
  });
});
