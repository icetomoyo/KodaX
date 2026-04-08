import { ToolCallStatus, type HistoryItem, type ToolCall } from "../types.js";
import {
  flattenTranscriptSections,
  type TranscriptColorToken,
  type TranscriptRenderModel,
  type TranscriptRow,
  type TranscriptSection,
} from "./transcript-layout.js";
import { calculateVisualLayout } from "./textUtils.js";
import {
  collapseToolCalls,
  formatCollapsedToolInlineText,
  formatToolResultExplanation,
  resolveToolExplanationTone,
} from "./tool-display.js";

export interface PromptSurfaceRenderModelOptions {
  items: readonly HistoryItem[];
  viewportWidth: number;
  streamingResponse?: string;
  isThinking?: boolean;
  thinkingContent?: string;
  isLoading?: boolean;
}

const PROMPT_THINKING_PREVIEW_MAX_LINES = 4;
const PROMPT_THINKING_PREVIEW_MAX_CHARS = 240;
const PROMPT_THINKING_TRUNCATION_HINT =
  "... (thinking truncated; press Ctrl+O to inspect full reasoning)";

function buildPromptThinkingPreview(text: string): string {
  const logicalLines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (logicalLines.length === 0) {
    return "";
  }

  const lineLimited = logicalLines.slice(0, PROMPT_THINKING_PREVIEW_MAX_LINES).join("\n");
  const truncatedByLines = logicalLines.length > PROMPT_THINKING_PREVIEW_MAX_LINES;
  const truncatedByChars = lineLimited.length > PROMPT_THINKING_PREVIEW_MAX_CHARS;
  if (!truncatedByLines && !truncatedByChars) {
    return lineLimited;
  }

  const charLimited = lineLimited.slice(0, PROMPT_THINKING_PREVIEW_MAX_CHARS).trimEnd();
  return `${charLimited}\n\n${PROMPT_THINKING_TRUNCATION_HINT}`;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function wrapText(text: string, width: number): string[] {
  const layout = calculateVisualLayout(
    text.split("\n"),
    Math.max(1, width),
    0,
    0,
  );
  return layout.visualLines.length > 0 ? layout.visualLines : [""];
}

function bodyWidth(viewportWidth: number, indent = 0): number {
  return Math.max(20, viewportWidth - indent);
}

function pushWrappedRows(
  rows: TranscriptRow[],
  keyPrefix: string,
  text: string,
  width: number,
  style: Omit<TranscriptRow, "key" | "text">,
): void {
  const lines = wrapText(text, width);
  lines.forEach((line, index) => {
    rows.push({
      key: `${keyPrefix}-${index}`,
      text: line,
      ...style,
    });
  });
}

function pushBlankRow(rows: TranscriptRow[], key: string, itemId?: string): void {
  rows.push({ key, text: " ", itemId });
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
    case ToolCallStatus.Cancelled:
      return "dim";
    case ToolCallStatus.AwaitingApproval:
      return "accent";
    case ToolCallStatus.Executing:
      return "primary";
    case ToolCallStatus.Success:
      return "success";
    case ToolCallStatus.Error:
      return "error";
    default:
      return "text";
  }
}

function buildPromptToolRows(
  rows: TranscriptRow[],
  itemId: string,
  viewportWidth: number,
  tool: ToolCall,
  count: number,
): void {
  pushWrappedRows(
    rows,
    `${itemId}-tool-${tool.id}`,
    `${getToolStatusIcon(tool.status)} ${formatCollapsedToolInlineText({ tool, count })}`,
    bodyWidth(viewportWidth, 2),
    {
      color: getToolStatusColor(tool.status),
      indent: 2,
      bold: tool.status === ToolCallStatus.Executing,
      itemId,
    },
  );

  const compactExplanation = formatToolResultExplanation(tool);
  compactExplanation.forEach((line, index) => {
    pushWrappedRows(
      rows,
      `${itemId}-tool-${tool.id}-explanation-${index}`,
      line,
      bodyWidth(viewportWidth, 4),
      {
        color: resolveToolExplanationTone(line),
        indent: 4,
        itemId,
      },
    );
  });
}

function buildPromptSurfaceSection(
  item: HistoryItem,
  viewportWidth: number,
): TranscriptSection | undefined {
  const rows: TranscriptRow[] = [];

  switch (item.type) {
    case "user":
      pushWrappedRows(rows, `${item.id}-header`, `You [${formatTimestamp(item.timestamp)}]`, viewportWidth, {
        color: "primary",
        bold: true,
        itemId: item.id,
      });
      pushWrappedRows(rows, `${item.id}-body`, item.text, bodyWidth(viewportWidth, 2), {
        color: "text",
        indent: 2,
        itemId: item.id,
      });
      break;
    case "assistant":
      pushWrappedRows(rows, `${item.id}-header`, `Assistant [${formatTimestamp(item.timestamp)}]`, viewportWidth, {
        color: "secondary",
        bold: true,
        itemId: item.id,
      });
      pushWrappedRows(rows, `${item.id}-body`, item.text, bodyWidth(viewportWidth, 2), {
        color: "text",
        indent: 2,
        itemId: item.id,
      });
      break;
    case "system":
      pushWrappedRows(rows, `${item.id}-header`, `System [${formatTimestamp(item.timestamp)}]`, viewportWidth, {
        color: "dim",
        bold: true,
        itemId: item.id,
      });
      pushWrappedRows(rows, `${item.id}-body`, item.text, bodyWidth(viewportWidth, 2), {
        color: "dim",
        indent: 2,
        itemId: item.id,
      });
      break;
    case "error":
      pushWrappedRows(rows, `${item.id}-header`, "\u2717 Error", viewportWidth, {
        color: "error",
        bold: true,
        itemId: item.id,
      });
      pushWrappedRows(rows, `${item.id}-body`, item.text, bodyWidth(viewportWidth, 2), {
        color: "error",
        indent: 2,
        itemId: item.id,
      });
      break;
    case "info":
      pushWrappedRows(rows, `${item.id}-body`, `${item.icon ?? "\u2139"} ${item.text}`, viewportWidth, {
        color: "info",
        itemId: item.id,
      });
      break;
    case "thinking": {
      const preview = buildPromptThinkingPreview(item.text);
      if (!preview) {
        return undefined;
      }
      pushWrappedRows(rows, `${item.id}-header`, "Thinking", viewportWidth, {
        color: "thinking",
        italic: true,
        itemId: item.id,
      });
      pushWrappedRows(rows, `${item.id}-body`, preview, bodyWidth(viewportWidth, 2), {
        color: "thinking",
        indent: 2,
        italic: true,
        itemId: item.id,
      });
      break;
    }
    case "tool_group":
      pushWrappedRows(rows, `${item.id}-header`, `Tools [${formatTimestamp(item.timestamp)}]`, viewportWidth, {
        color: "accent",
        bold: true,
        itemId: item.id,
      });
      collapseToolCalls(item.tools).forEach((group) => {
        buildPromptToolRows(rows, item.id, viewportWidth, group.tool, group.count);
      });
      break;
    default:
      return undefined;
  }

  pushBlankRow(rows, `${item.id}-blank`, item.id);
  return {
    key: item.id,
    rows,
  };
}

export function buildPromptSurfaceRenderModel(
  options: PromptSurfaceRenderModelOptions,
): TranscriptRenderModel {
  const sections = options.items
    .map((item) => buildPromptSurfaceSection(item, options.viewportWidth))
    .filter((section): section is TranscriptSection => Boolean(section));

  if (options.streamingResponse?.trim()) {
    const rows: TranscriptRow[] = [];
    pushWrappedRows(rows, "prompt-streaming-header", "Assistant", options.viewportWidth, {
      color: "secondary",
      bold: true,
    });
    pushWrappedRows(rows, "prompt-streaming-body", options.streamingResponse, bodyWidth(options.viewportWidth, 2), {
      color: "text",
      indent: 2,
    });
    pushBlankRow(rows, "prompt-streaming-blank");
    sections.push({
      key: "prompt-streaming",
      rows,
    });
  }

  if (!options.streamingResponse?.trim() && options.isLoading && options.isThinking && options.thinkingContent?.trim()) {
    const preview = buildPromptThinkingPreview(options.thinkingContent);
    if (preview) {
      const rows: TranscriptRow[] = [];
      pushWrappedRows(rows, "prompt-thinking-header", "Thinking", options.viewportWidth, {
        color: "thinking",
        italic: true,
      });
      pushWrappedRows(rows, "prompt-thinking-body", preview, bodyWidth(options.viewportWidth, 2), {
        color: "thinking",
        indent: 2,
        italic: true,
      });
      pushBlankRow(rows, "prompt-thinking-blank");
      sections.push({
        key: "prompt-thinking",
        rows,
      });
    }
  }

  return {
    staticSections: [],
    sections,
    rows: flattenTranscriptSections(sections),
  };
}
