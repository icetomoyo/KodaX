import { describe, expect, it } from 'vitest';
import type { ClientSessionView, ClientViewItem } from '@kodax-ai/coding/client-contract';
import { ToolCallStatus } from './types.js';
import { clientViewToHistoryItems, viewRunsActive } from './client-plane.js';

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

  it('marks streaming text on the trailing assistant item while a run is active', () => {
    const view: ClientSessionView = {
      session: { id: 's1', title: 't' },
      items: [
        viewItem({ id: 'a1', type: 'assistant', text: 'partial answer' }),
      ],
      settings: {},
      queue: [],
      interactions: [],
      runs: [{ runId: 'r1', phase: 'running' }],
    } as unknown as ClientSessionView;
    const items = clientViewToHistoryItems(view.items, { activeRunId: 'r1' });
    expect(items[0]).toMatchObject({ type: 'assistant', isStreaming: true });
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
