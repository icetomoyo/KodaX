import { describe, expect, it } from 'vitest';
import type { ClientInteraction } from '@kodax-ai/coding/client-contract';
import {
  answerClientPlaneInteraction,
  type ClientPlaneDialogSurface,
  type InkClientPlane,
} from '../ui/client-plane.js';
import { createClassicPlaneDialogSurface, parseClassicChoice } from './classic-plane-interactions.js';

const OPTIONS = [
  { label: 'Ship it', value: 'ship' },
  { label: 'Hold', description: 'wait a day', value: 'hold' },
];

describe('parseClassicChoice (T18)', () => {
  it('accepts a 1-based number, an exact label or value, and free text', () => {
    expect(parseClassicChoice('2', OPTIONS, true)).toEqual({ kind: 'value', value: 'hold' });
    expect(parseClassicChoice('Ship it', OPTIONS, true)).toEqual({ kind: 'value', value: 'ship' });
    expect(parseClassicChoice('ship', OPTIONS, true)).toEqual({ kind: 'value', value: 'ship' });
    expect(parseClassicChoice('maybe tomorrow', OPTIONS, true)).toEqual({ kind: 'custom', value: 'maybe tomorrow' });
    expect(parseClassicChoice('  ', OPTIONS, true)).toEqual({ kind: 'cancel' });
    expect(parseClassicChoice('maybe', OPTIONS, false)).toEqual({ kind: 'cancel' });
    expect(parseClassicChoice('9', OPTIONS, true)).toEqual({ kind: 'custom', value: '9' });
  });
});

describe('createClassicPlaneDialogSurface via answerClientPlaneInteraction (T18)', () => {
  function interaction(kind: 'question', question: string): ClientInteraction;
  function interaction(kind: 'question_input', question: string): ClientInteraction;
  function interaction(kind: 'question' | 'question_input', question: string): ClientInteraction {
    return {
      requestId: `req-${kind}`,
      sessionId: 's1',
      runId: 'r1',
      createdAt: '2026-09-07T00:00:00.000Z',
      kind,
      options: kind === 'question'
        ? { question, options: OPTIONS }
        : { question },
      expiresAt: '2026-09-07T00:05:00.000Z',
    } as ClientInteraction;
  }

  function planeWith(calls: unknown[]): InkClientPlane {
    return {
      executeTool: async () => { throw new Error('Unexpected tool invocation'); },
      cancelSession: async () => { throw new Error('Unexpected Session Stop'); },
      submit: () => Promise.resolve({}),
      withdraw: () => Promise.resolve(undefined),
      awaitRun: () => Promise.resolve({ phase: 'completed' }),
      stop: () => Promise.resolve(undefined),
      activeRun: () => Promise.resolve(undefined),
      observe: () => Promise.resolve(() => undefined),
      readItem: () => Promise.resolve(null),
      respondInteraction: (_id, response) => {
        calls.push(response);
        return Promise.resolve(true);
      },
    };
  }

  function surfaceWith(answers: string[]): ClientPlaneDialogSurface {
    return createClassicPlaneDialogSurface({
      rl: undefined as never,
      ask: async () => answers.shift(),
      permissionMode: () => 'accept-edits',
      confirm: undefined as never,
    });
  }

  it('forwards the complete Host plan to the existing approval renderer', async () => {
    const plan = 'Step with full context.\n'.repeat(500) + 'FINAL APPROVAL DETAIL';
    let renderedInput: Record<string, unknown> | undefined;
    const surface = createClassicPlaneDialogSurface({
      rl: undefined as never,
      permissionMode: () => 'plan',
      confirm: async (_rl, _toolName, input) => {
        renderedInput = input;
        return { confirmed: false };
      },
    });
    await surface.permission({ toolName: 'exit_plan_mode', inputPreview: 'bounded preview', plan });
    expect(renderedInput?.plan).toBe(plan);
    expect(renderedInput?.input).toBe('bounded preview');
  });

  it('answers a select question with the chosen option value', async () => {
    const calls: unknown[] = [];
    await answerClientPlaneInteraction(
      planeWith(calls), interaction('question', 'Deploy?'), surfaceWith(['1']),
    );
    expect(calls[0]).toEqual({ kind: 'question', answer: 'ship' });
  });

  it('maps free text to the customInput answer and empty input to cancel', async () => {
    const custom: unknown[] = [];
    await answerClientPlaneInteraction(
      planeWith(custom), interaction('question', 'Deploy?'), surfaceWith(['after lunch']),
    );
    expect(custom[0]).toEqual({ kind: 'question', answer: { kind: 'customInput', value: 'after lunch' } });

    const cancelled: unknown[] = [];
    await answerClientPlaneInteraction(
      planeWith(cancelled), interaction('question', 'Deploy?'), surfaceWith(['']),
    );
    expect(cancelled[0]).toEqual({ kind: 'cancel' });
  });

  it('answers a text question and maps empty input to cancel', async () => {
    const calls: unknown[] = [];
    await answerClientPlaneInteraction(
      planeWith(calls), interaction('question_input', 'Name?'), surfaceWith(['kodax']),
    );
    expect(calls[0]).toEqual({ kind: 'question_input', text: 'kodax' });

    const cancelled: unknown[] = [];
    await answerClientPlaneInteraction(
      planeWith(cancelled), interaction('question_input', 'Name?'), surfaceWith(['  ']),
    );
    expect(cancelled[0]).toEqual({ kind: 'cancel' });
  });
});
