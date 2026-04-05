import React, {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { Box } from "../index.js";

export interface ScrollBoxHandle {
  scrollTo: (y: number) => void;
  scrollBy: (dy: number) => void;
  scrollToBottom: () => void;
  getScrollTop: () => number;
  getScrollHeight: () => number;
  getViewportHeight: () => number;
  isSticky: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

export interface ScrollBoxWindow {
  start: number;
  end: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  sticky: boolean;
}

export interface ScrollBoxProps {
  children: React.ReactNode;
  width?: number | string;
  flexGrow?: number;
  flexShrink?: number;
  scrollTop?: number;
  scrollHeight?: number;
  viewportHeight?: number;
  stickyScroll?: boolean;
  scrollRef?: React.Ref<ScrollBoxHandle>;
  onScrollTopChange?: (nextScrollTop: number) => void;
  onStickyChange?: (sticky: boolean) => void;
  renderWindow?: (window: ScrollBoxWindow) => React.ReactNode;
}

interface ScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  sticky: boolean;
}

function clampScrollTop(snapshot: ScrollSnapshot, nextScrollTop: number): number {
  const maxScrollTop = Math.max(0, snapshot.scrollHeight - snapshot.viewportHeight);
  return Math.max(0, Math.min(Math.floor(nextScrollTop), maxScrollTop));
}

function resolveScrollWindow(snapshot: ScrollSnapshot): ScrollBoxWindow {
  const viewportHeight = Math.max(0, snapshot.viewportHeight);
  const clampedOffset = clampScrollTop(snapshot, snapshot.scrollTop);
  const end = Math.max(0, snapshot.scrollHeight - clampedOffset);
  const start = Math.max(0, end - viewportHeight);

  return {
    start,
    end,
    scrollTop: clampedOffset,
    scrollHeight: snapshot.scrollHeight,
    viewportHeight,
    sticky: snapshot.sticky,
  };
}

export const ScrollBox: React.FC<ScrollBoxProps> = ({
  children,
  width,
  flexGrow = 1,
  flexShrink = 0,
  scrollTop = 0,
  scrollHeight = 0,
  viewportHeight = 0,
  stickyScroll = true,
  scrollRef,
  onScrollTopChange,
  onStickyChange,
  renderWindow,
}) => {
  const listenersRef = useRef(new Set<() => void>());
  const snapshotRef = useRef<ScrollSnapshot>({
    scrollTop,
    scrollHeight,
    viewportHeight,
    sticky: stickyScroll,
  });

  const notify = useCallback(() => {
    for (const listener of listenersRef.current) {
      listener();
    }
  }, []);

  useEffect(() => {
    const previous = snapshotRef.current;
    const next: ScrollSnapshot = {
      scrollTop,
      scrollHeight,
      viewportHeight,
      sticky: stickyScroll,
    };
    snapshotRef.current = next;

    if (
      previous.scrollTop !== next.scrollTop
      || previous.scrollHeight !== next.scrollHeight
      || previous.viewportHeight !== next.viewportHeight
      || previous.sticky !== next.sticky
    ) {
      notify();
    }
  }, [notify, scrollHeight, scrollTop, stickyScroll, viewportHeight]);

  const handle = useMemo<ScrollBoxHandle>(() => ({
    scrollTo(y: number) {
      const nextScrollTop = clampScrollTop(snapshotRef.current, y);
      snapshotRef.current = {
        ...snapshotRef.current,
        scrollTop: nextScrollTop,
        sticky: false,
      };
      onStickyChange?.(false);
      onScrollTopChange?.(nextScrollTop);
      notify();
    },
    scrollBy(dy: number) {
      const nextScrollTop = clampScrollTop(
        snapshotRef.current,
        snapshotRef.current.scrollTop + dy,
      );
      snapshotRef.current = {
        ...snapshotRef.current,
        scrollTop: nextScrollTop,
        sticky: false,
      };
      onStickyChange?.(false);
      onScrollTopChange?.(nextScrollTop);
      notify();
    },
    scrollToBottom() {
      snapshotRef.current = {
        ...snapshotRef.current,
        scrollTop: 0,
        sticky: true,
      };
      onScrollTopChange?.(0);
      onStickyChange?.(true);
      notify();
    },
    getScrollTop() {
      return snapshotRef.current.scrollTop;
    },
    getScrollHeight() {
      return snapshotRef.current.scrollHeight;
    },
    getViewportHeight() {
      return snapshotRef.current.viewportHeight;
    },
    isSticky() {
      return snapshotRef.current.sticky;
    },
    subscribe(listener: () => void) {
      listenersRef.current.add(listener);
      return () => {
        listenersRef.current.delete(listener);
      };
    },
  }), [notify, onScrollTopChange, onStickyChange]);

  useImperativeHandle(scrollRef, () => handle, [handle]);

  const windowState = useMemo(
    () => resolveScrollWindow({
      scrollTop,
      scrollHeight,
      viewportHeight,
      sticky: stickyScroll,
    }),
    [scrollHeight, scrollTop, stickyScroll, viewportHeight],
  );

  return (
    <Box
      flexDirection="column"
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      width={width}
      overflowY="hidden"
    >
      {renderWindow ? renderWindow(windowState) : children}
    </Box>
  );
};
