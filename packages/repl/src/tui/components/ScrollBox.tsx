import React, {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useCallback,
  useState,
} from "react";
// FEATURE_093 (v0.7.24): import Box directly from renderer-runtime to
// avoid the `tui/index.ts ↔ components/ScrollBox.tsx` barrel cycle.
import { Box } from "../renderer-runtime.js";
import { computeOverscanWindow, staysWithinOverscanBlock } from "../../ui/utils/overscan-window.js";
import { scheduleRenderFromNode } from "./scroll-render-trigger.js";
import type { RenderableNode } from "./scroll-render-trigger.js";

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
  /**
   * FEATURE_214 (v0.7.46) — when overscan is active, [start, end) is the larger
   * OVERSCAN BLOCK and this is how far down within it the viewport sits (feeds
   * the renderer's `inWindowScrollTop` so the block translates without React).
   * 0 when overscan is off (the window == the viewport).
   */
  inWindowScrollTop: number;
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
  /**
   * FEATURE_214 (v0.7.46) — rows of overscan margin to render above+below the
   * viewport. When > 0 (and `renderWindow` is provided) the box renders an
   * overscan block and exposes the in-block offset for React-bypass scrolling.
   * Undefined/0 = the pre-FEATURE_214 behaviour (window == viewport).
   */
  overscanRows?: number;
}

interface ScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  pendingDelta: number;
  clampMin?: number;
  clampMax?: number;
  sticky: boolean;
  /** FEATURE_214: rows of overscan margin (0/undefined = no overscan). */
  overscanRows?: number;
}

interface ScrollBoxDomNode extends RenderableNode {
  scrollTop?: number;
  scrollHeight?: number;
  scrollViewportHeight?: number;
  scrollViewportTop?: number;
  attributes?: {
    inWindowScrollTop?: number;
    pendingScrollDelta?: number;
  };
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
    && left.sticky === right.sticky
    && left.overscanRows === right.overscanRows;
}

function areWindowsEqual(left: ScrollBoxWindow, right: ScrollBoxWindow): boolean {
  return left.start === right.start
    && left.end === right.end
    && left.scrollTop === right.scrollTop
    && left.scrollHeight === right.scrollHeight
    && left.viewportHeight === right.viewportHeight
    && left.viewportTop === right.viewportTop
    && left.pendingDelta === right.pendingDelta
    && left.sticky === right.sticky
    && left.inWindowScrollTop === right.inWindowScrollTop;
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

  const overscanRows = Math.max(0, Math.floor(snapshot.overscanRows ?? 0));
  if (overscanRows > 0 && viewportHeight > 0) {
    // FEATURE_214 (v0.7.46) — render an OVERSCAN BLOCK around the viewport and
    // translate within it (`inWindowScrollTop`) so a scroll within the block
    // can repaint via the renderer without a React re-window. `start..end` is
    // now the block; `viewportTop` stays the REAL viewport top (rows-from-top)
    // so hit-testing/selection are unaffected.
    const block = computeOverscanWindow({
      globalScrollTop: start,
      viewportHeight,
      contentHeight: snapshot.scrollHeight,
      overscan: overscanRows,
    });
    return {
      start: block.blockTop,
      end: block.blockTop + block.blockHeight,
      scrollTop: clampedOffset,
      scrollHeight: snapshot.scrollHeight,
      viewportHeight,
      viewportTop: start,
      pendingDelta: snapshot.pendingDelta,
      sticky: snapshot.sticky,
      inWindowScrollTop: block.inBlockOffset,
    };
  }

  return {
    start,
    end,
    scrollTop: clampedOffset,
    scrollHeight: snapshot.scrollHeight,
    viewportHeight,
    viewportTop: start,
    pendingDelta: snapshot.pendingDelta,
    sticky: snapshot.sticky,
    inWindowScrollTop: 0,
  };
}

interface ScrollBoxGeometryProps {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  stickyScroll: boolean;
  overscanRows?: number;
}

function sameGeometryProps(left: ScrollBoxGeometryProps, right: ScrollBoxGeometryProps): boolean {
  return left.scrollTop === right.scrollTop
    && left.scrollHeight === right.scrollHeight
    && left.viewportHeight === right.viewportHeight
    && left.stickyScroll === right.stickyScroll
    && left.overscanRows === right.overscanRows;
}

// The snapshot a geometry prop change commits. Imperative clamp bounds survive;
// a prop-driven move resets the pending delta.
function snapshotFromProps(previous: ScrollSnapshot, props: ScrollBoxGeometryProps): ScrollSnapshot {
  return {
    scrollTop: props.scrollTop,
    scrollHeight: props.scrollHeight,
    viewportHeight: props.viewportHeight,
    pendingDelta: 0,
    clampMin: previous.clampMin,
    clampMax: previous.clampMax,
    sticky: props.stickyScroll,
    overscanRows: props.overscanRows,
  };
}

function resolveNativeScrollTop(snapshot: ScrollSnapshot): number {
  const clampedOffset = clampScrollTop(snapshot, snapshot.scrollTop);
  return Math.max(0, snapshot.scrollHeight - snapshot.viewportHeight - clampedOffset);
}

export const ScrollBox: React.FC<ScrollBoxProps> = ({
  children,
  width,
  flexGrow = 0,
  flexShrink = 1,
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
  overscanRows,
}) => {
  const domRef = useRef<ScrollBoxDomNode | null>(null);
  const listenersRef = useRef(new Set<() => void>());
  const snapshotRef = useRef<ScrollSnapshot>(normalizeScrollSnapshot({
    scrollTop,
    scrollHeight,
    viewportHeight,
    pendingDelta: 0,
    sticky: stickyScroll,
    overscanRows,
  }));
  const [windowState, setWindowState] = useState<ScrollBoxWindow>(
    () => resolveScrollWindow(snapshotRef.current),
  );
  const geometryProps: ScrollBoxGeometryProps = { scrollTop, scrollHeight, viewportHeight, stickyScroll, overscanRows };
  // Geometry props reach the snapshot in an effect after this render commits.
  // Track what was committed so the render can use the incoming geometry now.
  const committedPropsRef = useRef<ScrollBoxGeometryProps>(geometryProps);
  // FEATURE_214 (v0.7.46) — live, un-committed offset during a React-bypass scroll
  // burst (null = no active bypass; the committed snapshot is authoritative). The
  // render reads it via `effectiveSnapshot` so a stray React re-render can't revert
  // a bypassed scroll, and a later commit folds it back into the snapshot.
  const bypassOffsetRef = useRef<number | null>(null);

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

  // FEATURE_214 (v0.7.46) — attempt a React-bypass scroll. When overscan is on and
  // the move stays inside the current overscan block, translate within the block by
  // mutating the node fields render-node reads (scrollTop = rawScrollTop, then
  // attributes.inWindowScrollTop) and repainting the existing subtree via the
  // engine — no React re-window, and the moved appliedScrollTop makes the DECSTBM
  // hint fire. Returns true when handled; false → the caller commits (re-window via
  // React), which also covers the no-engine host (tests) where the repaint is a
  // no-op. The branch decision uses the unit-gated overscan-window math.
  const tryBypassScroll = useCallback((dy: number): boolean => {
    const snap = snapshotRef.current;
    const overscanRows = Math.max(0, Math.floor(snap.overscanRows ?? 0));
    const node = domRef.current;
    if (overscanRows <= 0 || !node || snap.viewportHeight <= 0) {
      return false;
    }
    const maxOffset = Math.max(0, snap.scrollHeight - snap.viewportHeight);
    const curOffset = bypassOffsetRef.current ?? clampScrollTop(snap, snap.scrollTop);
    const newOffset = Math.max(0, Math.min(Math.floor(curOffset + dy), maxOffset));
    const appliedDelta = newOffset - curOffset;
    if (newOffset === curOffset) {
      return true; // clamped at an edge — swallow the tick, no re-render needed
    }
    // offset (rows-from-bottom) → global viewport top (rows-from-top)
    const curGlobalTop = Math.max(0, snap.scrollHeight - snap.viewportHeight - curOffset);
    const newGlobalTop = Math.max(0, snap.scrollHeight - snap.viewportHeight - newOffset);
    const overscanInput = {
      viewportHeight: snap.viewportHeight,
      contentHeight: snap.scrollHeight,
      overscan: overscanRows,
    };
    if (!staysWithinOverscanBlock(curGlobalTop, newGlobalTop, overscanInput)) {
      return false; // crossed a quantum bin → caller commits a fresh block (React)
    }
    const block = computeOverscanWindow({ ...overscanInput, globalScrollTop: newGlobalTop });
    // Drive the exact fields render-node reads. NOTE: node.scrollTop here is the
    // GLOBAL viewport top (rows-from-top) — render-node's rawScrollTop convention —
    // intentionally bypassing the attributes-layer rows-from-bottom nativeScrollTop;
    // render-node owns node.scrollTop from first paint, so this is the live source.
    node.scrollTop = newGlobalTop;
    if (node.attributes) {
      node.attributes.inWindowScrollTop = block.inBlockOffset;
      node.attributes.pendingScrollDelta = appliedDelta;
    }
    if (!scheduleRenderFromNode(node)) {
      return false; // no engine root (tests/teardown) → fall back to a React commit
    }
    bypassOffsetRef.current = newOffset;
    if (snap.sticky) {
      // Flip sticky synchronously in the ref (not just via onStickyChange, which is
      // async) so isSticky() + the "new content arrives → snap to bottom" decision
      // don't yank the user back while they're scrolled up mid-bypass.
      snapshotRef.current = { ...snapshotRef.current, sticky: false };
      onStickyChange?.(false);
    }
    notify();
    return true;
  }, [notify, onStickyChange]);

  // FEATURE_214 (v0.7.46) — after a React commit in overscan mode, drive
  // node.scrollTop to the committed global top. render-node owns node.scrollTop
  // once it has written it (the scrollTop prop maps to attributes.scrollTop, which
  // it ignores thereafter), so without this the viewportTop/DECSTBM hint would lag
  // the freshly-mounted block. No-op when overscan is off (the pre-FEATURE_214 path).
  const syncOverscanNodeTop = useCallback((committedWindow: ScrollBoxWindow) => {
    const node = domRef.current;
    if (node && snapshotRef.current.overscanRows) {
      node.scrollTop = committedWindow.viewportTop;
    }
  }, []);

  useEffect(() => {
    const next = snapshotFromProps(snapshotRef.current, {
      scrollTop, scrollHeight, viewportHeight, stickyScroll, overscanRows,
    });
    committedPropsRef.current = { scrollTop, scrollHeight, viewportHeight, stickyScroll, overscanRows };

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
    overscanRows,
    scrollHeight,
    scrollTop,
    stickyScroll,
    viewportHeight,
  ]);

  const syncSnapshotFromDom = useCallback(() => {
    const host = domRef.current;
    if (!host) {
      return;
    }
    // FEATURE_214: this is a committing path (it reads the renderer's geometry
    // back into the snapshot), so clear any in-flight bypass burst — like every
    // other commit path (scrollTo/scrollToBottom/scrollToElement/setClampBounds).
    // Otherwise a DOM readback mid-bypass leaves bypassOffsetRef stale vs the
    // freshly committed scrollTop and the next bypass computes from a wrong base.
    // No-op when overscan is off (bypassOffsetRef is always null then).
    bypassOffsetRef.current = null;

    const nextScrollHeight = typeof host.scrollHeight === "number"
      ? Math.max(0, Math.floor(host.scrollHeight))
      : undefined;
    const nextViewportHeight = typeof host.scrollViewportHeight === "number"
      ? Math.max(0, Math.floor(host.scrollViewportHeight))
      : undefined;
    const nextViewportTop = typeof host.scrollViewportTop === "number"
      ? Math.max(0, Math.floor(host.scrollViewportTop))
      : undefined;

    if (
      nextScrollHeight === undefined
      || nextViewportHeight === undefined
      || nextViewportTop === undefined
    ) {
      return;
    }

    const derivedScrollTop = Math.max(
      0,
      nextScrollHeight - nextViewportHeight - nextViewportTop,
    );

    const result = commitSnapshot({
      ...snapshotRef.current,
      scrollTop: derivedScrollTop,
      scrollHeight: nextScrollHeight,
      viewportHeight: nextViewportHeight,
    });

    if (result.changed && result.window.scrollTop !== result.previous.scrollTop) {
      onScrollTopChange?.(result.window.scrollTop);
    }
  }, [commitSnapshot, onScrollTopChange]);

  useEffect(() => {
    syncSnapshotFromDom();
  }, [syncSnapshotFromDom]);

  const handle = useMemo<ScrollBoxHandle>(() => ({
    scrollTo(y: number) {
      bypassOffsetRef.current = null;
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: y,
        pendingDelta: 0,
        sticky: false,
      });
      if (result.previous.sticky !== false) {
        onStickyChange?.(false);
      }
      syncOverscanNodeTop(result.window);
      onScrollTopChange?.(result.window.scrollTop);
    },
    scrollBy(dy: number) {
      if (tryBypassScroll(dy)) {
        return;
      }
      // Slow path (overscan off, or the move crossed a quantum bin): commit a new
      // window through React. Base off the live bypassed offset if a burst was in
      // flight, then clear it.
      const base = bypassOffsetRef.current ?? snapshotRef.current.scrollTop;
      bypassOffsetRef.current = null;
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: base + dy,
        pendingDelta: snapshotRef.current.pendingDelta + Math.floor(dy),
        sticky: false,
      });
      if (result.previous.sticky !== false) {
        onStickyChange?.(false);
      }
      syncOverscanNodeTop(result.window);
      onScrollTopChange?.(result.window.scrollTop);
    },
    scrollToElement(y: number, offset = 0) {
      bypassOffsetRef.current = null;
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: y - offset,
        pendingDelta: 0,
        sticky: false,
      });
      if (result.previous.sticky !== false) {
        onStickyChange?.(false);
      }
      syncOverscanNodeTop(result.window);
      onScrollTopChange?.(result.window.scrollTop);
    },
    scrollToBottom() {
      bypassOffsetRef.current = null;
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: 0,
        pendingDelta: 0,
        sticky: true,
      });
      syncOverscanNodeTop(result.window);
      onScrollTopChange?.(result.window.scrollTop);
      if (result.previous.sticky !== true) {
        onStickyChange?.(true);
      }
    },
    getScrollTop() {
      // Live offset: surface the in-flight bypass position so consumers (jump-to-
      // latest, search anchor) see where the user actually is between commits.
      return bypassOffsetRef.current ?? snapshotRef.current.scrollTop;
    },
    getPendingDelta() {
      return snapshotRef.current.pendingDelta;
    },
    getScrollHeight() {
      return domRef.current?.scrollHeight ?? snapshotRef.current.scrollHeight;
    },
    getViewportHeight() {
      return domRef.current?.scrollViewportHeight ?? windowState.viewportHeight;
    },
    getViewportTop() {
      return domRef.current?.scrollViewportTop ?? windowState.viewportTop;
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
      bypassOffsetRef.current = null;
      const result = commitSnapshot({
        ...snapshotRef.current,
        clampMin: min,
        clampMax: max,
      });
      syncOverscanNodeTop(result.window);
      if (result.window.scrollTop !== result.previous.scrollTop) {
        onScrollTopChange?.(result.window.scrollTop);
      }
    },
  }), [commitSnapshot, onScrollTopChange, onStickyChange, tryBypassScroll, syncOverscanNodeTop]);

  useImperativeHandle(scrollRef, () => handle, [handle]);

  useEffect(() => {
    onWindowChange?.(windowState);
  }, [onWindowChange, windowState]);

  useEffect(() => {
    if (snapshotRef.current.pendingDelta !== 0) {
      snapshotRef.current = { ...snapshotRef.current, pendingDelta: 0 };
    }
  }, [windowState]);

  // FEATURE_214: during a React-bypass burst render from the LIVE offset, so a
  // stray React re-render reflects the bypassed scroll instead of reverting it.
  // Safe in Ink's synchronous renderer (no concurrent tearing). null = no burst →
  // the committed snapshot/window is authoritative (pre-FEATURE_214 behaviour).
  const bypassActive = bypassOffsetRef.current !== null;
  // A render with new geometry must paint the window that geometry implies.
  // The committed window still describes the previous content: when sticky
  // content grows, it would hide the newest rows for one frame and then jump.
  const geometryPending = !sameGeometryProps(committedPropsRef.current, geometryProps);
  const baseSnapshot = geometryPending
    ? normalizeScrollSnapshot(snapshotFromProps(snapshotRef.current, geometryProps))
    : snapshotRef.current;
  const effectiveSnapshot = bypassActive
    ? { ...baseSnapshot, scrollTop: bypassOffsetRef.current as number }
    : baseSnapshot;
  const renderedWindow = bypassActive || geometryPending ? resolveScrollWindow(effectiveSnapshot) : windowState;
  const content = renderWindow ? renderWindow(renderedWindow) : children;

  const totalViewportHeight = Math.max(0, viewportHeight + paddingTop);
  const nativeScrollTop = resolveNativeScrollTop(effectiveSnapshot);
  return React.createElement(
    "ink-box",
    {
      ref: domRef,
      style: {
        flexWrap: "nowrap",
        flexDirection: "row",
        flexGrow,
        flexShrink,
        width,
        height: totalViewportHeight,
        paddingTop,
        overflowX: "visible",
        overflowY: "scroll",
      },
      scrollTop: nativeScrollTop,
      scrollHeight: baseSnapshot.scrollHeight,
      scrollViewportHeight: baseSnapshot.viewportHeight,
      scrollViewportTop: renderedWindow.viewportTop,
      pendingScrollDelta: baseSnapshot.pendingDelta,
      virtualScrollWindowed: Boolean(renderWindow),
      // FEATURE_214: only emit inWindowScrollTop in overscan mode. Setting it
      // (even 0) flips the renderer onto the overscan path, so gating on
      // `overscanRows` keeps the pre-FEATURE_214 windowed path (incl. the
      // FEATURE_212 streaming-shift DECSTBM) byte-identical when overscan is off.
      ...(baseSnapshot.overscanRows ? { inWindowScrollTop: renderedWindow.inWindowScrollTop } : {}),
      ...(baseSnapshot.clampMin !== undefined ? { scrollClampMin: baseSnapshot.clampMin } : {}),
      ...(baseSnapshot.clampMax !== undefined ? { scrollClampMax: baseSnapshot.clampMax } : {}),
      ...(stickyScroll ? { stickyScroll: true } : {}),
    },
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={0}
      width="100%"
    >
      {content}
    </Box>,
  );
};
