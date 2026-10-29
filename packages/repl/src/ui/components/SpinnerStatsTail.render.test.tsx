/**
 * v0.7.41 — integration tests for `<SpinnerStatsTail>` rendered output.
 *
 * The pure-function helpers (formatElapsedDuration, buildSpinnerStatsText,
 * estimateOutputTokens) are unit-tested in SpinnerStatsTail.test.ts; the
 * shared-clock subscription lifecycle is pinned in SharedSpinnerClock.test.tsx.
 *
 * These tests cover the rendered text — pinning the activity-bar wiring
 * gate that InkREPL applies: `streamingState.roundStartedAt != null ?
 * <SpinnerStatsTail .../> : null`. Browse-mode + showSpinner gating live
 * at the InkREPL level and are not retested here.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import {
  SpinnerStatsTail,
  _peekSharedSpinnerListenerCount,
  _peekSharedSpinnerTimerActive,
} from "./LoadingIndicator.js";

afterEach(() => {
  expect(_peekSharedSpinnerListenerCount()).toBe(0);
  expect(_peekSharedSpinnerTimerActive()).toBe(false);
});

describe("SpinnerStatsTail render output", () => {
  it("renders elapsed-only segment before any chars have streamed", () => {
    const startedAt = Date.now() - 3_000;
    const handle = render(
      <SpinnerStatsTail roundStartedAt={startedAt} charCount={0} />,
    );
    expect(handle.lastFrame()).toMatch(/\(\d+s\)/u);
    expect(handle.lastFrame()).not.toMatch(/↓/u);
    handle.unmount();
  });

  it("renders elapsed + tokens once chars start arriving", () => {
    const startedAt = Date.now() - 3_000;
    const handle = render(
      <SpinnerStatsTail roundStartedAt={startedAt} charCount={40} />,
    );
    expect(handle.lastFrame()).toMatch(/\(\d+s · ↓ ~10 tokens\)/u);
    handle.unmount();
  });

  it("renders nothing when roundStartedAt is null (no active round)", () => {
    const handle = render(
      <SpinnerStatsTail roundStartedAt={null} charCount={100} />,
    );
    expect(handle.lastFrame()).toBe("");
    handle.unmount();
  });

  it("rolls over to MmSs format past the 60s boundary", () => {
    const startedAt = Date.now() - 72_000;
    const handle = render(
      <SpinnerStatsTail roundStartedAt={startedAt} charCount={0} />,
    );
    expect(handle.lastFrame()).toMatch(/\(1m\d+s\)/u);
    handle.unmount();
  });

  it("rolls over to HhMmSs format past the 60m boundary", () => {
    const startedAt = Date.now() - 3_723_000;
    const handle = render(
      <SpinnerStatsTail roundStartedAt={startedAt} charCount={0} />,
    );
    expect(handle.lastFrame()).toMatch(/\(1h\d+m\d+s\)/u);
    handle.unmount();
  });
});
