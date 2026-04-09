import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "../../ui/tui.js";
import { ScrollBox, type ScrollBoxHandle } from "./ScrollBox.js";

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
});
