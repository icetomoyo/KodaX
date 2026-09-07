import { describe, expect, it } from 'vitest';
import type {
  ClientInteraction,
  ClientInteractionResponse,
  ClientSessionView,
  ClientViewItem,
} from '@kodax-ai/coding/client-contract';
import { CANCELLED_TOOL_RESULT_MESSAGE, type AskUserAnswer } from '@kodax-ai/coding';
import { ToolCallStatus } from './types.js';
import {
  answerClientPlaneInteraction,
  clientViewToHistoryItems,
  runClientPlaneRound,
  viewRunsActive,
  type ClientPlaneDialogSurface,
  type ClientRoundOutcome,
  type InkClientPlane,
} from './client-plane.js';

function viewItem(overrides: Partial<ClientViewItem> & Pick<ClientViewItem, 'id' | 'type' | 'text'>): ClientViewItem {
  return { timestamp: 1_700_000_000_000, ...overrides };
}

describe('clientViewToHistoryItems (T17)', () => {
  it('maps every display item kind onto the Ink render model', () => {
    const items = clientViewToHistoryItems([
      viewItem({ id: 'u1', type: 'user', text: 'Ship it.' }),
      viewItem({ id: 'a1', type: 'assistant', text: 'Done.', compactText: 'Done…' }),
      viewItem({ id: 't1', type: 'thinking', text: 'Reasoning…' }),
      viewItem({ id: 'e1', type: 'error', text: 'Provider failed.' }),
      viewItem({ id: 'v1', type: 'event', text: 'Retried.', icon: '↻' }),
      viewItem({ id: 'i1', type: 'info', text: 'Context compacted.' }),
      viewItem({ id: 'h1', type: 'hint', text: 'Press ? for help.' }),
      viewItem({ id: 's1', type: 'sidecar', text: 'Verifier says revise.' }),
      viewItem({ id: 'm1', type: 'system', text: 'Session resumed.' }),
    ]);

    expect(items.map((item) => [item.type, item.id])).toEqual([
      ['user', 'u1'],
      ['assistant', 'a1'],
      ['thinking', 't1'],
      ['error', 'e1'],
      ['event', 'v1'],
      ['info', 'i1'],
      ['hint', 'h1'],
      ['sidecar', 's1'],
      ['system', 'm1'],
    ]);
    expect(items[1]).toMatchObject({ text: 'Done.', compactText: 'Done…', timestamp: 1_700_000_000_000 });
    expect(items[4]).toMatchObject({ icon: '↻' });
  });

  it('maps a tool item to a tool group with the view tool status and preview', () => {
    const [group] = clientViewToHistoryItems([
      viewItem({
        id: 'tool-1',
        type: 'tool',
        text: 'npm test output',
        tool: {
          callId: 'call-1',
          name: 'bash',
          status: 'success',
          inputText: 'npm test',
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_001_000,
        },
      }),
    ]);
    expect(group).toMatchObject({
      id: 'tool-1',
      type: 'tool_group',
      timestamp: 1_700_000_000_000,
      tools: [{
        id: 'call-1',
        name: 'bash',
        status: ToolCallStatus.Success,
        preview: 'npm test',
        output: 'npm test output',
        startTime: 1_700_000_000_000,
        endTime: 1_700_000_001_000,
      }],
    });
  });

  it('maps running tools to executing with live progress', () => {
    const [group] = clientViewToHistoryItems([
      viewItem({
        id: 'tool-2',
        type: 'tool',
        text: '',
        tool: { callId: 'call-2', name: 'bash', status: 'running', inputText: 'npm run dev', progress: 'booting' },
      }),
    ]);
    expect(group?.type === 'tool_group' && group.tools[0]).toMatchObject({
      id: 'call-2',
      status: ToolCallStatus.Executing,
      preview: 'npm run dev',
      progressLines: ['booting'],
    });
  });

  it('maps awaiting_approval tools to the approval status', () => {
    const [group] = clientViewToHistoryItems([
      viewItem({
        id: 'tool-3',
        type: 'tool',
        text: '',
        tool: { callId: 'call-3', name: 'bash', status: 'awaiting_approval', inputText: 'rm -rf /tmp/x' },
      }),
    ]);
    expect(group?.type === 'tool_group' && group.tools[0]?.status).toBe(ToolCallStatus.AwaitingApproval);
  });

  it('marks streaming only on the trailing assistant item while a run is active', () => {
    const view: ClientSessionView = {
      session: { id: 's1', title: 't' },
      items: [
        viewItem({ id: 'a1', type: 'assistant', text: 'earlier answer' }),
        viewItem({ id: 'u1', type: 'user', text: 'again?' }),
        viewItem({ id: 'a2', type: 'assistant', text: 'partial answer' }),
      ],
      settings: {},
      queue: [],
      interactions: [],
      runs: [{ runId: 'r1', phase: 'running' }],
    } as unknown as ClientSessionView;
    const items = clientViewToHistoryItems(view.items, { activeRunId: 'r1' });
    expect(items[0]).not.toHaveProperty('isStreaming');
    expect(items[2]).toMatchObject({ type: 'assistant', isStreaming: true });
  });

  it('marks bounded suffix text so truncation is visible', () => {
    const [group] = clientViewToHistoryItems([
      viewItem({
        id: 'tool-9',
        type: 'tool',
        text: 'tail of a long output',
        totalTextLength: 9_999,
        tool: { callId: 'call-9', name: 'bash', status: 'success', inputText: 'npm run build' },
      }),
    ]);
    expect(group?.type === 'tool_group' && group.tools[0]?.output).toBe(
      'tail of a long output' + String.fromCharCode(10) + '[truncated]',
    );
  });

  it('reuses mapped items while their fingerprint is unchanged', () => {
    const memo = { entries: new Map() };
    const source = [
      viewItem({ id: 'a1', type: 'assistant', text: 'answer' }),
      viewItem({ id: 'e1', type: 'error', text: 'boom' }),
    ];
    const first = clientViewToHistoryItems(source, { memo });
    // Structurally equal clones (fresh identities, same content) reuse the
    // mapped HistoryItem references instead of allocating new ones.
    const cloned = source.map((item) => ({ ...item, tool: item.tool ? { ...item.tool } : undefined }));
    const second = clientViewToHistoryItems(cloned, { memo });
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    // A changed item remaps.
    const grown = [{ ...source[0]!, text: 'answer grows' }, source[1]!];
    const third = clientViewToHistoryItems(grown, { memo });
    expect(third[0]).not.toBe(first[0]);
    expect(third[1]).toBe(first[1]);
  });
});

describe('viewRunsActive (T17)', () => {
  const base: ClientSessionView = {
    session: { id: 's1', title: 't' },
    items: [],
    settings: {},
    queue: [],
    interactions: [],
    runs: [],
  } as unknown as ClientSessionView;

  it('reports no active run for an empty or terminal-only run list', () => {
    expect(viewRunsActive(base)).toBeUndefined();
    expect(viewRunsActive({
      ...base,
      runs: [
        { runId: 'r1', phase: 'completed' },
        { runId: 'r2', phase: 'failed' },
      ],
    } as unknown as ClientSessionView)).toBeUndefined();
  });

  it('reports the active run id for live phases', () => {
    const active = viewRunsActive({
      ...base,
      runs: [
        { runId: 'r1', phase: 'completed' },
        { runId: 'r2', phase: 'running' },
      ],
    } as unknown as ClientSessionView);
    expect(active).toBe('r2');
    expect(viewRunsActive({
      ...base,
      runs: [{ runId: 'r3', phase: 'waiting_user_input' }],
    } as unknown as ClientSessionView)).toBe('r3');
  });
});

describe('answerClientPlaneInteraction (T17)', () => {
  function interaction(kind: 'question', options: { question: string; options?: string[] }): ClientInteraction;
  function interaction(kind: 'question_input', options: { question: string; default?: string }): ClientInteraction;
  function interaction(kind: 'permission', options: {
    toolName: string; reason?: string; grantSuggestions?: { id: string; kind: 'session' | 'persistent'; label: string }[];
  }): ClientInteraction;
  function interaction(kind: 'question_multi', options: { questions: { question: string }[] }): ClientInteraction;
  function interaction(kind: ClientInteraction['kind'], options: unknown): ClientInteraction {
    return {
      requestId: `req-${kind}`,
      sessionId: 's1',
      runId: 'r1',
      createdAt: '2026-09-07T00:00:00.000Z',
      kind,
      options,
      ...(kind === 'permission' ? {} : { expiresAt: '2026-09-07T00:05:00.000Z' }),
    } as ClientInteraction;
  }

  function planeWith(responses: ClientInteractionResponse[], accepted = true): InkClientPlane & { calls: ClientInteractionResponse[] } {
    const calls: ClientInteractionResponse[] = [];
    return {
      calls,
      submit: () => Promise.resolve({}),
      withdraw: () => Promise.resolve(undefined),
      awaitRun: () => Promise.resolve({ phase: 'completed' }),
      stop: () => Promise.resolve(undefined),
      observe: () => Promise.resolve(() => undefined),
      readItem: () => Promise.resolve(null),
      respondInteraction: (_requestId, response) => {
        calls.push(response);
        responses.push(response);
        return Promise.resolve(accepted);
      },
    };
  }

  const baseSurface: ClientPlaneDialogSurface = {
    question: () => Promise.resolve('yes' as AskUserAnswer),
    questionMulti: () => Promise.resolve({ 'Deploy?' : 'later' }),
    questionInput: () => Promise.resolve('typed'),
    permission: () => Promise.resolve({ confirmed: true }),
  };

  it('answers a question with the dialog selection', async () => {
    const plane = planeWith([]);
    const accepted = await answerClientPlaneInteraction(
      plane, interaction('question', { question: 'Ship?' }), baseSurface,
    );
    expect(accepted).toBe(true);
    expect(plane.calls[0]).toEqual({ kind: 'question', answer: 'yes' });
  });

  it('maps a cancelled question dialog to the cancel response', async () => {
    const plane = planeWith([]);
    await answerClientPlaneInteraction(
      plane,
      interaction('question', { question: 'Ship?' }),
      { ...baseSurface, question: () => Promise.resolve(CANCELLED_TOOL_RESULT_MESSAGE as AskUserAnswer) },
    );
    expect(plane.calls[0]).toEqual({ kind: 'cancel' });
  });

  it('maps multi-question ESC to cancel and answers to the record', async () => {
    const cancelledPlane = planeWith([]);
    await answerClientPlaneInteraction(
      cancelledPlane,
      interaction('question_multi', { questions: [{ question: 'A?' }, { question: 'B?' }] }),
      { ...baseSurface, questionMulti: () => Promise.resolve(undefined) },
    );
    expect(cancelledPlane.calls[0]).toEqual({ kind: 'cancel' });

    const plane = planeWith([]);
    await answerClientPlaneInteraction(
      plane,
      interaction('question_multi', { questions: [{ question: 'A?' }] }),
      baseSurface,
    );
    expect(plane.calls[0]).toEqual({ kind: 'question_multi', answers: { 'Deploy?': 'later' } });
  });

  it('maps a text question answer and its ESC to cancel', async () => {
    const plane = planeWith([]);
    await answerClientPlaneInteraction(
      plane, interaction('question_input', { question: 'Name?' }), baseSurface,
    );
    expect(plane.calls[0]).toEqual({ kind: 'question_input', text: 'typed' });

    const cancelledPlane = planeWith([]);
    await answerClientPlaneInteraction(
      cancelledPlane,
      interaction('question_input', { question: 'Name?' }),
      { ...baseSurface, questionInput: () => Promise.resolve(undefined) },
    );
    expect(cancelledPlane.calls[0]).toEqual({ kind: 'cancel' });
  });

  it('resolves a permission decision from the confirm result and suggestions', async () => {
    const plane = planeWith([]);
    await answerClientPlaneInteraction(
      plane,
      interaction('permission', {
        toolName: 'bash',
        grantSuggestions: [
          { id: 'g1', kind: 'session', label: 'npm scripts' },
          { id: 'g2', kind: 'persistent', label: 'npm scripts forever' },
        ],
      }),
      { ...baseSurface, permission: () => Promise.resolve({ confirmed: true, runtimeGrantKind: 'session' }) },
    );
    expect(plane.calls[0]).toEqual({
      kind: 'permission',
      decision: { type: 'allow_session', suggestionId: 'g1' },
    });

    const rejectedPlane = planeWith([]);
    await answerClientPlaneInteraction(
      rejectedPlane,
      interaction('permission', { toolName: 'bash' }),
      { ...baseSurface, permission: () => Promise.resolve({ confirmed: false }) },
    );
    expect(rejectedPlane.calls[0]).toEqual({
      kind: 'permission',
      decision: { type: 'reject', reason: 'User rejected the tool call.' },
    });
  });

  it('propagates a not-accepted response as false', async () => {
    const plane = planeWith([], false);
    await expect(answerClientPlaneInteraction(
      plane, interaction('question', { question: 'Ship?' }), baseSurface,
    )).resolves.toBe(false);
  });
});

describe('runClientPlaneRound queue chain (T17)', () => {
  interface ScriptedPlaneLog {
    readonly stops: string[];
    readonly withdraws: string[];
    readonly submissions: { readonly inputId: string; readonly delivery?: string }[];
  }

  function scriptedPlane(script: {
    readonly firstAcceptance: { readonly runId?: string };
    readonly activeRun: readonly (string | undefined)[];
    readonly outcomes: Readonly<Record<string, ClientRoundOutcome>>;
    readonly onAwait?: (runId: string) => void;
  }): InkClientPlane & ScriptedPlaneLog {
    const stops: string[] = [];
    const withdraws: string[] = [];
    const submissions: { inputId: string; delivery?: string }[] = [];
    let activeRunIndex = 0;
    return {
      stops,
      withdraws,
      submissions,
      submit: (input) => {
        submissions.push({ inputId: input.inputId, ...(input.delivery !== undefined ? { delivery: input.delivery } : {}) });
        return Promise.resolve(script.firstAcceptance);
      },
      withdraw: (_sessionId, inputId) => {
        withdraws.push(inputId);
        return Promise.resolve(undefined);
      },
      awaitRun: (_sessionId, runId) => {
        script.onAwait?.(runId);
        const outcome = script.outcomes[runId];
        if (!outcome) throw new Error(`No scripted outcome for run ${runId}`);
        return Promise.resolve(outcome);
      },
      stop: (runId) => {
        stops.push(runId);
        return Promise.resolve(undefined);
      },
      activeRun: () => {
        const value = script.activeRun[activeRunIndex];
        if (activeRunIndex < script.activeRun.length - 1) activeRunIndex += 1;
        return Promise.resolve(value);
      },
      observe: () => Promise.resolve(() => undefined),
      readItem: () => Promise.resolve(null),
      respondInteraction: () => Promise.resolve(true),
    };
  }

  it('waits for the queued input to start its run and returns that result', async () => {
    const plane = scriptedPlane({
      firstAcceptance: {},
      activeRun: [undefined, 'r9'],
      outcomes: { r9: { phase: 'completed', result: { success: true, lastText: 'queued answer', messages: [], sessionId: 's1' } } },
    });
    const result = await runClientPlaneRound({ plane, sessionId: 's1', prompt: 'Later.' });
    expect(plane.submissions[0]).toMatchObject({ inputId: expect.stringMatching(/^ink-/) });
    expect(result.lastText).toBe('queued answer');
  });

  it('follows the continuation run the Host starts for queued batches', async () => {
    const plane = scriptedPlane({
      firstAcceptance: { runId: 'r1' },
      activeRun: ['r2'],
      outcomes: {
        r1: { phase: 'completed', result: { success: true, lastText: 'first', messages: [], sessionId: 's1' } },
        r2: { phase: 'completed', result: { success: true, lastText: 'second', messages: [], sessionId: 's1' } },
      },
    });
    const result = await runClientPlaneRound({ plane, sessionId: 's1', prompt: 'Go.' });
    expect(result.lastText).toBe('second');
  });

  it('stops the run currently in the chain when aborted mid-continuation', async () => {
    const controller = new AbortController();
    const plane = scriptedPlane({
      firstAcceptance: { runId: 'r1' },
      activeRun: ['r2'],
      outcomes: {
        r1: { phase: 'completed', result: { success: true, lastText: 'first', messages: [], sessionId: 's1' } },
        r2: { phase: 'cancelled' },
      },
      onAwait: (runId) => {
        if (runId === 'r2' && !controller.signal.aborted) controller.abort();
      },
    });
    const result = await runClientPlaneRound({
      plane, sessionId: 's1', prompt: 'Go.', abortSignal: controller.signal,
    });
    expect(result.interrupted).toBe(true);
    expect(plane.stops).toEqual(['r2']);
  });

  it('withdraws the queued input when aborted before any run starts', async () => {
    const controller = new AbortController();
    const plane = scriptedPlane({
      firstAcceptance: {},
      activeRun: [undefined],
      outcomes: {},
    });
    controller.abort();
    const result = await runClientPlaneRound({
      plane, sessionId: 's1', prompt: 'Later.', abortSignal: controller.signal,
    });
    expect(result.interrupted).toBe(true);
    expect(plane.withdraws).toEqual([plane.submissions[0]!.inputId]);
    expect(plane.stops).toEqual([]);
  });
});
