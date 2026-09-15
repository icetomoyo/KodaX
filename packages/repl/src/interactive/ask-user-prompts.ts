/**
 * Classic readline host implementation of the askUser surface (FEATURE_222
 * contract, see @kodax-ai/agent runtime/user-interaction.ts). Ink fulfils the
 * same contract with React dialogs; the classic REPL uses numbered prompts on
 * the shared readline interface. Semantics mirror Ink:
 * - the synthetic custom-input option prompts for text and resolves
 *   `{ kind: 'customInput', value }`;
 * - cancel/abort resolves CANCELLED_TOOL_RESULT_MESSAGE (askUser) or
 *   undefined (askUserMulti / askUserInput);
 * - askUserMulti keys answers by question text and offers ← Back navigation.
 */
import chalk from 'chalk';
import {
  ASK_USER_BACK_SIGNAL,
  ASK_USER_CUSTOM_INPUT_SIGNAL,
  type AskUserAnswer,
  type AskUserMultiOptions,
  type AskUserQuestionItem,
  type AskUserQuestionOptions,
  type AskUserSelectionAnswer,
} from '@kodax-ai/agent';
import { CANCELLED_TOOL_RESULT_MESSAGE, type KodaXEvents } from '@kodax-ai/coding';

/** Minimal readline surface the prompts need — satisfied by readline.Interface. */
export interface ClassicAskUserReadline {
  question(query: string, callback: (answer: string) => void): void;
  question(
    query: string,
    options: { signal?: AbortSignal },
    callback: (answer: string) => void,
  ): void;
}

export type ClassicAskUserEvents = Pick<KodaXEvents, 'askUser' | 'askUserMulti' | 'askUserInput'>;

interface SelectableEntry {
  label: string;
  description?: string;
  value: string;
}

type SelectSpec = AskUserQuestionOptions | AskUserQuestionItem;

type SelectResult =
  | { kind: 'answer'; value: AskUserAnswer }
  | { kind: 'cancelled' }
  | { kind: 'back' };

type PromptOutcome = { value: string } | { cancelled: true };

function promptLine(
  rl: ClassicAskUserReadline,
  text: string,
  signal?: AbortSignal,
): Promise<PromptOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: PromptOutcome): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ cancelled: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    const onAnswer = (answer: string): void => finish({ value: answer });
    if (signal) rl.question(text, { signal }, onAnswer);
    else rl.question(text, onAnswer);
  });
}

function parseIndex(raw: string, count: number): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const index = Number.parseInt(raw, 10) - 1;
  return index >= 0 && index < count ? index : undefined;
}

function parseIndexList(raw: string, count: number): number[] | undefined {
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const indices: number[] = [];
  for (const token of tokens) {
    const index = parseIndex(token, count);
    if (index === undefined || indices.includes(index)) return undefined;
    indices.push(index);
  }
  return indices;
}

async function askTextInput(
  rl: ClassicAskUserReadline,
  question: string,
  defaultText: string | undefined,
  signal?: AbortSignal,
): Promise<{ value: string } | { cancelled: true }> {
  if (signal?.aborted) return { cancelled: true };
  console.log();
  const hint = defaultText ? chalk.dim(` (${defaultText})`) : '';
  console.log(chalk.cyan(`? ${question}`));
  const outcome = await promptLine(rl, chalk.dim(`  › Answer${hint}: `), signal);
  if ('cancelled' in outcome) return { cancelled: true };
  const text = outcome.value.trim();
  return { value: text !== '' ? text : defaultText ?? '' };
}

async function resolveSingleSelection(
  entries: SelectableEntry[],
  index: number,
  rl: ClassicAskUserReadline,
  spec: SelectSpec,
  signal?: AbortSignal,
): Promise<SelectResult> {
  const value = entries[index]!.value;
  if (value === ASK_USER_BACK_SIGNAL) return { kind: 'back' };
  if (value === ASK_USER_CUSTOM_INPUT_SIGNAL) {
    const text = await askTextInput(
      rl,
      spec.customInputPrompt ?? spec.question,
      spec.customInputDefault,
      signal,
    );
    if ('cancelled' in text) return { kind: 'cancelled' };
    return { kind: 'answer', value: { kind: 'customInput', value: text.value } };
  }
  return { kind: 'answer', value };
}

async function askSelection(
  rl: ClassicAskUserReadline,
  title: string,
  spec: SelectSpec,
  offerBack: boolean,
  signal?: AbortSignal,
): Promise<SelectResult> {
  const allowCustom = spec.allowCustomInput !== false;
  const entries: SelectableEntry[] = (spec.options ?? []).map((option) => ({
    label: option.label,
    ...(option.description !== undefined ? { description: option.description } : {}),
    value: option.value,
  }));
  if (allowCustom) {
    entries.push({ label: spec.customInputLabel ?? 'Other…', value: ASK_USER_CUSTOM_INPUT_SIGNAL });
  }
  if (offerBack) {
    entries.push({ label: '← Back', value: ASK_USER_BACK_SIGNAL });
  }

  const multiSelect = spec.multiSelect === true;
  const defaultIndex = spec.default !== undefined
    ? entries.findIndex((entry) => entry.value === spec.default)
    : -1;
  const defaultHint = defaultIndex >= 0 ? ` [${defaultIndex + 1}]` : '';

  console.log();
  console.log(chalk.cyan(`? ${title}`));
  entries.forEach((entry, index) => {
    const num = chalk.dim(`${index + 1}.`.padStart(4));
    const description = entry.description ? chalk.dim(` - ${entry.description}`) : '';
    console.log(`  ${num} ${entry.label}${description}`);
  });

  while (true) {
    if (signal?.aborted) return { kind: 'cancelled' };
    const outcome = await promptLine(
      rl,
      chalk.dim(`  › Select (1-${entries.length})${defaultHint}: `),
      signal,
    );
    if ('cancelled' in outcome) return { kind: 'cancelled' };
    const raw = outcome.value.trim();

    if (!multiSelect) {
      const index = raw === '' ? (defaultIndex >= 0 ? defaultIndex : undefined) : parseIndex(raw, entries.length);
      if (index === undefined) {
        console.log(chalk.yellow(`  Please enter a number between 1 and ${entries.length}.`));
        continue;
      }
      return resolveSingleSelection(entries, index, rl, spec, signal);
    }

    const indices = raw === ''
      ? (defaultIndex >= 0 ? [defaultIndex] : [])
      : parseIndexList(raw, entries.length);
    if (indices === undefined) {
      console.log(chalk.yellow(`  Enter numbers between 1 and ${entries.length}, separated by commas.`));
      continue;
    }
    const backIndex = entries.findIndex((entry) => entry.value === ASK_USER_BACK_SIGNAL);
    if (backIndex >= 0 && indices.includes(backIndex)) return { kind: 'back' };
    const min = spec.minSelections ?? 1;
    const max = spec.maxSelections ?? entries.length;
    if (indices.length < min || indices.length > max) {
      console.log(chalk.yellow(`  Select between ${min} and ${max} options.`));
      continue;
    }
    if (indices.length === 0) return { kind: 'answer', value: [] };
    const customIndex = entries.findIndex((entry) => entry.value === ASK_USER_CUSTOM_INPUT_SIGNAL);
    if (customIndex >= 0 && indices.includes(customIndex)) {
      const text = await askTextInput(
        rl,
        spec.customInputPrompt ?? spec.question,
        spec.customInputDefault,
        signal,
      );
      if ('cancelled' in text) return { kind: 'cancelled' };
      const values = indices.map((index): AskUserSelectionAnswer =>
        index === customIndex
          ? { kind: 'customInput', value: text.value }
          : entries[index]!.value,
      );
      return { kind: 'answer', value: values };
    }
    return { kind: 'answer', value: indices.map((index) => entries[index]!.value) };
  }
}

export function createClassicAskUserEvents(rl: ClassicAskUserReadline): ClassicAskUserEvents {
  return {
    askUser: async (options, _meta, interaction) => {
      const result = await askSelection(rl, options.question, options, false, interaction?.signal);
      if (result.kind !== 'answer') return CANCELLED_TOOL_RESULT_MESSAGE;
      return result.value;
    },
    askUserMulti: async (options: AskUserMultiOptions, _meta, interaction) => {
      const total = options.questions.length;
      const answers: Record<string, AskUserAnswer> = {};
      let i = 0;
      while (i < total) {
        const item: AskUserQuestionItem = options.questions[i]!;
        const title = `[${i + 1}/${total}] ${item.question}`;
        const result = await askSelection(rl, title, item, i > 0, interaction?.signal);
        if (result.kind === 'cancelled') return undefined;
        if (result.kind === 'back') {
          i -= 1;
          continue;
        }
        answers[item.question] = result.value;
        i += 1;
      }
      return answers;
    },
    askUserInput: async (options, _meta, interaction) => {
      const text = await askTextInput(rl, options.question, options.default, interaction?.signal);
      return 'cancelled' in text ? undefined : text.value;
    },
  };
}
