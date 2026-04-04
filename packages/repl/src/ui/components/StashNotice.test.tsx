import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StashNotice } from "./StashNotice.js";

describe("StashNotice", () => {
  it("renders a stash hint when text is present", () => {
    const { lastFrame } = render(
      <StashNotice text="Draft preserved while browsing transcript" />,
    );

    expect(lastFrame()).toContain("Draft preserved while browsing transcript");
  });

  it("renders nothing when there is no stash text", () => {
    const { lastFrame } = render(<StashNotice text="" />);
    expect(lastFrame()).toBe("");
  });
});
