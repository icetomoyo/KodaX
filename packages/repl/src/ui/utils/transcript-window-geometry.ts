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
  topChromeRows: number;
}

export interface ResolveTranscriptOwnedWindowGeometryOptions {
  window: ScrollBoxWindow;
  stickyHeader?: FullscreenChromeSlotLike;
  width?: number | string;
  topChromeRows?: number;
}

export function resolveTranscriptOwnedWindowGeometry(
  options: ResolveTranscriptOwnedWindowGeometryOptions,
): TranscriptOwnedWindowGeometry {
  const stickyHeaderText = resolveFullscreenChromeSlotText(options.stickyHeader);
  const stickyHeaderRows = measureFullscreenChromeSlotRows(stickyHeaderText, options.width);
  const topChromeRows = Math.max(0, options.topChromeRows ?? 0);

  return {
    contentWindow: options.window,
    topOffsetRows: stickyHeaderRows + topChromeRows,
    stickyHeaderRows,
    topChromeRows,
  };
}
