import type { StatusBarProps } from "../types.js";

const ITERATION_SYMBOL = "\u{1F504}";
const BAR_FILLED = "\u2588";
const BAR_EMPTY = "\u2592";
const TOKEN_ARROW = "\u2192";

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

function formatBusyStatus({
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

  const legacyManagedPhase = managedPhase as StatusBarProps["managedPhase"];

  if (legacyManagedPhase === "routing") {
    if (runningToolsLabel) {
      return `Routing \u2192 ${runningToolsLabel}`;
    }
    if (currentTool) {
      return `Routing \u2192 ${formatToolStatus(currentTool, toolInputCharCount, toolInputContent)}`;
    }
    if (isThinkingActive) {
      return formatThinkingStatus("Routing", thinkingCharCount);
    }
    return "Routing";
  }

  if (legacyManagedPhase === "preflight") {
    const scoutLabel = managedWorkerTitle ? `Scout - ${managedWorkerTitle}` : "Scout";
    if (runningToolsLabel) {
      return `${scoutLabel} \u2192 ${runningToolsLabel}`;
    }
    if (currentTool) {
      return `${scoutLabel} \u2192 ${formatToolStatus(currentTool, toolInputCharCount, toolInputContent)}`;
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
      return `${roleLabel} \u2192 ${runningToolsLabel}`;
    }
    if (currentTool) {
      return `${roleLabel} · ${formatToolStatus(currentTool, toolInputCharCount, toolInputContent)}`;
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
    .join(" 路 ")}`;
}

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

export function getStatusBarText({
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
}: StatusBarProps): string {
  const parts: string[] = [];

  parts.push(`KodaX - ${agentMode.toUpperCase()}`);
  parts.push(permissionMode.toUpperCase());
  parts.push(parallel ? "parallel" : "sequential");

  const rModeShort = formatReasoningModeShort(reasoningMode);
  const rCapShort = formatReasoningCapabilityShort(reasoningCapability);
  parts.push(reasoningCapability ? `${rModeShort}/${rCapShort}` : rModeShort);

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
    parts.push(iterationStatus);
  }

  const busyStatus = showBusyStatus
    ? formatBusyStatus({
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
  parts.push(sessionId);
  if (busyStatus) {
    parts.push(busyStatus);
  }
  parts.push(`${provider}/${model}`);

  if (contextUsage && contextUsage.contextWindow !== 0) {
    const percent = Math.round((contextUsage.currentTokens / contextUsage.contextWindow) * 100);
    const currentStr = formatTokenCount(contextUsage.currentTokens);
    const windowStr = formatTokenCount(contextUsage.contextWindow);
    const progressBar = createMiniProgressBar(percent);
    parts.push(`${currentStr}/${windowStr} ${progressBar} ${percent}%`);
  }

  if (tokenUsage) {
    parts.push(`${tokenUsage.input}${TOKEN_ARROW}${tokenUsage.output} (${tokenUsage.total})`);
  }

  return parts.join(" | ");
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
