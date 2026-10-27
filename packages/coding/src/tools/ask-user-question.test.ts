import { describe, expect, it, vi } from 'vitest';
import { toolAskUserQuestion } from './ask-user-question.js';
import { CANCELLED_TOOL_RESULT_MESSAGE, CANCELLED_TOOL_RESULT_PREFIX } from '../constants.js';
import type { KodaXToolExecutionContext } from '../types.js';
import type { AskUserMultiOptions, AskUserQuestionOptions } from '@kodax-ai/agent';

/** Minimal execution context; the tool only reads the ask-user callbacks. */
function makeCtx(overrides: Partial<KodaXToolExecutionContext>): KodaXToolExecutionContext {
  return overrides as unknown as KodaXToolExecutionContext;
}

describe('toolAskUserQuestion - single select', () => {
  it('keeps multi-question answers named kind and reason distinct from unanswered results', async () => {
    const result = await toolAskUserQuestion({
      questions: [
        { question: 'kind', options: [{ label: 'unanswered' }] },
        { question: 'reason', options: [{ label: 'timeout' }] },
      ],
    }, makeCtx({ askUserMulti: async () => ({ kind: 'unanswered', reason: 'timeout' }) }));
    expect(JSON.parse(result)).toEqual({ success: true, answers: { kind: 'unanswered', reason: 'timeout' } });
  });

  it.each(['timeout', 'skipped', 'non_interactive'] as const)('returns an explicit unanswered result for an ordinary question (%s)', async reason => {
    const askUser = vi.fn(async () => ({ unanswered: true as const, reason }));
    const result = await toolAskUserQuestion(
      { question: 'Color?', default: 'blue', options: [{ label: 'Blue', value: 'blue' }] },
      makeCtx({ askUser }),
    );
    expect(JSON.parse(result)).toEqual({ success: true, status: 'unanswered', reason });
  });

  it('emits {choice} for a string answer', async () => {
    const ctx = makeCtx({ askUser: async () => 'blue' });
    const result = await toolAskUserQuestion(
      { question: 'Color?', options: [{ label: 'Blue', value: 'blue' }] },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ success: true, choice: 'blue' });
  });

  it('treats legacy dialog cancellation as a normal skipped result', async () => {
    const cancelled = `${CANCELLED_TOOL_RESULT_PREFIX} Operation cancelled by user`;
    const ctx = makeCtx({ askUser: async () => cancelled });
    const result = await toolAskUserQuestion(
      { question: 'Color?', options: [{ label: 'Blue', value: 'blue' }] },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ success: true, status: 'unanswered', reason: 'skipped' });
  });

  it('preserves an explicit Stop when the tool abort signal is set', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await toolAskUserQuestion(
      { question: 'Color?', options: [{ label: 'Blue', value: 'blue' }] },
      makeCtx({ abortSignal: controller.signal, askUser: async () => CANCELLED_TOOL_RESULT_MESSAGE }),
    );
    expect(result).toBe(CANCELLED_TOOL_RESULT_MESSAGE);
  });

  it('enables custom input by default and emits compatible custom metadata', async () => {
    const askUser = vi.fn<[AskUserQuestionOptions], Promise<string | string[]>>(
      async () => ({ kind: 'customInput', value: 'teal' }) as unknown as string,
    );
    const ctx = makeCtx({ askUser });
    const result = await toolAskUserQuestion(
      { question: 'Color?', options: [{ label: 'Blue', value: 'blue' }] },
      ctx,
    );

    expect(askUser).toHaveBeenCalledTimes(1);
    expect(askUser.mock.calls[0]![0].allowCustomInput).toBe(true);
    expect(JSON.parse(result)).toEqual({
      success: true,
      choice: 'teal',
      custom_input: true,
    });
  });

  it('can disable custom input for closed choices', async () => {
    const askUser = vi.fn<[AskUserQuestionOptions], Promise<string | string[]>>(async () => 'reject');
    const ctx = makeCtx({ askUser });
    const result = await toolAskUserQuestion(
      {
        question: 'Approve?',
        allow_custom_input: false,
        options: [
          { label: 'Approve', value: 'approve' },
          { label: 'Reject', value: 'reject' },
        ],
      },
      ctx,
    );

    expect(askUser.mock.calls[0]![0].allowCustomInput).toBe(false);
    expect(JSON.parse(result)).toEqual({ success: true, choice: 'reject' });
  });

  it('rejects the reserved custom-input sentinel supplied as an option value', async () => {
    const ctx = makeCtx({ askUser: async () => 'ignored' });
    const result = await toolAskUserQuestion(
      {
        question: 'Pick',
        options: [{ label: 'Other', value: '__custom_input__' }],
      },
      ctx,
    );

    expect(result).toContain('reserved');
  });
});

describe('toolAskUserQuestion - multi select', () => {
  it('emits {choices} (array) for an array answer, never a joined string', async () => {
    const ctx = makeCtx({ askUser: async () => ['red', 'green, with comma'] });
    const result = await toolAskUserQuestion(
      {
        question: 'Colors?',
        multi_select: true,
        options: [
          { label: 'Red', value: 'red' },
          { label: 'Green', value: 'green, with comma' },
        ],
      },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({
      success: true,
      choices: ['red', 'green, with comma'],
    });
  });

  it('threads min_selections/max_selections into the host options', async () => {
    const askUser = vi.fn<[AskUserQuestionOptions], Promise<string | string[]>>(
      async () => ['a', 'b'],
    );
    const ctx = makeCtx({ askUser });
    await toolAskUserQuestion(
      {
        question: 'Pick 2-3',
        multi_select: true,
        min_selections: 2,
        max_selections: 3,
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
          { label: 'C', value: 'c' },
        ],
      },
      ctx,
    );
    expect(askUser).toHaveBeenCalledTimes(1);
    const passed = askUser.mock.calls[0]![0];
    expect(passed.minSelections).toBe(2);
    expect(passed.maxSelections).toBe(3);
    expect(passed.multiSelect).toBe(true);
  });

  it('drops non-numeric selection bounds rather than forwarding garbage', async () => {
    const askUser = vi.fn<[AskUserQuestionOptions], Promise<string | string[]>>(
      async () => ['a'],
    );
    const ctx = makeCtx({ askUser });
    await toolAskUserQuestion(
      {
        question: 'Pick',
        multi_select: true,
        min_selections: 'lots' as unknown as number,
        options: [{ label: 'A', value: 'a' }],
      },
      ctx,
    );
    expect(askUser.mock.calls[0]![0].minSelections).toBeUndefined();
  });

  it('rejects an unsatisfiable range (min > max) up front instead of opening a dialog', async () => {
    const askUser = vi.fn<[AskUserQuestionOptions], Promise<string | string[]>>(async () => ['a']);
    const ctx = makeCtx({ askUser });
    const result = await toolAskUserQuestion(
      {
        question: 'Pick',
        multi_select: true,
        min_selections: 3,
        max_selections: 2,
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
          { label: 'C', value: 'c' },
        ],
      },
      ctx,
    );
    expect(result).toMatch(/\[Tool Error\]/);
    expect(result).toMatch(/min_selections/);
    expect(askUser).not.toHaveBeenCalled();
  });

  it('rejects min_selections greater than the selectable count', async () => {
    const askUser = vi.fn<[AskUserQuestionOptions], Promise<string | string[]>>(async () => ['a']);
    const ctx = makeCtx({ askUser });
    const result = await toolAskUserQuestion(
      {
        question: 'Pick',
        multi_select: true,
        min_selections: 5,
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      },
      ctx,
    );
    expect(result).toMatch(/\[Tool Error\]/);
    expect(askUser).not.toHaveBeenCalled();
  });

  it('normalizes custom input inside multi-select answers', async () => {
    const ctx = makeCtx({
      askUser: async () => [
        'red',
        { kind: 'customInput', value: 'infra docs' } as unknown as string,
      ],
    });
    const result = await toolAskUserQuestion(
      {
        question: 'Scopes?',
        multi_select: true,
        options: [{ label: 'Red', value: 'red' }],
      },
      ctx,
    );

    expect(JSON.parse(result)).toEqual({
      success: true,
      choices: ['red', 'infra docs'],
      custom_inputs: ['infra docs'],
    });
  });
});

describe('toolAskUserQuestion - free-text input', () => {
  it('emits {choice} for free-text input', async () => {
    const ctx = makeCtx({ askUserInput: async () => 'typed answer' });
    const result = await toolAskUserQuestion(
      { question: 'What else?', kind: 'input' },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ success: true, choice: 'typed answer' });
  });

  it('skips free-text input normally when the host returns undefined', async () => {
    const ctx = makeCtx({ askUserInput: async () => undefined });
    const result = await toolAskUserQuestion(
      { question: 'What else?', kind: 'input' },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ success: true, status: 'unanswered', reason: 'skipped' });
  });
});

describe('toolAskUserQuestion - multi question', () => {
  it('returns the per-question answers map (string or string[])', async () => {
    const askUserMulti = vi.fn<[AskUserMultiOptions], Promise<Record<string, string | string[]> | undefined>>(
      async () => ({ env: 'prod', regions: ['us', 'eu'] }),
    );
    const ctx = makeCtx({ askUserMulti });
    const result = await toolAskUserQuestion(
      {
        questions: [
          { question: 'env', default: 'prod', options: [{ label: 'Prod', value: 'prod' }] },
          {
            question: 'regions',
            multi_select: true,
            min_selections: 1,
            options: [
              { label: 'US', value: 'us' },
              { label: 'EU', value: 'eu' },
            ],
          },
        ],
      },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({
      success: true,
      answers: { env: 'prod', regions: ['us', 'eu'] },
    });
    const passed = askUserMulti.mock.calls[0]![0];
    expect(passed.questions[0]!.default).toBe('prod');
    expect(passed.questions[1]!.minSelections).toBe(1);
  });

  it('rejects the reserved back sentinel supplied as an option value', async () => {
    const ctx = makeCtx({ askUserMulti: async () => ({}) });
    const result = await toolAskUserQuestion(
      {
        questions: [
          { question: 'q', options: [{ label: 'Back', value: '__back__' }] },
        ],
      },
      ctx,
    );
    expect(result).toContain('reserved');
  });

  it('skips normally when the host returns undefined', async () => {
    const ctx = makeCtx({ askUserMulti: async () => undefined });
    const result = await toolAskUserQuestion(
      { questions: [{ question: 'q', options: [{ label: 'A', value: 'a' }] }] },
      ctx,
    );
    expect(JSON.parse(result)).toEqual({ success: true, status: 'unanswered', reason: 'skipped' });
  });

  it('threads custom input config and normalizes per-question custom answers', async () => {
    const askUserMulti = vi.fn<[AskUserMultiOptions], Promise<Record<string, string | string[]> | undefined>>(
      async () => ({
        target: { kind: 'customInput', value: 'examples' } as unknown as string,
        scopes: [
          'docs',
          { kind: 'customInput', value: 'migration notes' } as unknown as string,
        ],
      }),
    );
    const ctx = makeCtx({ askUserMulti });
    const result = await toolAskUserQuestion(
      {
        questions: [
          {
            question: 'target',
            custom_input_label: 'Something else',
            options: [{ label: 'Source', value: 'src' }],
          },
          {
            question: 'scopes',
            multi_select: true,
            options: [{ label: 'Docs', value: 'docs' }],
          },
        ],
      },
      ctx,
    );

    const passed = askUserMulti.mock.calls[0]![0];
    expect(passed.questions[0]!.allowCustomInput).toBe(true);
    expect(passed.questions[0]!.customInputLabel).toBe('Something else');
    expect(passed.questions[1]!.allowCustomInput).toBe(true);
    expect(JSON.parse(result)).toEqual({
      success: true,
      answers: {
        target: 'examples',
        scopes: ['docs', 'migration notes'],
      },
      custom_inputs: {
        target: ['examples'],
        scopes: ['migration notes'],
      },
    });
  });
});
