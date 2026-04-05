import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "../../ui/tui.js";
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
});
