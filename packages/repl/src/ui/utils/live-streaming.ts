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

function trimRepeatedWorkerPrefix(note: string | undefined, workerTitle?: string): string | undefined {
  if (!note) {
    return undefined;
  }
  if (!workerTitle) {
    return note;
  }

  return note.replace(
    new RegExp(`^${workerTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[-: ]*`, "i"),
    "",
  ).trim();
}

export function formatManagedTaskLiveStatusLabel(
  status: KodaXManagedTaskStatusEvent,
): string | undefined {
  const harness = formatHarnessProfileShort(status.harnessProfile) ?? status.harnessProfile;
  const trimmedNote = trimRepeatedWorkerPrefix(status.note, status.activeWorkerTitle);

  if (status.activeWorkerTitle) {
    if (status.phase === "preflight") {
      return trimmedNote ? `[Scout] ${trimmedNote}` : "[Phase] Scout preflight";
    }
    if (status.phase === "routing") {
      return trimmedNote ? `[Routing] ${trimmedNote}` : "[Routing]";
    }
    const prefix = `[Phase] ${status.agentMode.toUpperCase()} ${harness}${status.activeWorkerTitle ? ` - ${status.activeWorkerTitle}` : ""}`;
    return trimmedNote ? `${prefix} - ${trimmedNote}` : prefix;
  }

  if (status.phase === "routing" && trimmedNote) {
    return `[Routing] ${trimmedNote}`;
  }

  if (status.phase === "round" && trimmedNote) {
    return `[Round] ${trimmedNote}`;
  }

  if (status.phase === "preflight") {
    return "[Phase] Scout preflight";
  }

  return undefined;
}

export function formatManagedTaskBreadcrumb(
  status: KodaXManagedTaskStatusEvent,
  options?: { expanded?: boolean },
): string | undefined {
  const note = options?.expanded ? (status.detailNote ?? status.note) : status.note;
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
      return note ? `${prefix} - ${note}` : `${prefix} - Managed task starting`;
    case "preflight":
      return note ? `${scoutPrefix} - ${note}` : `${scoutPrefix} - Scout preflight starting`;
    case "round":
      return note ? `${prefix} - ${note}` : `${prefix} - Managed task round update${roundSuffix}`;
    case "worker":
      return note
        ? `${prefix} - ${note}${roundSuffix}`
        : `${prefix} - ${status.activeWorkerTitle ?? "Worker"} starting${roundSuffix}`;
    case "upgrade":
      return note ? `${prefix} - ${note}` : `${prefix} - Harness transition${roundSuffix}`;
    case "completed":
      return note ? `${prefix} - ${note}` : `${prefix} - Managed task completed`;
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
