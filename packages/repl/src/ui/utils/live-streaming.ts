import type { KodaXManagedTaskStatusEvent } from "@kodax/coding";

function formatHarnessProfileShort(harnessProfile?: string): string | undefined {
  switch (harnessProfile) {
    case "H0_DIRECT":
      return "H0";
    case "H1_EXECUTE_EVAL":
      return "H1";
    case "H2_PLAN_EXECUTE_EVAL":
      return "H2";
    default:
      return harnessProfile;
  }
}

export function mergeLiveThinkingContent(currentThinking: string, finalThinking: string): string {
  const current = currentThinking.trim();
  const finalText = finalThinking.trim();

  if (!finalText) {
    return currentThinking;
  }
  if (!current) {
    return finalThinking;
  }
  if (currentThinking === finalThinking) {
    return currentThinking;
  }
  if (finalThinking.startsWith(currentThinking)) {
    return finalThinking;
  }
  if (currentThinking.startsWith(finalThinking)) {
    return currentThinking;
  }
  return finalThinking;
}

export function formatManagedTaskBreadcrumb(
  status: KodaXManagedTaskStatusEvent,
): string | undefined {
  const harness = formatHarnessProfileShort(status.harnessProfile) ?? status.harnessProfile;
  const prefix = `${status.agentMode.toUpperCase()} ${harness}`;
  const scoutPrefix = `${status.agentMode.toUpperCase()} Scout`;
  const routingPrefix = `${status.agentMode.toUpperCase()} Routing`;
  const roundSuffix = status.currentRound && status.maxRounds && status.currentRound > 1
    ? ` - Round ${status.currentRound}/${status.maxRounds}`
    : "";

  switch (status.phase) {
    case "routing":
      return `${routingPrefix} - Routing ready`;
    case "starting":
      return status.note ? `${prefix} - ${status.note}` : `${prefix} - Managed task starting`;
    case "preflight":
      return status.note ? `${scoutPrefix} - ${status.note}` : `${scoutPrefix} - Scout preflight starting`;
    case "worker":
      return `${prefix} - ${status.activeWorkerTitle ?? "Worker"} starting${roundSuffix}`;
    case "upgrade":
      return status.note ? `${prefix} - ${status.note}` : `${prefix} - Harness transition${roundSuffix}`;
    case "completed":
      return status.note ? `${prefix} - ${status.note}` : `${prefix} - Managed task completed`;
    default:
      return undefined;
  }
}

export function formatSilentIterationToolsSummary(
  iteration: number,
  toolsUsed: string[],
  managedStatus?: Pick<KodaXManagedTaskStatusEvent, "activeWorkerTitle"> | null,
): string {
  const workerPrefix = managedStatus?.activeWorkerTitle
    ? `[${managedStatus.activeWorkerTitle}] `
    : "";
  return `${workerPrefix}Iter ${iteration} tools: ${toolsUsed.join(", ")}`;
}
