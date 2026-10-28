/**
 * Eval: ask_user_question custom-input tool schema.
 *
 * The production tool description teaches three prompt-facing rules:
 *
 * - select questions are open-ended by default;
 * - models should not add their own Other/Custom option;
 * - closed safety/protocol choices should set `allow_custom_input=false`.
 *
 * Unit tests cover executor behavior. This eval checks whether the
 * LLM-facing schema nudges real models toward the intended call shape.
 *
 * Run modes (env var `KODAX_ASK_USER_CUSTOM_INPUT_PROBE`):
 * - `pilot`: ark/v4flash x 4 cases x 1 run (4 calls, <=4096 output tokens).
 * - `panel`: five aliases x 4 cases (20 calls, <=20480 output tokens).
 * - `off`: compile/no-cost smoke path.
 *
 * Raw dump path:
 *   `<tmpdir>/kodax-eval-dumps/ask-user-custom-input/`
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { describe, expect, it } from 'vitest';
import { KODAX_TOOLS } from '@kodax-ai/coding';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import { runJudges, type PromptJudge } from '../benchmark/harness/judges.js';

type Mode = 'off' | 'pilot' | 'panel';

interface AskUserEvalCase {
  readonly id: string;
  readonly userMessage: string;
  readonly judges: readonly PromptJudge[];
}

interface ToolCallInput {
  readonly name: string;
  readonly input: unknown;
}

const MODE = parseMode(process.env.KODAX_ASK_USER_CUSTOM_INPUT_PROBE);
const PANEL_ALIASES: readonly ModelAlias[] = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ark/v4pro',
  'ark/v4flash',
];
const REQUESTED_ALIASES: readonly ModelAlias[] =
  MODE === 'pilot' ? (['ark/v4flash'] as const) : PANEL_ALIASES;
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'ask-user-custom-input');
const definition = KODAX_TOOLS.find(tool => tool.name === 'ask_user_question');
if (!definition) throw new Error('Production AskUser definition is missing.');
const ASK_USER_TOOL: KodaXToolDefinition = { name: definition.name, description: definition.description, input_schema: definition.input_schema };
const SYSTEM_PROMPT = [
  'You are KodaX, an AI coding assistant.',
  'When the user explicitly asks you to ask them a question, call the ask_user_question tool directly.',
  'Do not narrate the call instead of making it.',
].join('\n');

const CASES: readonly AskUserEvalCase[] = [
  {
    id: 'skippable_question_has_no_required_flag',
    userMessage: 'Use ask_user_question to ask which module to review: Runtime or Client. Allow me to skip this question.',
    judges: [mustCallAskUser(), {
      name: 'no_required_answer_flag', category: 'correctness',
      judge(_output, context) {
        const input = askUserInputs(context?.toolCalls ?? [])[0];
        return { passed: input !== undefined && !Object.hasOwn(input, 'required') };
      },
    }],
  },
  {
    id: 'open_select_no_manual_other_option',
    userMessage:
      'Use ask_user_question to ask me which deploy region to use. Offer hkg, sin, sfo, and fra. Let me type another region if none fit, but do not add a manual Other option.',
    judges: [
      mustCallAskUser(),
      allowCustomInputIsNotFalse(),
      doesNotAddManualOtherOption(),
    ],
  },
  {
    id: 'closed_protocol_choice_disables_custom_input',
    userMessage:
      'Use ask_user_question to ask whether to approve or reject applying the migration. This is a closed safety/protocol decision, so do not allow free text.',
    judges: [
      mustCallAskUser(),
      allowCustomInputIsFalse(),
    ],
  },
  {
    id: 'free_text_uses_input_mode',
    userMessage:
      'Use ask_user_question to ask me for the project name. I need to type arbitrary text, not choose from options.',
    judges: [
      mustCallAskUser(),
      usesFreeTextInputMode(),
    ],
  },
];

describe(`Eval: ask_user_question custom input (${MODE})`, () => {
  if (MODE === 'off') {
    it('skips: disabled by KODAX_ASK_USER_CUSTOM_INPUT_PROBE=off', () => {
      // no-op
    });
    return;
  }

  const aliases = availableAliases(...REQUESTED_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // no-op
    });
    return;
  }

  it(
    'runs ask-user custom-input probes and dumps raw output',
    { timeout: MODE === 'pilot' ? 600_000 : 1_800_000 },
    async () => {
      mkdirSync(DUMP_ROOT, { recursive: true });
      const rows: EvalRow[] = [];

      for (const testCase of CASES) {
        for (const alias of aliases) {
          const result = await runOneShot(alias, {
            systemPrompt: SYSTEM_PROMPT,
            userMessage: testCase.userMessage,
            tools: [ASK_USER_TOOL],
            maxOutputTokens: 1024,
            timeoutMs: 60_000,
          });
          const judgeRun = runJudges(result.text, testCase.judges, {
            toolCalls: result.toolCalls,
          });
          rows.push({
            caseId: testCase.id,
            alias,
            durationMs: result.durationMs,
            text: result.text,
            toolCalls: result.toolCalls,
            passed: judgeRun.passed,
            judgeResults: judgeRun.results,
          });
        }
      }

      const dumpPath = join(DUMP_ROOT, `${MODE}-${Date.now()}.json`);
      writeFileSync(
        dumpPath,
        JSON.stringify({ mode: MODE, aliases, rows }, null, 2),
        'utf8',
      );

      const failed = rows.filter((row) => !row.passed);
      expect(failed).toEqual([]);
    },
  );
});

interface EvalRow {
  readonly caseId: string;
  readonly alias: ModelAlias;
  readonly durationMs: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<ToolCallInput>;
  readonly passed: boolean;
  readonly judgeResults: ReadonlyArray<{
    readonly name: string;
    readonly passed: boolean;
    readonly reason?: string;
  }>;
}

function mustCallAskUser(): PromptJudge {
  return {
    name: 'must_call_ask_user_question',
    category: 'correctness',
    judge(output, context) {
      if (askUserInputs(context?.toolCalls ?? []).length > 0) return { passed: true };
      if (/\bask_user_question\b/i.test(output)) return { passed: true };
      return { passed: false, reason: 'model did not call ask_user_question' };
    },
  };
}

function allowCustomInputIsNotFalse(): PromptJudge {
  return {
    name: 'allow_custom_input_not_false',
    category: 'correctness',
    judge(_output, context) {
      const input = askUserInputs(context?.toolCalls ?? [])[0];
      if (input === undefined) return { passed: false, reason: 'no ask_user_question input captured' };
      return input.allow_custom_input === false
        ? { passed: false, reason: 'open select disabled the automatic custom input option' }
        : { passed: true };
    },
  };
}

function allowCustomInputIsFalse(): PromptJudge {
  return {
    name: 'allow_custom_input_false_for_closed_choice',
    category: 'correctness',
    judge(_output, context) {
      const input = askUserInputs(context?.toolCalls ?? [])[0];
      if (input === undefined) return { passed: false, reason: 'no ask_user_question input captured' };
      return input.allow_custom_input === false
        ? { passed: true }
        : { passed: false, reason: 'closed protocol choice did not set allow_custom_input=false' };
    },
  };
}

function doesNotAddManualOtherOption(): PromptJudge {
  return {
    name: 'does_not_add_manual_other_option',
    category: 'correctness',
    judge(_output, context) {
      const input = askUserInputs(context?.toolCalls ?? [])[0];
      if (input === undefined) return { passed: false, reason: 'no ask_user_question input captured' };
      const labels = collectOptionLabels(input);
      const manualOther = labels.find((label) => /other|custom|something else/i.test(label));
      return manualOther === undefined
        ? { passed: true }
        : { passed: false, reason: `manual custom option present: ${manualOther}` };
    },
  };
}

function usesFreeTextInputMode(): PromptJudge {
  return {
    name: 'uses_kind_input_for_free_text',
    category: 'correctness',
    judge(_output, context) {
      const input = askUserInputs(context?.toolCalls ?? [])[0];
      if (input === undefined) return { passed: false, reason: 'no ask_user_question input captured' };
      return input.kind === 'input'
        ? { passed: true }
        : { passed: false, reason: 'free-text question did not set kind=input' };
    },
  };
}

function askUserInputs(calls: readonly ToolCallInput[]): readonly Readonly<Record<string, unknown>>[] {
  return calls
    .filter((call) => call.name === 'ask_user_question' && isRecord(call.input))
    .map((call) => call.input as Readonly<Record<string, unknown>>);
}

function collectOptionLabels(input: Readonly<Record<string, unknown>>): readonly string[] {
  const flatLabels = labelsFromOptions(input.options);
  const questionLabels = Array.isArray(input.questions)
    ? input.questions.flatMap((question) =>
        isRecord(question) ? labelsFromOptions(question.options) : [],
      )
    : [];
  return [...flatLabels, ...questionLabels];
}

function labelsFromOptions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (!isRecord(option)) return [];
    const label = option.label;
    return typeof label === 'string' ? [label] : [];
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMode(value: string | undefined): Mode {
  if (value === 'off' || value === 'pilot' || value === 'panel') return value;
  return 'off';
}
