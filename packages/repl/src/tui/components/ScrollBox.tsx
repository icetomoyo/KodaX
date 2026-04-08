import React, {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useCallback,
  useState,
} from "react";
import { Box } from "../index.js";

export interface ScrollBoxHandle {
  scrollTo: (y: number) => void;
  scrollBy: (dy: number) => void;
  scrollToElement: (y: number, offset?: number) => void;
  scrollToBottom: () => void;
  getScrollTop: () => number;
  getPendingDelta: () => number;
  getScrollHeight: () => number;
  getViewportHeight: () => number;
  getViewportTop: () => number;
  isSticky: () => boolean;
  subscribe: (listener: () => void) => () => void;
  setClampBounds: (min: number | undefined, max: number | undefined) => void;
}

export interface ScrollBoxWindow {
  start: number;
  end: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  viewportTop: number;
  pendingDelta: number;
  sticky: boolean;
}

export interface ScrollBoxProps {
  children: React.ReactNode;
  width?: number | string;
  flexGrow?: number;
  flexShrink?: number;
  paddingTop?: number;
  scrollTop?: number;
  scrollHeight?: number;
  viewportHeight?: number;
  stickyScroll?: boolean;
  scrollRef?: React.Ref<ScrollBoxHandle>;
  onScrollTopChange?: (nextScrollTop: number) => void;
  onStickyChange?: (sticky: boolean) => void;
  onWindowChange?: (window: ScrollBoxWindow) => void;
  renderWindow?: (window: ScrollBoxWindow) => React.ReactNode;
}

interface ScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  pendingDelta: number;
  clampMin?: number;
  clampMax?: number;
  sticky: boolean;
}

function normalizeScrollSnapshot(snapshot: ScrollSnapshot): ScrollSnapshot {
  const normalized: ScrollSnapshot = {
    ...snapshot,
    scrollHeight: Math.max(0, Math.floor(snapshot.scrollHeight)),
    viewportHeight: Math.max(0, Math.floor(snapshot.viewportHeight)),
    pendingDelta: Math.floor(snapshot.pendingDelta),
  };

  return {
    ...normalized,
    scrollTop: clampScrollTop(normalized, normalized.scrollTop),
  };
}

function areSnapshotsEqual(left: ScrollSnapshot, right: ScrollSnapshot): boolean {
  return left.scrollTop === right.scrollTop
    && left.scrollHeight === right.scrollHeight
    && left.viewportHeight === right.viewportHeight
    && left.pendingDelta === right.pendingDelta
    && left.clampMin === right.clampMin
    && left.clampMax === right.clampMax
    && left.sticky === right.sticky;
}

function areWindowsEqual(left: ScrollBoxWindow, right: ScrollBoxWindow): boolean {
  return left.start === right.start
    && left.end === right.end
    && left.scrollTop === right.scrollTop
    && left.scrollHeight === right.scrollHeight
    && left.viewportHeight === right.viewportHeight
    && left.viewportTop === right.viewportTop
    && left.pendingDelta === right.pendingDelta
    && left.sticky === right.sticky;
}

function clampScrollTop(snapshot: ScrollSnapshot, nextScrollTop: number): number {
  const viewportMax = Math.max(0, snapshot.scrollHeight - snapshot.viewportHeight);
  const clampMin = snapshot.clampMin ?? 0;
  const clampMax = snapshot.clampMax ?? viewportMax;
  return Math.max(clampMin, Math.min(Math.floor(nextScrollTop), Math.min(viewportMax, clampMax)));
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
    viewportTop: start,
    pendingDelta: snapshot.pendingDelta,
    sticky: snapshot.sticky,
  };
}

export const ScrollBox: React.FC<ScrollBoxProps> = ({
  children,
  width,
  flexGrow = 1,
  flexShrink = 0,
  paddingTop = 0,
  scrollTop = 0,
  scrollHeight = 0,
  viewportHeight = 0,
  stickyScroll = true,
  scrollRef,
  onScrollTopChange,
  onStickyChange,
  onWindowChange,
  renderWindow,
}) => {
  const listenersRef = useRef(new Set<() => void>());
  const snapshotRef = useRef<ScrollSnapshot>(normalizeScrollSnapshot({
    scrollTop,
    scrollHeight,
    viewportHeight,
    pendingDelta: 0,
    sticky: stickyScroll,
  }));
  const [windowState, setWindowState] = useState<ScrollBoxWindow>(
    () => resolveScrollWindow(snapshotRef.current),
  );

  const notify = useCallback(() => {
    for (const listener of listenersRef.current) {
      listener();
    }
  }, []);

  const commitSnapshot = useCallback((
    nextSnapshot: ScrollSnapshot,
    notifyListeners = true,
  ) => {
    const previous = snapshotRef.current;
    const normalized = normalizeScrollSnapshot(nextSnapshot);
    const nextWindow = resolveScrollWindow(normalized);

    snapshotRef.current = normalized;
    setWindowState((previousWindow) => (
      areWindowsEqual(previousWindow, nextWindow)
        ? previousWindow
        : nextWindow
    ));

    if (notifyListeners && !areSnapshotsEqual(previous, normalized)) {
      notify();
    }

    return {
      previous,
      snapshot: normalized,
      window: nextWindow,
      changed: !areSnapshotsEqual(previous, normalized),
    };
  }, [notify]);

  useEffect(() => {
    const previous = snapshotRef.current;
    const next: ScrollSnapshot = {
      scrollTop,
      scrollHeight,
      viewportHeight,
      pendingDelta:
        previous.scrollTop !== scrollTop
          ? 0
          : previous.pendingDelta,
      clampMin: previous.clampMin,
      clampMax: previous.clampMax,
      sticky: stickyScroll,
    };

    const result = commitSnapshot(next);
    if (result.previous.sticky !== stickyScroll) {
      onStickyChange?.(stickyScroll);
    }
    if (result.window.scrollTop !== scrollTop) {
      onScrollTopChange?.(result.window.scrollTop);
    }
  }, [
    commitSnapshot,
    onStickyChange,
    onScrollTopChange,
    scrollHeight,
    scrollTop,
    stickyScroll,
    viewportHeight,
  ]);

  const handle = useMemo<ScrollBoxHandle>(() => ({
    scrollTo(y: number) {
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: y,
        pendingDelta: 0,
        sticky: false,
      });
      if (result.previous.sticky !== false) {
        onStickyChange?.(false);
      }
      onScrollTopChange?.(result.window.scrollTop);
    },
    scrollBy(dy: number) {
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: snapshotRef.current.scrollTop + dy,
        pendingDelta: snapshotRef.current.pendingDelta + Math.floor(dy),
        sticky: false,
      });
      if (result.previous.sticky !== false) {
        onStickyChange?.(false);
      }
      onScrollTopChange?.(result.window.scrollTop);
    },
    scrollToElement(y: number, offset = 0) {
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: y - offset,
        pendingDelta: 0,
        sticky: false,
      });
      if (result.previous.sticky !== false) {
        onStickyChange?.(false);
      }
      onScrollTopChange?.(result.window.scrollTop);
    },
    scrollToBottom() {
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: 0,
        pendingDelta: 0,
        sticky: true,
      });
      onScrollTopChange?.(result.window.scrollTop);
      if (result.previous.sticky !== true) {
        onStickyChange?.(true);
      }
    },
    getScrollTop() {
      return snapshotRef.current.scrollTop;
    },
    getPendingDelta() {
      return snapshotRef.current.pendingDelta;
    },
    getScrollHeight() {
      return snapshotRef.current.scrollHeight;
    },
    getViewportHeight() {
      return snapshotRef.current.viewportHeight;
    },
    getViewportTop() {
      return resolveScrollWindow(snapshotRef.current).viewportTop;
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
    setClampBounds(min: number | undefined, max: number | undefined) {
      const result = commitSnapshot({
        ...snapshotRef.current,
        clampMin: min,
        clampMax: max,
      });
      if (result.window.scrollTop !== result.previous.scrollTop) {
        onScrollTopChange?.(result.window.scrollTop);
      }
    },
  }), [commitSnapshot, onScrollTopChange, onStickyChange]);

  useImperativeHandle(scrollRef, () => handle, [handle]);

  useEffect(() => {
    onWindowChange?.(windowState);
  }, [onWindowChange, windowState]);

  return (
    <Box
      flexDirection="column"
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      width={width}
      paddingTop={paddingTop}
      overflowY="hidden"
    >
      {renderWindow ? renderWindow(windowState) : children}
    </Box>
  );
};
