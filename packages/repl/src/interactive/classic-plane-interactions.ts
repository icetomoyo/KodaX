/**
 * FEATURE_298 T18 — readline dialog surface for plane-bound classic rounds.
 *
 * Pending Host interactions (question / question_multi / question_input /
 * permission) are answered through the same answerClientPlaneInteraction
 * mapping the Ink surface uses; the dialogs here are the classic readline
 * flows: numbered choices, free-text input, and confirmToolExecution.
 */
import readline from 'node:readline';
import {
  CANCELLED_TOOL_RESULT_MESSAGE,
  type AskUserAnswer,
  type AskUserMultiOptions,
  type AskUserQuestionOptions,
} from '@kodax-ai/coding';
import type { ClientPermissionInteractionOptions } from '@kodax-ai/coding/client-contract';
import type { ClientPlaneDialogSurface } from '../ui/client-plane.js';
import type { PermissionMode } from '../permission/types.js';
import { confirmToolExecution } from './prompts.js';

interface ChoiceOption {
  readonly label: string;
  readonly description?: string;
  readonly value: string;
}

export type ClassicAsk = (prompt: string) => Promise<string | undefined>;

/**
 * Interpret one readline answer against a choice list: a 1-based number, an
 * exact label/value match, or free text (the open-ended custom answer the
 * AskUser contract defaults to). Empty input cancels.
 */
export function parseClassicChoice(
  input: string | undefined,
  options: readonly ChoiceOption[],
  allowCustomInput: boolean,
): { kind: 'value'; value: string } | { kind: 'custom'; value: string } | { kind: 'cancel' } {
  const trimmed = (input ?? '').trim();
  if (trimmed.length === 0) return { kind: 'cancel' };
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return { kind: 'value', value: options[numeric - 1]!.value };
  }
  const matched = options.find(
    (option) => option.value === trimmed || option.label === trimmed,
  );
  if (matched !== undefined) return { kind: 'value', value: matched.value };
  if (allowCustomInput) return { kind: 'custom', value: trimmed };
  return { kind: 'cancel' };
}

function describeChoices(question: string, options: readonly ChoiceOption[]): string {
  const lines = options.map(
    (option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`,
  );
  return `${question}\n${lines.join('\n')}\nChoice (number, label, or free text; empty cancels): `;
}

async function askChoice(
  ask: ClassicAsk,
  question: string,
  options: readonly ChoiceOption[],
  allowCustomInput: boolean,
): Promise<AskUserAnswer> {
  const parsed = parseClassicChoice(await ask(describeChoices(question, options)), options, allowCustomInput);
  if (parsed.kind === 'cancel') return CANCELLED_TOOL_RESULT_MESSAGE;
  if (parsed.kind === 'custom') return { kind: 'customInput', value: parsed.value };
  return parsed.value;
}

/**
 * Build the dialog surface over one readline interface. `ask` is injectable
 * for tests; production uses the shared askInput helper.
 */
export function createClassicPlaneDialogSurface(input: {
  readonly rl: readline.Interface;
  readonly ask?: ClassicAsk;
  readonly permissionMode: () => PermissionMode;
  readonly confirm?: typeof confirmToolExecution;
}): ClientPlaneDialogSurface {
  const ask = input.ask ?? (async (prompt) => {
    const { askInput } = await import('./readline-helpers.js');
    return askInput(input.rl, prompt);
  });
  const confirm = input.confirm ?? confirmToolExecution;
  return {
    question: async (options: AskUserQuestionOptions) => {
      if (options.kind === 'input' || options.options === undefined || options.options.length === 0) {
        const text = await ask(`${options.question}: `);
        const trimmed = (text ?? '').trim();
        return trimmed.length === 0 ? CANCELLED_TOOL_RESULT_MESSAGE : trimmed;
      }
      return askChoice(ask, options.question, options.options, options.allowCustomInput !== false);
    },
    questionMulti: async (options: AskUserMultiOptions) => {
      const answers: Record<string, AskUserAnswer> = {};
      for (const question of options.questions) {
        const answer = await askChoice(
          ask,
          question.question,
          question.options,
          question.allowCustomInput !== false,
        );
        if (answer === CANCELLED_TOOL_RESULT_MESSAGE) return undefined;
        answers[question.question] = answer;
      }
      return answers;
    },
    questionInput: async (options) => {
      const text = await ask(`${options.question}: `);
      return text !== undefined && text.trim().length > 0 ? text : undefined;
    },
    permission: async (options: ClientPermissionInteractionOptions, signal) => {
      const result = await confirm(
        input.rl,
        options.toolName,
        {
          ...(options.inputPreview !== undefined ? { input: options.inputPreview } : {}),
          ...(options.reason !== undefined ? { _reason: options.reason } : {}),
          ...(options.executionCwd !== undefined ? { _executionCwd: options.executionCwd } : {}),
          ...(options.risk !== undefined ? { _runtimeRisk: options.risk } : {}),
        },
        {
          permissionMode: input.permissionMode(),
          runtimeGrantSuggestions: options.grantSuggestions ?? [],
          ...(signal !== undefined ? { signal } : {}),
        },
      );
      return result;
    },
  };
}
