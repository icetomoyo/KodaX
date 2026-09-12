import { describe, expect, it } from 'vitest';
import type {
  ClientInteraction,
  ClientInteractionResponse,
  ClientSessionView,
  ClientViewItem,
} from '@kodax-ai/coding/client-contract';
import { CANCELLED_TOOL_RESULT_MESSAGE, type AskUserAnswer } from '@kodax-ai/coding';
import { ToolCallStatus } from './types.js';
import { isTranscriptItemVisible, resolveTranscriptSelectionOffset } from './utils/transcript-scroll-controller.js';
import { buildTranscriptToolInputCopyText, buildTranscriptCopyText, searchTranscriptItems } from './utils/transcript-search.js';
import { buildTranscriptRows, buildHistoryItemTranscriptSections, buildTranscriptRenderModel, getVisibleTranscriptRows } from './utils/transcript-layout.js';
import {
  answerClientPlaneInteraction,
  clientViewToHistoryItems,
  readClientPlaneItemText,
  readClientPlaneHistory,
  readFrozenClientPlaneItems,
  runClientPlaneRound,
  followClientPlaneRun,
  viewRunsActive,
  type ClientPlaneDialogSurface,
  type ClientRoundOutcome,
  type InkClientPlane,
} from './client-plane.js';

function viewItem(overrides: Partial<ClientViewItem> & Pick<ClientViewItem, 'id' | 'type' | 'text'>): ClientViewItem {
  return { timestamp: 1_700_000_000_000, ...overrides };
}

describe('clientViewToHistoryItems (T17)', () => {
  it('scrolls to the last distinct tool row rather than the header of a long merged section', () => {
    const items = clientViewToHistoryItems([
      ...Array.from({ length: 20 }, (_, index) => viewItem({
        id: `tool-${index}`, type: 'tool', text: `unique-result-${index}`,
        tool: { callId: `call-${index}`, name: 'read', status: 'success', inputText: JSON.stringify({ path: `file-${index}.ts` }) },
      })),
      viewItem({ id: 'later', type: 'assistant', text: 'Later output\n'.repeat(30) }),
    ]);
    const [match] = searchTranscriptItems(items, 'unique-result-19');
    expect(match?.itemId).toBe('tool-19');
    const renderModel = buildTranscriptRenderModel({ items, viewportWidth: 100, windowed: true });
    const options = { items, renderModel, terminalWidth: 100, transcriptMaxLines: 1000,
      viewportRows: 8, itemId: match!.itemId };
    const headerWindow = renderModel.sections[0]!.rows.slice(0, 8);
    expect(isTranscriptItemVisible({ ...options, visibleRows: headerWindow })).toBe(false);
    const offset = resolveTranscriptSelectionOffset(options);
    const visibleRows = getVisibleTranscriptRows(renderModel.rows, 8, offset);
    expect(visibleRows.some(row => row.key.startsWith('tool-19-tool-'))).toBe(true);
    expect(isTranscriptItemVisible({ ...options, visibleRows })).toBe(true);
  });
  it('locates, expands, and copies the middle original item in an x3 tool summary', () => {
    const tools = clientViewToHistoryItems(['first', 'middle', 'last'].map(id => viewItem({
      id, type: 'tool', text: `needle-${id}`,
      tool: { callId: `call-${id}`, name: 'bash', status: 'success', inputText: '{"command":"git status"}' },
    })));
    const items = [...tools, ...clientViewToHistoryItems([viewItem({
      id: 'later', type: 'assistant', text: 'Later output\n'.repeat(30),
    })])];
    const [match] = searchTranscriptItems(items, 'needle-middle');
    expect(match?.itemId).toBe('middle');
    const renderModel = buildTranscriptRenderModel({ items, viewportWidth: 100, windowed: true });
    expect(renderModel.rows.map(row => row.text).join('\n')).toContain('x3');
    const options = { items, renderModel, terminalWidth: 100, transcriptMaxLines: 1000,
      viewportRows: 8, itemId: match!.itemId };
    const offset = resolveTranscriptSelectionOffset(options);
    expect(offset).toBeGreaterThan(0);
    const visibleRows = getVisibleTranscriptRows(renderModel.rows, 8, offset);
    expect(isTranscriptItemVisible({ ...options, visibleRows })).toBe(true);
    expect(visibleRows.find(row => row.text.includes('x3'))?.itemIds).toContain('middle');
    const selected = items.find(item => item.id === match!.itemId);
    expect(buildTranscriptCopyText(selected)).toContain('Output: needle-middle');
    expect(buildTranscriptCopyText(selected)).not.toContain('needle-last');
    expect(buildTranscriptToolInputCopyText(selected)).toBe('Tool: bash\n{"command":"git status"}');
    const expanded = buildHistoryItemTranscriptSections(items, 100, 1000, false, new Set([match!.itemId]));
    expect(expanded.find(section => section.key === 'middle')?.rows.map(row => row.text).join('\n'))
      .toContain('needle-middle');
  });
  it('renders adjacent Host tool items with the existing collapsed summary while keeping item reads separate', async () => {
    const source = ['first', 'second'].map(id => viewItem({
      id, type: 'tool', text: 'same output', totalTextLength: 16,
      tool: { callId: `call-${id}`, name: 'bash', status: 'success',
        inputText: '{"command":"git status"}' },
    }));
    const items = clientViewToHistoryItems(source);
    expect(items.map(item => item.id)).toEqual(['first', 'second']);
    const rows = buildHistoryItemTranscriptSections(items, 100).flatMap(section => section.rows);
    expect(rows.filter(row => row.text.startsWith('Tools [')).length).toBe(1);
    expect(rows.map(row => row.text).join('\n')).toContain('x2');
    expect(rows.find(row => row.text.includes('x2'))?.itemId).toBe('second');
    expect(buildTranscriptToolInputCopyText(items.find(item => item.id === rows.find(row => row.text.includes('x2'))?.itemId)))
      .toBe('Tool: bash\n{"command":"git status"}');
    const expandedRows = buildHistoryItemTranscriptSections(items, 100, 1000, false, new Set(['first']))
      .flatMap(section => section.rows);
    expect(expandedRows.some(row => row.key.startsWith('first-tool-'))).toBe(true);
    expect(expandedRows.some(row => row.key.startsWith('second-tool-'))).toBe(true);
    expect(expandedRows.some(row => row.text.includes('x2'))).toBe(false);
    const separated = buildHistoryItemTranscriptSections([items[0]!, { id: 'answer', type: 'assistant', text: 'Between tools', timestamp: 0 }, items[1]!], 100);
    expect(separated.flatMap(section => section.rows).filter(row => row.text.startsWith('Tools [')).length).toBe(2);
    const readIds: string[] = [];
    const expanded = await readFrozenClientPlaneItems({ readItem: async (_session, id) => {
      readIds.push(id);
      return { id, text: `full ${id} body`.padEnd(16), offset: 0, totalLength: 16 };
    } }, 'session', items);
    expect(readIds).toEqual(['first', 'second']);
    expect(expanded[0]?.type === 'tool_group' && expanded[0].tools[0]?.output).toBe('full first body ');
    expect(expanded[1]?.type === 'tool_group' && expanded[1].tools[0]?.output).toBe('full second body');
  });
  it('searches and copies the complete frozen stream without later appended characters', async () => {
    const items = clientViewToHistoryItems([viewItem({
      id: 'stream', type: 'assistant', text: 'snapshot', textOffset: 6, totalTextLength: 14,
    })], { activeRunId: 'run' });
    const expanded = await readFrozenClientPlaneItems({ readItem: async () => ({
      id: 'stream', text: 'Early snapshot LATER', offset: 0, totalLength: 20,
    }) }, 'session', items);
    expect(expanded).toMatchObject([{ id: 'stream', text: 'Early snapshot', isStreaming: true }]);
    expect(expanded[0]?.totalTextLength).toBeUndefined();
    expect(items).toMatchObject([{ text: 'snapshot', textOffset: 6, totalTextLength: 14 }]);
  });
  it('reads a captured multi-page prefix while the live stream continues to grow', async () => {
    const prefix = 'a'.repeat(65_536);
    const items = clientViewToHistoryItems([viewItem({ id: 'growing', type: 'assistant',
      text: 'frozen-tail', textOffset: prefix.length, totalTextLength: prefix.length + 11,
    })]);
    let reads = 0;
    const expanded = await readFrozenClientPlaneItems({ readItem: async (_session, id, options) => {
      reads += 1;
      return typeof options === 'object' && options.offset === prefix.length
        ? { id, text: 'frozen-tailLATER', offset: prefix.length, totalLength: prefix.length + 16 }
        : { id, text: prefix, offset: 0, totalLength: prefix.length + 11, nextOffset: prefix.length };
    } }, 'session', items);
    expect(expanded).toMatchObject([{ text: `${prefix}frozen-tail` }]);
    expect(reads).toBe(2);
  });
  it('stops frozen content paging when transcript browsing is cancelled', async () => {
    const controller = new AbortController();
    let reads = 0;
    const items = clientViewToHistoryItems([viewItem({ id: 'cancelled-read', type: 'assistant',
      text: 'tail', textOffset: 65_536, totalTextLength: 65_540,
    })]);
    await expect(readFrozenClientPlaneItems({ readItem: async (_session, id) => {
      reads += 1;
      controller.abort(new Error('Left transcript'));
      return { id, text: 'a'.repeat(65_536), offset: 0, totalLength: 65_540, nextOffset: 65_536 };
    } }, 'session', items, controller.signal)).rejects.toThrow('Left transcript');
    expect(reads).toBe(1);
  });
  it('rejects a changed captured suffix rather than replacing the frozen text', async () => {
    const items = clientViewToHistoryItems([viewItem({ id: 'changed', type: 'assistant',
      text: 'old', textOffset: 7, totalTextLength: 10,
    })]);
    await expect(readFrozenClientPlaneItems({ readItem: async () => ({
      id: 'changed', text: 'prefix new', offset: 0, totalLength: 10,
    }) }, 'session', items)).rejects.toThrow('Frozen transcript content changed');
  });
  it('renders Host tool arguments and result details in the transcript', () => {
    const items = clientViewToHistoryItems([viewItem({
      id: 'bash-details', type: 'tool', text: 'Command: git status\nExit: 0\nworking tree clean',
      tool: { callId: 'bash-call', name: 'bash', status: 'success',
        inputText: JSON.stringify({ command: 'git status', description: 'Inspect working tree' }),
        startedAt: 1000, endedAt: 3800 },
    })]);
    const text = buildTranscriptRows({ items, viewportWidth: 100 })
      .map((row) => row.text).join('\n');
    expect(text).toContain('git status');
    expect(text).toContain('2.8s');
    const expanded = buildTranscriptRows({ items, viewportWidth: 100, showDetailedTools: true })
      .map((row) => row.text).join('\n');
    expect(expanded).toContain('working tree clean');
    expect(expanded).toContain('Inspect working tree');
  });
  it('loads older pages and full bounded text for transcript search', async () => {
    const plane = {
      readItem: async () => null,
      readHistory: async (_sessionId: string, options?: { cursor?: string }) => options?.cursor
        ? { revision: 'r', items: [viewItem({ id: 'old', type: 'user', text: 'old question' })], oversized: [] }
        : { revision: 'r', nextCursor: 'older', items: [viewItem({ id: 'new', type: 'assistant', text: 'tail', totalTextLength: 18 })], oversized: [] },
      readHistoryEntry: async () => ({ id: 'new', text: 'middle needle tail', offset: 0, totalLength: 18 }),
    };
    const items = await readClientPlaneHistory(plane, 's');
    expect(items.map((item) => item.id)).toEqual(['old', 'new']);
    expect(items[1]).toMatchObject({ text: 'middle needle tail', historyItemId: 'new' });
  });
  it('keeps full tool arguments in a frozen history snapshot for later copying', async () => {
    const plane = {
      readItem: async () => null,
      readHistory: async () => ({ revision: 'r', oversized: [], items: [viewItem({
        id: 'tool', type: 'tool', text: 'done', tool: { callId: 'c', name: 'read', status: 'success',
          inputText: '{"p', totalInputLength: 19 },
      })] }),
      readHistoryEntry: async () => ({ id: 'tool', text: '{"path":"full.txt"}', offset: 0, totalLength: 19 }),
    };
    const [item] = await readClientPlaneHistory(plane, 's');
    expect(buildTranscriptToolInputCopyText(item)).toBe('Tool: read\n{"path":"full.txt"}');
    expect(item?.totalInputLength).toBeUndefined();
  });
  it('rejects incomplete content instead of returning a successfully copied preview', async () => {
    const readItem = async (_sessionId: string, itemId: string, options?: { offset?: number }) =>
      options?.offset ? null : { id: itemId, text: 'first', offset: 0, totalLength: 10, nextOffset: 5 };
    await expect(readClientPlaneItemText({ readItem }, 's', 'a')).rejects.toThrow('unavailable');
  });
  it('preserves bounded content coordinates and copyable raw tool arguments', () => {
    const items = clientViewToHistoryItems([
      viewItem({ id: 'long-answer', type: 'assistant', text: 'last words', textOffset: 8990, totalTextLength: 9000 }),
      viewItem({ id: 'tool-raw', type: 'tool', text: '', tool: {
        callId: 'call-raw', name: 'read', status: 'success', inputText: '{"path":"a.txt"}',
      } }),
    ]);
    expect(items[0]).toMatchObject({ textOffset: 8990, totalTextLength: 9000 });
    expect(buildTranscriptToolInputCopyText(items[1])).toBe('Tool: read\n{"path":"a.txt"}');
  });
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

  it('remaps the trailing assistant item when its run turns terminal (T27 review)', () => {
    const memo = { entries: new Map() };
    const streaming = clientViewToHistoryItems(
      [viewItem({ id: 'a1', type: 'assistant', text: 'abc' })],
      { memo, activeRunId: 'r1' },
    );
    expect(streaming[0]).toMatchObject({ isStreaming: true });
    // Same text, same length — but the run ended, so the stale
    // streaming-marked item must not be reused.
    const terminal = clientViewToHistoryItems(
      [viewItem({ id: 'a1', type: 'assistant', text: 'abc' })],
      { memo },
    );
    expect(terminal[0]).not.toBe(streaming[0]);
    expect(terminal[0]).not.toMatchObject({ isStreaming: true });
  });

  it('remaps items whose text changed with an equal length (T27 review)', () => {
    const memo = { entries: new Map() };
    const first = clientViewToHistoryItems(
      [viewItem({ id: 'u1', type: 'user', text: 'abcdef' })],
      { memo },
    );
    const swapped = clientViewToHistoryItems(
      [viewItem({ id: 'u1', type: 'user', text: 'xyzklm' })],
      { memo },
    );
    expect(swapped[0]).not.toBe(first[0]);
    expect(swapped[0]).toMatchObject({ text: 'xyzklm' });
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
      executeTool: async () => { throw new Error('Unexpected tool invocation'); },
      cancelSession: async () => { throw new Error('Unexpected Session Stop'); },
      activeRun: async () => undefined,
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

  it.each(['question', 'question_multi', 'question_input', 'permission'] as const)(
    'does not submit a %s answer when observation cleanup aborts the dialog', async (kind) => {
      const plane = planeWith([]);
      const controller = new AbortController();
      const surface: ClientPlaneDialogSurface = {
        question: async () => { controller.abort(); return CANCELLED_TOOL_RESULT_MESSAGE as AskUserAnswer; },
        questionMulti: async () => { controller.abort(); return undefined; },
        questionInput: async () => { controller.abort(); return undefined; },
        permission: async () => { controller.abort(); return { confirmed: false }; },
      };
      const pending = kind === 'permission' ? interaction(kind, { toolName: 'bash' })
        : kind === 'question_multi' ? interaction(kind, { questions: [{ question: 'A?' }] })
          : kind === 'question_input' ? interaction(kind, { question: 'Name?' })
            : interaction(kind, { question: 'Ship?' });
      expect(await answerClientPlaneInteraction(plane, pending, surface, controller.signal)).toBe(false);
      expect(plane.calls).toEqual([]);
    },
  );

  it('does not open an interaction after its observation has already closed', async () => {
    const plane = planeWith([]);
    const question = vi.fn(baseSurface.question);
    const controller = new AbortController();
    controller.abort();
    expect(await answerClientPlaneInteraction(plane, interaction('question', { question: 'Ship?' }),
      { ...baseSurface, question }, controller.signal)).toBe(false);
    expect(question).not.toHaveBeenCalled();
    expect(plane.calls).toEqual([]);
  });

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
      executeTool: async () => { throw new Error('Unexpected tool invocation'); },
      cancelSession: async () => { throw new Error('Unexpected Session Stop'); },
      withdraws,
      submissions,
      submit: (input) => {
        submissions.push({
          inputId: input.inputId,
          ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
          ...(input.inputArtifacts !== undefined ? { inputArtifacts: input.inputArtifacts } : {}),
        });
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

  it('follows a command Run without another submission and stops that same Run on Escape', async () => {
    const controller = new AbortController();
    const plane = scriptedPlane({ firstAcceptance: { runId: 'duplicate' }, activeRun: ['unrelated'],
      outcomes: { command: { phase: 'cancelled' } }, onAwait: () => controller.abort() });
    const result = await followClientPlaneRun({ plane, sessionId: 's1', runId: 'command',
      abortSignal: controller.signal });
    expect(result.interrupted).toBe(true);
    expect(plane.submissions).toEqual([]);
    expect(plane.withdraws).toEqual([]);
    expect(plane.stops).toEqual(['command']);
  });

  it('keeps following a command while a queued input runs, and stops the continuation', async () => {
    const controller = new AbortController();
    const awaited: string[] = [];
    const plane = scriptedPlane({ firstAcceptance: {}, activeRun: ['continuation'],
      outcomes: {
        command: { phase: 'completed', result: { success: true, lastText: 'first', messages: [], sessionId: 's1' } },
        continuation: { phase: 'cancelled' },
      }, onAwait: (runId) => {
        awaited.push(runId);
        if (runId === 'command') {
          void plane.submit({ sessionId: 's1', inputId: 'follow-up', text: 'Next task', delivery: 'after_turn' });
        } else controller.abort();
      } });
    const result = await followClientPlaneRun({ plane, sessionId: 's1', runId: 'command',
      abortSignal: controller.signal });
    expect(awaited).toEqual(['command', 'continuation']);
    expect(plane.submissions).toEqual([{ inputId: 'follow-up', delivery: 'after_turn' }]);
    expect(plane.stops).toEqual(['continuation']);
    expect(result.interrupted).toBe(true);
  });

  it.each([
    { mode: 'command', displayedAtAbort: 'continuation', accepted: true },
    { mode: 'command', displayedAtAbort: 'continuation', accepted: false },
    { mode: 'command', displayedAtAbort: 'command', accepted: false },
    { mode: 'input', displayedAtAbort: 'continuation', accepted: true },
    { mode: 'input', displayedAtAbort: 'continuation', accepted: false },
    { mode: 'input', displayedAtAbort: 'command', accepted: false },
  ])('freezes the displayed $displayedAtAbort in $mode at abort when stop accepted=$accepted despite a later unrelated Run', async ({ mode, displayedAtAbort, accepted }) => {
    const controller = new AbortController();
    const plane = scriptedPlane({ firstAcceptance: { runId: 'command' }, activeRun: ['unrelated'], outcomes: {} });
    let displayed = displayedAtAbort;
    let finishCommand: ((outcome: ClientRoundOutcome) => void) | undefined;
    const completed: ClientRoundOutcome = { phase: 'completed',
      result: { success: true, lastText: 'first', messages: [], sessionId: 's1' } };
    const awaited: string[] = [];
    plane.awaitRun = (_sessionId, runId) => {
      awaited.push(runId);
      return runId !== 'command' ? Promise.resolve({ phase: 'cancelled' })
        : new Promise((resolve) => { finishCommand = resolve; });
    };
    plane.stop = async (runId) => {
      plane.stops.push(runId);
      finishCommand?.(completed);
      displayed = 'unrelated';
      return { runId, sessionId: 's1', accepted,
        state: 'submitted', outcome: 'stopped', phase: runId === 'command' ? 'completed' : 'running' };
    };
    const input = { plane, sessionId: 's1', abortSignal: controller.signal, getDisplayedRunId: () => displayed };
    const pending = mode === 'command' ? followClientPlaneRun({ ...input, runId: 'command' })
      : runClientPlaneRound({ ...input, prompt: 'Run task' });
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    expect(plane.stops).toEqual([displayedAtAbort]);
    expect(awaited).toEqual(displayedAtAbort === 'command' ? ['command'] : ['command', 'continuation']);
    expect(result.interrupted === true).toBe(displayedAtAbort === 'continuation');
    expect(plane.submissions).toHaveLength(mode === 'command' ? 0 : 1);
  });

  it.each([
    { mode: 'command', phase: 'failed' }, { mode: 'command', phase: 'unknown' },
    { mode: 'input', phase: 'failed' }, { mode: 'input', phase: 'unknown' },
  ])('preserves $phase errors even with a residual result in the $mode path', async ({ mode, phase }) => {
    const plane = scriptedPlane({ firstAcceptance: { runId: 'r1' }, activeRun: [], outcomes: {
      r1: { phase, error: 'Settlement could not be confirmed',
        result: { success: true, lastText: 'Residual output', messages: [], sessionId: 's1' } },
    } });
    const pending = mode === 'command'
      ? followClientPlaneRun({ plane, sessionId: 's1', runId: 'r1' })
      : runClientPlaneRound({ plane, sessionId: 's1', prompt: 'Run task' });
    await expect(pending).rejects.toThrow('Settlement could not be confirmed');
  });

  it('forwards prompt input artifacts with the submission (T27 review)', async () => {
    const plane = scriptedPlane({
      firstAcceptance: { runId: 'r1' },
      activeRun: [],
      outcomes: { r1: { phase: 'completed', result: { success: true, lastText: 'ok', messages: [], sessionId: 's1' } } },
    });
    await runClientPlaneRound({
      plane,
      sessionId: 's1',
      prompt: 'describe the screenshot',
      inputArtifacts: [{
        kind: 'image',
        path: 'C:/shots/screen.png',
        mediaType: 'image/png',
        source: 'clipboard',
      }],
    });
    expect(plane.submissions[0]).toMatchObject({ inputId: expect.stringMatching(/^ink-/) });
    expect((plane.submissions[0] as { inputArtifacts?: unknown }).inputArtifacts).toEqual([{
      kind: 'image',
      path: 'C:/shots/screen.png',
      mediaType: 'image/png',
      source: 'clipboard',
    }]);
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

  it('withdraws its queued input instead of stopping the displayed unrelated Run before admission', async () => {
    const controller = new AbortController();
    const plane = scriptedPlane({ firstAcceptance: {}, activeRun: [], outcomes: {} });
    plane.activeRun = async () => { controller.abort(); return 'unrelated'; };
    const pending = runClientPlaneRound({ plane, sessionId: 's1', prompt: 'Later.',
      abortSignal: controller.signal, getDisplayedRunId: () => 'unrelated' });
    await expect(pending).resolves.toMatchObject({ interrupted: true });
    expect(plane.withdraws).toEqual([plane.submissions[0]!.inputId]);
    expect(plane.stops).toEqual([]);
  });
});
