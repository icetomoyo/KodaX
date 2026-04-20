import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  useInputHistory,
  type UseInputHistoryReturn,
  __resetInputHistoryForTesting,
} from "./useInputHistory.js";

/**
 * Regression tests for FEATURE_077 (docs/features/v0.7.21.md).
 *
 * Verifies that prompt history is session-scoped (survives PromptComposer
 * unmount+remount triggered by Ctrl+O transcript toggle in InkREPL), while
 * the navigation cursor and temp-input remain component-scoped.
 */

/** Test host that captures the hook API into a caller-provided ref. */
function HookHost({
  apiRef,
}: {
  apiRef: { current: UseInputHistoryReturn | null };
}): React.ReactElement | null {
  apiRef.current = useInputHistory();
  return null;
}

describe("useInputHistory — session-scoped history across remount", () => {
  afterEach(() => {
    __resetInputHistoryForTesting();
  });

  it("preserves history when the consuming component unmounts and remounts", () => {
    const firstRef: { current: UseInputHistoryReturn | null } = { current: null };
    const first = render(<HookHost apiRef={firstRef} />);
    firstRef.current?.add("A");
    firstRef.current?.add("B");
    first.unmount();

    // Simulates Ctrl+O-driven PromptComposer unmount+remount.
    const secondRef: { current: UseInputHistoryReturn | null } = { current: null };
    const second = render(<HookHost apiRef={secondRef} />);

    expect(secondRef.current?.navigateUp()?.text).toBe("B");
    expect(secondRef.current?.navigateUp()?.text).toBe("A");
    second.unmount();
  });

  it("resets navigation cursor on remount (index is component-scoped)", () => {
    const firstRef: { current: UseInputHistoryReturn | null } = { current: null };
    const first = render(<HookHost apiRef={firstRef} />);
    firstRef.current?.add("A");
    firstRef.current?.add("B");
    // Move nav cursor away from -1 before unmount.
    expect(firstRef.current?.navigateUp()?.text).toBe("B");
    first.unmount();

    // On remount, the fresh useRef starts at -1, so the next Up should
    // return the most recent entry again (not skip to "A").
    const secondRef: { current: UseInputHistoryReturn | null } = { current: null };
    const second = render(<HookHost apiRef={secondRef} />);
    expect(secondRef.current?.navigateUp()?.text).toBe("B");
    second.unmount();
  });

  it("__resetInputHistoryForTesting clears the module store", () => {
    const apiRef: { current: UseInputHistoryReturn | null } = { current: null };
    const harness = render(<HookHost apiRef={apiRef} />);
    apiRef.current?.add("A");
    __resetInputHistoryForTesting();
    expect(apiRef.current?.navigateUp()).toBeNull();
    harness.unmount();
  });

  it("carries pastedContents snapshot on history entries (Issue 121)", () => {
    const apiRef: { current: UseInputHistoryReturn | null } = { current: null };
    const harness = render(<HookHost apiRef={apiRef} />);
    apiRef.current?.add("prompt with placeholder", {
      pastedContents: [{ id: 1, type: "text", content: "hidden content" }],
    });
    const entry = apiRef.current?.navigateUp();
    expect(entry?.text).toBe("prompt with placeholder");
    expect(entry?.pastedContents).toEqual([
      { id: 1, type: "text", content: "hidden content" },
    ]);
    harness.unmount();
  });
});
