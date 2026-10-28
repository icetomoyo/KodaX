/**
 * KodaX AskUserQuestion Tool
 *
 * Lets the LLM ask the user interactive questions. Supports single-select,
 * multi-select, free-text input, and multi-question modes.
 */

import type { KodaXToolExecutionContext } from '../types.js';
import {
  ASK_USER_BACK_SIGNAL,
  ASK_USER_CUSTOM_INPUT_SIGNAL,
  isAskUserCustomInputAnswer,
  isAskUserUnanswered,
  type AskUserAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionOptions,
  type AskUserSelectionAnswer,
} from '@kodax-ai/agent';
import { CANCELLED_TOOL_RESULT_PREFIX, CANCELLED_TOOL_RESULT_MESSAGE } from '../constants.js';

const BACK_SENTINEL = ASK_USER_BACK_SIGNAL;
const CUSTOM_INPUT_SENTINEL = ASK_USER_CUSTOM_INPUT_SIGNAL;

export interface AskUserQuestionOption {
  label: string;
  description?: string;
  value?: string;
}

/** A single question within a multi-question batch. */
export interface AskUserQuestionItemInput {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multi_select?: boolean;
  /** Only meaningful when multi_select is true; see tool schema. */
  min_selections?: number;
  max_selections?: number;
  default?: string;
  allow_custom_input?: boolean;
  custom_input_label?: string;
  custom_input_prompt?: string;
  custom_input_default?: string;
}

export interface AskUserQuestionInput {
  question: string;
  kind?: 'select' | 'input';
  options?: AskUserQuestionOption[];
  multi_select?: boolean;
  /** Only meaningful when multi_select is true; see tool schema. */
  min_selections?: number;
  max_selections?: number;
  default?: string;
  allow_custom_input?: boolean;
  custom_input_label?: string;
  custom_input_prompt?: string;
  custom_input_default?: string;
  /** Multiple independent questions; takes precedence over question+options. */
  questions?: AskUserQuestionItemInput[];
}

interface NormalizedAnswer {
  value: string | string[];
  customInputs: string[];
}

function toSelectionBound(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function allowsCustomInput(value: unknown): boolean {
  return value !== false;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toHostOption(opt: AskUserQuestionOption): { label: string; description?: string; value: string } {
  const hostOption: { label: string; description?: string; value: string } = {
    label: opt.label || String(opt),
    value: opt.value || opt.label || String(opt),
  };
  if (opt.description !== undefined) hostOption.description = opt.description;
  return hostOption;
}

function addIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function normalizeSelectionAnswer(answer: AskUserSelectionAnswer): { value: string; customInput?: string } {
  if (isAskUserCustomInputAnswer(answer)) {
    return { value: answer.value, customInput: answer.value };
  }
  return { value: answer };
}

function normalizeAskUserAnswer(answer: AskUserAnswer): NormalizedAnswer {
  if (Array.isArray(answer)) {
    const normalized = answer.map(normalizeSelectionAnswer);
    return {
      value: normalized.map((item) => item.value),
      customInputs: normalized.flatMap((item) => item.customInput === undefined ? [] : [item.customInput]),
    };
  }

  const normalized = normalizeSelectionAnswer(answer);
  return {
    value: normalized.value,
    customInputs: normalized.customInput === undefined ? [] : [normalized.customInput],
  };
}

function validateReservedOptionValues(options: AskUserQuestionOption[]): string | undefined {
  for (const opt of options) {
    const resolvedValue = opt.value || opt.label || String(opt);
    if (resolvedValue === BACK_SENTINEL || resolvedValue === CUSTOM_INPUT_SENTINEL) {
      return `Option value "${resolvedValue}" is reserved and cannot be used`;
    }
  }
  return undefined;
}

function validateSelectionBounds(
  minSelections: number | undefined,
  maxSelections: number | undefined,
  selectableCount: number,
): string | undefined {
  if (
    minSelections !== undefined &&
    maxSelections !== undefined &&
    minSelections > maxSelections
  ) {
    return `min_selections (${minSelections}) cannot exceed max_selections (${maxSelections})`;
  }
  if (minSelections !== undefined && minSelections > selectableCount) {
    return `min_selections (${minSelections}) cannot exceed the number of selectable choices (${selectableCount})`;
  }
  return undefined;
}

function normalizeAnswerMap(answers: Record<string, AskUserAnswer>): {
  answers: Record<string, string | string[]>;
  customInputs: Record<string, string[]>;
} {
  const normalizedAnswers: Record<string, string | string[]> = {};
  const customInputs: Record<string, string[]> = {};

  for (const [key, answer] of Object.entries(answers)) {
    const normalized = normalizeAskUserAnswer(answer);
    normalizedAnswers[key] = normalized.value;
    if (normalized.customInputs.length > 0) {
      customInputs[key] = normalized.customInputs;
    }
  }

  return { answers: normalizedAnswers, customInputs };
}

function addCustomInputResponseFields(
  response: Record<string, unknown>,
  customInputs: string[],
  mode: 'single' | 'multi',
): void {
  if (customInputs.length === 0) return;
  if (mode === 'single') {
    response.custom_input = true;
  } else {
    response.custom_inputs = customInputs;
  }
}

/**
 * Ask user a question with multiple interaction modes.
 *
 * This tool requires context.askUser (select), context.askUserMulti
 * (multi-question), or context.askUserInput (input) from the host.
 */
export async function toolAskUserQuestion(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (Array.isArray(input.questions) && input.questions.length > 0) {
    if (!ctx.askUserMulti) {
      return '[Tool Error] ask_user_question: Multi-question mode not available (askUserMulti callback not provided)';
    }

    for (const item of input.questions as AskUserQuestionItemInput[]) {
      if (!item.question || typeof item.question !== 'string') {
        return '[Tool Error] ask_user_question: Each item in "questions" must have a "question" string';
      }
      if (!Array.isArray(item.options) || item.options.length === 0) {
        return `[Tool Error] ask_user_question: Question "${item.question}" must have a non-empty "options" array`;
      }

      const reservedError = validateReservedOptionValues(item.options);
      if (reservedError) return `[Tool Error] ask_user_question: ${reservedError}`;

      if (item.multi_select === true) {
        const allowCustom = item.allow_custom_input === undefined
          ? allowsCustomInput(input.allow_custom_input)
          : allowsCustomInput(item.allow_custom_input);
        const boundsError = validateSelectionBounds(
          toSelectionBound(item.min_selections),
          toSelectionBound(item.max_selections),
          item.options.length + (allowCustom ? 1 : 0),
        );
        if (boundsError) {
          return `[Tool Error] ask_user_question: Question "${item.question}" ${boundsError}`;
        }
      }
    }

    try {
      const answers = await ctx.askUserMulti({
        questions: (input.questions as AskUserQuestionItemInput[]).map((q): AskUserQuestionItem => {
          const item: AskUserQuestionItem = {
            question: q.question,
            options: q.options.map(toHostOption),
            multiSelect: q.multi_select === true,
            allowCustomInput: q.allow_custom_input === undefined
              ? allowsCustomInput(input.allow_custom_input)
              : allowsCustomInput(q.allow_custom_input),
          };
          addIfDefined(item, 'header', q.header);
          addIfDefined(item, 'minSelections', toSelectionBound(q.min_selections));
          addIfDefined(item, 'maxSelections', toSelectionBound(q.max_selections));
          addIfDefined(item, 'default', optionalString(q.default));
          addIfDefined(item, 'customInputLabel', optionalString(q.custom_input_label ?? input.custom_input_label));
          addIfDefined(item, 'customInputPrompt', optionalString(q.custom_input_prompt ?? input.custom_input_prompt));
          addIfDefined(item, 'customInputDefault', optionalString(q.custom_input_default ?? input.custom_input_default));
          return item;
        }),
      });

      if (ctx.abortSignal?.aborted) return CANCELLED_TOOL_RESULT_MESSAGE;
      if (isAskUserUnanswered(answers)) {
        return JSON.stringify({ success: true, status: 'unanswered', reason: answers.reason });
      }
      if (answers === undefined) {
        return JSON.stringify({ success: true, status: 'unanswered', reason: 'skipped' });
      }

      const normalized = normalizeAnswerMap(answers);
      const response: Record<string, unknown> = {
        success: true,
        answers: normalized.answers,
      };
      if (Object.keys(normalized.customInputs).length > 0) {
        response.custom_inputs = normalized.customInputs;
      }
      return JSON.stringify(response);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return `[Tool Error] ask_user_question: ${errorMsg}`;
    }
  }

  if (!input.question || typeof input.question !== 'string') {
    return '[Tool Error] ask_user_question: Missing or invalid required parameter: question';
  }

  const kind = (input.kind as string) ?? 'select';

  if (kind === 'input') {
    if (!ctx.askUserInput) {
      return '[Tool Error] ask_user_question: Interactive input mode not available (askUserInput callback not provided)';
    }

    try {
      const userText = await ctx.askUserInput({
        question: input.question,
        default: input.default as string | undefined,
      });

      if (ctx.abortSignal?.aborted) return CANCELLED_TOOL_RESULT_MESSAGE;
      if (isAskUserUnanswered(userText)) {
        return JSON.stringify({ success: true, status: 'unanswered', reason: userText.reason });
      }
      if (userText === undefined) {
        return JSON.stringify({ success: true, status: 'unanswered', reason: 'skipped' });
      }

      return JSON.stringify({
        success: true,
        choice: userText,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return `[Tool Error] ask_user_question: ${errorMsg}`;
    }
  }

  if (!Array.isArray(input.options) || input.options.length === 0) {
    return '[Tool Error] ask_user_question: Missing required parameter: options (must be a non-empty array for select mode)';
  }

  const options = input.options as AskUserQuestionOption[];
  const reservedError = validateReservedOptionValues(options);
  if (reservedError) return `[Tool Error] ask_user_question: ${reservedError}`;

  if (!ctx.askUser) {
    return '[Tool Error] ask_user_question: Interactive mode not available (askUser callback not provided)';
  }

  if (input.multi_select === true) {
    const allowCustom = allowsCustomInput(input.allow_custom_input);
    const boundsError = validateSelectionBounds(
      toSelectionBound(input.min_selections),
      toSelectionBound(input.max_selections),
      options.length + (allowCustom ? 1 : 0),
    );
    if (boundsError) return `[Tool Error] ask_user_question: ${boundsError}`;
  }

  try {
    const askOptions: AskUserQuestionOptions = {
      question: input.question,
      kind: 'select',
      options: options.map(toHostOption),
      multiSelect: input.multi_select === true,
      allowCustomInput: allowsCustomInput(input.allow_custom_input),
    };
    addIfDefined(askOptions, 'minSelections', toSelectionBound(input.min_selections));
    addIfDefined(askOptions, 'maxSelections', toSelectionBound(input.max_selections));
    addIfDefined(askOptions, 'default', optionalString(input.default));
    addIfDefined(askOptions, 'customInputLabel', optionalString(input.custom_input_label));
    addIfDefined(askOptions, 'customInputPrompt', optionalString(input.custom_input_prompt));
    addIfDefined(askOptions, 'customInputDefault', optionalString(input.custom_input_default));

    const userChoice = await ctx.askUser(askOptions);

    if (ctx.abortSignal?.aborted) return CANCELLED_TOOL_RESULT_MESSAGE;
    if (isAskUserUnanswered(userChoice)) {
      return JSON.stringify({ success: true, status: 'unanswered', reason: userChoice.reason });
    }

    if (typeof userChoice === 'string' && userChoice.startsWith(CANCELLED_TOOL_RESULT_PREFIX)) {
      return JSON.stringify({ success: true, status: 'unanswered', reason: 'skipped' });
    }

    const normalized = normalizeAskUserAnswer(userChoice);
    if (Array.isArray(normalized.value)) {
      const response: Record<string, unknown> = {
        success: true,
        choices: normalized.value,
      };
      addCustomInputResponseFields(response, normalized.customInputs, 'multi');
      return JSON.stringify(response);
    }

    const response: Record<string, unknown> = {
      success: true,
      choice: normalized.value,
    };
    addCustomInputResponseFields(response, normalized.customInputs, 'single');
    return JSON.stringify(response);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return `[Tool Error] ask_user_question: ${errorMsg}`;
  }
}
