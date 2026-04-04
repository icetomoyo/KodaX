import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { KeyInfo } from "../types.js";

const { handlerRef, controllerHandleKeyMock, textInputPropsRef } = vi.hoisted(() => ({
  handlerRef: {
    current: undefined as ((key: KeyInfo) => boolean) | undefined,
  },
  controllerHandleKeyMock: vi.fn<(key: KeyInfo) => boolean>(),
  textInputPropsRef: {
    current: undefined as Record<string, unknown> | undefined,
  },
}));

vi.mock("ink", () => ({
  Box: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Text: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useApp: () => ({ exit: vi.fn() }),
}));

vi.mock("./TextInput.js", () => ({
  TextInput: (props: Record<string, unknown>) => {
    textInputPropsRef.current = props;
    return null;
  },
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

vi.mock("../themes/index.js", () => ({
  getTheme: () => ({
    colors: {
      primary: "cyan",
      dim: "gray",
      success: "green",
    },
  }),
}));

vi.mock("../utils/prompt-input-controller.js", () => ({
  usePromptInputController: () => ({
    text: "",
    cursor: { row: 2, col: 3 },
    lines: ["one", "two"],
    isPasting: true,
    terminalFocused: false,
    editingMode: "pasting",
    handleKey: controllerHandleKeyMock,
  }),
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
    textInputPropsRef.current = undefined;
    render(<InputPrompt onSubmit={vi.fn()} />);
    expect(handlerRef.current).toBeDefined();
  });

  it("delegates key handling to the prompt input controller", () => {
    const key = createKey({ name: "a", sequence: "a", insertable: true });
    controllerHandleKeyMock.mockReturnValueOnce(true);

    const handled = handlerRef.current?.(key);

    expect(handled).toBe(true);
    expect(controllerHandleKeyMock).toHaveBeenCalledWith(key);
  });

  it("preserves unhandled keys for lower-priority handlers", () => {
    const key = createKey({ name: "t", sequence: "\u0014", ctrl: true });
    controllerHandleKeyMock.mockReturnValueOnce(false);

    const handled = handlerRef.current?.(key);

    expect(handled).toBe(false);
    expect(controllerHandleKeyMock).toHaveBeenCalledWith(key);
  });

  it("renders the text input from controller state", () => {
    expect(textInputPropsRef.current).toMatchObject({
      lines: ["one", "two"],
      cursorRow: 2,
      cursorCol: 3,
      prompt: ">",
      placeholder: "Type a message...",
      focus: true,
      terminalFocused: false,
      isPasting: true,
      editingMode: "pasting",
      theme: "dark",
    });
  });
});
