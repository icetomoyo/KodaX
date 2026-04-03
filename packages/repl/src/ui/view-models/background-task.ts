export interface BackgroundTaskViewModelInput {
  isLoading: boolean;
  activeWorkerTitle?: string;
  activePhase?: string;
  parallelText?: string;
}

export interface BackgroundTaskViewModel {
  primaryText?: string;
  parallelText?: string;
}

export function buildBackgroundTaskViewModel(
  input: BackgroundTaskViewModelInput,
): BackgroundTaskViewModel {
  if (!input.isLoading) {
    return {
      parallelText: input.parallelText,
    };
  }

  if (input.activeWorkerTitle) {
    return {
      primaryText: `${input.activeWorkerTitle} active`,
      parallelText: input.parallelText,
    };
  }

  if (input.activePhase) {
    return {
      primaryText: input.activePhase,
      parallelText: input.parallelText,
    };
  }

  return {
    primaryText: "Agent active",
    parallelText: input.parallelText,
  };
}
