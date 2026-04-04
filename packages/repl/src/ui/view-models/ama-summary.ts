import type {
  KodaXAgentMode,
  KodaXManagedTaskStatusEvent,
} from "@kodax/coding";
import { formatAmaWorkStripText } from "../components/AmaWorkStrip.js";
import {
  buildBackgroundTaskViewModel,
  type BackgroundTaskViewModel,
} from "./background-task.js";

type ManagedAmaSummaryStatus = Pick<
  KodaXManagedTaskStatusEvent,
  "agentMode" | "childFanoutClass" | "childFanoutCount" | "activeWorkerTitle" | "phase"
>;

export interface AmaSummaryViewModel {
  workStripText?: string;
  backgroundTask: BackgroundTaskViewModel;
}

export function buildAmaWorkStripFromStatus(
  status: Pick<
    KodaXManagedTaskStatusEvent,
    "agentMode" | "childFanoutClass" | "childFanoutCount"
  > | null | undefined,
  isLoading: boolean,
): string | undefined {
  if (!isLoading || !status || status.agentMode !== "ama") {
    return undefined;
  }

  return formatAmaWorkStripText(
    status.childFanoutClass,
    status.childFanoutCount,
  );
}

export function buildAmaSummaryViewModel(options: {
  status: ManagedAmaSummaryStatus | null | undefined;
  isLoading: boolean;
  agentMode: KodaXAgentMode;
  parallelTextOverride?: string;
}): AmaSummaryViewModel {
  const workStripText = buildAmaWorkStripFromStatus(
    options.status,
    options.isLoading,
  );

  return {
    workStripText,
    backgroundTask: buildBackgroundTaskViewModel({
      isLoading: options.isLoading,
      activeWorkerTitle: options.status?.activeWorkerTitle,
      activePhase:
        options.status?.phase
        ?? (options.agentMode === "ama" ? "AMA active" : "Working"),
      parallelText: options.parallelTextOverride ?? workStripText,
    }),
  };
}
