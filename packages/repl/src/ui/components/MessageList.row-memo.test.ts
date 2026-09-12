/**
 * FEATURE_172 P1.3 (v0.7.41) — TranscriptRowRenderer memo comparator unit tests.
 *
 * Pins the equality logic for `areTranscriptRowPropsEqual`. The comparator is
 * load-bearing for SSH long-session perf: it's the React-layer counterpart to
 * the P1.1 data-layer cache, skipping per-row React work when only the active
 * round's rows change per 80ms flush.
 *
 * If any of these tests fail, per-row re-render count regresses and the long-
 * session refresh stutter returns — root-cause before touching the test.
 */
import { describe, expect, it } from "vitest";
import {
  areTranscriptRowPropsEqual,
  type TranscriptRowRendererProps,
} from "./MessageList.js";

const baseTheme = { colors: { accent: "cyan", background: "black" } } as unknown as TranscriptRowRendererProps["theme"];

function makeRow(overrides: Partial<TranscriptRowRendererProps["row"]> = {}): TranscriptRowRendererProps["row"] {
  return {
    key: "row-1",
    text: "alpha",
    color: "default",
    indent: 0,
    bold: false,
    italic: false,
    spinner: false,
    ...overrides,
  };
}

function makeProps(overrides: Partial<TranscriptRowRendererProps> = {}): TranscriptRowRendererProps {
  return {
    row: makeRow(),
    theme: baseTheme,
    animateSpinners: true,
    selectedItem: false,
    selectionRange: undefined,
    ...overrides,
  };
}

describe("areTranscriptRowPropsEqual", () => {
  it('invalidates a reused summary header when its original member identities change', () => {
    const first = makeProps();
    const oldHeader = { ...first.row, itemIds: ['first', 'middle', 'last'] };
    const newHeader = { ...first.row, itemIds: ['first', 'replacement', 'last'] };
    expect(areTranscriptRowPropsEqual({ ...first, row: oldHeader }, { ...first, row: newHeader })).toBe(false);
  });
  it("returns true for same reference rows", () => {
    const props = makeProps();
    expect(areTranscriptRowPropsEqual(props, props)).toBe(true);
  });

  it("returns true for structurally equal rows (different reference)", () => {
    // The dominant case post-data-layer cache: every render creates fresh row
    // objects but their visible fields are identical for unchanged rows.
    const a = makeProps({ row: makeRow({ key: "row-1", text: "hello" }) });
    const b = makeProps({ row: makeRow({ key: "row-1", text: "hello" }) });
    expect(a.row).not.toBe(b.row);
    expect(areTranscriptRowPropsEqual(a, b)).toBe(true);
  });

  it("returns false when text differs (streaming character append)", () => {
    const a = makeProps({ row: makeRow({ text: "hel" }) });
    const b = makeProps({ row: makeRow({ text: "hell" }) });
    expect(areTranscriptRowPropsEqual(a, b)).toBe(false);
  });

  it("returns false when key differs", () => {
    const a = makeProps({ row: makeRow({ key: "row-1" }) });
    const b = makeProps({ row: makeRow({ key: "row-2" }) });
    expect(areTranscriptRowPropsEqual(a, b)).toBe(false);
  });

  it("returns false when color toggle differs", () => {
    const a = makeProps({ row: makeRow({ color: "default" }) });
    const b = makeProps({ row: makeRow({ color: "dim" }) });
    expect(areTranscriptRowPropsEqual(a, b)).toBe(false);
  });

  it("returns false when bold/italic/indent/spinner differ", () => {
    expect(areTranscriptRowPropsEqual(
      makeProps({ row: makeRow({ bold: false }) }),
      makeProps({ row: makeRow({ bold: true }) }),
    )).toBe(false);
    expect(areTranscriptRowPropsEqual(
      makeProps({ row: makeRow({ italic: false }) }),
      makeProps({ row: makeRow({ italic: true }) }),
    )).toBe(false);
    expect(areTranscriptRowPropsEqual(
      makeProps({ row: makeRow({ indent: 0 }) }),
      makeProps({ row: makeRow({ indent: 2 }) }),
    )).toBe(false);
    expect(areTranscriptRowPropsEqual(
      makeProps({ row: makeRow({ spinner: false }) }),
      makeProps({ row: makeRow({ spinner: true }) }),
    )).toBe(false);
  });

  it("returns false when itemId differs (semantic selection target)", () => {
    const a = makeProps({ row: makeRow({ itemId: "msg-1" }) });
    const b = makeProps({ row: makeRow({ itemId: "msg-2" }) });
    expect(areTranscriptRowPropsEqual(a, b)).toBe(false);
  });

  it("returns false when theme reference changes (theme switch)", () => {
    const altTheme = { colors: { accent: "magenta", background: "white" } } as unknown as TranscriptRowRendererProps["theme"];
    const a = makeProps();
    const b = makeProps({ theme: altTheme });
    expect(areTranscriptRowPropsEqual(a, b)).toBe(false);
  });

  it("returns false when animateSpinners toggles", () => {
    expect(areTranscriptRowPropsEqual(
      makeProps({ animateSpinners: true }),
      makeProps({ animateSpinners: false }),
    )).toBe(false);
  });

  it("treats animateSpinners default (undefined) as true", () => {
    expect(areTranscriptRowPropsEqual(
      makeProps({ animateSpinners: undefined }),
      makeProps({ animateSpinners: true }),
    )).toBe(true);
  });

  it("returns false when selectedItem toggles", () => {
    expect(areTranscriptRowPropsEqual(
      makeProps({ selectedItem: false }),
      makeProps({ selectedItem: true }),
    )).toBe(false);
  });

  it("treats selectedItem default (undefined) as false", () => {
    expect(areTranscriptRowPropsEqual(
      makeProps({ selectedItem: undefined }),
      makeProps({ selectedItem: false }),
    )).toBe(true);
  });

  it("returns true for both selectionRange undefined", () => {
    expect(areTranscriptRowPropsEqual(
      makeProps({ selectionRange: undefined }),
      makeProps({ selectionRange: undefined }),
    )).toBe(true);
  });

  it("returns true for structurally equal selectionRange (different reference)", () => {
    // Map.get() returns a fresh range object when selection state rebuilds —
    // structural equality is required, reference equality is not enough.
    const a = makeProps({ selectionRange: { start: 1, end: 4 } });
    const b = makeProps({ selectionRange: { start: 1, end: 4 } });
    expect(a.selectionRange).not.toBe(b.selectionRange);
    expect(areTranscriptRowPropsEqual(a, b)).toBe(true);
  });

  it("returns false when selectionRange.start differs", () => {
    expect(areTranscriptRowPropsEqual(
      makeProps({ selectionRange: { start: 1, end: 4 } }),
      makeProps({ selectionRange: { start: 2, end: 4 } }),
    )).toBe(false);
  });

  it("returns false when selectionRange.end differs", () => {
    expect(areTranscriptRowPropsEqual(
      makeProps({ selectionRange: { start: 1, end: 4 } }),
      makeProps({ selectionRange: { start: 1, end: 5 } }),
    )).toBe(false);
  });

  it("returns false when one selectionRange is undefined", () => {
    expect(areTranscriptRowPropsEqual(
      makeProps({ selectionRange: undefined }),
      makeProps({ selectionRange: { start: 0, end: 3 } }),
    )).toBe(false);
    expect(areTranscriptRowPropsEqual(
      makeProps({ selectionRange: { start: 0, end: 3 } }),
      makeProps({ selectionRange: undefined }),
    )).toBe(false);
  });
});
