import { calculateVisualLayout } from "./textUtils.js";
import {
  HELP_BAR_HORIZONTAL_PADDING,
  HELP_BAR_SPACER_ROWS,
  buildHelpBarText,
  MESSAGE_LIST_VERTICAL_PADDING_ROWS,
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

export interface ViewportBudgetOptions {
  terminalRows: number;
  terminalWidth: number;
  inputText: string;
  inputPrompt?: string;
  pendingInputSummary?: string;
  suggestionsReserved: boolean;
  showHelp: boolean;
  statusBarText: string;
  confirmPrompt?: string;
  confirmInstruction?: string;
  uiRequest?: ViewportBudgetUIRequest | null;
  maxVisibleSelectOptions?: number;
  reviewHint?: string;
}

export interface ViewportBudgetResult {
  messageRows: number;
  reservedBottomRows: number;
  pendingInputRows: number;
  inputRows: number;
  suggestionsRows: number;
  helpRows: number;
  statusRows: number;
  confirmRows: number;
  uiRequestRows: number;
  visibleSelectOptions: number;
  reviewHintRows: number;
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
  return contentRows + 4;
}

export function calculateViewportBudget(options: ViewportBudgetOptions): ViewportBudgetResult {
  const {
    terminalRows,
    terminalWidth,
    inputText,
    inputPrompt = ">",
    pendingInputSummary,
    suggestionsReserved,
    showHelp,
    statusBarText,
    confirmPrompt,
    confirmInstruction,
    uiRequest,
    maxVisibleSelectOptions = 5,
    reviewHint,
  } = options;

  const pendingInputRows = pendingInputSummary
    ? wrapLineCount(pendingInputSummary, Math.max(1, terminalWidth - 2))
    : 0;
  const inputRows = calculateInputPromptRows(inputText, terminalWidth, inputPrompt);
  const suggestionsRows = suggestionsReserved ? 8 : 0;

  const helpRows = showHelp
    ? wrapLineCount(
        buildHelpBarText(),
        Math.max(1, terminalWidth - HELP_BAR_HORIZONTAL_PADDING)
      ) + HELP_BAR_SPACER_ROWS
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
        (uiRequest.options.length > visibleSelectOptions ? 1 : 0) +
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

  const reviewHintRows = reviewHint
    ? wrapLineCount(reviewHint, Math.max(1, terminalWidth - 2))
    : 0;

  const reservedBottomRows =
    pendingInputRows + inputRows + suggestionsRows + helpRows + statusRows + confirmRows + uiRequestRows + reviewHintRows;
  const messageRows = Math.max(
    1,
    terminalRows - reservedBottomRows - MESSAGE_LIST_VERTICAL_PADDING_ROWS
  );

  return {
    messageRows,
    reservedBottomRows,
    pendingInputRows,
    inputRows,
    suggestionsRows,
    helpRows,
    statusRows,
    confirmRows,
    uiRequestRows,
    visibleSelectOptions,
    reviewHintRows,
  };
}
