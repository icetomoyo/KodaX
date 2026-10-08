/**
 * Unit tests for the spinner-tail helpers (v0.7.41).
 *
 * `<SpinnerStatsTail>` itself self-ticks via `useSharedSpinnerTick`
 * which is awkward to test in pure-JS environments without rendering
 * Ink + JSDOM. The component's only logic is composing the formatted
 * string from elapsed-ms + char-count — we test those pure functions
 * directly.
 *
 * Behaviour pins:
 *   - elapsed format rolls over by magnitude (`Ns` → `MmSs` → `HhMmSs`)
 *     so long-running queries stay glanceable
 *   - tokens use the chars/4 heuristic (claudecode parity, see
 *     `c:/Works/claudecode/src/utils/tokens.ts:172-199`) — provider
 *     `usage.output_tokens` only lands at message-end so we can't use
 *     it for a live progress indicator
 */
import { describe, it, expect } from "vitest";
import {
  buildSpinnerStatsText,
  estimateOutputTokens,
  formatElapsedDuration,
} from "./LoadingIndicator.js";

describe("formatElapsedDuration — rollover by magnitude", () => {
  it("sub-second renders as 0s (no jitter on very short rounds)", () => {
    expect(formatElapsedDuration(0)).toBe("0s");
    expect(formatElapsedDuration(999)).toBe("0s");
  });

  it("under one minute renders as bare seconds", () => {
    expect(formatElapsedDuration(1_000)).toBe("1s");
    expect(formatElapsedDuration(45_000)).toBe("45s");
    expect(formatElapsedDuration(59_999)).toBe("59s");
  });

  it("at one minute and beyond renders as MmSs", () => {
    expect(formatElapsedDuration(60_000)).toBe("1m0s");
    expect(formatElapsedDuration(72_000)).toBe("1m12s");
    expect(formatElapsedDuration(125_000)).toBe("2m5s");
    expect(formatElapsedDuration(3_540_000)).toBe("59m0s");
    expect(formatElapsedDuration(3_599_000)).toBe("59m59s");
  });

  it("at one hour and beyond renders as HhMmSs (full time-of-day style)", () => {
    expect(formatElapsedDuration(3_600_000)).toBe("1h0m0s");
    expect(formatElapsedDuration(3_723_000)).toBe("1h2m3s");
    expect(formatElapsedDuration(7_200_000)).toBe("2h0m0s");
    expect(formatElapsedDuration(86_400_000)).toBe("24h0m0s");
  });

  it("clamps negative input to 0s (defensive against clock skew)", () => {
    expect(formatElapsedDuration(-100)).toBe("0s");
    expect(formatElapsedDuration(-3_600_000)).toBe("0s");
  });

});

describe("estimateOutputTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateOutputTokens(0)).toBe(0);
    expect(estimateOutputTokens(-5)).toBe(0);
  });

  it("approximates 4 chars per token (claudecode parity)", () => {
    expect(estimateOutputTokens(4)).toBe(1);
    expect(estimateOutputTokens(40)).toBe(10);
    expect(estimateOutputTokens(400)).toBe(100);
  });

  it("rounds half-up", () => {
    expect(estimateOutputTokens(6)).toBe(2);  // 1.5 → 2
    expect(estimateOutputTokens(5)).toBe(1);  // 1.25 → 1
  });
});

describe("buildSpinnerStatsText", () => {
  it("omits the token segment when no chars streamed yet", () => {
    expect(buildSpinnerStatsText(3000, 0)).toBe(" (3s)");
    expect(buildSpinnerStatsText(72_000, 0)).toBe(" (1m12s)");
  });

  it("includes the token segment once chars start arriving", () => {
    expect(buildSpinnerStatsText(3000, 40)).toBe(" (3s · ↓ 10 tokens)");
  });

  it("renders MmSs format for round in the 1-60min range", () => {
    expect(buildSpinnerStatsText(72_000, 8_000)).toBe(" (1m12s · ↓ 2.0k tokens)");
  });

  it("renders HhMmSs format for round >= 60min", () => {
    expect(buildSpinnerStatsText(3_723_000, 40_000)).toBe(" (1h2m3s · ↓ 10.0k tokens)");
  });

  it.each([
    [3_996, '999'],
    [4_000, '1.0k'],
    [4_524, '1.1k'],
    [4_800, '1.2k'],
    [40_492, '10.1k'],
    [4_400_000, '1.1M'],
  ])('formats %i streamed characters as %s tokens', (chars, expected) => {
    expect(buildSpinnerStatsText(3000, chars)).toBe(` (3s · ↓ ${expected} tokens)`);
  });

  it("leads with a space (so it concatenates after the row text cleanly)", () => {
    expect(buildSpinnerStatsText(1000, 100).startsWith(" ")).toBe(true);
  });

  it("uses the U+00B7 middle dot separator (matches claudecode)", () => {
    expect(buildSpinnerStatsText(1000, 100)).toContain("·");
  });

  it("uses ↓ (U+2193) for output direction (claudecode parity)", () => {
    expect(buildSpinnerStatsText(1000, 100)).toContain("↓");
  });
});
