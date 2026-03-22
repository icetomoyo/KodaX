import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { KeyInfo } from "../types.js";

const {
  moveMock,
  clearMock,
  resetHistoryMock,
  handlerRef,
} = vi.hoisted(() => ({
  moveMock: vi.fn(),
  clearMock: vi.fn(),
  resetHistoryMock: vi.fn(),
  handlerRef: {
    current: undefined as ((key: KeyInfo) => boolean) | undefined,
  },
}));

vi.mock("ink", () => ({
  Box: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Text: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useApp: () => ({ exit: vi.fn() }),
}));

vi.mock("./TextInput.js", () => ({
  TextInput: () => null,
}));

vi.mock("../contexts/KeypressContext.js", () => ({
  useKeypress: (...args: unknown[]) => {
    const handler =
      typeof args[0] === "function"
        ? (args[0] as (key: KeyInfo) => boolean)
        : (args[1] as (key: KeyInfo) => boolean);
    handlerRef.current = handler;
  },
}));

vi.mock("../hooks/useTextBuffer.js", () => ({
  useTextBuffer: () => ({
    buffer: { getAbsoluteOffset: () => 0 },
    text: "",
    cursor: { row: 0, col: 0 },
    lines: [""],
    setText: vi.fn(),
    replaceRange: vi.fn(),
    clear: clearMock,
    move: moveMock,
    insert: vi.fn(),
    backspace: vi.fn(),
    newline: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock("../hooks/useInputHistory.js", () => ({
  useInputHistory: () => ({
    add: vi.fn(),
    navigateUp: vi.fn(),
    navigateDown: vi.fn(),
    reset: resetHistoryMock,
    saveTempInput: vi.fn(),
  }),
}));

vi.mock("../hooks/useAutocomplete.js", () => ({
  useAutocomplete: () => ({
    state: { visible: false },
    suggestions: [],
    handleInput: vi.fn(),
    handleTab: vi.fn(),
    handleEnter: vi.fn(),
    handleUp: vi.fn(),
    handleDown: vi.fn(),
    handleEscape: vi.fn(),
  }),
  useAutocompleteContext: () => null,
}));

vi.mock("../themes/index.js", () => ({
  getTheme: () => ({
    colors: {
      primary: "cyan",
      dim: "gray",
      success: "green",
    },
  }),
}));

vi.mock("../utils/autocomplete-replacement.js", () => ({
  buildAutocompleteReplacement: vi.fn(),
}));

import { InputPrompt } from "./InputPrompt.js";

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

describe("InputPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlerRef.current = undefined;
    render(<InputPrompt onSubmit={vi.fn()} />);
    expect(handlerRef.current).toBeDefined();
  });

  it("does not consume unhandled ctrl shortcuts", () => {
    const handledThinking = handlerRef.current?.(
      createKey({ name: "t", sequence: "\u0014", ctrl: true }),
    );
    const handledParallel = handlerRef.current?.(
      createKey({ name: "p", sequence: "\u0010", ctrl: true }),
    );

    expect(handledThinking).toBe(false);
    expect(handledParallel).toBe(false);
  });

  it("still handles local ctrl navigation shortcuts", () => {
    const handled = handlerRef.current?.(
      createKey({ name: "a", sequence: "\u0001", ctrl: true }),
    );

    expect(handled).toBe(true);
    expect(moveMock).toHaveBeenCalledWith("home");
  });
});
