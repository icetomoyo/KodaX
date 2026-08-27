import { ToolCallStatus, type HistoryItem, type Theme, type ToolCall } from "../types.js";
import type { IterationRecord } from "../contexts/StreamingContext.js";
import { buildDiffRows, type DiffRowKind } from "./diff-rows.js";
import { calculateVisualLayout } from "./textUtils.js";
import {
  collapseToolCalls,
  formatCollapsedToolInlineText,
  formatToolResultExplanation,
  formatLiveToolLabel,
  resolveToolExplanationTone,
  stripRolePrefix,
} from "./tool-display.js";
import { truncateUserMessageForDisplay } from "./user-message-display.js";
import { stripOuterBlankLines } from "./strip-outer-blank-lines.js";
import { stripAnsi } from "./strip-ansi.js";

/**
 * FEATURE_141 (v0.7.37) wired a colored `<DiffHunk>` component, but the live
 * transcript renders through the flat `TranscriptRow[]` model (FEATURE_172/214
 * windowing), not the React component tree — so that path was never reached and
 * file edits showed no diff. The dead DiffHunk/parse-unified-diff components
 * were removed; mutation-tool diffs now flow through `buildDiffRows`
 * (diff-rows.ts): line-number gutter, add/remove background bars, and
 * changed-lines-first folding, rendered as colored rows inline in the
 * transcript without leaving the row model.
 */
const MUTATION_TOOL_NAMES = new Set([
  "edit",
  "write",
  "multi_edit",
  "insert_after_anchor",
]);

/** Default fold cap for an inline diff body when not in show-all mode. */
const DIFF_PREVIEW_MAX_LINES = 20;

function isMutationTool(tool: ToolCall): boolean {
  return MUTATION_TOOL_NAMES.has(stripRolePrefix(tool.name).trim().toLowerCase());
}

function colorForDiffRow(kind: DiffRowKind): TranscriptColorToken {
  switch (kind) {
    case "add":
      return "success";
    case "remove":
      return "error";
    case "context":
      // Context rows carry no background bar, so their foreground must stay
      // legible on its own. "dim" gets double-dimmed (#666666 plus the
      // renderer's dimColor flag) and becomes unreadable; the muted prose
      // gray keeps hierarchy while staying readable.
      return "thinking";
    default:
      return "dim"; // notes (banner / LSP dump): intentionally quiet
  }
}

function bgForDiffRow(kind: DiffRowKind): TranscriptRow["bg"] {
  if (kind === "add") return "diffAdd";
  if (kind === "remove") return "diffRemove";
  return undefined;
}

/**
 * Emit colored diff rows for a mutation tool result. Returns true if any diff
 * row was emitted (so the caller can skip the generic dim-output branch and
 * avoid double-rendering).
 */
function pushDiffRows(
  rows: TranscriptRow[],
  keyPrefix: string,
  output: string,
  viewportWidth: number,
  showAllContent: boolean,
): boolean {
  const result = buildDiffRows(output, {
    maxRows: DIFF_PREVIEW_MAX_LINES,
    showAll: showAllContent,
  });
  // Only render when the result actually contains added/removed lines. A
  // `write` that creates a new file emits a summary ("File created: … / N
  // lines written") with no diff — fall through to the normal output path so
  // we don't surface an orphaned stat line.
  if (!result) return false;

  result.rows.forEach((row, index) => {
    pushWrappedRows(
      rows,
      `${keyPrefix}-diff-${index}`,
      row.text,
      getBodyWidth(viewportWidth, 4),
      {
        color: colorForDiffRow(row.kind),
        bg: bgForDiffRow(row.kind),
        indent: 4,
      },
    );
  });
  if (result.hiddenRowCount > 0) {
    pushWrappedRows(
      rows,
      `${keyPrefix}-diff-more`,
      `... (${result.hiddenRowCount} more lines, Ctrl+O then Ctrl+E to expand)`,
      getBodyWidth(viewportWidth, 4),
      { color: "dim", indent: 4 },
    );
  }
  return true;
}

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
  /**
   * Optional row background accent for diff rows. Resolved to
   * theme.colors.diffAddBackground / diffRemoveBackground by the row
   * renderer; a pure function of the diff text, so row fingerprints
   * (key + text) stay sufficient for section identity.
   */
  bg?: "diffAdd" | "diffRemove";
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
  managedPhase?: "starting" | "routing" | "preflight" | "round" | "worker" | "upgrade" | "verifying" | "completed";
  managedHarnessProfile?: string;
  managedWorkerTitle?: string;
  managedRound?: number;
  managedMaxRounds?: number;
  managedGlobalWorkBudget?: number;
  managedBudgetUsage?: number;
  managedBudgetApprovalRequired?: boolean;
  lastLiveActivityLabel?: string;
  liveStatusLines?: readonly string[];
  /**
   * FEATURE_149 (v0.7.38) — when a todo item is `in_progress` and carries
   * an `activeForm` string, the spinner status line uses it as the leader
   * verb (e.g. "Running failing tests..."). Mirrors Claude Code's
   * `Spinner.tsx:169` `currentTodo?.activeForm` lookup. When undefined,
   * falls back to the legacy `currentTool` / `isThinking` cascade.
   */
  currentTodoActiveForm?: string;
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

/**
 * FEATURE_220 (v0.7.47) — collapse a finalized `thinking` block to a single
 * summary line by default, so a run of think→call→think reads as one compact
 * "agent working" block instead of a stack of full reasoning dumps. Mirrors
 * Claude Code's `∴ Thinking <Ctrl+O to expand>` fold and Codex/opencode's
 * one-line reasoning summary. Expanding (Ctrl+O → `showFullThinking`, or
 * transcript show-all → `showAllContent`) bypasses the fold entirely. Set
 * `KODAX_THINKING_COLLAPSE=0` to restore the legacy multi-line preview inline.
 *
 * Collapse is a pure function of the finalized item text, so a thinking
 * section's rendered rows stay identical across frames — the inline scrollback
 * ledger keeps appending finalized history rather than rebuilding it.
 */
const THINKING_COLLAPSE_SUMMARY_MAX_CHARS = 120;
const THINKING_COLLAPSE_EXPAND_HINT = " … (Ctrl+O to expand)";

function isThinkingCollapseEnabled(): boolean {
  return process.env.KODAX_THINKING_COLLAPSE !== "0";
}

/**
 * Reduce a thinking block to a single summary line plus a flag for whether
 * anything is hidden behind it. `hasMore` is false only when the whole block
 * already fits on one short line — in that case the caller renders it verbatim
 * (no fold, no expand hint), so short reasoning is untouched.
 */
export function buildCollapsedThinkingLine(text: string): {
  summary: string;
  hasMore: boolean;
} {
  const nonEmpty = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = nonEmpty[0] ?? "";
  const multiLine = nonEmpty.length > 1;
  const tooLong = firstLine.length > THINKING_COLLAPSE_SUMMARY_MAX_CHARS;
  const summary = tooLong
    ? `${firstLine.slice(0, THINKING_COLLAPSE_SUMMARY_MAX_CHARS).trimEnd()}…`
    : firstLine;
  return { summary, hasMore: multiLine || tooLong };
}

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

export function buildThinkingPreview(
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
    if (items[i]?.type === "user" && items[i]?.isSessionUiOnly !== true) {
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
  const plainText = stripAnsi(text);
  const lines = wrapText(plainText, width);
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

  // Default-on colored diff for file mutations: edit / write / multi_edit /
  // insert_after_anchor embed unified-diff text in their result string. Render
  // it inline (green added / red removed) regardless of `showDetailedTools` so
  // edits are visible at a glance; folded unless show-all is active.
  const renderedDiff =
    tool.status === ToolCallStatus.Success &&
    typeof tool.output === "string" &&
    tool.output.trim().length > 0 &&
    isMutationTool(tool) &&
    pushDiffRows(rows, `${itemKey}-tool-${tool.id}`, tool.output, viewportWidth, showAllContent);

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

  if (showDetailedTools && !renderedDiff && typeof tool.output === "string" && tool.output.trim()) {
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
    liveStatusLines = [],
    currentTodoActiveForm,
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
        // Strip OUTER blank lines from the body before wrapping. The model
        // output frequently ends with a trailing newline; `wrapText` turns
        // that into an empty visual row, which then stacks on top of the
        // fixed `${id}-blank` spacer below — two blank lines between the
        // answer and the next tool/assistant block instead of one. Internal
        // blank lines (paragraph breaks) are preserved. Mirrors the `info`
        // row's normalization; display-only, the stored text is untouched.
        const displayText = stripOuterBlankLines(
          showAllContent ? item.text : item.compactText ?? item.text
        );
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
          pushWrappedRows(rows, `${item.id}-header`, "Thinking", viewportWidth, {
            color: "thinking",
            italic: true,
            itemId: item.id,
          });
          // FEATURE_220: fold a finalized thinking block to one summary line by
          // default. Only fold when there is genuinely something hidden behind
          // the summary (`hasMore`) — a short single-line block falls through to
          // the legacy preview path below and renders verbatim. Expanding
          // (showFullThinking / showAllContent) or KODAX_THINKING_COLLAPSE=0
          // also skips the fold.
          const collapsed =
            isThinkingCollapseEnabled() && !showFullThinking && !showAllContent
              ? buildCollapsedThinkingLine(item.compactText ?? item.text)
              : undefined;
          if (collapsed?.hasMore) {
            pushWrappedRows(
              rows,
              `${item.id}-body`,
              `${collapsed.summary}${THINKING_COLLAPSE_EXPAND_HINT}`,
              getBodyWidth(viewportWidth, 2),
              { color: "thinking", indent: 2, italic: true, itemId: item.id },
            );
            rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
            break;
          }
          // FEATURE_060 Track 3: route show-all through buildThinkingPreview
          // so the per-block hard char cap fires even when showAllContent is
          // true. The previous short-circuit `showAllContent ? item.text : ...`
          // bypassed all caps in show-all mode.
          const preview = showAllContent
            ? buildThinkingPreview(item.text, maxLines, showFullThinking, showAllContent)
            : item.compactText ?? buildThinkingPreview(item.text, maxLines, showFullThinking, showAllContent);
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
          `${item.icon ?? "\u2139"} ${stripOuterBlankLines(showAllContent ? item.text : item.compactText ?? item.text)}`,
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
      case "sidecar": {
        const sidecarLabel = item.delivery === "budget-exhausted"
          ? "⚡ Sidecar Verifier — budget exhausted"
          : item.verdict === "blocked"
          ? "⚡ Sidecar Verifier — blocked"
          : "⚡ Sidecar Verifier — revise";
        pushWrappedRows(
          rows,
          `${item.id}-header`,
          `${sidecarLabel} [${formatTimestamp(item.timestamp)}]`,
          viewportWidth,
          { color: "warning", bold: true, itemId: item.id },
        );
        pushWrappedRows(rows, `${item.id}-body`, item.text, getBodyWidth(viewportWidth, 2), {
          color: "dim",
          indent: 2,
          itemId: item.id,
        });
        rows.push({ key: `${item.id}-blank`, text: " ", itemId: item.id });
        break;
      }
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
    const normalizedLiveActivityLabel = normalizeManagedLiveActivityLabel(lastLiveActivityLabel, managedWorkerTitle);
    // FEATURE_114 v0.7.38 Slice 7 — preflight prefix derives the role
    // label from `managedWorkerTitle`. The runner emits 'Worker' on
    // V2 preflight and 'Scout' on V1; previously this branch
    // hardcoded 'Scout' and only appended a non-Scout title as a
    // suffix, so V2 sessions rendered '[AMA Scout - Worker]' instead
    // of '[AMA Worker]'. Falling back to 'Scout' keeps legacy
    // transcripts unchanged when the title is missing.
    const preflightRole = managedWorkerTitle ?? "Scout";
    const managedPrefix = managedPhase === "routing"
      ? `[${managedAgentMode ? managedAgentMode.toUpperCase() : 'AMA'} Routing] `
      : managedPhase === "preflight"
        ? `[${managedAgentMode ? managedAgentMode.toUpperCase() : 'AMA'} ${preflightRole}] `
        : managedPhase === "verifying"
          ? `[${managedAgentMode ? managedAgentMode.toUpperCase() : 'AMA'} Verifying] `
          : managedHarnessProfile
            ? `[${managedAgentMode ? managedAgentMode.toUpperCase() : 'AMA'} ${managedWorkerTitle ?? 'Worker'}] `
            : "";
    const activeToolCount = activeToolCalls.filter((tool) => tool.status === ToolCallStatus.Executing).length;
    const completedToolCount = activeToolCalls.filter((tool) => tool.status === ToolCallStatus.Success).length;
    const erroredToolCount = activeToolCalls.filter((tool) => tool.status === ToolCallStatus.Error).length;
    const cancelledToolCount = activeToolCalls.filter((tool) => tool.status === ToolCallStatus.Cancelled).length;
    const shouldRenderLiveToolBlock = activeToolCalls.length > 0 && (activeToolCount > 0 || !streamingResponse);

    if (isCompacting) {
      loadingText = "Compacting";
    } else if (managedPhase === "verifying") {
      // FEATURE_184 Phase D.3 — sidecar verifier is running out-of-chain
      // (3-10s on inherit-main provider). No main-loop tool / thinking
      // signals fire during this window, so override the default cascade
      // to keep the spinner readable instead of falling through to
      // "Thinking..." which would misattribute the work to the Worker.
      prefix = managedPrefix;
      loadingText = "checking agent output";
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
    } else if (currentTodoActiveForm) {
      // FEATURE_149 (v0.7.38) — activeForm-driven spinner, mirroring CC's
      // `Spinner.tsx:169` `currentTodo?.activeForm` lookup. When the LLM
      // marks a todo `in_progress` with an `activeForm` like
      // "Running failing tests", the spinner immediately shows that verb
      // in place of the generic "[Tool] read..." or "[Thinking]
      // processing" fallback. Tools / thinking still happen — this just
      // gives the user a higher-level "what is the agent working on right
      // now" cue while they happen.
      prefix = managedPrefix || "[Plan] ";
      loadingText = currentTodoActiveForm;
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

  if (showLiveProgressRows && liveStatusLines.length > 0) {
    pushWrappedRows(rows, "live-status-header", "Live status", viewportWidth, {
      color: "dim",
      bold: true,
    });
    liveStatusLines.forEach((line, index) => {
      pushWrappedRows(
        rows,
        `live-status-${index}`,
        line,
        getBodyWidth(viewportWidth, 2),
        { color: "dim", indent: 2 },
      );
    });
    pushBlankRow(rows, "live-status-blank");
  }

  if (streamingResponse) {
    // FEATURE_149 (v0.7.38) — line-buffered streaming render. Mirror Claude
    // Code's `REPL.tsx:1473` `streamingText.substring(0, lastIndexOf('\n')+1)`:
    // only show COMPLETE lines while a token stream is in flight. The
    // currently-being-typed line is hidden until its `\n` arrives, so the
    // user sees lines materialize whole instead of flickering character by
    // character as deltas land. Once the round completes the full final
    // text lands in transcript history (which renders unfiltered), so no
    // tail content is lost.
    const lastNewline = streamingResponse.lastIndexOf("\n");
    const visibleStreaming =
      lastNewline >= 0 ? streamingResponse.slice(0, lastNewline + 1) : "";
    if (visibleStreaming.length > 0) {
      pushWrappedRows(rows, "streaming-header", "Assistant", viewportWidth, {
        color: "secondary",
        bold: true,
      });
      pushWrappedRows(rows, "streaming-body", visibleStreaming, getBodyWidth(viewportWidth, 2), {
        color: "text",
        indent: 2,
      });
      pushBlankRow(rows, "streaming-blank");
    }
  }

  return rows;
}

export function buildStaticTranscriptSections(
  items: HistoryItem[],
  viewportWidth: number,
  maxLines = 1000,
  showDetailedTools = false,
  showAllContent = false,
  showFullThinking = false,
): TranscriptSection[] {
  return buildHistoryItemTranscriptSections(items, viewportWidth, maxLines, showDetailedTools, undefined, showAllContent, showFullThinking);
}

/**
 * FEATURE_214 (v0.7.46) perf — per-item transcript-section cache.
 *
 * The owned (fullscreen, windowed) render model keeps the WHOLE transcript
 * "active" — `buildTranscriptStaticPortion({ windowed: true })` puts every item
 * in `activeItems`, so `buildHistoryItemTranscriptSections` re-wraps ALL
 * committed items on every 80ms streaming flush (the streaming text itself is a
 * separate pending section). Measured cost is strictly linear, ~0.09ms/item, so
 * a long resumed session (~2-3K items) re-wraps for ~200-300ms PER FLUSH — the
 * 3-6fps streaming stutter the spinner can't keep up with.
 *
 * Committed items are immutable (any content change produces a new object — the
 * same invariant the surrounding `useMemo`/`buildPromptSurfaceItems` chain already
 * relies on), so a WeakMap keyed by the item reference returns the prior section
 * untouched. The param signature invalidates on viewport-width / show-flag /
 * per-item-expand changes (resize, Ctrl+E, Ctrl+R). WeakMap auto-evicts on GC, so
 * there is no unbounded growth. Output is byte-identical to the uncached map — a
 * pure memoization, verified by transcript-layout.test.ts.
 */
const _itemSectionCache = new WeakMap<
  HistoryItem,
  { sig: string; section: TranscriptSection }
>();

/**
 * FEATURE_220 (v0.7.47) — items whose blocks form a continuous "agent working"
 * run. Within a maximal run of consecutive thinking/tool_group items, the blank
 * spacer between members is dropped so the run reads as one block; the run's
 * last member keeps its blank, separating it from the following assistant text /
 * user turn. Set `KODAX_TRANSCRIPT_TIGHT=0` to restore per-item spacing.
 */
const TIGHT_RUN_ITEM_TYPES: ReadonlySet<HistoryItem["type"]> = new Set([
  "thinking",
  "tool_group",
]);

function isTightRunSpacingEnabled(): boolean {
  return process.env.KODAX_TRANSCRIPT_TIGHT !== "0";
}

/**
 * Drop the trailing blank row of each run-member section that is itself followed
 * by another run member. Pure: returns new section objects only for the trimmed
 * entries (immutability — the per-item cache keeps the untrimmed originals).
 * Deterministic from item order, so inline scrollback fingerprints stay stable.
 */
function suppressTightRunBlanks(
  items: readonly HistoryItem[],
  sections: TranscriptSection[],
): TranscriptSection[] {
  if (!isTightRunSpacingEnabled()) {
    return sections;
  }
  return sections.map((section, index) => {
    const item = items[index];
    const next = items[index + 1];
    if (
      !item ||
      !next ||
      !TIGHT_RUN_ITEM_TYPES.has(item.type) ||
      !TIGHT_RUN_ITEM_TYPES.has(next.type)
    ) {
      return section;
    }
    const rows = section.rows;
    const last = rows[rows.length - 1];
    if (last && last.text === " " && last.key.endsWith("-blank")) {
      return { ...section, rows: rows.slice(0, -1) };
    }
    return section;
  });
}

export function buildHistoryItemTranscriptSections(
  items: HistoryItem[],
  viewportWidth: number,
  maxLines = 1000,
  showDetailedTools = false,
  expandedItemKeys?: ReadonlySet<string>,
  showAllContent = false,
  showFullThinking = false,
): TranscriptSection[] {
  const sections = items.map((item) => {
    const expanded = showDetailedTools || Boolean(expandedItemKeys?.has(item.id));
    // FEATURE_220: the thinking-collapse mode (KODAX_THINKING_COLLAPSE) and the
    // showFullThinking expand both change a thinking item's rendered rows, so
    // they MUST be part of the cache key — else a toggle would serve stale
    // sections for a reused item reference.
    const sig = `${viewportWidth}|${maxLines}|${showAllContent ? 1 : 0}|${expanded ? 1 : 0}|${isThinkingCollapseEnabled() ? 1 : 0}|${showFullThinking ? 1 : 0}`;
    const cached = _itemSectionCache.get(item);
    if (cached !== undefined && cached.sig === sig) {
      return cached.section;
    }
    const section: TranscriptSection = {
      key: item.id,
      rows: buildTranscriptRows({
        items: [item],
        viewportWidth,
        maxLines,
        showAllContent,
        showDetailedTools: expanded,
        showFullThinking,
      }),
    };
    _itemSectionCache.set(item, { sig, section });
    return section;
  });
  return suppressTightRunBlanks(items, sections);
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

/**
 * FEATURE_172 P1.1 (v0.7.41) — render-model split helpers.
 *
 * The data layer is partitioned into three pure functions so the InkREPL
 * useMemo chain can cache the expensive static portion independently
 * from the streaming-state-dependent dynamic portion:
 *
 *   buildTranscriptStaticPortion  — items[..activeRoundStart] → row sections
 *                                   Depends ONLY on items + viewportWidth +
 *                                   maxLines + show* flags. Recomputes
 *                                   rarely (round boundary, resize).
 *   buildTranscriptDynamicPortion — activeItems[..] + streaming-state
 *                                   → row sections + preview. Recomputes
 *                                   per 80ms StreamingContext flush; cheap
 *                                   because activeItems is typically 1-5.
 *   composeTranscriptRenderModel  — Stitches the two portions back into
 *                                   the canonical TranscriptRenderModel
 *                                   shape downstream MessageList consumes.
 *
 * `buildTranscriptRenderModel` is preserved as the original entry point
 * (now implemented in terms of these three) so all 65 existing
 * transcript-layout.test.ts cases + 8 golden snapshots + 22 edge cases
 * pass byte-equal — refactor parity, not behavior change.
 */
export interface TranscriptStaticBuildOptions {
  items: HistoryItem[];
  viewportWidth: number;
  maxLines?: number;
  showDetailedTools?: boolean;
  showAllContent?: boolean;
  showFullThinking?: boolean;
  windowed?: boolean;
}

export interface TranscriptStaticPortion {
  staticSections: TranscriptSection[];
  activeItems: HistoryItem[];
}

export function buildTranscriptStaticPortion(
  options: TranscriptStaticBuildOptions,
): TranscriptStaticPortion {
  const {
    items,
    viewportWidth,
    maxLines = 1000,
    showDetailedTools = false,
    showAllContent = false,
    showFullThinking = false,
    windowed = false,
  } = options;

  if (windowed) {
    // Owned-viewport mode: entire transcript is dynamic (app manages scroll
    // window via virtualization). No items go to the static cache.
    return { staticSections: [], activeItems: items };
  }

  const activeRoundStartIndex = findActiveRoundStartIndex(items);
  const staticItems = items.slice(0, activeRoundStartIndex);
  const activeItems = items.slice(activeRoundStartIndex);
  const staticSections = buildStaticTranscriptSections(
    staticItems,
    viewportWidth,
    maxLines,
    showDetailedTools,
    showAllContent,
    showFullThinking,
  );
  return { staticSections, activeItems };
}

export interface TranscriptDynamicBuildOptions
  extends Omit<TranscriptBuildOptions, "items"> {
  activeItems: HistoryItem[];
  showDetailedTools?: boolean;
  showAllContent?: boolean;
  expandedItemKeys?: ReadonlySet<string>;
}

export interface TranscriptDynamicPortion {
  sections: TranscriptSection[];
  previewSections: TranscriptSection[];
}

export function buildTranscriptDynamicPortion(
  options: TranscriptDynamicBuildOptions,
): TranscriptDynamicPortion {
  const {
    activeItems,
    viewportWidth,
    maxLines = 1000,
    showDetailedTools = false,
    showAllContent = false,
    showFullThinking = false,
    expandedItemKeys,
    ...dynamicOptions
  } = options;

  const sections = buildHistoryItemTranscriptSections(
    activeItems,
    viewportWidth,
    maxLines,
    showDetailedTools,
    expandedItemKeys,
    showAllContent,
    showFullThinking,
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
    // FEATURE_220 P1 closure: the live streaming thinking (thinkingContent) also
    // honours showFullThinking, so transcript mode (Ctrl+O) expands the in-flight
    // reasoning too, not just the finalized history sections.
    showFullThinking,
    expandedItemKeys,
  });
  const previewSections = pendingSection.rows.length > 0
    ? [pendingSection]
    : [];

  return { sections, previewSections };
}

export function composeTranscriptRenderModel(
  staticPortion: TranscriptStaticPortion,
  dynamicPortion: TranscriptDynamicPortion,
): TranscriptRenderModel {
  return {
    staticSections: staticPortion.staticSections,
    sections: dynamicPortion.sections,
    rows: flattenTranscriptSections(dynamicPortion.sections),
    previewSections: dynamicPortion.previewSections,
    previewRows: flattenTranscriptSections(dynamicPortion.previewSections),
  };
}

/**
 * FEATURE_214 Phase 2b — assemble the INLINE prompt render model.
 *
 * Unlike the transcript surface (which `materializeTranscriptRenderModel`-merges
 * finalized + dynamic into one `rows` array so a windowed viewport can paint a
 * complete frame), the inline prompt must keep finalized history in `staticSections`
 * and OUT of `rows`. That routes finalized through `<Static>` → the engine's
 * `hasStaticOutput` branch (erase live region → write the block into native
 * scrollback ONCE → repaint the live region), so finalized history never enters the
 * live cell-frame — killing the growing-path duplication (docs/features/v0.7.46.md
 * §4). The banner joins `staticSections` so it, too, commits to scrollback once at
 * the top of the session rather than re-painting in the live frame each render.
 */
export function buildInlinePromptRenderModel(
  staticPortion: TranscriptStaticPortion,
  dynamicPortion: TranscriptDynamicPortion,
  bannerSection: TranscriptSection | undefined,
): TranscriptRenderModel {
  const composed = composeTranscriptRenderModel(staticPortion, dynamicPortion);
  if (!bannerSection) {
    return composed;
  }
  return {
    ...composed,
    staticSections: [bannerSection, ...composed.staticSections],
  };
}

export interface InlineLedgerSplit {
  /**
   * The unified scrollback commit source = finalized history rows + the active round's
   * overflow rows (completed-item AND already-stable streaming lines, minus mutable
   * spinner rows), as ONE positional 1-row section per line. Both the section key AND the
   * row's key are normalised to positional `il-${i}` so the per-line fingerprint depends
   * ONLY on position + text — NOT on the original row key. That is what makes finalize
   * align: a row rendered while "active" and the SAME content rendered after it moves into
   * finalized history land at the same position with the same text, so the ledger sees a
   * prefix match and APPENDS the previously-live tail rather than rebuilding (a raw row key
   * differs across that transition and would force a full rebuild; the Assistant header's
   * timestamp difference is handled by the caller's `identifyInlineCommitSection`).
   * Transcript rows only — input/footer/status are separate React nodes, never here.
   */
  readonly committedSections: TranscriptSection[];
  /** The bounded live tail rendered in the live frame (≤ liveBudget rows). */
  readonly liveRows: TranscriptRow[];
}

/**
 * FEATURE_214 — split the inline active round into {committed scrollback source,
 * bounded live tail} for the ledger=1 path. Pure.
 *
 * The active block = `completedRows` (completed-item rows) + `previewRows` (the in-flight
 * streaming render). The live frame is a HARD CAP — ALWAYS the last `liveBudget` rows — so
 * a spinner anywhere can never inflate it. Everything above overflows into the commit
 * source (joined after finalized history), INCLUDING already-stable streaming lines, so a
 * long streaming answer's body does not stay live (the unbounded-preview bug). Completed
 * rows are byte-identical to their post-finalization render (same
 * `buildHistoryItemTranscriptSections`) so they align positionally; the streaming header's
 * timestamp difference is reconciled by the caller's `identifyInlineCommitSection`
 * (timestamp-insensitive fingerprint). The ONLY thing dropped from the overflow is a
 * mutable spinner row (`row.spinner`) — a transient animation must never freeze into
 * scrollback; the current spinner stays in the bounded live tail and is shown there.
 */
export function splitInlineLedgerModel(
  finalizedSections: readonly TranscriptSection[],
  completedRows: readonly TranscriptRow[],
  previewRows: readonly TranscriptRow[],
  liveBudget: number,
): InlineLedgerSplit {
  const budget = Number.isFinite(liveBudget) ? Math.max(1, Math.floor(liveBudget)) : 1;
  // The active block = completed-item rows + the streaming preview rows. The live frame is
  // a TRUE HARD CAP: ALWAYS the last `budget` rows of the active block — a spinner anywhere
  // (even at the top) can never inflate it. Everything above the last `budget` rows
  // overflows into the commit source, INCLUDING already-stable streaming lines (so a long
  // streaming answer never keeps its whole body live — the unbounded-preview bug).
  const active = [...completedRows, ...previewRows];
  const overflowCount = Math.max(0, active.length - budget);
  const liveRows = active.slice(overflowCount);
  // The overflow commits, MINUS mutable spinner rows: a spinner pushed above the live
  // budget is a transient animation and must NEVER be frozen into scrollback, so it is
  // dropped (not committed); the current spinner lives in the bounded tail and is shown
  // there. Dropping it is safe — the finalized render has no spinner, so the committed
  // (spinner-free) prefix still aligns at finalize.
  const finalizedRows = finalizedSections.flatMap((section) => section.rows);
  const overflowStable = active.slice(0, overflowCount).filter((row) => row.spinner !== true);
  const committedRows = [...finalizedRows, ...overflowStable];
  const committedSections: TranscriptSection[] = committedRows.map((row, index) => ({
    key: `il-${index}`,
    // Normalise the row key to positional so the fingerprint is position+text only
    // (Codex review): the raw key differs between the active and finalized renders of
    // the same content. (Timestamp text differences are handled by the commit-time
    // canonical identify — see identifyInlineCommitSection.)
    rows: [{ ...row, key: `il-${index}` }],
  }));
  return { committedSections, liveRows };
}

/**
 * FEATURE_214 — strip a trailing ` [HH:MM …]` header timestamp for inline-commit
 * fingerprinting. The streaming render emits an `Assistant` header WITHOUT a timestamp
 * while the finalized render emits `Assistant [02:24 PM]`; without this, the same
 * committed line would mismatch at finalize and force a full ledger rebuild. The
 * DISPLAYED text is untouched — only the fingerprint is canonicalised.
 */
function stripHeaderTimestamp(text: string): string {
  // ONLY a full header row "You|Assistant|Tools|System [HH:MM …]" → its prefix word.
  // A body line that merely ends in "[02:24 PM]" must KEEP its identity (not be stripped
  // and mis-aligned with another line), so the match is anchored to the whole row.
  return text.replace(/^(You|Assistant|Tools|System) \[\d{1,2}:\d{2}[^\]]*\]$/u, "$1");
}

/**
 * Canonical section identity for the inline scrollback commit: positional key + a
 * timestamp-insensitive content fingerprint. Drop-in for `identifyTranscriptSection`
 * (djb2 over each row's key + text) but on timestamp-stripped text,
 * so a streamed line and its post-finalization render align (append, never rebuild).
 */
export function identifyInlineCommitSection(section: TranscriptSection): {
  key: string;
  fingerprint: string;
} {
  let hash = 5381;
  for (const row of section.rows) {
    const text = stripHeaderTimestamp(row.text);
    for (let i = 0; i < row.key.length; i++) hash = ((hash << 5) + hash + row.key.charCodeAt(i)) | 0;
    hash = ((hash << 5) + hash + 0) | 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    hash = ((hash << 5) + hash + 1) | 0;
  }
  return { key: section.key, fingerprint: `${hash >>> 0}` };
}

export function buildTranscriptRenderModel(
  options: TranscriptRenderModelOptions,
): TranscriptRenderModel {
  // Implemented in terms of the split helpers — preserves byte-equal output
  // (verified by transcript-layout.test.ts + transcript-render-golden.test.ts).
  const staticPortion = buildTranscriptStaticPortion({
    items: options.items,
    viewportWidth: options.viewportWidth,
    maxLines: options.maxLines,
    showDetailedTools: options.showDetailedTools,
    showAllContent: options.showAllContent,
    showFullThinking: options.showFullThinking,
    windowed: options.windowed,
  });
  const { items: _items, ...rest } = options;
  const dynamicPortion = buildTranscriptDynamicPortion({
    ...rest,
    activeItems: staticPortion.activeItems,
  });
  return composeTranscriptRenderModel(staticPortion, dynamicPortion);
}

export function flattenTranscriptSections(sections: TranscriptSection[]): TranscriptRow[] {
  return sections.flatMap((section) => section.rows);
}

/**
 * FEATURE_214 — derive an inline-scrollback ledger identity for a rendered section:
 * its stable `key` + a content `fingerprint` over the rendered row text. An in-place
 * content edit, reorder, or compact changes the fingerprint (→ ledger rebuild); a
 * pure terminal-width change is handled separately by the ledger's width check, so a
 * width-dependent row fingerprint is acceptable here. Cheap djb2 over `key\0text`
 * per row, prefixed with the row count to make collisions vanishingly unlikely.
 */
export function identifyTranscriptSection(section: TranscriptSection): {
  key: string;
  fingerprint: string;
} {
  let hash = 5381;
  for (const row of section.rows) {
    const cell = `${row.key}\u0000${row.text}\u0001`;
    for (let i = 0; i < cell.length; i++) {
      hash = (Math.imul(hash, 33) + cell.charCodeAt(i)) | 0;
    }
  }
  return {
    key: section.key,
    fingerprint: `${section.rows.length}:${(hash >>> 0).toString(36)}`,
  };
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
    if (items[i]?.type === "user" && items[i]?.isSessionUiOnly !== true) {
      userCount++;
      if (userCount > maxRounds) {
        startIndex = i + 1;
        break;
      }
    }
  }

  return items.slice(startIndex);
}

export function sliceHistoryToRecentCanonicalItems(
  items: HistoryItem[],
  maxCanonicalItems: number,
): HistoryItem[] {
  if (maxCanonicalItems <= 0 || items.length === 0) return [];
  let canonicalCount = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.isSessionUiOnly === true) continue;
    canonicalCount += 1;
    if (canonicalCount > maxCanonicalItems) return items.slice(index + 1);
  }
  return items;
}

export function transcriptRenderCapForHistory(
  items: readonly HistoryItem[],
  canonicalCap: number = TRANSCRIPT_RENDER_CAP,
): number {
  const uiOnlyCount = items.reduce(
    (count, item) => count + (item.isSessionUiOnly === true ? 1 : 0),
    0,
  );
  return canonicalCap + uiOnlyCount;
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

// Synthetic-divider helpers for the transcript-mode 30-item compact cap
// (FEATURE_060 Tier 2). When the cap hides earlier rounds the InkREPL
// useMemo prepends `buildTranscriptHiddenDivider(hiddenCount, ts)` so the
// user sees `↑ N earlier messages hidden — press Ctrl+E to show all`
// instead of a silent slice. The id is a stable sentinel so selection /
// search / scrollback-dump can skip it via `isTranscriptHiddenDivider`.
export const TRANSCRIPT_HIDDEN_DIVIDER_ID = "__transcript_hidden_divider__";

export function buildTranscriptHiddenDivider(
  hiddenCount: number,
  anchorTimestamp?: number,
): HistoryItem {
  const noun = hiddenCount === 1 ? "message" : "messages";
  return {
    id: TRANSCRIPT_HIDDEN_DIVIDER_ID,
    type: "info",
    timestamp: anchorTimestamp ? Math.max(0, anchorTimestamp - 1) : 0,
    text: `${hiddenCount} earlier ${noun} hidden — press Ctrl+E to show all`,
    icon: "↑",
  };
}

export function isTranscriptHiddenDivider(item: HistoryItem): boolean {
  return item.id === TRANSCRIPT_HIDDEN_DIVIDER_ID;
}
