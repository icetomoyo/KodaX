import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANCELLED_TOOL_RESULT_MESSAGE } from '@kodax-ai/coding';

import { createClassicAskUserEvents } from './ask-user-prompts.js';

interface FakeReadline {
  readonly prompts: string[];
  question(
    prompt: string,
    callbackOrOptions: ((answer: string) => void) | { signal?: AbortSignal },
    maybeCallback?: (answer: string) => void,
  ): void;
}

function createFakeRl(answers: string[]): { rl: FakeReadline; calls: string[] } {
  const calls: string[] = [];
  const rl: FakeReadline = {
    prompts: [],
    question(prompt, callbackOrOptions, maybeCallback) {
      calls.push(prompt);
      const callback = typeof callbackOrOptions === 'function' ? callbackOrOptions : maybeCallback!;
      // Emit on the next microtask so promise wiring settles first.
      void Promise.resolve().then(() => {
        const answer = answers.shift();
        callback(answer === undefined ? '' : answer);
      });
    },
  };
  return { rl, calls };
}

function selectionOptions() {
  return {
    question: 'Which framework?',
    options: [
      { label: 'React', value: 'react' },
      { label: 'Vue', value: 'vue' },
      { label: 'Svelte', value: 'svelte' },
    ],
  };
}

describe('classic askUser readline surface', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the selected option value by number', async () => {
    const { rl } = createFakeRl(['2']);
    const events = createClassicAskUserEvents(rl as never);
    await expect(events.askUser!(selectionOptions())).resolves.toBe('vue');
  });

  it('accepts the default option on empty input', async () => {
    const { rl } = createFakeRl(['']);
    const events = createClassicAskUserEvents(rl as never);
    await expect(events.askUser!({ ...selectionOptions(), default: 'svelte' })).resolves.toBe('svelte');
  });

  it('re-prompts on out-of-range input before accepting', async () => {
    const { rl, calls } = createFakeRl(['99', '1']);
    const events = createClassicAskUserEvents(rl as never);
    await expect(events.askUser!(selectionOptions())).resolves.toBe('react');
    expect(calls).toHaveLength(2);
  });

  it('follows up with a text prompt for the custom-input option', async () => {
    const { rl, calls } = createFakeRl(['4', 'my own answer']);
    const events = createClassicAskUserEvents(rl as never);
    await expect(events.askUser!(selectionOptions())).resolves.toEqual({
      kind: 'customInput',
      value: 'my own answer',
    });
    expect(calls).toHaveLength(2);
  });

  it('collects a comma-separated multi-select within bounds', async () => {
    const { rl } = createFakeRl(['1,3']);
    const events = createClassicAskUserEvents(rl as never);
    await expect(
      events.askUser!({ ...selectionOptions(), multiSelect: true }),
    ).resolves.toEqual(['react', 'svelte']);
  });

  it('re-prompts when a multi-select violates min/max bounds', async () => {
    const { rl } = createFakeRl(['1', '1,2,3']);
    const events = createClassicAskUserEvents(rl as never);
    await expect(
      events.askUser!({ ...selectionOptions(), multiSelect: true, minSelections: 2 }),
    ).resolves.toEqual(['react', 'vue', 'svelte']);
  });

  it('returns the cancelled tool message when the interaction aborts', async () => {
    const { rl } = createFakeRl(['1']);
    const controller = new AbortController();
    controller.abort();
    const events = createClassicAskUserEvents(rl as never);
    await expect(
      events.askUser!(selectionOptions(), undefined, { signal: controller.signal }),
    ).resolves.toBe(CANCELLED_TOOL_RESULT_MESSAGE);
  });

  it('askUserMulti keys answers by question and supports back navigation', async () => {
    // q1: pick 1 → q2: pick Back (option 3) → q1: pick 2 → q2: pick 1
    const { rl } = createFakeRl(['1', '3', '2', '1']);
    const events = createClassicAskUserEvents(rl as never);
    await expect(
      events.askUserMulti!({
        questions: [
          { question: 'First?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
          { question: 'Second?', options: [{ label: 'C', value: 'c' }] },
        ],
      }),
    ).resolves.toEqual({ 'First?': 'b', 'Second?': 'c' });
  });

  it('askUserMulti resolves undefined when a question is cancelled', async () => {
    const { rl } = createFakeRl(['1']);
    const controller = new AbortController();
    const events = createClassicAskUserEvents(rl as never);
    const pending = events.askUserMulti!({
      questions: [{ question: 'Only?', options: [{ label: 'A', value: 'a' }] }],
    }, undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it('askUserInput falls back to the default on empty input', async () => {
    const { rl } = createFakeRl(['']);
    const events = createClassicAskUserEvents(rl as never);
    await expect(
      events.askUserInput!({ question: 'Name?', default: 'kodax' }),
    ).resolves.toBe('kodax');
  });

  it('askUserInput resolves undefined when aborted before input', async () => {
    const { rl } = createFakeRl(['x']);
    const controller = new AbortController();
    controller.abort();
    const events = createClassicAskUserEvents(rl as never);
    await expect(
      events.askUserInput!({ question: 'Name?' }, undefined, { signal: controller.signal }),
    ).resolves.toBeUndefined();
  });
});
