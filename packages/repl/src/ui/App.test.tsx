import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App.js";

vi.mock("./components/InputPrompt.js", () => ({
  InputPrompt: () => <></>,
}));

vi.mock("./components/MessageList.js", () => ({
  MessageList: () => <></>,
}));

describe("App", () => {
  it("module loads without errors", () => {
    expect(App).toBeDefined();
  });
});
