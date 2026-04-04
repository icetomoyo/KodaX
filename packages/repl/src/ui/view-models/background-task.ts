import type { BackgroundTaskBarItem } from "../components/BackgroundTaskBar.js";

export interface BackgroundTaskViewModelInput {
  isLoading: boolean;
  activeWorkerTitle?: string;
  activePhase?: string;
  parallelText?: string;
}

export interface BackgroundTaskViewModel {
  items: BackgroundTaskBarItem[];
  overflowLabel?: string;
  ctaHint?: string;
}

export function buildBackgroundTaskViewModel(
  input: BackgroundTaskViewModelInput,
): BackgroundTaskViewModel {
  const items: BackgroundTaskBarItem[] = [];

  if (input.isLoading) {
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
      ctaHint: input.parallelText ? "PgUp history" : undefined,
    };
  }

  return {
    items: visibleItems,
    overflowLabel: rest.length > 0 ? `+${rest.length} more` : undefined,
    ctaHint: input.parallelText ? "PgUp history" : undefined,
  };
}
