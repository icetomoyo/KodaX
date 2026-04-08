import { calculateVisualLayout } from "../../ui/utils/textUtils.js";

export interface FullscreenChromeSlotLike {
  visible?: boolean;
  label?: string;
  hint?: string;
}

export const DEFAULT_FULLSCREEN_LAYOUT_WIDTH = 80;

export function resolveFullscreenChromeSlotText(
  slot: FullscreenChromeSlotLike | undefined,
): string | undefined {
  if (!slot?.visible || !slot.label) {
    return undefined;
  }

  return slot.hint ? `${slot.label}: ${slot.hint}` : slot.label;
}

export function measureFullscreenChromeSlotRows(
  slotText: string | undefined,
  width: number | string | undefined,
): number {
  if (!slotText) {
    return 0;
  }

  const availableWidth = Math.max(
    1,
    (typeof width === "number" ? width : DEFAULT_FULLSCREEN_LAYOUT_WIDTH) - 2,
  );
  return Math.max(
    1,
    calculateVisualLayout(slotText.split("\n"), availableWidth, 0, 0).visualLines.length,
  );
}
