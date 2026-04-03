import React from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render } from "ink-testing-library";
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
    navigateUpReturn: null as string | null,
    navigateDownReturn: null as string | null,
  };

  return {
    state,
    addHistoryMock: vi.fn(),
    navigateUpMock: vi.fn(() => state.navigateUpReturn),
    navigateDownMock: vi.fn(() => state.navigateDownReturn),
    resetHistoryMock: vi.fn(),
    saveTempInputMock: vi.fn(),
    setTextMock: vi.fn(),
    replaceRangeMock: vi.fn(),
    clearMock: vi.fn(),
    moveMock: vi.fn(),
    insertMock: vi.fn(),
    backspaceMock: vi.fn(),
    newlineMock: vi.fn(),
    deleteMock: vi.fn(),
    undoMock: vi.fn(() => true),
    redoMock: vi.fn(() => true),
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
    buffer: { getAbsoluteOffset: () => 0 },
    text: mocks.state.text,
    cursor: mocks.state.cursor,
    lines: mocks.state.lines,
    setText: mocks.setTextMock,
    replaceRange: mocks.replaceRangeMock,
    clear: mocks.clearMock,
    move: mocks.moveMock,
    insert: mocks.insertMock,
    backspace: mocks.backspaceMock,
    newline: mocks.newlineMock,
    delete: mocks.deleteMock,
    undo: mocks.undoMock,
    redo: mocks.redoMock,
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

import {
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
    })).toBe("accept-completion-and-submit");

    expect(resolvePromptEnterBehavior({
      keyName: "newline",
      ctrl: false,
      shift: false,
      isAutocompleteVisible: false,
      isLineContinuation: false,
    })).toBe("newline");
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
    expect(mocks.addHistoryMock).toHaveBeenCalledWith("completed result");
    expect(submitMock).toHaveBeenCalledWith("completed result");
    expect(mocks.clearMock).toHaveBeenCalled();
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

  it("leaves unrelated ctrl shortcuts for lower-priority handlers", () => {
    let controller: ReturnType<typeof usePromptInputController> | undefined;

    const Harness = () => {
      controller = usePromptInputController({ onSubmit: vi.fn() });
      return null;
    };

    render(React.createElement(Harness));

    expect(controller?.handleKey(createKey({ name: "t", sequence: "\u0014", ctrl: true }))).toBe(false);
  });
});
