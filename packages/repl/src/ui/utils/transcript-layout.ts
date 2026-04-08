import { ToolCallStatus, type HistoryItem, type Theme, type ToolCall } from "../types.js";
import type { IterationRecord } from "../contexts/StreamingContext.js";
import { calculateVisualLayout } from "./textUtils.js";
import {
  collapseToolCalls,
  formatCollapsedToolInlineText,
  formatLiveToolLabel,
} from "./tool-display.js";

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
  showLiveProgressRows?: boolean;
  expandedItemKeys?: ReadonlySet<string>;
}

export interface TranscriptRenderModel {
  staticSections: TranscriptSection[];
  sections: TranscriptSection[];
  rows: TranscriptRow[];
}

export interface TranscriptRenderModelOptions extends TranscriptBuildOptions {
  windowed?: boolean;
}

const THINKING_PREVIEW_MAX_CHARS = 400;
const THINKING_PREVIEW_TRUNCATION_HINT =
  "... (thinking truncated; press Ctrl+O to inspect full reasoning)";

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
): string {
  if (showFullThinking) {
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

  if (tool.error) {
    pushWrappedRows(
      rows,
      `${itemKey}-tool-${tool.id}-error`,
      tool.error,
      getBodyWidth(viewportWidth, 4),
      { color: "error", indent: 4 }
    );
  }

  if (showDetailedTools) {
    const inputLines = buildToolInputPreview(tool);
    inputLines.forEach((line, index) => {
      pushWrappedRows(
        rows,
        `${itemKey}-tool-${tool.id}-input-${index}`,
        line,
        getBodyWidth(viewportWidth, 4),
        { color: "dim", indent: 4 }
      );
    });
  }

  if (showDetailedTools && typeof tool.output === "string" && tool.output.trim()) {
    const outputLines = tool.output
      .trim()
      .split(/\r?\n/)
      .slice(0, 8);
    outputLines.forEach((line, index) => {
      pushWrappedRows(
        rows,
        `${itemKey}-tool-${tool.id}-output-${index}`,
        line,
        getBodyWidth(viewportWidth, 4),
        { color: "dim", indent: 4 }
      );
    });
    const totalLineCount = tool.output.trim().split(/\r?\n/).length;
    if (totalLineCount > outputLines.length) {
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

  if (tool.error) {
    pushWrappedRows(
      rows,
      `${itemKey}-tool-${tool.id}-error`,
      tool.error,
      getBodyWidth(viewportWidth, 4),
      { color: "error", indent: 4 }
    );
  }
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
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "text",
          indent: 2,
          itemId: item.id,
        });
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      case "assistant": {
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
          item.text,
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
          buildToolRows(rows, item.id, group.tool, group.count, viewportWidth, showDetailedTools)
        ));
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      case "thinking":
        {
          const preview = buildThinkingPreview(item.text, maxLines, showFullThinking);
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
        pushWrappedRows(rows, `${item.id}-body`, `${item.icon ?? "\u2139"} ${item.text}`, viewportWidth, {
          color: "info",
          itemId: item.id,
        });
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

  if (showLiveProgressRows && isLoading && thinkingContent) {
    const thinkingPreview = buildThinkingPreview(thinkingContent, maxLines, showFullThinking);
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

  if (showLiveProgressRows && isLoading) {
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
    let renderedStickyToolBlock = false;

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
      renderedStickyToolBlock = true;
      if (activeToolCount > 0) {
        return rows;
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
    } else if (normalizedLiveActivityLabel && !renderedStickyToolBlock) {
      loadingText = normalizedLiveActivityLabel;
    }

    pushWrappedRows(
      rows,
      "loading-indicator",
      `${prefix}${loadingText}...`,
      viewportWidth,
      { color: "accent", spinner: true }
    );
  }

  return rows;
}

export function buildStaticTranscriptSections(
  items: HistoryItem[],
  viewportWidth: number,
  maxLines = 1000,
  showDetailedTools = false,
): TranscriptSection[] {
  return buildHistoryItemTranscriptSections(items, viewportWidth, maxLines, showDetailedTools);
}

export function buildHistoryItemTranscriptSections(
  items: HistoryItem[],
  viewportWidth: number,
  maxLines = 1000,
  showDetailedTools = false,
  expandedItemKeys?: ReadonlySet<string>,
): TranscriptSection[] {
  return items.map((item) => ({
    key: item.id,
    rows: buildTranscriptRows({
      items: [item],
      viewportWidth,
      maxLines,
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
    expandedItemKeys,
    ...dynamicOptions
  } = options;

  const activeRoundStartIndex = findActiveRoundStartIndex(items);
  const staticItems = windowed ? [] : items.slice(0, activeRoundStartIndex);
  const activeItems = windowed ? items : items.slice(activeRoundStartIndex);
  const staticSections = windowed
    ? []
    : buildStaticTranscriptSections(staticItems, viewportWidth, maxLines, showDetailedTools);
  const sections = buildHistoryItemTranscriptSections(
    activeItems,
    viewportWidth,
    maxLines,
    showDetailedTools,
    expandedItemKeys,
  );
  const pendingSection = buildDynamicTranscriptSection("active-pending", {
    ...dynamicOptions,
    items: [],
    viewportWidth,
    maxLines,
    showDetailedTools,
    expandedItemKeys,
  });
  const nextSections = pendingSection.rows.length > 0
    ? [...sections, pendingSection]
    : sections;

  return {
    staticSections,
    sections: nextSections,
    rows: flattenTranscriptSections(nextSections),
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
  };
}

export function resolveVisibleTranscriptRows(
  rows: TranscriptRow[],
  options: {
    start?: number;
    end?: number;
    viewportRows?: number;
    scrollOffset?: number;
    windowed?: boolean;
  } = {},
): TranscriptRow[] {
  const {
    start,
    end,
    viewportRows,
    scrollOffset = 0,
    windowed = false,
  } = options;

  if (typeof start === "number" && typeof end === "number") {
    return rows.slice(Math.max(0, start), Math.max(0, end));
  }

  if (windowed) {
    return getVisibleTranscriptRows(rows, viewportRows, scrollOffset);
  }

  return rows;
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
