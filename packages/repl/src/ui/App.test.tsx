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
  it("passes parallel mode through to the status bar", () => {
    const { lastFrame } = render(
      <App
        model="sonnet"
        provider="anthropic"
        parallel
        onSubmit={async () => {}}
      />
    );

    expect(lastFrame()).toContain("parallel");
  });
});
