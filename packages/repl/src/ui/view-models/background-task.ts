import type { BackgroundTaskBarItem } from "../components/BackgroundTaskBar.js";
import { formatLiveToolLabel } from "../utils/tool-display.js";

export interface BackgroundTaskViewModelInput {
  isLoading: boolean;
  activeWorkerTitle?: string;
  activePhase?: string;
  parallelText?: string;
  currentTool?: string;
  toolInputCharCount?: number;
  toolInputContent?: string;
  liveActivityLabel?: string;
  isThinkingActive?: boolean;
}

export interface BackgroundTaskViewModel {
  items: BackgroundTaskBarItem[];
  overflowLabel?: string;
  ctaHint?: string;
}

function stripLiveActivityPrefix(label: string): string {
  return label.replace(/^\[[^\]]+\]\s*/, "").trim();
}

export function buildBackgroundTaskViewModel(
  input: BackgroundTaskViewModelInput,
): BackgroundTaskViewModel {
  const items: BackgroundTaskBarItem[] = [];

  if (input.isLoading) {
    const liveToolLabel = input.currentTool
      ? stripLiveActivityPrefix(
        formatLiveToolLabel(
          input.currentTool,
          input.toolInputContent ?? "",
          input.toolInputCharCount ?? 0,
        ),
      )
      : undefined;
    const liveActivityLabel = input.liveActivityLabel
      ? stripLiveActivityPrefix(input.liveActivityLabel)
      : undefined;

    if (input.activeWorkerTitle) {
      items.push({
        id: "primary-worker",
        label: `${input.activeWorkerTitle} active`,
        accent: true,
        selected: true,
      });
    } else if (input.activePhase) {
      items.push({
        id: "primary-phase",
        label: input.activePhase,
        accent: true,
        selected: true,
      });
    } else if (liveActivityLabel) {
      items.push({
        id: "primary-live-activity",
        label: liveActivityLabel,
        accent: true,
        selected: true,
      });
    } else if (liveToolLabel) {
      items.push({
        id: "primary-tool",
        label: liveToolLabel,
        accent: true,
        selected: true,
      });
    } else if (input.isThinkingActive) {
      items.push({
        id: "primary-thinking",
        label: "Thinking",
        accent: true,
        selected: true,
      });
    } else {
      items.push({
        id: "primary-generic",
        label: "Agent active",
        accent: true,
        selected: true,
      });
    }
  }

  if (input.parallelText) {
    items.push({
      id: "parallel",
      label: input.parallelText,
    });
  }

  const [visibleOne, visibleTwo, visibleThree, ...rest] = items;
  const visibleItems = [visibleOne, visibleTwo, visibleThree].filter(
    (item): item is BackgroundTaskBarItem => Boolean(item),
  );

  if (!input.isLoading) {
    return {
      items: visibleItems,
      overflowLabel: rest.length > 0 ? `+${rest.length} more` : undefined,
      ctaHint: input.parallelText ? "Ctrl+O transcript" : undefined,
    };
  }

  return {
    items: visibleItems,
    overflowLabel: rest.length > 0 ? `+${rest.length} more` : undefined,
    ctaHint: input.parallelText ? "Ctrl+O transcript" : undefined,
  };
}
