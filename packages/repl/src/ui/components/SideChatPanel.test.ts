import { describe, expect, it } from 'vitest';
import type { ClientSessionView, ClientViewItem } from '@kodax-ai/coding/client-contract';
import { inheritedItemCount, sideCommand, sideMarker, sidePermissionAnswer, sideSignature, sideTranscriptRows, tidySideItems, undeliveredSideReports, visibleSideItems } from './SideChatPanel.js';

const item = (id: string, type: ClientViewItem['type'], inputId?: string): ClientViewItem =>
  ({ id, type, text: id, ...(inputId ? { inputId } : {}) }) as ClientViewItem;

describe('sideCommand', () => {
  it('matches /side and /btw with an optional question', () => {
    expect(sideCommand('/side')).toEqual({ question: '', end: false });
    expect(sideCommand('  /BTW why?  ')).toEqual({ question: 'why?', end: false });
    expect(sideCommand('/side line1\nline2')).toEqual({ question: 'line1\nline2', end: false });
  });

  it('ignores other input, including names that only start with side', () => {
    expect(sideCommand('/sidebar')).toBeUndefined();
    expect(sideCommand('please /side')).toBeUndefined();
  });
});

describe('sidePermissionAnswer', () => {
  it('accepts only the exact /allow and /deny commands', () => {
    expect(sidePermissionAnswer(' /allow ')).toBe('allow');
    expect(sidePermissionAnswer('/deny')).toBe('deny');
    expect(sidePermissionAnswer('allow it')).toBeUndefined();
  });
});

describe('visibleSideItems', () => {
  it('hides inherited history before the first side user input', () => {
    const items = [item('old-user', 'user'), item('old-reply', 'assistant'),
      item('q', 'user', 'in-1'), item('a', 'assistant')];
    expect(visibleSideItems(items).map(i => i.id)).toEqual(['q', 'a']);
  });

  it('shows nothing when the side chat has no user input yet', () => {
    expect(visibleSideItems([item('old-user', 'user')])).toEqual([]);
  });

  it('keeps only the newest 16 items', () => {
    const items = [item('q', 'user', 'in-1'), ...Array.from({ length: 20 }, (_, n) => item('r' + n, 'assistant'))];
    const shown = visibleSideItems(items);
    expect(shown).toHaveLength(16);
    expect(shown.at(-1)?.id).toBe('r19');
  });
});

describe('sideCommand end', () => {
  it('treats exactly "end" as the end command, case-insensitively', () => {
    expect(sideCommand('/side end')).toMatchObject({ end: true });
    expect(sideCommand('/btw  END ')).toMatchObject({ end: true });
    expect(sideCommand('/side end of file?')).toMatchObject({ end: false });
  });
});

const view = (items: ClientViewItem[], runs: { runId: string; phase: string }[] = [], interactions: unknown[] = []) =>
  ({ items, runs, interactions }) as unknown as ClientSessionView;

describe('sideMarker', () => {
  const reply = [item('q', 'user', 'in-1'), item('a', 'assistant')];
  it('shows nothing before the side chat has any activity', () => {
    expect(sideMarker(view([item('old', 'user')]), '')).toBeUndefined();
  });
  it('reports a running side agent', () => {
    expect(sideMarker(view(reply, [{ runId: 'r', phase: 'running' }]), '')).toContain('running');
  });
  it('reports a tool request that needs an answer before anything else', () => {
    const waiting = view(reply, [{ runId: 'r', phase: 'running' }], [{ kind: 'permission' }]);
    expect(sideMarker(waiting, '')).toContain('approval');
  });
  it('reports a new reply only for items added after the panel was last closed', () => {
    expect(sideMarker(view(reply), '')).toContain('new reply');
    expect(sideMarker(view(reply), sideSignature(view(reply)))).toBeUndefined();
    const grown = [reply[0]!, { ...reply[1]!, text: 'a much longer answer' }];
    expect(sideMarker(view(grown), sideSignature(view(reply)))).toContain('new reply');
  });
});

describe('undeliveredSideReports', () => {
  const receipt = (text: string) => ({ id: 'side-report:' + text, type: 'info', text }) as ClientViewItem;
  it('counts outbound reports the parent has not read, including ones stranded by a branch change', () => {
    const items = [receipt('To parent (delivered): a'), receipt('To parent (queued): b'),
      receipt('To parent (parent branch changed): c'), item('x', 'info')];
    expect(undeliveredSideReports(items)).toBe(2);
  });
});

describe('inheritedItemCount', () => {
  it('counts the items before the first side user input', () => {
    expect(inheritedItemCount([item('o1', 'user'), item('o2', 'assistant'), item('q', 'user', 'in-1')])).toBe(2);
    expect(inheritedItemCount([item('o1', 'user'), item('o2', 'assistant')])).toBe(2);
  });
});

const sendTool = (callId = 'c1'): ClientViewItem => ({ id: 'tool-' + callId, type: 'tool', text: '',
  tool: { callId, name: 'send_to_parent', status: 'success' } }) as ClientViewItem;
const receiptFor = (callId: string): ClientViewItem =>
  ({ id: 'side-report:' + JSON.stringify(['run-1', callId]), type: 'info', text: 'To parent (queued): B' }) as ClientViewItem;

describe('tidySideItems', () => {
  it('hides the send_to_parent tool row once its receipt is shown', () => {
    expect(tidySideItems([sendTool('c1'), sendTool('c2'), receiptFor('c1')]).map(i => i.id))
      .toEqual(['tool-c2', receiptFor('c1').id]);
  });
  it('keeps the tool row while it has no receipt', () => {
    expect(tidySideItems([sendTool('c1')])).toHaveLength(1);
  });
  it('leaves other tools alone', () => {
    const read = { id: 'r', type: 'tool', text: '', tool: { callId: 'c1', name: 'read', status: 'success' } } as ClientViewItem;
    expect(tidySideItems([read, receiptFor('c1')])).toHaveLength(2);
  });
});

describe('sideTranscriptRows', () => {
  const items = [item('inherited parent text', 'user'), item('side question', 'user', 'in-1'),
    { ...item('a1', 'assistant'), text: Array.from({ length: 30 }, (_, n) => 'line ' + n).join('\n\n') } as ClientViewItem];
  it('leaves the inherited parent history out', () => {
    const text = sideTranscriptRows(items, { width: 80, maxRows: 100 }).map(r => r.text).join('\n');
    expect(text).toContain('side question');
    expect(text).not.toContain('inherited parent text');
  });
  it('keeps the newest rows when the budget is smaller than the conversation', () => {
    const rows = sideTranscriptRows(items, { width: 80, maxRows: 5 });
    expect(rows).toHaveLength(5);
    expect(rows.map(r => r.text).join('\n')).toContain('line 29');
  });
});
