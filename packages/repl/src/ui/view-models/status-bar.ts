import type { StatusBarProps } from "../types.js";

const ITERATION_SYMBOL = "\u{1F504}";
const BAR_FILLED = "\u2588";
const BAR_EMPTY = "\u2592";
const TOKEN_ARROW = "\u2192";
const INLINE_SEPARATOR = " \u00B7 ";

export interface StatusBarSegment {
  id: string;
  text: string;
  color?: string;
  tone?: "primary" | "accent" | "success" | "warning" | "error" | "dim";
  bold?: boolean;
}

export interface StatusBarViewModel {
  text: string;
  segments: StatusBarSegment[];
}

function formatReasoningModeShort(mode: string): string {
  switch (mode) {
    case "auto":
      return "auto";
    case "balanced":
      return "balanced";
    case "quick":
      return "quick";
    case "deep":
      return "deep";
    case "off":
      return "off";
    default:
      return mode.toLowerCase();
  }
}

function formatReasoningCapabilityShort(capability?: string): string {
  switch (capability) {
    case "budget":
    case "B":
      return "B";
    case "effort":
    case "E":
      return "E";
    case "toggle":
    case "T":
      return "T";
    case "prompt":
    case "-":
      return "-";
    case "unknown":
    case "?":
      return "?";
    default:
      return capability ?? "";
  }
}

function getReasoningColor(mode: string): string {
  switch (mode) {
    case "off":
      return "dim";
    case "quick":
      return "green";
    case "balanced":
      return "yellow";
    case "deep":
      return "magenta";
    case "auto":
    default:
      return "cyan";
  }
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

function createMiniProgressBar(percent: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(percent / 10)));
  const empty = 10 - filled;
  return `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(empty)}`;
}

function getContextColor(
  currentTokens: number,
  contextWindow: number,
  triggerPercent: number,
): string {
  if (contextWindow === 0) {
    return "green";
  }
  const percent = (currentTokens / contextWindow) * 100;
  const warningThreshold = triggerPercent * (2 / 3);
  if (percent >= triggerPercent) {
    return "red";
  }
  if (percent >= warningThreshold) {
    return "yellow";
  }
  return "green";
}

function getPermissionModeColor(permissionMode: StatusBarProps["permissionMode"]): string {
  switch (permissionMode.toLowerCase()) {
    case "plan":
      return "blue";
    case "accept-edits":
      return "green";
    case "auto-in-project":
      return "warning";
    default:
      return "magenta";
  }
}

function formatToolAction(currentTool: string): string {
  const name = currentTool.toLowerCase();
  if (
    name.includes("read")
    || name.includes("view")
    || name.includes("search")
    || name.includes("list")
    || name.includes("find")
    || name.includes("browser")
    || name.includes("get")
  ) {
    return "Read";
  }
  if (
    name.includes("write")
    || name.includes("replace")
    || name.includes("edit")
    || name.includes("modify")
  ) {
    return "Edit";
  }
  if (name.includes("command") || name.includes("bash") || name.includes("terminal")) {
    return "Bash";
  }
  if (
    name.includes("ask")
    || name.includes("notify")
    || name.includes("user")
    || name.includes("question")
  ) {
    return "Ask";
  }
  if (name.includes("think") || name.includes("reason")) {
    return "Think";
  }
  return currentTool;
}

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

function formatThinkingStatus(label: string, thinkingCharCount?: number): string {
  return thinkingCharCount && thinkingCharCount > 0
    ? `${label} (${thinkingCharCount} chars)`
    : label;
}

function formatToolStatus(
  currentTool: string,
  toolInputCharCount?: number,
  toolInputContent?: string,
): string {
  const action = formatToolAction(currentTool);
  if (toolInputContent) {
    return `${action} (${toolInputContent}...)`;
  }
  if (toolInputCharCount && toolInputCharCount > 0) {
    return `${action} (${toolInputCharCount} chars)`;
  }
  return action;
}

export function buildBusyStatusText({
  activeToolCount,
  currentTool,
  isThinkingActive,
  thinkingCharCount,
  isCompacting,
  toolInputCharCount,
  toolInputContent,
  managedPhase,
  managedHarnessProfile,
  managedWorkerTitle,
}: Pick<
  StatusBarProps,
  | "activeToolCount"
  | "currentTool"
  | "isThinkingActive"
  | "thinkingCharCount"
  | "isCompacting"
  | "toolInputCharCount"
  | "toolInputContent"
  | "managedPhase"
  | "managedHarnessProfile"
  | "managedWorkerTitle"
>): string | undefined {
  const runningToolsLabel = activeToolCount && activeToolCount > 0
    ? `${activeToolCount} tool${activeToolCount === 1 ? "" : "s"} running`
    : undefined;

  if (isCompacting) {
    return "Compacting";
  }

  if (managedPhase === "routing") {
    if (runningToolsLabel) {
      return `Routing - ${runningToolsLabel}`;
    }
    if (currentTool) {
      return `Routing - ${formatToolStatus(currentTool, toolInputCharCount, toolInputContent)}`;
    }
    if (isThinkingActive) {
      return formatThinkingStatus("Routing", thinkingCharCount);
    }
    return "Routing";
  }

  if (managedPhase === "preflight") {
    const scoutLabel = managedWorkerTitle && managedWorkerTitle !== "Scout"
      ? `Scout - ${managedWorkerTitle}`
      : "Scout";
    if (runningToolsLabel) {
      return `${scoutLabel} - ${runningToolsLabel}`;
    }
    if (currentTool) {
      return `${scoutLabel} - ${formatToolStatus(currentTool, toolInputCharCount, toolInputContent)}`;
    }
    if (isThinkingActive) {
      return formatThinkingStatus(scoutLabel, thinkingCharCount);
    }
    return scoutLabel;
  }

  if (managedHarnessProfile) {
    const harness = formatHarnessProfileShort(managedHarnessProfile);
    const roleLabel = `${harness}${managedWorkerTitle ? ` - ${managedWorkerTitle}` : ""}`;
    if (runningToolsLabel) {
      return `${roleLabel} - ${runningToolsLabel}`;
    }
    if (currentTool) {
      return `${roleLabel} - ${formatToolStatus(currentTool, toolInputCharCount, toolInputContent)}`;
    }
    if (isThinkingActive) {
      return formatThinkingStatus(roleLabel, thinkingCharCount);
    }
    return roleLabel;
  }

  if (runningToolsLabel) {
    return runningToolsLabel;
  }
  if (currentTool) {
    return formatToolStatus(currentTool, toolInputCharCount, toolInputContent);
  }
  if (isThinkingActive) {
    return formatThinkingStatus("Thinking", thinkingCharCount);
  }
  return undefined;
}

function resolveIterationSegments({
  agentMode,
  managedPhase,
  managedHarnessProfile,
  managedRound,
  managedMaxRounds,
  managedGlobalWorkBudget,
  managedBudgetUsage,
  currentIteration,
  maxIter,
}: Pick<
  StatusBarProps,
  | "agentMode"
  | "managedPhase"
  | "managedHarnessProfile"
  | "managedRound"
  | "managedMaxRounds"
  | "managedGlobalWorkBudget"
  | "managedBudgetUsage"
  | "currentIteration"
  | "maxIter"
>): Array<{ label: "Round" | "Work" | "Iter"; current: number; max: number }> {
  const segments: Array<{ label: "Round" | "Work" | "Iter"; current: number; max: number }> = [];

  if (managedPhase === "routing" || managedPhase === "preflight") {
    return segments;
  }

  if (managedHarnessProfile && managedRound && managedMaxRounds && managedRound > 1) {
    segments.push({
      label: "Round",
      current: managedRound,
      max: managedMaxRounds,
    });
  }

  if (managedHarnessProfile && managedGlobalWorkBudget && typeof managedBudgetUsage === "number") {
    segments.push({
      label: "Work",
      current: managedBudgetUsage,
      max: managedGlobalWorkBudget,
    });
  } else if (agentMode === "sa" && currentIteration && maxIter) {
    segments.push({
      label: "Iter",
      current: currentIteration,
      max: maxIter,
    });
  }

  return segments;
}

function formatLabeledIterationStatus(
  segments: Array<{ label: "Round" | "Work" | "Iter"; current: number; max: number }>,
): string | undefined {
  if (segments.length === 0) {
    return undefined;
  }
  return `${ITERATION_SYMBOL} ${segments
    .map((segment) => `${segment.label} ${segment.current}/${segment.max}`)
    .join(INLINE_SEPARATOR)}`;
}

function buildStatusBarSegments(props: StatusBarProps): StatusBarSegment[] {
  const {
    sessionId,
    permissionMode,
    agentMode,
    parallel = false,
    provider,
    model,
    tokenUsage,
    currentTool,
    activeToolCount,
    thinking,
    isThinkingActive,
    thinkingCharCount,
    reasoningMode = thinking ? "auto" : "off",
    reasoningCapability,
    isCompacting,
    toolInputCharCount,
    toolInputContent,
    currentIteration,
    maxIter,
    contextUsage,
    showBusyStatus = true,
    managedPhase,
    managedHarnessProfile,
    managedWorkerTitle,
    managedRound,
    managedMaxRounds,
    managedGlobalWorkBudget,
    managedBudgetUsage,
  } = props;

  const segments: StatusBarSegment[] = [
    {
      id: "agent-mode",
      text: `KodaX - ${agentMode.toUpperCase()}`,
      color: "primary",
      bold: true,
    },
    {
      id: "permission-mode",
      text: permissionMode.toUpperCase(),
      color: getPermissionModeColor(permissionMode),
    },
    {
      id: "execution-mode",
      text: parallel ? "parallel" : "sequential",
      color: parallel ? "green" : "gray",
    },
  ];

  const rModeShort = formatReasoningModeShort(reasoningMode);
  const rCapShort = formatReasoningCapabilityShort(reasoningCapability);
  segments.push({
    id: "reasoning-mode",
    text: reasoningCapability ? `${rModeShort}/${rCapShort}` : rModeShort,
    color: getReasoningColor(reasoningMode),
  });

  const iterationSegments = resolveIterationSegments({
    agentMode,
    managedPhase,
    managedHarnessProfile,
    managedRound,
    managedMaxRounds,
    managedGlobalWorkBudget,
    managedBudgetUsage,
    currentIteration,
    maxIter,
  });
  const iterationStatus = formatLabeledIterationStatus(iterationSegments);
  if (iterationStatus) {
    const ratio = Math.max(...iterationSegments.map((segment) => segment.current / segment.max));
    let color = "green";
    if (ratio >= 0.8) {
      color = "red";
    } else if (ratio >= 0.5) {
      color = "yellow";
    }
    segments.push({
      id: "iteration-status",
      text: iterationStatus,
      color,
    });
  }

  segments.push({
    id: "session-id",
    text: sessionId,
    color: "dim",
  });

  const busyStatus = showBusyStatus
    ? buildBusyStatusText({
        activeToolCount,
        currentTool,
        isThinkingActive,
        thinkingCharCount,
        isCompacting,
        toolInputCharCount,
        toolInputContent,
        managedPhase,
        managedHarnessProfile,
        managedWorkerTitle,
      })
    : undefined;

  if (busyStatus) {
    segments.push({
      id: "busy-status",
      text: busyStatus,
      color: "dim",
    });
  }

  segments.push({
    id: "provider-model",
    text: `${provider}/${model}`,
    color: "secondary",
  });

  if (contextUsage && contextUsage.contextWindow !== 0) {
    const percent = Math.round((contextUsage.currentTokens / contextUsage.contextWindow) * 100);
    const currentStr = formatTokenCount(contextUsage.currentTokens);
    const windowStr = formatTokenCount(contextUsage.contextWindow);
    const progressBar = createMiniProgressBar(percent);
    segments.push({
      id: "context-usage",
      text: `${currentStr}/${windowStr} ${progressBar} ${percent}%`,
      color: getContextColor(
        contextUsage.currentTokens,
        contextUsage.contextWindow,
        contextUsage.triggerPercent,
      ),
    });
  }

  if (tokenUsage) {
    segments.push({
      id: "token-usage",
      text: `${tokenUsage.input}${TOKEN_ARROW}${tokenUsage.output} (${tokenUsage.total})`,
      color: "dim",
    });
  }

  return segments;
}

export function getStatusBarText(props: StatusBarProps): string {
  return buildStatusBarSegments(props).map((segment) => segment.text).join(" | ");
}

export function buildStatusBarViewModel(
  props: StatusBarProps,
): StatusBarViewModel {
  const segments = buildStatusBarSegments(props);
  return {
    text: segments.map((segment) => segment.text).join(" | "),
    segments,
  };
}
