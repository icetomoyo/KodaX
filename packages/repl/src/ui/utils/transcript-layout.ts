import { ToolCallStatus, type HistoryItem, type Theme, type ToolCall } from "../types.js";
import type { IterationRecord } from "../contexts/StreamingContext.js";
import { calculateVisualLayout } from "./textUtils.js";
import {
  collapseToolCalls,
  formatCollapsedToolInlineText,
  formatToolResultExplanation,
  formatLiveToolLabel,
  resolveToolExplanationTone,
} from "./tool-display.js";
import { truncateUserMessageForDisplay } from "./user-message-display.js";

export type TranscriptColorToken =
  | "primary"
  | "secondary"
  | "accent"
  | "text"
  | "dim"
  | "thinking"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "hint";

export interface TranscriptRow {
  key: string;
  text: string;
  itemId?: string;
  color?: TranscriptColorToken;
  indent?: number;
  bold?: boolean;
  italic?: boolean;
  spinner?: boolean;
}

export interface TranscriptSection {
  key: string;
  rows: TranscriptRow[];
}

export interface TranscriptBuildOptions {
  items: HistoryItem[];
  managedLiveEvents?: readonly HistoryItem[];
  viewportWidth: number;
  isLoading?: boolean;
  maxLines?: number;
  isThinking?: boolean;
  thinkingCharCount?: number;
  thinkingContent?: string;
  streamingResponse?: string;
  currentTool?: string;
  activeToolCalls?: ToolCall[];
  toolInputCharCount?: number;
  toolInputContent?: string;
  iterationHistory?: IterationRecord[];
  currentIteration?: number;
  isCompacting?: boolean;
  managedAgentMode?: string;
  managedPhase?: "starting" | "routing" | "preflight" | "round" | "worker" | "upgrade" | "completed";
  managedHarnessProfile?: string;
  managedWorkerTitle?: string;
  managedRound?: number;
  managedMaxRounds?: number;
  managedGlobalWorkBudget?: number;
  managedBudgetUsage?: number;
  managedBudgetApprovalRequired?: boolean;
  lastLiveActivityLabel?: string;
  showFullThinking?: boolean;
  showDetailedTools?: boolean;
  showAllContent?: boolean;
  showLiveProgressRows?: boolean;
  expandedItemKeys?: ReadonlySet<string>;
}

export interface TranscriptRenderModel {
  staticSections: TranscriptSection[];
  sections: TranscriptSection[];
  rows: TranscriptRow[];
  previewSections: TranscriptSection[];
  previewRows: TranscriptRow[];
}

export interface TranscriptRenderModelOptions extends TranscriptBuildOptions {
  windowed?: boolean;
}

const THINKING_PREVIEW_MAX_CHARS = 400;
const THINKING_PREVIEW_TRUNCATION_HINT =
  "... (thinking truncated; press Ctrl+O to inspect full reasoning)";

/**
 * FEATURE_060 Track 3 (v0.7.30): hard char cap per thinking block, applied
 * even when `showFullThinking`/`showAllContent` is on. Protects against
 * pathological reasoning traces (LLM stuck in a tight loop, runaway
 * verbose-mode output, malformed protocol leaking into the transcript)
 * driving the layout pass to materialize tens of MB of wrapped rows. The
 * cap is set well above any realistic single-block reasoning length so
 * normal show-all UX is unaffected; the truncation hint mirrors the
 * preview-mode hint and points at the same `Ctrl+O` inspection affordance.
 */
export const THINKING_SHOW_ALL_HARD_CHAR_CAP = 200_000;
const THINKING_SHOW_ALL_TRUNCATION_HINT =
  "... (thinking show-all truncated at 200K chars; full content available via session artifacts)";

/**
 * FEATURE_060 Track 3: hard-cap on the per-item line budget used by
 * `buildThinkingPreview` and downstream layout. Replaces the previous
 * `Number.POSITIVE_INFINITY` value passed in show-all transcript mode.
 * 100_000 lines at ~100 chars/line ≈ 10 MB of materialized rows — orders
 * of magnitude beyond any realistic interactive session, while preventing
 * unbounded growth on degenerate inputs.
 */
export const TRANSCRIPT_HARD_LINE_CAP = 100_000;

function normalizeManagedLiveActivityLabel(label: string | undefined, workerTitle?: string): string | undefined {
  if (!label || !workerTitle) {
    return label;
  }
  const escapedWorkerTitle = workerTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return label
    .replace(new RegExp(`^\\[Tools\\]\\s+\\[${escapedWorkerTitle}\\]\\s+`, "i"), "[Tools] ")
    .replace(new RegExp(`^\\[Thinking\\]\\s+\\[${escapedWorkerTitle}\\]\\s*`, "i"), "[Thinking] ")
    .replace(new RegExp(`^\\[${escapedWorkerTitle}\\]\\s+thinking\\b`, "i"), "[Thinking]")
    .trim();
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getToolStatusIcon(status: ToolCallStatus): string {
  switch (status) {
    case ToolCallStatus.Scheduled:
      return "\u25CB";
    case ToolCallStatus.Validating:
      return "\u25D0";
    case ToolCallStatus.AwaitingApproval:
      return "\u23F8";
    case ToolCallStatus.Executing:
      return "\u25CF";
    case ToolCallStatus.Success:
      return "\u2713";
    case ToolCallStatus.Error:
      return "\u2717";
    case ToolCallStatus.Cancelled:
      return "\u2298";
    default:
      return "[tool]";
  }
}

function getToolStatusColor(status: ToolCallStatus): TranscriptColorToken {
  switch (status) {
    case ToolCallStatus.Scheduled:
    case ToolCallStatus.Validating:
      return "dim";
    case ToolCallStatus.AwaitingApproval:
      return "accent";
    case ToolCallStatus.Executing:
      return "primary";
    case ToolCallStatus.Success:
      return "success";
    case ToolCallStatus.Error:
      return "error";
    case ToolCallStatus.Cancelled:
      return "dim";
    default:
      return "text";
  }
}

function wrapText(text: string, width: number): string[] {
  const normalizedWidth = Math.max(1, width);
  const logicalLines = text.split("\n");
  const layout = calculateVisualLayout(
    logicalLines.length > 0 ? logicalLines : [""],
    normalizedWidth,
    0,
    0
  );

  return layout.visualLines.length > 0 ? layout.visualLines : [""];
}

function buildThinkingPreview(
  text: string,
  maxLines: number,
  showFullThinking: boolean,
  showAllContent = false,
): string {
  if (showFullThinking || showAllContent) {
    // FEATURE_060 Track 3: even in show-all mode, cap individual thinking
    // blocks at THINKING_SHOW_ALL_HARD_CHAR_CAP. Pathological inputs (LLM
    // loop / runaway verbose / malformed protocol leak) would otherwise
    // materialize unbounded wrapped-row arrays into the layout pass.
    if (text.length > THINKING_SHOW_ALL_HARD_CHAR_CAP) {
      return `${text.slice(0, THINKING_SHOW_ALL_HARD_CHAR_CAP)}\n\n${THINKING_SHOW_ALL_TRUNCATION_HINT}`;
    }
    return text;
  }

  const logicalLines = text.split(/\r?\n/);
  const truncatedByLines = logicalLines.length > maxLines;
  const lineLimitedText = truncatedByLines
    ? logicalLines.slice(0, maxLines).join("\n")
    : text;
  const truncatedByChars = lineLimitedText.length > THINKING_PREVIEW_MAX_CHARS;
  const previewBody = truncatedByChars
    ? lineLimitedText.slice(0, THINKING_PREVIEW_MAX_CHARS)
    : lineLimitedText;

  if (!truncatedByLines && !truncatedByChars) {
    return text;
  }

  return `${previewBody}\n\n${THINKING_PREVIEW_TRUNCATION_HINT}`;
}

function findActiveRoundStartIndex(items: HistoryItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.type === "user") {
      return i;
    }
  }

  return 0;
}

function pushWrappedRows(
  rows: TranscriptRow[],
  keyPrefix: string,
  text: string,
  width: number,
  style: Omit<TranscriptRow, "key" | "text">
): void {
  const lines = wrapText(text, width);
  if (lines.length === 0) {
    rows.push({ key: `${keyPrefix}-0`, text: "", ...style });
    return;
  }

  lines.forEach((line, index) => {
    rows.push({
      key: `${keyPrefix}-${index}`,
      text: line,
      ...style,
    });
  });
}

function pushBlankRow(rows: TranscriptRow[], key: string): void {
  rows.push({ key, text: " " });
}

function getBodyWidth(viewportWidth: number, indent = 0): number {
  return Math.max(20, viewportWidth - indent);
}

function buildToolInputPreview(tool: ToolCall): string[] {
  if (!tool.input) {
    return [];
  }

  const serializedInput = JSON.stringify(tool.input, null, 2)?.trim();
  if (!serializedInput) {
    return [];
  }

  return serializedInput
    .split(/\r?\n/)
    .slice(0, 6)
    .map((line: string, index: number) => (index === 0 ? `input: ${line}` : line));
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

function buildToolRows(
  rows: TranscriptRow[],
  itemKey: string,
  tool: ToolCall,
  count: number,
  viewportWidth: number,
  showDetailedTools = false,
  showAllContent = false,
): void {
  pushWrappedRows(
    rows,
    `${itemKey}-tool-${tool.id}-main`,
    `${getToolStatusIcon(tool.status)} ${formatCollapsedToolInlineText({ tool, count })}`,
    getBodyWidth(viewportWidth, 2),
    {
      color: getToolStatusColor(tool.status),
      indent: 2,
      bold: tool.status === ToolCallStatus.Executing,
    }
  );

  const compactExplanation = formatToolResultExplanation(tool);
  compactExplanation.forEach((line, index) => {
    const tone = resolveToolExplanationTone(line);
    pushWrappedRows(
      rows,
      `${itemKey}-tool-${tool.id}-explanation-${index}`,
      line,
      getBodyWidth(viewportWidth, 4),
      {
        color: tone,
        indent: 4,
      }
    );
  });

  if (showDetailedTools) {
    const inputLines = buildToolInputPreview(tool);
    const visibleInputLines = showAllContent ? inputLines : inputLines.slice(0, 6);
    visibleInputLines.forEach((line, index) => {
      pushWrappedRows(
        rows,
        `${itemKey}-tool-${tool.id}-input-${index}`,
        line,
        getBodyWidth(viewportWidth, 4),
        { color: "dim", indent: 4 }
      );
    });
    if (!showAllContent && inputLines.length > visibleInputLines.length) {
      pushWrappedRows(
        rows,
        `${itemKey}-tool-${tool.id}-input-more`,
        `... (${inputLines.length - visibleInputLines.length} more lines)`,
        getBodyWidth(viewportWidth, 4),
        { color: "dim", indent: 4 }
      );
    }
  }

  if (showDetailedTools && typeof tool.output === "string" && tool.output.trim()) {
    const allOutputLines = tool.output.trim().split(/\r?\n/);
    const outputLines = showAllContent
      ? allOutputLines
      : allOutputLines.slice(0, 8);
    outputLines.forEach((line, index) => {
      pushWrappedRows(
        rows,
        `${itemKey}-tool-${tool.id}-output-${index}`,
        line,
        getBodyWidth(viewportWidth, 4),
        { color: "dim", indent: 4 }
      );
    });
    const totalLineCount = allOutputLines.length;
    if (!showAllContent && totalLineCount > outputLines.length) {
      pushWrappedRows(
        rows,
        `${itemKey}-tool-${tool.id}-output-more`,
        `... (${totalLineCount - outputLines.length} more lines)`,
        getBodyWidth(viewportWidth, 4),
        { color: "dim", indent: 4 }
      );
    }
  }
}

function buildLiveToolRows(
  rows: TranscriptRow[],
  itemKey: string,
  tool: ToolCall,
  viewportWidth: number,
): void {
  const isExecuting = tool.status === ToolCallStatus.Executing;
  const prefix = isExecuting ? "" : `${getToolStatusIcon(tool.status)} `;
  pushWrappedRows(
    rows,
    `${itemKey}-tool-${tool.id}-main`,
    `${prefix}${formatCollapsedToolInlineText({ tool, count: 1 })}`,
    getBodyWidth(viewportWidth, 2),
    {
      color: getToolStatusColor(tool.status),
      indent: 2,
      bold: isExecuting,
      spinner: isExecuting,
    }
  );

  const compactExplanation = formatToolResultExplanation(tool);
  compactExplanation.forEach((line, index) => {
    const tone = resolveToolExplanationTone(line);
    pushWrappedRows(
      rows,
      `${itemKey}-tool-${tool.id}-explanation-${index}`,
      line,
      getBodyWidth(viewportWidth, 4),
      {
        color: tone,
        indent: 4,
      }
    );
  });
}

export function buildTranscriptRows(options: TranscriptBuildOptions): TranscriptRow[] {
  const {
    items,
    viewportWidth,
    isLoading = false,
    maxLines = 1000,
    isThinking = false,
    thinkingCharCount = 0,
    thinkingContent = "",
    streamingResponse = "",
    currentTool,
    activeToolCalls = [],
    toolInputCharCount = 0,
    toolInputContent = "",
    iterationHistory = [],
    currentIteration = 1,
    isCompacting = false,
    managedAgentMode,
    managedPhase,
    managedHarnessProfile,
    managedWorkerTitle,
    managedRound,
    managedMaxRounds,
    lastLiveActivityLabel,
    showFullThinking = false,
    showDetailedTools = false,
    showAllContent = false,
    showLiveProgressRows = true,
  } = options;

  const rows: TranscriptRow[] = [];

  for (const item of items) {
    switch (item.type) {
      case "user":
        pushWrappedRows(
          rows,
          `${item.id}-header`,
          `You [${formatTimestamp(item.timestamp)}]`,
          viewportWidth,
          { color: "primary", bold: true, itemId: item.id }
        );
        // Issue 121 Layer 3: cap extremely long user messages so giant text
        // nodes don't force Ink to wrap/output on every frame.
        pushWrappedRows(rows, `${item.id}-body`, truncateUserMessageForDisplay(item.text), getBodyWidth(viewportWidth, 2), {
          color: "text",
          indent: 2,
          itemId: item.id,
        });
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      case "assistant": {
        const displayText = showAllContent ? item.text : item.compactText ?? item.text;
        pushWrappedRows(
          rows,
          `${item.id}-header`,
          `Assistant [${formatTimestamp(item.timestamp)}]`,
          viewportWidth,
          { color: "secondary", bold: true, spinner: item.isStreaming, itemId: item.id }
        );
        pushWrappedRows(
          rows,
          `${item.id}-body`,
          displayText,
          getBodyWidth(viewportWidth, 2),
          { color: "text", indent: 2, itemId: item.id }
        );
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      }
      case "system":
        pushWrappedRows(
          rows,
          `${item.id}-header`,
          `System [${formatTimestamp(item.timestamp)}]`,
          viewportWidth,
          { color: "dim", bold: true, itemId: item.id }
        );
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "dim",
          indent: 2,
          itemId: item.id,
        });
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      case "tool_group":
        pushWrappedRows(
          rows,
          `${item.id}-header`,
          `Tools [${formatTimestamp(item.timestamp)}]`,
          viewportWidth,
          { color: "accent", bold: true, itemId: item.id }
        );
        collapseToolCalls(item.tools).forEach((group) => (
          buildToolRows(rows, item.id, group.tool, group.count, viewportWidth, showDetailedTools, showAllContent)
        ));
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      case "thinking":
        {
          // FEATURE_060 Track 3: route show-all through buildThinkingPreview
          // so the per-block hard char cap fires even when showAllContent is
          // true. The previous short-circuit `showAllContent ? item.text : ...`
          // bypassed all caps in show-all mode.
          const preview = showAllContent
            ? buildThinkingPreview(item.text, maxLines, showFullThinking, showAllContent)
            : item.compactText ?? buildThinkingPreview(item.text, maxLines, showFullThinking, showAllContent);
        pushWrappedRows(rows, `${item.id}-header`, "Thinking", viewportWidth, {
          color: "thinking",
          italic: true,
          itemId: item.id,
        });
        pushWrappedRows(rows, `${item.id}-body`, preview, getBodyWidth(viewportWidth, 2), {
          color: "thinking",
          indent: 2,
          italic: true,
          itemId: item.id,
        });
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
        }
      case "error":
        pushWrappedRows(rows, `${item.id}-header`, "\u2717 Error", viewportWidth, {
          color: "error",
          bold: true,
          itemId: item.id,
        });
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "error",
          indent: 2,
          itemId: item.id,
        });
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      case "info":
        pushWrappedRows(
          rows,
          `${item.id}-body`,
          `${item.icon ?? "\u2139"} ${showAllContent ? item.text : item.compactText ?? item.text}`,
          viewportWidth,
          {
          color: "info",
          itemId: item.id,
          }
        );
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      case "event":
        pushWrappedRows(
          rows,
          `${item.id}-body`,
          `${item.icon ?? ">"} ${showAllContent ? item.text : item.compactText ?? item.text}`,
          viewportWidth,
          {
            color: "text",
            itemId: item.id,
          }
        );
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      case "hint":
        pushWrappedRows(rows, `${item.id}-header`, "\u{1F4A1} Hint", viewportWidth, {
          color: "hint",
          bold: true,
          itemId: item.id,
        });
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "dim",
          indent: 2,
          itemId: item.id,
        });
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      default:
        break;
    }
  }

  if (showLiveProgressRows && iterationHistory.length > 0) {
    iterationHistory.forEach((record) => {
      pushWrappedRows(
        rows,
        `iteration-${record.iteration}-header`,
        `\u2500\u2500 Round ${record.iteration} \u2500\u2500`,
        viewportWidth,
        { color: "dim", bold: true }
      );

      if (record.thinkingSummary) {
        const suffix =
          record.thinkingLength > 60 ? ` (${record.thinkingLength} chars total)` : "";
        pushWrappedRows(
          rows,
          `iteration-${record.iteration}-thinking`,
          `\u{1F4AD} ${record.thinkingSummary}${suffix}`,
          getBodyWidth(viewportWidth, 1),
          { color: "thinking", indent: 1, italic: true }
        );
      }

      if (record.response) {
        const snippet = record.response.slice(0, 200);
        pushWrappedRows(
          rows,
          `iteration-${record.iteration}-response`,
          snippet,
          getBodyWidth(viewportWidth, 1),
          { color: "text", indent: 1 }
        );
        if (record.response.length > 200) {
          pushWrappedRows(
            rows,
            `iteration-${record.iteration}-response-more`,
            `... (${record.response.length} chars total)`,
            getBodyWidth(viewportWidth, 1),
            { color: "dim", indent: 1 }
          );
        }
      }

      if (record.toolsUsed.length > 0) {
        pushWrappedRows(
          rows,
          `iteration-${record.iteration}-tools`,
          `* tools: ${record.toolsUsed.join(", ")}`,
          getBodyWidth(viewportWidth, 1),
          { color: "accent", indent: 1 }
        );
      }

      pushBlankRow(rows, `iteration-${record.iteration}-blank`);
    });

    pushWrappedRows(rows, "iteration-current-header", `\u2500\u2500 Round ${currentIteration} (current) \u2500\u2500`, viewportWidth, {
      color: "accent",
      bold: true,
    });
    pushBlankRow(rows, "iteration-current-blank");
  }

  if (isLoading && thinkingContent) {
    const thinkingPreview = buildThinkingPreview(thinkingContent, maxLines, showFullThinking, showAllContent);
    pushWrappedRows(rows, "thinking-stream-header", "Thinking", viewportWidth, {
      color: "thinking",
      italic: true,
    });
    pushWrappedRows(rows, "thinking-stream-body", thinkingPreview, getBodyWidth(viewportWidth, 2), {
      color: "thinking",
      indent: 2,
      italic: true,
    });
    pushBlankRow(rows, "thinking-stream-blank");
  }

  if (isLoading) {
    let loadingText = "Thinking";
    let prefix = "";
    const managedHarnessShort = formatHarnessProfileShort(managedHarnessProfile);
    const normalizedLiveActivityLabel = normalizeManagedLiveActivityLabel(lastLiveActivityLabel, managedWorkerTitle);
    const managedPrefix = managedPhase === "routing"
      ? `[${managedAgentMode ? managedAgentMode.toUpperCase() : 'AMA'} Routing] `
      : managedPhase === "preflight"
        ? `[${managedAgentMode ? managedAgentMode.toUpperCase() : 'AMA'} Scout${managedWorkerTitle && managedWorkerTitle !== "Scout" ? ` - ${managedWorkerTitle}` : ''}] `
        : managedHarnessProfile
          ? `[${managedAgentMode ? managedAgentMode.toUpperCase() : 'AMA'} ${managedHarnessShort ?? managedHarnessProfile}${managedWorkerTitle ? ` - ${managedWorkerTitle}` : ''}] `
          : "";
    const activeToolCount = activeToolCalls.filter((tool) => tool.status === ToolCallStatus.Executing).length;
    const completedToolCount = activeToolCalls.filter((tool) => tool.status === ToolCallStatus.Success).length;
    const erroredToolCount = activeToolCalls.filter((tool) => tool.status === ToolCallStatus.Error).length;
    const cancelledToolCount = activeToolCalls.filter((tool) => tool.status === ToolCallStatus.Cancelled).length;
    const shouldRenderLiveToolBlock = activeToolCalls.length > 0 && (activeToolCount > 0 || !streamingResponse);

    if (isCompacting) {
      loadingText = "Compacting";
    } else if (shouldRenderLiveToolBlock) {
      const summaryParts: string[] = [];
      if (activeToolCount > 0) {
        summaryParts.push(`${activeToolCount} running`);
      }
      if (completedToolCount > 0) {
        summaryParts.push(`${completedToolCount} done`);
      }
      if (erroredToolCount > 0) {
        summaryParts.push(`${erroredToolCount} error`);
      }
      if (cancelledToolCount > 0) {
        summaryParts.push(`${cancelledToolCount} cancelled`);
      }
      if (summaryParts.length === 0) {
        summaryParts.push(`${activeToolCalls.length} tools`);
      }
      pushWrappedRows(
        rows,
        "loading-tools-header",
        `${managedPrefix}[Tools] ${summaryParts.join(", ")}`,
        viewportWidth,
        {
          color: "primary",
          bold: true,
          spinner: activeToolCount > 0,
        }
      );
      activeToolCalls.forEach((tool) => {
        buildLiveToolRows(rows, "loading-tools", tool, viewportWidth);
      });
      pushBlankRow(rows, "loading-tools-blank");
      if (activeToolCount > 0) {
        if (!streamingResponse && !showLiveProgressRows) {
          return rows;
        }
      }
    } else if (currentTool) {
      prefix = managedPrefix || "[Tool] ";
      loadingText = normalizedLiveActivityLabel?.startsWith("[Tools]")
        ? normalizedLiveActivityLabel
        : formatLiveToolLabel(currentTool, toolInputContent, toolInputCharCount);
    } else if (isThinking) {
      prefix = managedPrefix || "[Thinking] ";
      const roundSuffix = managedRound && managedMaxRounds && managedRound > 1
        ? ` round ${managedRound}/${managedMaxRounds}`
        : "";
      loadingText = thinkingCharCount > 0
        ? `${thinkingCharCount} chars${roundSuffix}`
        : normalizedLiveActivityLabel
          ? `${normalizedLiveActivityLabel}${roundSuffix}`
          : `processing${roundSuffix}`;
    } else if (normalizedLiveActivityLabel) {
      loadingText = normalizedLiveActivityLabel;
    }

    if (showLiveProgressRows) {
      pushWrappedRows(
        rows,
        "loading-indicator",
        `${prefix}${loadingText}...`,
        viewportWidth,
        { color: "accent", spinner: true }
      );
    }
  }

  if (streamingResponse) {
    pushWrappedRows(rows, "streaming-header", "Assistant", viewportWidth, {
      color: "secondary",
      bold: true,
    });
    pushWrappedRows(rows, "streaming-body", streamingResponse, getBodyWidth(viewportWidth, 2), {
      color: "text",
      indent: 2,
    });
    pushBlankRow(rows, "streaming-blank");
  }

  return rows;
}

export function buildStaticTranscriptSections(
  items: HistoryItem[],
  viewportWidth: number,
  maxLines = 1000,
  showDetailedTools = false,
  showAllContent = false,
): TranscriptSection[] {
  return buildHistoryItemTranscriptSections(items, viewportWidth, maxLines, showDetailedTools, undefined, showAllContent);
}

export function buildHistoryItemTranscriptSections(
  items: HistoryItem[],
  viewportWidth: number,
  maxLines = 1000,
  showDetailedTools = false,
  expandedItemKeys?: ReadonlySet<string>,
  showAllContent = false,
): TranscriptSection[] {
  return items.map((item) => ({
    key: item.id,
    rows: buildTranscriptRows({
      items: [item],
      viewportWidth,
      maxLines,
      showAllContent,
      showDetailedTools: showDetailedTools || Boolean(expandedItemKeys?.has(item.id)),
    }),
  }));
}

export function buildDynamicTranscriptSection(
  key: string,
  options: TranscriptBuildOptions
): TranscriptSection {
  return {
    key,
    rows: buildTranscriptRows(options),
  };
}

export function buildTranscriptRenderModel(
  options: TranscriptRenderModelOptions,
): TranscriptRenderModel {
  const {
    items,
    viewportWidth,
    maxLines = 1000,
    windowed = false,
    showDetailedTools = false,
    showAllContent = false,
    expandedItemKeys,
    ...dynamicOptions
  } = options;

  const activeRoundStartIndex = findActiveRoundStartIndex(items);
  const staticItems = windowed ? [] : items.slice(0, activeRoundStartIndex);
  const activeItems = windowed ? items : items.slice(activeRoundStartIndex);
  const staticSections = windowed
    ? []
    : buildStaticTranscriptSections(staticItems, viewportWidth, maxLines, showDetailedTools, showAllContent);
  const sections = buildHistoryItemTranscriptSections(
    activeItems,
    viewportWidth,
    maxLines,
    showDetailedTools,
    expandedItemKeys,
    showAllContent,
  );
  const pendingSection = buildDynamicTranscriptSection("active-pending", {
    ...dynamicOptions,
    items: [],
    managedLiveEvents: [],
    lastLiveActivityLabel: dynamicOptions.lastLiveActivityLabel,
    viewportWidth,
    maxLines,
    showAllContent,
    showDetailedTools,
    expandedItemKeys,
  });
  const previewSections = pendingSection.rows.length > 0
    ? [pendingSection]
    : [];

  return {
    staticSections,
    sections,
    rows: flattenTranscriptSections(sections),
    previewSections,
    previewRows: flattenTranscriptSections(previewSections),
  };
}

export function flattenTranscriptSections(sections: TranscriptSection[]): TranscriptRow[] {
  return sections.flatMap((section) => section.rows);
}

export function materializeTranscriptRenderModel(
  model: TranscriptRenderModel,
): TranscriptRenderModel {
  const sections = [...model.staticSections, ...model.sections];
  return {
    staticSections: [],
    sections,
    rows: flattenTranscriptSections(sections),
    previewSections: [...model.previewSections],
    previewRows: flattenTranscriptSections(model.previewSections),
  };
}

export function resolveVisibleTranscriptRows(
  rows: TranscriptRow[],
  options: {
    start?: number;
    end?: number;
    viewportTop?: number;
    viewportHeight?: number;
    viewportRows?: number;
    scrollOffset?: number;
    windowed?: boolean;
  } = {},
): TranscriptRow[] {
  const {
    start,
    end,
    viewportTop,
    viewportHeight,
    viewportRows,
    scrollOffset = 0,
    windowed = false,
  } = options;

  if (typeof viewportTop === "number" && typeof viewportHeight === "number") {
    const safeStart = Math.max(0, viewportTop);
    const safeEnd = Math.max(safeStart, viewportTop + Math.max(0, viewportHeight));
    return rows.slice(safeStart, safeEnd);
  }

  if (typeof start === "number" && typeof end === "number") {
    return rows.slice(Math.max(0, start), Math.max(0, end));
  }

  if (windowed) {
    return getVisibleTranscriptRows(rows, viewportRows, scrollOffset);
  }

  return rows;
}

/**
 * FEATURE_060 Tier 2 (v0.7.30) — count-based hard cap on transcript items
 * with UUID-anchored slice boundary.
 *
 * KodaX wraps Ink's `<Static>` block around historical items so each item
 * paints to terminal scrollback exactly once. But on `kodax -c` resume of a
 * long session, that one-time paint is one giant `stream.write` of all N
 * historical items at once — under SSH/ConPTY this stalls the connection
 * for seconds and the local-host CPU pays O(N) Ink fiber + Yoga layout cost
 * per render even though the *bytes* only flush once.
 *
 * Mirrors `claudecode/src/components/Messages.tsx:307` (`MAX_MESSAGES_WITHOUT_VIRTUALIZATION = 200`)
 * + `MESSAGE_CAP_STEP = 50`. The 50-step quantization avoids the front item
 * sliding off on every append, which would shift `<Static>` content and
 * force a full repaint per turn (CC-941). UUID-anchored boundary survives
 * collapse/regrouping churn (where `items.length` changes without items
 * actually being added — CC-1174).
 */
export const TRANSCRIPT_RENDER_CAP = 200;
export const TRANSCRIPT_RENDER_CAP_STEP = 50;

/**
 * Transcript-mode "compact view" cap — when the user is in transcript-mode
 * and has NOT toggled `showAllInTranscript`, only the last N items render.
 * Mirrors `claudecode/src/components/Messages.tsx:276`
 * (`MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE = 30`).
 */
export const TRANSCRIPT_MODE_VISIBLE_MESSAGES = 30;

export type TranscriptCapAnchor = { id: string; idx: number } | null;

/**
 * Compute the start index for the capped slice. Mutates `anchorRef.current`
 * to track the front item's id+idx so subsequent calls remain stable across
 * id churn.
 *
 *   - Anchor found by id   → slice from there
 *   - Anchor lost (id gone) → fall back to clamped stored idx, so collapse
 *     regrouping doesn't reset to 0 and yank ~200 messages of static
 *     content from scrollback into a re-paint
 *   - No anchor yet         → slice from 0 (until first advancement)
 *   - Once `length - start > cap + step`, advance to `length - cap`
 */
export function computeTranscriptCapStart(
  items: ReadonlyArray<{ id: string }>,
  anchorRef: { current: TranscriptCapAnchor },
  cap: number = TRANSCRIPT_RENDER_CAP,
  step: number = TRANSCRIPT_RENDER_CAP_STEP,
): number {
  const anchor = anchorRef.current;
  const anchorIdx = anchor
    ? items.findIndex((m) => m.id === anchor.id)
    : -1;
  let start = anchorIdx >= 0
    ? anchorIdx
    : anchor
      ? Math.min(anchor.idx, Math.max(0, items.length - cap))
      : 0;
  if (items.length - start > cap + step) {
    start = items.length - cap;
  }
  // Refresh anchor from whatever now lives at start — heals stale id after
  // a fallback and captures a new id after advancement.
  const itemAtStart = items[start];
  if (itemAtStart && (anchor?.id !== itemAtStart.id || anchor.idx !== start)) {
    anchorRef.current = { id: itemAtStart.id, idx: start };
  } else if (!itemAtStart && anchor) {
    anchorRef.current = null;
  }
  return start;
}

export function sliceHistoryToRecentRounds(
  items: HistoryItem[],
  maxRounds: number
): HistoryItem[] {
  if (maxRounds <= 0 || items.length === 0) {
    return [];
  }

  let userCount = 0;
  let startIndex = 0;

  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.type === "user") {
      userCount++;
      if (userCount > maxRounds) {
        startIndex = i + 1;
        break;
      }
    }
  }

  return items.slice(startIndex);
}

export function capHistoryByTranscriptRows(
  items: HistoryItem[],
  viewportWidth: number,
  rowCap: number,
  maxLines = 1000
): HistoryItem[] {
  if (rowCap <= 0 || items.length === 0) {
    return [];
  }

  let totalRows = 0;
  let startIndex = items.length - 1;

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) {
      continue;
    }

    const itemRows = buildTranscriptRows({
      items: [item],
      viewportWidth,
      maxLines,
    }).length;

    if (totalRows + itemRows > rowCap && i !== items.length - 1) {
      break;
    }

    totalRows += itemRows;
    startIndex = i;

    if (totalRows >= rowCap) {
      break;
    }
  }

  return items.slice(startIndex);
}

export function getVisibleTranscriptRows(
  rows: TranscriptRow[],
  viewportRows?: number,
  scrollOffset = 0
): TranscriptRow[] {
  if (!viewportRows || viewportRows <= 0) {
    return rows;
  }

  const clampedOffset = Math.max(0, scrollOffset);
  const end = Math.max(0, rows.length - clampedOffset);
  const start = Math.max(0, end - viewportRows);
  return rows.slice(start, end);
}

export function resolveScrollOffsetForTranscriptItem(
  sections: TranscriptSection[],
  targetItemId: string | undefined,
  viewportRows: number | undefined,
): number {
  if (!targetItemId || !viewportRows || viewportRows <= 0) {
    return 0;
  }

  const rows = flattenTranscriptSections(sections);
  const targetSection = sections.find((section) => section.key === targetItemId);
  if (!targetSection || targetSection.rows.length === 0) {
    return 0;
  }

  const targetRowKey = targetSection.rows[0]?.key;
  const rowIndex = rows.findIndex((row) => row.key === targetRowKey);
  if (rowIndex === -1) {
    return 0;
  }

  const desiredStart = Math.max(0, rowIndex - Math.floor(viewportRows / 3));
  const desiredEnd = Math.min(rows.length, desiredStart + viewportRows);
  return Math.max(0, rows.length - desiredEnd);
}

export function resolveTranscriptColor(
  theme: Theme,
  color: TranscriptColorToken | undefined
): string | undefined {
  if (!color) return undefined;
  switch (color) {
    case "warning":
      return theme.colors.warning;
    case "info":
      return theme.colors.info;
    case "hint":
      return theme.colors.hint;
    default:
      return theme.colors[color];
  }
}
