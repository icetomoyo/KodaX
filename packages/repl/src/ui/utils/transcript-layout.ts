import { ToolCallStatus, type HistoryItem, type Theme, type ToolCall } from "../types.js";
import type { IterationRecord } from "../contexts/StreamingContext.js";
import { calculateVisualLayout } from "./textUtils.js";

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
  toolInputCharCount?: number;
  toolInputContent?: string;
  iterationHistory?: IterationRecord[];
  currentIteration?: number;
  isCompacting?: boolean;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(startTime: number, endTime?: number): string {
  if (!endTime) return "";
  const ms = endTime - startTime;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

function getLogicalLineSlice(text: string, maxLines: number): string[] {
  const logicalLines = text.split("\n");
  return logicalLines.slice(0, maxLines);
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

function buildToolRows(
  rows: TranscriptRow[],
  itemKey: string,
  tool: ToolCall,
  viewportWidth: number
): void {
  const preview = tool.input ? JSON.stringify(tool.input) : "";
  const previewText =
    preview.length > 0 ? ` ${preview.slice(0, 50)}${preview.length > 50 ? "..." : ""}` : "";

  pushWrappedRows(
    rows,
    `${itemKey}-tool-${tool.id}-main`,
    `${getToolStatusIcon(tool.status)} ${tool.name}${previewText}`,
    getBodyWidth(viewportWidth, 2),
    {
      color: getToolStatusColor(tool.status),
      indent: 2,
      bold: tool.status === ToolCallStatus.Executing,
    }
  );

  if (tool.progress !== undefined && tool.status === ToolCallStatus.Executing) {
    pushWrappedRows(
      rows,
      `${itemKey}-tool-${tool.id}-progress`,
      `Progress: ${tool.progress}%`,
      getBodyWidth(viewportWidth, 4),
      { color: "dim", indent: 4 }
    );
  }

  if (tool.error) {
    pushWrappedRows(
      rows,
      `${itemKey}-tool-${tool.id}-error`,
      tool.error,
      getBodyWidth(viewportWidth, 4),
      { color: "error", indent: 4 }
    );
  }

  const duration = formatDuration(tool.startTime, tool.endTime);
  if (duration) {
    pushWrappedRows(
      rows,
      `${itemKey}-tool-${tool.id}-duration`,
      `Completed in ${duration}`,
      getBodyWidth(viewportWidth, 4),
      { color: "dim", indent: 4 }
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
    toolInputCharCount = 0,
    toolInputContent = "",
    iterationHistory = [],
    currentIteration = 1,
    isCompacting = false,
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
          { color: "primary", bold: true }
        );
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "text",
          indent: 2,
        });
        pushBlankRow(rows, `${item.id}-blank`);
        break;
      case "assistant": {
        pushWrappedRows(
          rows,
          `${item.id}-header`,
          `Assistant [${formatTimestamp(item.timestamp)}]`,
          viewportWidth,
          { color: "secondary", bold: true, spinner: item.isStreaming }
        );
        const truncatedLines = getLogicalLineSlice(item.text, maxLines);
        pushWrappedRows(
          rows,
          `${item.id}-body`,
          truncatedLines.join("\n"),
          getBodyWidth(viewportWidth, 2),
          { color: "text", indent: 2 }
        );
        if (item.text.split("\n").length > maxLines) {
          pushWrappedRows(
            rows,
            `${item.id}-more`,
            `... (${item.text.split("\n").length - maxLines} more lines)`,
            getBodyWidth(viewportWidth, 2),
            { color: "dim", indent: 2 }
          );
        }
        pushBlankRow(rows, `${item.id}-blank`);
        break;
      }
      case "system":
        pushWrappedRows(
          rows,
          `${item.id}-header`,
          `System [${formatTimestamp(item.timestamp)}]`,
          viewportWidth,
          { color: "dim", bold: true }
        );
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "dim",
          indent: 2,
        });
        pushBlankRow(rows, `${item.id}-blank`);
        break;
      case "tool_group":
        pushWrappedRows(
          rows,
          `${item.id}-header`,
          `Tools [${formatTimestamp(item.timestamp)}]`,
          viewportWidth,
          { color: "accent", bold: true }
        );
        item.tools.forEach((tool) => buildToolRows(rows, item.id, tool, viewportWidth));
        pushBlankRow(rows, `${item.id}-blank`);
        break;
      case "thinking":
        pushWrappedRows(rows, `${item.id}-header`, "Thinking", viewportWidth, {
          color: "thinking",
          italic: true,
        });
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "thinking",
          indent: 2,
          italic: true,
        });
        pushBlankRow(rows, `${item.id}-blank`);
        break;
      case "error":
        pushWrappedRows(rows, `${item.id}-header`, "\u2717 Error", viewportWidth, {
          color: "error",
          bold: true,
        });
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "error",
          indent: 2,
        });
        pushBlankRow(rows, `${item.id}-blank`);
        break;
      case "info":
        pushWrappedRows(rows, `${item.id}-header`, `${item.icon ?? "\u2139"} Info`, viewportWidth, {
          color: "info",
          bold: true,
        });
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "info",
          indent: 2,
        });
        pushBlankRow(rows, `${item.id}-blank`);
        break;
      case "hint":
        pushWrappedRows(rows, `${item.id}-header`, "\u{1F4A1} Hint", viewportWidth, {
          color: "hint",
          bold: true,
        });
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "dim",
          indent: 2,
        });
        pushBlankRow(rows, `${item.id}-blank`);
        break;
      default:
        break;
    }
  }

  if (iterationHistory.length > 0) {
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

      pushBlankRow(rows, `iteration-${record.iteration}-blank`);
    });

    pushWrappedRows(rows, "iteration-current-header", `\u2500\u2500 Round ${currentIteration} (current) \u2500\u2500`, viewportWidth, {
      color: "accent",
      bold: true,
    });
    pushBlankRow(rows, "iteration-current-blank");
  }

  if (isLoading && thinkingContent) {
    pushWrappedRows(rows, "thinking-stream-header", "Thinking", viewportWidth, {
      color: "thinking",
      italic: true,
    });
    pushWrappedRows(rows, "thinking-stream-body", thinkingContent, getBodyWidth(viewportWidth, 2), {
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

  if (isLoading) {
    let loadingText = "Thinking";
    let prefix = "";
    if (isCompacting) {
      loadingText = "Compacting";
    } else if (currentTool) {
      prefix = "[Tool] ";
      loadingText = toolInputContent
        ? `${currentTool} (${toolInputContent}...)`
        : toolInputCharCount > 0
          ? `${currentTool} (${toolInputCharCount} chars)`
          : `Executing ${currentTool}...`;
    } else if (isThinking) {
      prefix = "[Thinking] ";
      loadingText = thinkingCharCount > 0 ? `(${thinkingCharCount} chars)` : "processing...";
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
  maxLines = 1000
): TranscriptSection[] {
  return buildHistoryItemTranscriptSections(items, viewportWidth, maxLines);
}

export function buildHistoryItemTranscriptSections(
  items: HistoryItem[],
  viewportWidth: number,
  maxLines = 1000
): TranscriptSection[] {
  return items.map((item) => ({
    key: item.id,
    rows: buildTranscriptRows({
      items: [item],
      viewportWidth,
      maxLines,
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

export function flattenTranscriptSections(sections: TranscriptSection[]): TranscriptRow[] {
  return sections.flatMap((section) => section.rows);
}

export function getVisibleTranscriptRows(rows: TranscriptRow[], viewportRows?: number): TranscriptRow[] {
  if (!viewportRows || viewportRows <= 0) {
    return rows;
  }

  return rows.slice(Math.max(0, rows.length - viewportRows));
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
