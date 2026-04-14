import { calculateVisualLayout } from "./textUtils.js";
import {
  HELP_BAR_HORIZONTAL_PADDING,
  HELP_MENU_CHROME_ROWS,
  HELP_BAR_SPACER_ROWS,
  buildHelpMenuSections,
} from "../constants/layout.js";

export interface ViewportBudgetSelectRequest {
  kind: "select";
  title: string;
  options: Array<{ label: string; description?: string }>;
  buffer: string;
  error?: string;
}

export interface ViewportBudgetInputRequest {
  kind: "input";
  prompt: string;
  defaultValue?: string;
  buffer: string;
  error?: string;
}

export type ViewportBudgetUIRequest =
  | ViewportBudgetSelectRequest
  | ViewportBudgetInputRequest;

export type ViewportBudgetSurfaceMode = "inline" | "overlay";

export interface ViewportBudgetHistorySearchState {
  query: string;
  selectedExcerpt?: string;
  matchCount: number;
}

export interface ViewportBudgetOptions {
  terminalRows: number;
  terminalWidth: number;
  windowedTranscript?: boolean;
  inputText: string;
  inputPrompt?: string;
  footerHeaderText?: string;
  activitySummary?: string;
  pendingInputSummary?: string;
  stashNoticeSummary?: string;
  notificationSummary?: string;
  statusNoticeSummary?: string;
  workStripText?: string;
  suggestionsReserved: boolean;
  suggestionsMode?: ViewportBudgetSurfaceMode;
  showHelp: boolean;
  statusBarText: string;
  confirmPrompt?: string;
  confirmInstruction?: string;
  uiRequest?: ViewportBudgetUIRequest | null;
  dialogMode?: ViewportBudgetSurfaceMode;
  historySearch?: ViewportBudgetHistorySearchState | null;
  maxVisibleSelectOptions?: number;
  reviewHint?: string;
}

export type ViewportBudgetSlotName =
  | "transcript"
  | "footer"
  | "overlay"
  | "status"
  | "task-bar";

export interface ViewportBudgetSlot {
  name: ViewportBudgetSlotName;
  rows: number;
}

export interface ViewportBudgetResult {
  messageRows: number;
  reservedBottomRows: number;
  headerRows: number;
  activityRows: number;
  pendingInputRows: number;
  stashNoticeRows: number;
  notificationRows: number;
  workStripRows: number;
  inputRows: number;
  suggestionsRows: number;
  helpRows: number;
  statusNoticeRows: number;
  statusRows: number;
  confirmRows: number;
  uiRequestRows: number;
  historySearchRows: number;
  footerRows: number;
  overlayRows: number;
  visibleSelectOptions: number;
  reviewHintRows: number;
  slots: ViewportBudgetSlot[];
}

function wrapLineCount(text: string, width: number): number {
  const layout = calculateVisualLayout(
    text.length > 0 ? text.split("\n") : [""],
    Math.max(1, width),
    0,
    0
  );
  return Math.max(1, layout.visualLines.length);
}

export function calculateInputPromptRows(
  inputText: string,
  terminalWidth: number,
  prompt = ">"
): number {
  const promptWidth = prompt.length + 1;
  const availableWidth = Math.max(20, terminalWidth - promptWidth);
  const layout = calculateVisualLayout(
    inputText.length > 0 ? inputText.split("\n") : [""],
    availableWidth,
    0,
    0
  );

  const contentRows = Math.max(1, layout.visualLines.length);
  // TextInput renders a top divider, the content block, and a bottom divider.
  // Prompt-specific outer padding is intentionally omitted so fullscreen bottom
  // slots stay closer to Claude's fixed footer/input stack.
  return contentRows + 2;
}

export function calculateViewportBudget(options: ViewportBudgetOptions): ViewportBudgetResult {
  const {
    terminalRows,
    terminalWidth,
    windowedTranscript = false,
    inputText,
    inputPrompt = ">",
    footerHeaderText,
    activitySummary,
    pendingInputSummary,
    stashNoticeSummary,
    notificationSummary,
    statusNoticeSummary,
    workStripText,
    suggestionsReserved,
    suggestionsMode = "inline",
    showHelp,
    statusBarText,
    confirmPrompt,
    confirmInstruction,
    uiRequest,
    dialogMode = "inline",
    historySearch,
    maxVisibleSelectOptions = 5,
    reviewHint,
  } = options;

  const headerRows = footerHeaderText
    ? wrapLineCount(footerHeaderText, Math.max(1, terminalWidth - 2))
    : 0;
  const activityRows = activitySummary
    ? wrapLineCount(activitySummary, Math.max(1, terminalWidth - 2))
    : 0;
  const pendingInputRows = pendingInputSummary
    ? wrapLineCount(pendingInputSummary, Math.max(1, terminalWidth - 2))
    : 0;
  const stashNoticeRows = stashNoticeSummary
    ? wrapLineCount(stashNoticeSummary, Math.max(1, terminalWidth - 2))
    : 0;
  const notificationRows = notificationSummary
    ? wrapLineCount(notificationSummary, Math.max(1, terminalWidth - 2))
    : 0;
  const statusNoticeRows = statusNoticeSummary
    ? wrapLineCount(statusNoticeSummary, Math.max(1, terminalWidth - 2))
    : 0;
  const workStripRows = workStripText
    ? wrapLineCount(workStripText, Math.max(1, terminalWidth - 2))
    : 0;
  const inputRows = calculateInputPromptRows(inputText, terminalWidth, inputPrompt);
  const suggestionsRows = suggestionsReserved ? 8 : 0;

  const helpRows = showHelp
    ? (
        HELP_BAR_SPACER_ROWS +
        HELP_MENU_CHROME_ROWS +
        buildHelpMenuSections().reduce((sum, section) => (
          sum +
          wrapLineCount(
            section.title,
            Math.max(1, terminalWidth - HELP_BAR_HORIZONTAL_PADDING),
          ) +
          wrapLineCount(
            section.items.map((item) => item.label).join(" | "),
            Math.max(1, terminalWidth - HELP_BAR_HORIZONTAL_PADDING),
          )
        ), 0)
      )
    : 0;

  const statusRows = wrapLineCount(statusBarText, Math.max(1, terminalWidth - 2));

  let confirmRows = 0;
  if (confirmPrompt && confirmInstruction) {
    const innerWidth = Math.max(1, terminalWidth - 4);
    confirmRows =
      1 +
      2 +
      wrapLineCount(`[Confirm] ${confirmPrompt}`, innerWidth) +
      wrapLineCount(confirmInstruction, innerWidth);
  }

  let uiRequestRows = 0;
  let visibleSelectOptions = 0;
  if (uiRequest) {
    const innerWidth = Math.max(1, terminalWidth - 4);
    if (uiRequest.kind === "select") {
      visibleSelectOptions = Math.min(maxVisibleSelectOptions, uiRequest.options.length);
      uiRequestRows =
        1 +
        2 +
        wrapLineCount(`[Select] ${uiRequest.title}`, innerWidth) +
        uiRequest.options
          .slice(0, visibleSelectOptions)
          .reduce(
            (sum, option, index) =>
              sum +
              wrapLineCount(
                `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`,
                innerWidth
              ),
            0
          ) +
        (uiRequest.options.length > visibleSelectOptions ? 2 : 0) +
        wrapLineCount(`Choice: ${uiRequest.buffer || "(type a number)"}`, innerWidth) +
        1 +
        (uiRequest.error ? wrapLineCount(uiRequest.error, innerWidth) : 0);
    } else {
      uiRequestRows =
        1 +
        2 +
        wrapLineCount(`[Input] ${uiRequest.prompt}`, innerWidth) +
        (uiRequest.defaultValue !== undefined
          ? wrapLineCount(`Default: ${uiRequest.defaultValue}`, innerWidth)
          : 0) +
        wrapLineCount(`Value: ${uiRequest.buffer || "(type your response)"}`, innerWidth) +
        1 +
        (uiRequest.error ? wrapLineCount(uiRequest.error, innerWidth) : 0);
    }
  }

  let historySearchRows = 0;
  if (historySearch) {
    const innerWidth = Math.max(1, terminalWidth - 4);
    historySearchRows =
      1 +
      2 +
      wrapLineCount(
        `Query: ${historySearch.query || "(type to search)"}`,
        innerWidth
      ) +
      (historySearch.matchCount === 0
        ? wrapLineCount("No matches yet", innerWidth)
        : wrapLineCount(
            `${Math.max(1, historySearch.matchCount)} matches`,
            innerWidth
          ) +
          wrapLineCount(historySearch.selectedExcerpt || "", innerWidth)) +
      1;
  }

  const reviewHintRows = reviewHint
    ? wrapLineCount(reviewHint, Math.max(1, terminalWidth - 2))
    : 0;

  const footerRows =
    headerRows +
    activityRows +
    pendingInputRows +
    stashNoticeRows +
    notificationRows +
    inputRows +
    helpRows +
    statusNoticeRows +
    reviewHintRows +
    (suggestionsMode === "inline" ? suggestionsRows : 0) +
    (dialogMode === "inline" ? confirmRows + uiRequestRows + historySearchRows : 0);
  const overlayRows =
    (suggestionsMode === "overlay" ? suggestionsRows : 0) +
    (dialogMode === "overlay" ? confirmRows + uiRequestRows + historySearchRows : 0);
  const reservedBottomRows =
    footerRows + workStripRows + statusRows;
  const messageRows = Math.max(
    1,
    terminalRows - reservedBottomRows
  );
  const slots: ViewportBudgetSlot[] = [
    { name: "transcript", rows: messageRows },
    { name: "footer", rows: footerRows },
    { name: "overlay", rows: overlayRows },
    { name: "status", rows: statusRows },
    { name: "task-bar", rows: workStripRows },
  ];

  return {
    messageRows,
    reservedBottomRows,
    headerRows,
    activityRows,
    pendingInputRows,
    stashNoticeRows,
    notificationRows,
    workStripRows,
    inputRows,
    suggestionsRows,
    helpRows,
    statusNoticeRows,
    statusRows,
    confirmRows,
    uiRequestRows,
    historySearchRows,
    footerRows,
    overlayRows,
    visibleSelectOptions,
    reviewHintRows,
    slots,
  };
}
