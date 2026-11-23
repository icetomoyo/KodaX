import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "../../ui/tui.js";
import { ScrollBox, type ScrollBoxHandle } from "./ScrollBox.js";
import { scheduleRenderFromNode } from "./scroll-render-trigger.js";

// FEATURE_214 (v0.7.46) — the React-bypass repaint is an engine-only side effect
// ink-testing-library can't run faithfully, so mock it. Default true = "engine
// present, bypass available"; tests flip it to exercise both branches. The pure
// bypass MATH is gated separately in overscan-window.test.ts / scroll-state.test.ts.
vi.mock("./scroll-render-trigger.js", () => ({
  scheduleRenderFromNode: vi.fn(() => true),
}));
const mockScheduleRender = vi.mocked(scheduleRenderFromNode);

const ScrollBoxHarness = React.forwardRef<ScrollBoxHandle>((_, ref) => {
  const [scrollTop, setScrollTop] = useState(0);
  const [sticky, setSticky] = useState(true);

  return (
    <ScrollBox
      scrollRef={ref}
      scrollTop={scrollTop}
      scrollHeight={120}
      viewportHeight={20}
      stickyScroll={sticky}
      onScrollTopChange={setScrollTop}
      onStickyChange={setSticky}
    >
      <Text>Transcript</Text>
    </ScrollBox>
  );
});

ScrollBoxHarness.displayName = "ScrollBoxHarness";

describe("ScrollBox", () => {
  it("updates scroll offset through the imperative handle", () => {
    const ref = React.createRef<ScrollBoxHandle>();
    render(<ScrollBoxHarness ref={ref} />);

    ref.current?.scrollBy(8);
    expect(ref.current?.getScrollTop()).toBe(8);
    expect(ref.current?.isSticky()).toBe(false);

    ref.current?.scrollToBottom();
    expect(ref.current?.getScrollTop()).toBe(0);
    expect(ref.current?.isSticky()).toBe(true);
  });

  it("notifies subscribers when scroll state changes", () => {
    const ref = React.createRef<ScrollBoxHandle>();
    render(<ScrollBoxHarness ref={ref} />);
    const listener = vi.fn();
    const unsubscribe = ref.current?.subscribe(listener);

    ref.current?.scrollTo(12);
    ref.current?.scrollBy(2);

    expect(listener).toHaveBeenCalled();
    unsubscribe?.();
  });

  it("computes the visible window inside the renderer boundary", () => {
    const { lastFrame } = render(
      <ScrollBox
        scrollTop={10}
        scrollHeight={120}
        viewportHeight={20}
        renderWindow={(window) => (
          <Text>{`window:${window.start}-${window.end}`}</Text>
        )}
      >
        <Text>ignored</Text>
      </ScrollBox>,
    );

    expect(lastFrame()).toContain("window:90-110");
  });

  it("preserves the full logical scroll height for renderer-owned windows", async () => {
    const ref = React.createRef<ScrollBoxHandle>();
    render(
      <ScrollBox
        scrollRef={ref}
        scrollTop={10}
        scrollHeight={120}
        viewportHeight={20}
        renderWindow={() => <Text>Visible row only</Text>}
      >
        <Text>ignored</Text>
      </ScrollBox>,
    );

    await vi.waitFor(() => {
      expect(ref.current?.getScrollHeight()).toBe(120);
      expect(ref.current?.getViewportTop()).toBe(90);
    });
  });

  it("notifies sticky changes when the controlled sticky flag flips", async () => {
    const onStickyChange = vi.fn();

    const StickyHarness: React.FC = () => {
      const [sticky, setSticky] = useState(true);

      React.useEffect(() => {
        setSticky(false);
      }, []);

      return (
        <ScrollBox
          scrollTop={0}
          scrollHeight={120}
          viewportHeight={20}
          stickyScroll={sticky}
          onStickyChange={onStickyChange}
        >
          <Text>Transcript</Text>
        </ScrollBox>
      );
    };

    render(<StickyHarness />);

    await vi.waitFor(() => {
      expect(onStickyChange).toHaveBeenCalledWith(false);
    });
  });

  it("renders grown content with the bottom window in the same frame", () => {
    // A sticky transcript that grows must not paint the previous window over
    // the new rows: that frame hides the newest rows, then the next commit
    // jumps the history up (streaming jitter above the spinner).
    const windows: string[] = [];
    const renderBox = (scrollHeight: number) => (
      <ScrollBox
        scrollTop={0}
        scrollHeight={scrollHeight}
        viewportHeight={20}
        renderWindow={(window) => {
          windows.push(`${window.start}-${window.end}`);
          return <Text>{`window:${window.start}-${window.end}`}</Text>;
        }}
      >
        <Text>ignored</Text>
      </ScrollBox>
    );
    const { rerender, lastFrame } = render(renderBox(50));
    windows.length = 0;

    rerender(renderBox(53));

    expect(windows).not.toContain("30-50");
    expect(windows[0]).toBe("33-53");
    expect(lastFrame()).toContain("window:33-53");
  });

  it("applies clamp bounds to the rendered window immediately", async () => {
    const ref = React.createRef<ScrollBoxHandle>();
    const { lastFrame } = render(
      <ScrollBox
        scrollRef={ref}
        scrollTop={10}
        scrollHeight={120}
        viewportHeight={20}
        renderWindow={(window) => (
          <Text>{`window:${window.start}-${window.end}`}</Text>
        )}
      >
        <Text>ignored</Text>
      </ScrollBox>,
    );

    expect(lastFrame()).toContain("window:90-110");

    ref.current?.setClampBounds(undefined, 5);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("window:95-115");
    });
  });

  it("keeps a footer sibling tight when the fullscreen host provides explicit growth", () => {
    const { lastFrame } = render(
      <Box flexDirection="column">
        <ScrollBox
          flexGrow={1}
          scrollTop={0}
          scrollHeight={2}
          viewportHeight={2}
          renderWindow={() => (
            <>
              <Text>Row 1</Text>
              <Text>Row 2</Text>
            </>
          )}
        >
          <Text>ignored</Text>
        </ScrollBox>
        <Text>FOOTER</Text>
      </Box>,
    );

    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    const rowIndex = lines.findIndex((line) => line.includes("Row 2"));
    const footerIndex = lines.findIndex((line) => line.includes("FOOTER"));

    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(footerIndex).toBeGreaterThanOrEqual(rowIndex + 1);
    expect(footerIndex).toBeLessThanOrEqual(rowIndex + 2);
  });

  // FEATURE_214 (v0.7.46) — scroll→window contract the React-bypass refactor
  // (Phase A.3/B: imperative scrollBy + SCROLL_QUANTUM-quantized React commit)
  // MUST preserve. The refactor changes HOW OFTEN renderWindow is called, never
  // the FINAL window for a given resting scroll position. These pin that
  // invariant: same logical scrollTop ⇒ same {start, end, scrollTop}, and a
  // coalesced multi-step scroll lands identically to one direct scroll.
  describe("FEATURE_214 scroll→window contract", () => {
    function renderWindowed() {
      const ref = React.createRef<ScrollBoxHandle>();
      const utils = render(
        <ScrollBox
          scrollRef={ref}
          scrollTop={0}
          scrollHeight={120}
          viewportHeight={20}
          renderWindow={(w) => <Text>{`w:${w.start}-${w.end}@${w.scrollTop}`}</Text>}
        >
          <Text>ignored</Text>
        </ScrollBox>,
      );
      return { ref, ...utils };
    }

    it("maps a scroll position to a deterministic window", async () => {
      const { ref, lastFrame } = renderWindowed();
      ref.current?.scrollTo(30);
      expect(ref.current?.getScrollTop()).toBe(30); // snapshot is synchronous
      await vi.waitFor(() => expect(lastFrame()).toContain("w:70-90@30"));
    });

    it("clamps at the oldest content (cannot over-scroll up)", async () => {
      const { ref, lastFrame } = renderWindowed();
      ref.current?.scrollTo(1000); // past max = scrollHeight - viewportHeight = 100
      expect(ref.current?.getScrollTop()).toBe(100);
      await vi.waitFor(() => expect(lastFrame()).toContain("w:0-20@100"));
    });

    it("scrollToBottom re-sticks to the latest window", async () => {
      const { ref, lastFrame } = renderWindowed();
      ref.current?.scrollTo(40);
      ref.current?.scrollToBottom();
      expect(ref.current?.getScrollTop()).toBe(0);
      expect(ref.current?.isSticky()).toBe(true);
      await vi.waitFor(() => expect(lastFrame()).toContain("w:100-120@0"));
    });

    it("coalescing-invariant: stepped scrollBy lands at the same window as one scrollTo", async () => {
      const stepped = renderWindowed();
      stepped.ref.current?.scrollBy(10);
      stepped.ref.current?.scrollBy(10);
      stepped.ref.current?.scrollBy(5);

      const direct = renderWindowed();
      direct.ref.current?.scrollTo(25);

      expect(stepped.ref.current?.getScrollTop()).toBe(direct.ref.current?.getScrollTop());
      await vi.waitFor(() => expect(stepped.lastFrame()).toContain("w:75-95@25"));
      await vi.waitFor(() => expect(direct.lastFrame()).toContain("w:75-95@25"));
    });
  });

  // FEATURE_214 (v0.7.46) — overscan window capability (Phase A). OFF unless
  // `overscanRows` is passed, so every existing ScrollBox + the pre-overscan
  // transcript path stays byte-identical (the contract tests above stay green).
  // ink-testing-library ignores the renderer's inWindowScrollTop translation, so
  // these assert the WINDOW resolveScrollWindow hands to renderWindow — the exact
  // data the overscan/React-bypass refactor depends on.
  describe("FEATURE_214 overscan window capability", () => {
    it("renders an overscan block around the viewport and exposes the in-block offset", () => {
      const { lastFrame } = render(
        <ScrollBox
          scrollTop={500}
          scrollHeight={1000}
          viewportHeight={20}
          overscanRows={80}
          renderWindow={(w) => (
            <Text>{`blk:${w.start}-${w.end}|vt:${w.viewportTop}|in:${w.inWindowScrollTop}`}</Text>
          )}
        >
          <Text>ignored</Text>
        </ScrollBox>,
      );
      // viewport top = 1000 - 500 - 20 = 480 (bin 12, anchor 480) → block [400, 580);
      // the REAL viewport top stays 480 (hit-test), in-block offset = 80.
      expect(lastFrame()).toContain("blk:400-580|vt:480|in:80");
    });

    it("is inert without overscanRows (window == viewport, in-block 0)", () => {
      const { lastFrame } = render(
        <ScrollBox
          scrollTop={500}
          scrollHeight={1000}
          viewportHeight={20}
          renderWindow={(w) => (
            <Text>{`blk:${w.start}-${w.end}|in:${w.inWindowScrollTop}`}</Text>
          )}
        >
          <Text>ignored</Text>
        </ScrollBox>,
      );
      expect(lastFrame()).toContain("blk:480-500|in:0");
    });

    it("scrolls within a bin via the React-bypass path (no re-window commit)", () => {
      mockScheduleRender.mockClear();
      mockScheduleRender.mockReturnValue(true); // engine present → bypass available
      const ref = React.createRef<ScrollBoxHandle>();
      const onScrollTopChange = vi.fn();
      render(
        <ScrollBox
          scrollRef={ref}
          scrollTop={500}
          scrollHeight={1000}
          viewportHeight={20}
          overscanRows={80}
          onScrollTopChange={onScrollTopChange}
          renderWindow={(w) => <Text>{`blk:${w.start}-${w.end}|in:${w.inWindowScrollTop}`}</Text>}
        >
          <Text>ignored</Text>
        </ScrollBox>,
      );
      onScrollTopChange.mockClear();
      // scroll toward newer 20 rows: viewport top 480 → 500, still bin 12 ([480,520)).
      ref.current?.scrollBy(-20);
      expect(mockScheduleRender).toHaveBeenCalled();        // repainted via the engine
      expect(onScrollTopChange).not.toHaveBeenCalled();      // NO React re-window
      expect(ref.current?.getScrollTop()).toBe(480);         // live (un-committed) offset
      expect(ref.current?.isSticky()).toBe(false);           // sticky flipped synchronously
    });

    it("crossing a quantum boundary falls back to a React re-window commit", async () => {
      mockScheduleRender.mockClear();
      mockScheduleRender.mockReturnValue(true);
      const ref = React.createRef<ScrollBoxHandle>();
      const onScrollTopChange = vi.fn();
      const { lastFrame } = render(
        <ScrollBox
          scrollRef={ref}
          scrollTop={500}
          scrollHeight={1000}
          viewportHeight={20}
          overscanRows={80}
          onScrollTopChange={onScrollTopChange}
          renderWindow={(w) => <Text>{`blk:${w.start}-${w.end}`}</Text>}
        >
          <Text>ignored</Text>
        </ScrollBox>,
      );
      onScrollTopChange.mockClear();
      // scroll toward older 80 rows: viewport top 480 → 400 (bin 10) — crosses the
      // bin, so the bypass declines and the slow path commits the new block.
      ref.current?.scrollBy(80);
      expect(onScrollTopChange).toHaveBeenCalled();          // re-window committed
      await vi.waitFor(() => expect(lastFrame()).toContain("blk:320-500"));
    });

    it("falls back to a React commit when no engine root is present (no bypass)", () => {
      mockScheduleRender.mockClear();
      mockScheduleRender.mockReturnValue(false); // e.g. teardown / non-engine host
      const ref = React.createRef<ScrollBoxHandle>();
      const onScrollTopChange = vi.fn();
      render(
        <ScrollBox
          scrollRef={ref}
          scrollTop={500}
          scrollHeight={1000}
          viewportHeight={20}
          overscanRows={80}
          onScrollTopChange={onScrollTopChange}
          renderWindow={(w) => <Text>{`blk:${w.start}-${w.end}|in:${w.inWindowScrollTop}`}</Text>}
        >
          <Text>ignored</Text>
        </ScrollBox>,
      );
      onScrollTopChange.mockClear();
      // same in-bin move, but the bypass repaint is unavailable → commit instead.
      ref.current?.scrollBy(-20);
      expect(onScrollTopChange).toHaveBeenCalled();          // committed (graceful fallback)
      expect(ref.current?.getScrollTop()).toBe(480);
    });
  });
});
