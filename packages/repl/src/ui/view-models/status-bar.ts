import type { StatusBarProps } from "../types.js";
import { getStatusBarText } from "../components/StatusBar.js";

export interface StatusBarSegment {
  id: string;
  text: string;
  tone?: "primary" | "accent" | "success" | "warning" | "error" | "dim";
  bold?: boolean;
}

export interface StatusBarViewModel {
  text: string;
  segments: StatusBarSegment[];
}

function inferSegmentTone(
  segment: string,
  index: number,
): StatusBarSegment["tone"] {
  if (index === 0) {
    return "primary";
  }
  if (/error|failed|denied/i.test(segment)) {
    return "error";
  }
  if (/warning|fallback|approve|approval/i.test(segment)) {
    return "warning";
  }
  if (/thinking|routing|scout|round|work|parallel|sequential/i.test(segment)) {
    return "accent";
  }
  if (/done|success/i.test(segment)) {
    return "success";
  }
  return "dim";
}

function buildSegmentsFromText(text: string): StatusBarSegment[] {
  return text
    .split(" | ")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment, index) => ({
      id: `segment-${index}`,
      text: segment,
      tone: inferSegmentTone(segment, index),
      bold: index === 0,
    }));
}

export function buildStatusBarViewModel(
  props: StatusBarProps,
): StatusBarViewModel {
  const text = getStatusBarText(props);
  return {
    text,
    segments: buildSegmentsFromText(text),
  };
}
