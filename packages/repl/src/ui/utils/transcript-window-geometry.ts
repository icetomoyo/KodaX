import type { ScrollBoxWindow } from "../../tui/components/ScrollBox.js";
import {
  measureFullscreenChromeSlotRows,
  resolveFullscreenChromeSlotText,
  type FullscreenChromeSlotLike,
} from "../../tui/components/fullscreen-layout-utils.js";

export interface TranscriptOwnedWindowGeometry {
  contentWindow: ScrollBoxWindow;
  topOffsetRows: number;
  stickyHeaderRows: number;
  bannerVisibleRows: number;
}

export interface ResolveTranscriptOwnedWindowGeometryOptions {
  window: ScrollBoxWindow;
  stickyHeader?: FullscreenChromeSlotLike;
  width?: number | string;
  bannerVisible?: boolean;
  fullscreenBannerRows?: number;
  contentOffsetRows?: number;
}

export function resolveTranscriptOwnedWindowGeometry(
  options: ResolveTranscriptOwnedWindowGeometryOptions,
): TranscriptOwnedWindowGeometry {
  const stickyHeaderText = resolveFullscreenChromeSlotText(options.stickyHeader);
  const stickyHeaderRows = measureFullscreenChromeSlotRows(stickyHeaderText, options.width);
  const fullscreenBannerRows = Math.max(0, options.fullscreenBannerRows ?? 0);
  const contentOffsetRows = Math.max(0, options.contentOffsetRows ?? 0);
  const bannerVisibleRows = options.bannerVisible ? fullscreenBannerRows : 0;

  return {
    contentWindow: {
      ...options.window,
      start: Math.max(0, options.window.start - contentOffsetRows),
      end: Math.max(0, options.window.end - contentOffsetRows),
      viewportTop: Math.max(0, options.window.viewportTop - contentOffsetRows),
      viewportHeight: Math.max(0, options.window.viewportHeight - bannerVisibleRows),
    },
    topOffsetRows: stickyHeaderRows + bannerVisibleRows,
    stickyHeaderRows,
    bannerVisibleRows,
  };
}
