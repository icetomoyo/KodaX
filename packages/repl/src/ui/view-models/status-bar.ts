import type { StatusBarProps } from "../types.js";
import { permissionModeDisplayName } from "../../permission/types.js";
import { resolveCompactionThresholdTokens } from "../../common/compaction-display.js";

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
      return "medium";
    case "quick":
      return "low";
    case "deep":
      return "high";
    case "off":
      return "off";
    default:
      return mode.toLowerCase();
  }
}

function formatEffortShort(effort?: string): string | undefined {
  if (!effort) {
    return undefined;
  }
  return effort === "none" ? "off" : effort;
}

function getReasoningColor(label: string): string {
  const parts = label.split("->");
  const configured = parts[0] ?? label;
  const effective = parts.length > 1 ? parts[parts.length - 1]! : configured;
  // The effective tier is the wire truth. When a configured tier folds to 'off'
  // (e.g. `minimal->off` on a toggle/budget model that can't honor it), colour
  // by that truth — a dimmed segment signals thinking is actually off, not the
  // cyan/magenta that would imply it is still active.
  if (effective === "off") {
    return "dim";
  }
  switch (configured) {
    case "off":
      return "dim";
    case "low":
      return "green";
    case "medium":
      return "yellow";
    case "high":
    case "xhigh":
    case "max":
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
  reservedResponseTokens?: number,
  triggerTokens?: number,
): string {
  if (contextWindow === 0) {
    return "green";
  }
  const compactionThreshold = resolveCompactionThresholdTokens(
    contextWindow,
    triggerPercent,
    reservedResponseTokens,
    triggerTokens,
  );
  if (currentTokens >= compactionThreshold) {
    return "red";
  }
  if (currentTokens >= compactionThreshold * (2 / 3)) {
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
    case "auto":
    case "auto-in-project":
      return "warning";
    case "full-access":
      return "red";
    default:
      return "magenta";
  }
}

/**
 * Compose the permission-mode segment text. Mode names render Title-Case
 * short labels (`Plan` / `Edits` / `Auto`) sourced from
 * `permissionModeDisplayName` — same helper the readline status bar uses
 * so the two surfaces never drift on capitalization. The compatibility alias
 * folds into the canonical Auto label at this display boundary.
 */
function buildPermissionModeText(
  permissionMode: StatusBarProps["permissionMode"],
): string {
  const display = permissionModeDisplayName(permissionMode);
  const isAutoFamily =
    permissionMode === "auto" || permissionMode === "auto-in-project";
  return isAutoFamily ? `${display}[LLM]` : display;
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
  managedIdleWaiting,
  managedIdleWaitingPendingCount,
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
  | "managedIdleWaiting"
  | "managedIdleWaitingPendingCount"
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
    // f23a7cb1 follow-up — V1 set workerTitle="Scout"; V2 (FEATURE_114
    // Slice 7) sets workerTitle="Worker". Original code wrapped the
    // title in `Scout - {title}` which stamped a stale "Scout -" prefix
    // onto V2 sessions where workerTitle already IS the entry role.
    // managedWorkerTitle is the authoritative entry-agent label for the
    // current chain — use it directly; fall back to "Scout" only when
    // the preflight ran without setting a title.
    const phaseLabel = managedWorkerTitle ?? "Scout";
    if (runningToolsLabel) {
      return `${phaseLabel} - ${runningToolsLabel}`;
    }
    if (currentTool) {
      return `${phaseLabel} - ${formatToolStatus(currentTool, toolInputCharCount, toolInputContent)}`;
    }
    if (isThinkingActive) {
      return formatThinkingStatus(phaseLabel, thinkingCharCount);
    }
    return phaseLabel;
  }

  if (managedPhase === "verifying") {
    return "Verifying";
  }

  if (managedHarnessProfile) {
    const roleLabel = managedWorkerTitle ?? "Worker";
    // v0.7.38 FEATURE_156 — idle-wait visual indicator. Distinct from
    // `currentTool` / `isThinkingActive`: the agent is alive but
    // suspended pending external wake, so the spinner is justified but
    // there's no tool / thinking to surface. Without this branch the
    // status bar falls through to the bare role label and the user has
    // no signal about what the spinner is waiting on. Tool / thinking
    // override idle-waiting because once the agent resumes the next
    // role-emit clears `managedIdleWaiting` and the running tool /
    // thinking state becomes the truth.
    if (
      managedIdleWaiting === true
      && !runningToolsLabel
      && !currentTool
      && !isThinkingActive
    ) {
      const count = managedIdleWaitingPendingCount ?? 0;
      const phrase = count > 1
        ? `waiting for ${count} children`
        : count === 1
          ? "waiting for 1 child"
          : "idle - resuming";
      return `${roleLabel} - ${phrase}`;
    }
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
    provider,
    model,
    tokenUsage,
    currentTool,
    activeToolCount,
    thinking,
    isThinkingActive,
    thinkingCharCount,
    reasoningMode = thinking ? "auto" : "off",
    effort,
    reasoningEffortLabel,
    isCompacting,
    toolInputCharCount,
    toolInputContent,
    currentIteration,
    maxIter,
    contextUsage,
    learning,
    showBusyStatus = true,
    managedPhase,
    managedHarnessProfile,
    managedWorkerTitle,
    managedRound,
    managedMaxRounds,
    managedGlobalWorkBudget,
    managedBudgetUsage,
    managedIdleWaiting,
    managedIdleWaitingPendingCount,
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
      text: buildPermissionModeText(permissionMode),
      color: getPermissionModeColor(permissionMode),
    },
  ];

  const reasoningText = reasoningEffortLabel
    ?? formatEffortShort(effort)
    ?? formatReasoningModeShort(reasoningMode);
  segments.push({
    id: "reasoning-mode",
    text: reasoningText,
    color: getReasoningColor(reasoningText),
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
        managedIdleWaiting,
        managedIdleWaitingPendingCount,
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
        contextUsage.reservedResponseTokens,
        contextUsage.triggerTokens,
      ),
    });
  }

  if (learning && (learning.ready > 0 || learning.newlyActive > 0 || learning.attention > 0)) {
    const parts = [
      ...(learning.ready > 0 ? [`${learning.ready}R`] : []),
      ...(learning.newlyActive > 0 ? [`${learning.newlyActive}N`] : []),
      ...(learning.attention > 0 ? [`${learning.attention}!`] : []),
    ];
    segments.push({
      id: "learning",
      text: `Learn:${parts.join("/")}`,
      color: learning.attention > 0 || learning.ready > 0 ? "yellow" : "cyan",
      tone: learning.attention > 0 || learning.ready > 0 ? "warning" : "accent",
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
